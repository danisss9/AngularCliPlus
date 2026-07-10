import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawnManaged } from './spawn';
import { ngOutput, extensionTerminals } from './state';
import { getTrackedTerminalState } from './state';
import { analyzeSignalsInFile } from './signals-ast';
import { showSignalGraphWebview } from './signals-webview';
import {
  resolveWorkspaceAndAngularJson,
  runInTerminal,
  pickProjectWithCurrentFile,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
  pickWorkspaceFolder,
  buildAngularCliTerminalCommand,
  resolveAngularCliSpawn,
} from './utils';
import { detectCliVersion } from './version';
import { getBuildConfigFlag, supportsTestUiFlag } from './version-adapter';
import { parseComponentFilePath, getComponentSiblingPaths } from './pure-utils';
import type { AngularProject } from './types';

// ── Component file switching ──────────────────────────────────────────────────

export async function switchComponentFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor');
    return;
  }

  const currentPath = editor.document.uri.fsPath;
  const parsed = parseComponentFilePath(currentPath);
  if (!parsed) {
    vscode.window.showInformationMessage('Current file is not an Angular component file');
    return;
  }

  const candidates = getComponentSiblingPaths(parsed.basePath);
  const existing = candidates.filter((p) => fs.existsSync(p));

  if (existing.length <= 1) {
    vscode.window.showInformationMessage('No sibling component files found');
    return;
  }

  const extLabel = (filePath: string): string => {
    const ext = filePath.slice(parsed.basePath.length);
    switch (ext) {
      case '.component.ts':
        return '$(symbol-class)  TypeScript (.component.ts)';
      case '.component.html':
        return '$(code)  Template (.component.html)';
      case '.component.css':
      case '.component.scss':
      case '.component.sass':
      case '.component.less':
        return `$(symbol-color)  Styles (${ext.slice('.component.'.length)})`;
      case '.component.spec.ts':
        return '$(beaker)  Test (.component.spec.ts)';
      default:
        return ext;
    }
  };

  type FileItem = vscode.QuickPickItem & { filePath: string };
  const items: FileItem[] = existing.map((p) => ({
    label: extLabel(p),
    filePath: p,
    description: p === currentPath ? '(current)' : undefined,
  }));

  const qp = vscode.window.createQuickPick<FileItem>();
  qp.items = items;
  qp.placeholder = 'Switch to component file…';
  qp.title = `Switch: ${path.basename(parsed.basePath)}.component.*`;
  qp.activeItems = items.filter((i) => i.filePath === currentPath);
  qp.matchOnDescription = true;

  const chosen = await new Promise<FileItem | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();

  if (!chosen || chosen.filePath === currentPath) {
    return;
  }

  const doc = await vscode.workspace.openTextDocument(chosen.filePath);
  await vscode.window.showTextDocument(doc, editor.viewColumn);
}

// ── Serve ─────────────────────────────────────────────────────────────────────

export async function serveAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const appProjects = Object.entries(projects)
    .filter(([, p]) => !p.projectType || p.projectType === 'application')
    .map(([n]) => n);

  const projectName = await pickProjectWithCurrentFile(
    workspaceRoot,
    projects,
    appProjects,
    'Angular Serve: Select Project',
    'serve',
  );
  if (!projectName) {
    return;
  }

  const serveCommand = buildAngularCliTerminalCommand(
    workspaceRoot,
    `ng serve --project "${projectName}"`,
  );
  const terminalName = `ng serve (${projectName})`;
  void runInTerminal(terminalName, serveCommand, workspaceRoot, { trackAsServe: true }).catch(
    (err) => vscode.window.showErrorMessage(`Failed to start "${terminalName}": ${err}`),
  );
}

// ── Test ──────────────────────────────────────────────────────────────────────

const VITEST_UI_DEFAULT_PORT = 51204;
const VITEST_UI_START_TIMEOUT_MS = 60000;

let vitestUiPanel: vscode.WebviewPanel | null = null;

function createVitestUiWebview(port: number): void {
  const url = `http://localhost:${port}/__vitest__/#/`;

  if (vitestUiPanel) {
    vitestUiPanel.reveal();
    return;
  }

  vitestUiPanel = vscode.window.createWebviewPanel(
    'angularCliPlus.vitestUi',
    'Vitest UI',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableCommandUris: true,
    },
  );

  vitestUiPanel.webview.html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Vitest UI</title>
      <style>
        html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: none; }
      </style>
    </head>
    <body>
      <iframe src="${url}"></iframe>
    </body>
    </html>
  `;

  vitestUiPanel.onDidDispose(() => {
    vitestUiPanel = null;
  });
}

async function openVitestUiInVscode(port: number = VITEST_UI_DEFAULT_PORT): Promise<void> {
  const url = `http://localhost:${port}/__vitest__/#/`;

  try {
    await vscode.commands.executeCommand('workbench.action.browser.open', url);
  } catch {
    createVitestUiWebview(port);
  }
}

