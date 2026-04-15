import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ngOutput, extensionTerminals } from './state';
import {
  resolveWorkspaceAndAngularJson,
  runInTerminal,
  pickProjectWithCurrentFile,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
  pickWorkspaceFolder,
} from './utils';
import { spawnCapture } from './dependencies';
import {
  parseNgUpdateOutput,
  parseComponentFilePath,
  getComponentSiblingPaths,
} from './pure-utils';

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

  const serveCommand = `ng serve --project "${projectName}"`;
  const terminalName = `ng serve (${projectName})`;
  runInTerminal(terminalName, serveCommand, workspaceRoot, { trackAsServe: true });
}

// ── Test ──────────────────────────────────────────────────────────────────────

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

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  const watchMode = config.get<boolean>('test.watch', false);
  const watchFlag = watchMode ? ' --watch' : ' --watch=false';
  const uiMode = config.get<boolean>('test.ui', false);
  const uiFlag = uiMode ? ' --ui' : '';

  if (picked === CURRENT_FILE && activeFile) {
    const relPath = path.relative(workspaceRoot, activeFile).replaceAll(path.sep, '/');
    testCommand = `ng test --include "${relPath}"${watchFlag}${uiFlag}`;
    terminalName = `ng test (${path.basename(activeFile)})`;
  } else if (CURRENT_PROJECT_LABEL && picked === CURRENT_PROJECT_LABEL) {
    setLastProject('test', currentInTestable!);
    testCommand = `ng test --project "${currentInTestable}"${watchFlag}${uiFlag}`;
    terminalName = `ng test (${currentInTestable})`;
  } else if (LAST_LABEL && picked === LAST_LABEL) {
    testCommand = `ng test --project "${lastInTestable}"${watchFlag}${uiFlag}`;
    terminalName = `ng test (${lastInTestable})`;
  } else if (picked === ALL_PROJECTS) {
    testCommand = `ng test${watchFlag}${uiFlag}`;
    terminalName = 'ng test (all)';
  } else {
    setLastProject('test', picked);
    testCommand = `ng test --project "${picked}"${watchFlag}${uiFlag}`;
    terminalName = `ng test (${picked})`;
  }

  runInTerminal(terminalName, testCommand, workspaceRoot, {
    successMessage: watchMode ? undefined : `${terminalName} completed successfully.`,
    retryLabel: watchMode ? undefined : 'Retry',
  });
}

// ── Lint ──────────────────────────────────────────────────────────────────────

export async function lintAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const allProjects = Object.keys(projects);
  const projectName = await pickProjectWithCurrentFile(
    workspaceRoot,
    projects,
    allProjects,
    'Angular Lint: Select Project',
    'lint',
  );
  if (!projectName) {
    return;
  }

  const terminalName = `ng lint (${projectName})`;
  const lintCommand = `ng lint --project "${projectName}"`;
  runInTerminal(terminalName, lintCommand, workspaceRoot, {
    successMessage: `ng lint (${projectName}) completed successfully.`,
    retryLabel: 'Retry',
  });
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
  const configFlag = effectiveConfig !== 'default' ? ` --configuration=${effectiveConfig}` : '';
  const watchFlag = watch ? ' --watch' : '';

  const terminalName = watch ? `ng build --watch (${projectName})` : `ng build (${projectName})`;
  const buildCommand = `ng build --project "${projectName}"${configFlag}${watchFlag}`;
  runInTerminal(terminalName, buildCommand, workspaceRoot, {
    trackAsServe: watch,
    successMessage: watch ? undefined : `ng build (${projectName}) completed successfully.`,
    retryLabel: watch ? undefined : 'Retry',
  });
}

// ── Clear terminals ───────────────────────────────────────────────────────────

export async function clearFinishedTerminals() {
  if (extensionTerminals.size === 0) {
    vscode.window.showInformationMessage('No extension terminals to close.');
    return;
  }

  type TerminalState = 'running' | 'terminated' | 'errored' | 'killed';

  function getTerminalState(terminal: vscode.Terminal): {
    state: TerminalState;
    label: string;
    icon: string;
  } {
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

  const stateOrder: Record<TerminalState, number> = {
    errored: 0,
    killed: 1,
    terminated: 2,
    running: 3,
  };

  type TerminalItem = vscode.QuickPickItem & { terminal: vscode.Terminal; state: TerminalState };

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

export function spawnNg(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    ngOutput.appendLine(`> ng ${args.join(' ')}\n`);
    const proc = cp.spawn('ng', args, { cwd, shell: true });
    proc.stdout.on('data', (d: Buffer) => ngOutput.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => ngOutput.append(d.toString()));
    proc.on('error', (err) => {
      ngOutput.appendLine(`Failed to start process: ${err.message}`);
      resolve(1);
    });
    proc.on('close', (code) => resolve(code ?? 1));
  });
}

export async function updateAngularPackages() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot } = resolved;

  let capturedOutput = '';
  let checkExitCode = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Checking for Angular package updates…',
      cancellable: false,
    },
    async () => {
      const result = await spawnCapture('ng', ['update'], workspaceRoot);
      capturedOutput = result.stdout;
      checkExitCode = result.exitCode;
    },
  );

  if (checkExitCode !== 0) {
    ngOutput.clear();
    ngOutput.appendLine(capturedOutput);
    ngOutput.show(true);
    vscode.window.showErrorMessage(
      "Failed to check for Angular updates. See 'Angular CLI Plus: ng' output for details.",
    );
    return;
  }

  const packages = parseNgUpdateOutput(capturedOutput);
  if (packages.length === 0) {
    vscode.window.showInformationMessage('All Angular packages are up to date.');
    return;
  }

  const items = packages.map((p) => ({ label: p.name, description: p.versions, picked: false }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select packages to update',
    title: 'Angular Update: Select Packages',
  });

  if (!selected || selected.length === 0) {
    return;
  }

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  const allowDirty = config.get<boolean>('update.allowDirty', false);

  await runNgUpdate(
    selected.map((s) => s.label),
    allowDirty,
    false,
    workspaceRoot,
  );
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