async function waitForVitestUi(
  port: number = VITEST_UI_DEFAULT_PORT,
  timeoutMs: number = VITEST_UI_START_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const socket = net.createConnection({ port, host: 'localhost' });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error('socket timeout'));
        }, 1000);

        socket.on('connect', () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve();
        });

        socket.on('error', () => {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error('connection refused'));
        });
      });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return false;
}

// Basename of the throwaway Vitest config we hand to `ng test --runner-config`.
const TEMP_VITEST_CONFIG_BASENAME = 'angular-cli-plus.vitest-open.config.ts';

// Config filenames the builder may auto-discover / a project may point at. If
// any exists we stay hands-off rather than risk overriding a real config.
const RUNNER_CONFIG_SEARCH_BASENAMES = [
  'vitest-base.config.ts',
  'vitest-base.config.mts',
  'vitest-base.config.cts',
  'vitest-base.config.js',
  'vitest-base.config.mjs',
  'vitest-base.config.cjs',
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
];

/**
 * True when the workspace already supplies its own Vitest runner config — either
 * a `runnerConfig` option on a project's `test` target in `angular.json`, or a
 * Vitest/Vite config file at the workspace root. In that case we must NOT inject
 * our own `--runner-config`, since the CLI flag would override (and thus
 * discard) the project's real config.
 */
function hasExistingRunnerConfig(
  workspaceRoot: string,
  projects: { [name: string]: AngularProject },
): boolean {
  const configuredInAngularJson = Object.values(projects).some((project) => {
    const options = (project.architect?.test as { options?: Record<string, unknown> } | undefined)
      ?.options;
    return options?.runnerConfig !== undefined;
  });
  if (configuredInAngularJson) {
    return true;
  }

  return RUNNER_CONFIG_SEARCH_BASENAMES.some((name) =>
    fs.existsSync(path.join(workspaceRoot, name)),
  );
}

/**
 * Writes a throwaway Vitest config that disables Vitest's automatic
 * external-browser open (`test.open = false`). It is passed to the Angular
 * unit-test builder via `--runner-config`, which merges it into the builder's
 * generated config — so the UI no longer pops a system browser tab (the
 * extension surfaces it inside VS Code instead).
 *
 * A config file is required because `ng test` has no `--open` flag; the value
 * can only be supplied through the runner config. The file is removed again
 * once Vitest has started — it has read the config into memory by then (see the
 * caller and {@link deleteTempVitestOpenConfig}).
 *
 * Returns the path written, or `null` if the write failed.
 */
function writeTempVitestOpenConfig(configPath: string): string | null {
  const contents =
    `import { defineConfig } from 'vitest/config';\n\n` +
    `// Temporary config written by the Angular CLI Plus extension so the Vitest\n` +
    `// UI is not opened in an external browser tab (it is shown inside VS Code).\n` +
    `// It is removed automatically once Vitest has started.\n` +
    `export default defineConfig({\n` +
    `  test: { open: false },\n` +
    `});\n`;

  try {
    fs.writeFileSync(configPath, contents, 'utf8');
    return configPath;
  } catch {
    return null;
  }
}

/** Removes the temp config written by {@link writeTempVitestOpenConfig}. */
function deleteTempVitestOpenConfig(configPath: string | null): void {
  if (!configPath) {
    return;
  }
  try {
    fs.rmSync(configPath, { force: true });
  } catch {
    // Best effort — a leftover temp config is harmless and overwritten next run.
  }
}

export async function testAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const testableProjects = Object.entries(projects)
    .filter(([, p]) => p.architect?.test !== undefined)
    .map(([n]) => n);

  if (testableProjects.length === 0) {
    vscode.window.showWarningMessage('No projects with a test architect found in angular.json.');
    return;
  }

  const ALL_PROJECTS = '$(list-flat)  All projects';

  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const isSpecFile = activeFile?.endsWith('.spec.ts') ?? false;
  const CURRENT_FILE = '$(file)  Run current test file';

  const currentProject = detectActiveFileProject(workspaceRoot, projects);
  const currentInTestable =
    currentProject && testableProjects.includes(currentProject) ? currentProject : null;
  const CURRENT_PROJECT_LABEL = currentInTestable
    ? `$(file)  Current project (${currentInTestable})`
    : null;

  const lastTest = getLastProject('test');
  const lastInTestable =
    lastTest && testableProjects.includes(lastTest) && lastTest !== currentInTestable
      ? lastTest
      : null;
  const LAST_LABEL = lastInTestable ? `$(history)  Last used (${lastInTestable})` : null;

  const choices = [
    ...(isSpecFile ? [CURRENT_FILE] : []),
    ...(CURRENT_PROJECT_LABEL ? [CURRENT_PROJECT_LABEL] : []),
    ...(LAST_LABEL ? [LAST_LABEL] : []),
    ALL_PROJECTS,
    ...testableProjects,
  ];

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select a project to test, or "All" to run ng test without a project',
    title: 'Angular Test: Select Project',
  });

  if (!picked) {
    return;
  }

  let testCommand: string;
  let terminalName: string;

  const cliVersion = await detectCliVersion(workspaceRoot);
  const supportsUi = supportsTestUiFlag(cliVersion);

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  const watchMode = config.get<boolean>('test.watch', false);
  const uiMode = config.get<boolean>('test.ui', false);
  const uiInVscode = config.get<boolean>('test.uiInVscode', true);
  const uiPort = config.get<number>('test.uiPort', VITEST_UI_DEFAULT_PORT);

  let watchFlag = '';
  let uiFlag = '';

  if (uiMode && supportsUi) {
    uiFlag = ' --ui';
    watchFlag = ' --watch';
  } else {
    watchFlag = watchMode ? ' --watch' : ' --watch=false';
  }

  // When showing the UI inside VS Code, hand the builder a temp runner config
  // that disables Vitest's external-browser open — unless the project already
  // supplies its own runner config, which we must not override.
  const wantsVitestUi = uiMode && supportsUi && uiInVscode;
  const tempVitestConfigPath =
    wantsVitestUi && !hasExistingRunnerConfig(workspaceRoot, projects)
      ? path.join(workspaceRoot, TEMP_VITEST_CONFIG_BASENAME)
      : null;
  if (tempVitestConfigPath) {
    uiFlag += ` --runner-config "${tempVitestConfigPath}"`;
  }

  if (picked === CURRENT_FILE && activeFile) {
    const relPath = path.relative(workspaceRoot, activeFile).replaceAll(path.sep, '/');
    const projectFlag = currentInTestable ? ` --project "${currentInTestable}"` : '';
    testCommand = buildAngularCliTerminalCommand(
      workspaceRoot,
      `ng test${projectFlag} --include "${relPath}"${watchFlag}${uiFlag}`,
    );
    terminalName = currentInTestable
      ? `ng test (${currentInTestable}:${path.basename(activeFile)})`
      : `ng test (${path.basename(activeFile)})`;
  } else if (CURRENT_PROJECT_LABEL && picked === CURRENT_PROJECT_LABEL) {
    setLastProject('test', currentInTestable!);
    testCommand = buildAngularCliTerminalCommand(
      workspaceRoot,
      `ng test --project "${currentInTestable}"${watchFlag}${uiFlag}`,
    );
    terminalName = `ng test (${currentInTestable})`;
  } else if (LAST_LABEL && picked === LAST_LABEL) {
    testCommand = buildAngularCliTerminalCommand(
      workspaceRoot,
      `ng test --project "${lastInTestable}"${watchFlag}${uiFlag}`,
    );
    terminalName = `ng test (${lastInTestable})`;
  } else if (picked === ALL_PROJECTS) {
    testCommand = buildAngularCliTerminalCommand(workspaceRoot, `ng test${watchFlag}${uiFlag}`);
    terminalName = 'ng test (all)';
  } else {
    setLastProject('test', picked);
    testCommand = buildAngularCliTerminalCommand(
      workspaceRoot,
      `ng test --project "${picked}"${watchFlag}${uiFlag}`,
    );
    terminalName = `ng test (${picked})`;
  }

  // Write the temp runner config in place before the terminal boots Vitest; it
  // is removed again once Vitest is up (see the finally block below).
  const tempVitestConfig = tempVitestConfigPath
    ? writeTempVitestOpenConfig(tempVitestConfigPath)
    : null;

  const terminalPromise = runInTerminal(terminalName, testCommand, workspaceRoot, {
    successMessage: watchMode ? undefined : `${terminalName} completed successfully.`,
    retryLabel: watchMode ? undefined : 'Retry',
  }).catch((err) => vscode.window.showErrorMessage(`Failed to start "${terminalName}": ${err}`));

  if (wantsVitestUi) {
    void terminalPromise.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        await waitForVitestUi(uiPort, VITEST_UI_START_TIMEOUT_MS);
        await openVitestUiInVscode(uiPort);
      } catch {
        vscode.window.showWarningMessage(
          `Vitest UI did not start within the expected time. Please try opening http://localhost:${uiPort} manually.`,
        );
      } finally {
        // Give Vitest a 5s grace window to finish reading the config (it may
        // re-read on an initial restart) before removing the temp file.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        deleteTempVitestOpenConfig(tempVitestConfig);
      }
    });
  }
}

// ── Build ─────────────────────────────────────────────────────────────────────

export async function buildAngularProject() {
  await runNgBuild(false);
}

export async function buildAngularProjectWatch() {
  await runNgBuild(true);
}

async function runNgBuild(watch: boolean) {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const allProjects = Object.keys(projects);
  const title = watch ? 'Angular Build Watch: Select Project' : 'Angular Build: Select Project';
  const projectName = await pickProjectWithCurrentFile(
    workspaceRoot,
    projects,
    allProjects,
    title,
    watch ? 'buildWatch' : 'build',
  );
  if (!projectName) {
    return;
  }

  const cliVersion = await detectCliVersion(workspaceRoot);

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  let effectiveConfig: string;
  if (watch) {
    const watchConfig = config.get<string>('watch.configuration', 'development');
    effectiveConfig =
      watchConfig === 'inherit'
        ? config.get<string>('build.configuration', 'production')
        : watchConfig;
  } else {
    effectiveConfig = config.get<string>('build.configuration', 'production');
  }
  const configFlag = getBuildConfigFlag(effectiveConfig, cliVersion);
  const watchFlag = watch ? ' --watch' : '';

  const terminalName = watch ? `ng build --watch (${projectName})` : `ng build (${projectName})`;
  const buildCommand = buildAngularCliTerminalCommand(
    workspaceRoot,
    `ng build --project "${projectName}"${configFlag}${watchFlag}`,
  );
  void runInTerminal(terminalName, buildCommand, workspaceRoot, {
    trackAsServe: watch,
    successMessage: watch ? undefined : `ng build (${projectName}) completed successfully.`,
    retryLabel: watch ? undefined : 'Retry',
  }).catch((err) => vscode.window.showErrorMessage(`Failed to start "${terminalName}": ${err}`));
}

// ── Clear terminals ───────────────────────────────────────────────────────────

export async function clearFinishedTerminals() {
  if (extensionTerminals.size === 0) {
    vscode.window.showInformationMessage('No extension terminals to close.');
    return;
  }

  function getTerminalState(terminal: vscode.Terminal): {
    state: 'running' | 'terminated' | 'errored' | 'killed';
    label: string;
    icon: string;
  } {
    const trackedState = getTrackedTerminalState(terminal);
    if (trackedState) {
      switch (trackedState) {
        case 'running':
          return { state: 'running', label: 'running', icon: '$(play)' };
        case 'killed':
          return { state: 'killed', label: 'killed', icon: '$(circle-slash)' };
        case 'terminated':
          return { state: 'terminated', label: 'terminated', icon: '$(check)' };
        case 'errored':
          return { state: 'errored', label: 'errored', icon: '$(error)' };
      }
    }

    if (terminal.exitStatus === undefined) {
      return { state: 'running', label: 'running', icon: '$(play)' };
    }
    if (terminal.exitStatus.code === undefined) {
      return { state: 'killed', label: 'killed', icon: '$(circle-slash)' };
    }
    if (terminal.exitStatus.code === 0) {
      return { state: 'terminated', label: 'terminated', icon: '$(check)' };
    }
    return { state: 'errored', label: 'errored', icon: '$(error)' };
  }

  const stateOrder: Record<'running' | 'terminated' | 'errored' | 'killed', number> = {
    errored: 0,
    killed: 1,
    terminated: 2,
    running: 3,
  };

  type TerminalItem = vscode.QuickPickItem & {
    terminal: vscode.Terminal;
    state: 'running' | 'terminated' | 'errored' | 'killed';
  };

  const terminals = [...extensionTerminals].sort((a, b) => {
    const sa = getTerminalState(a);
    const sb = getTerminalState(b);
    return stateOrder[sa.state] - stateOrder[sb.state];
  });

  const terminalItems: TerminalItem[] = terminals.map((t) => {
    const { state, label, icon } = getTerminalState(t);
    return {
      label: `${icon} ${t.name}`,
      description: label,
      terminal: t,
      state,
    };
  });

  const qp = vscode.window.createQuickPick<TerminalItem>();
  qp.items = terminalItems;
  qp.canSelectMany = true;
  qp.placeholder = 'Search and select terminals to close...';
  qp.title = 'Close Terminals';
  // Pre-select finished (non-running) terminals
  qp.selectedItems = terminalItems.filter((i) => i.state !== 'running');

  const chosen = await new Promise<TerminalItem[]>((resolve) => {
    qp.onDidAccept(() => {
      resolve([...qp.selectedItems]);
      qp.hide();
    });
    qp.onDidHide(() => resolve([]));
    qp.show();
  });
  qp.dispose();

  for (const item of chosen) {
    item.terminal.dispose();
    extensionTerminals.delete(item.terminal);
  }

  if (chosen.length > 0) {
    vscode.window.showInformationMessage(
      `Closed ${chosen.length} terminal${chosen.length > 1 ? 's' : ''}.`,
    );
  }
}

// ── Update packages ───────────────────────────────────────────────────────────

export async function spawnNg(args: string[], cwd: string): Promise<number> {
  const ngCommand = resolveAngularCliSpawn(cwd, args);
  ngOutput.appendLine(`> ${ngCommand.displayCommand}\n`);
  const { exitCode } = await spawnManaged(ngCommand.command, ngCommand.args, {
    cwd,
    shell: ngCommand.shell,
    onStdout: (t) => ngOutput.append(t),
    onStderr: (t) => ngOutput.append(t),
  });
  return exitCode;
}

export async function runNgUpdate(
  packages: string[],
  allowDirty: boolean,
  force: boolean,
  workspaceRoot: string,
) {
  const args = ['update', ...packages];
  if (allowDirty) {
    args.push('--allow-dirty');
  }
  if (force) {
    args.push('--force');
  }

  ngOutput.clear();
  ngOutput.show(true);

  const exitCode = await spawnNg(args, workspaceRoot);

  if (exitCode === 0) {
    vscode.window.showInformationMessage('ng update completed successfully.');
    return;
  }

  if (!force) {
    const action = await vscode.window.showErrorMessage(
      'ng update failed. Try with --force?',
      'Run with --force',
    );
    if (action === 'Run with --force') {
      await runNgUpdate(packages, allowDirty, true, workspaceRoot);
    }
  } else {
    vscode.window.showErrorMessage(
      "ng update --force also failed. Check the 'Angular CLI Plus: ng' output for details.",
    );
  }
}

// ── Run npm script ────────────────────────────────────────────────────────────

export async function runNpmScript() {
  const workspaceRoot = await pickWorkspaceFolder();
  if (!workspaceRoot) {
    return;
  }

  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    vscode.window.showErrorMessage('No package.json found in the workspace root.');
    return;
  }

  let pkgJson: { scripts?: Record<string, string> };
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    vscode.window.showErrorMessage('Failed to parse package.json.');
    return;
  }

  const scripts = pkgJson.scripts;
  if (!scripts || Object.keys(scripts).length === 0) {
    vscode.window.showInformationMessage('No npm scripts found in package.json.');
    return;
  }

  const items: vscode.QuickPickItem[] = Object.entries(scripts).map(([name, cmd]) => ({
    label: name,
    description: cmd,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an npm script to run',
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }

  const terminalName = `npm: ${picked.label}`;
  await runInTerminal(terminalName, `npm run ${picked.label}`, workspaceRoot);
}

// ── Signal Graph ──────────────────────────────────────────────────────────────

export async function showSignalGraph(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Angular: Show Signal Graph — no active editor.');
    return;
  }

  const filePath = editor.document.uri.fsPath;
  if (!filePath.endsWith('.ts')) {
    vscode.window.showErrorMessage('Angular: Show Signal Graph — please open a TypeScript file.');
    return;
  }

  const data = analyzeSignalsInFile(filePath);
  if (!data || data.nodes.length === 0) {
    vscode.window.showInformationMessage(
      'No Angular signals found in the current file. Make sure the file contains signal(), input(), computed(), effect(), or output() calls.',
    );
    return;
  }

  showSignalGraphWebview(data);
}
