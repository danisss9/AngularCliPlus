import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as cp from 'child_process';

const npmOutput = vscode.window.createOutputChannel('ng Generate: npm');
const ngOutput = vscode.window.createOutputChannel('ng Generate: ng');

interface ServeEntry {
  terminal: vscode.Terminal;
  command: string;
  cwd: string;
}

const activeServeTerminals = new Map<string, ServeEntry>();
const depCheckTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

interface GenerateOptions {
  [key: string]: boolean | string;
}

interface AngularProject {
  root?: string;
  sourceRoot?: string;
  projectType?: string;
  architect?: {
    serve?: {
      options?: {
        port?: number;
      };
    };
    test?: Record<string, unknown>;
  };
}

interface AngularJson {
  projects?: { [name: string]: AngularProject };
  defaultProject?: string;
}

type SchematicType =
  | 'component'
  | 'service'
  | 'module'
  | 'directive'
  | 'pipe'
  | 'guard'
  | 'interceptor'
  | 'class'
  | 'interface'
  | 'enum'
  | 'resolver';

export function activate(context: vscode.ExtensionContext) {
  // Register commands for each schematic type
  const schematics: SchematicType[] = [
    'component',
    'service',
    'module',
    'directive',
    'pipe',
    'guard',
    'interceptor',
    'class',
    'interface',
    'enum',
    'resolver',
  ];

  schematics.forEach((schematic) => {
    const disposable = vscode.commands.registerCommand(
      `ng-generate.${schematic}`,
      (uri: vscode.Uri) => generatengSchematic(schematic, uri),
    );
    context.subscriptions.push(disposable);
  });

  const debugDisposable = vscode.commands.registerCommand('ng-generate.debugAngular', () =>
    debugAngularProject(context),
  );
  context.subscriptions.push(debugDisposable);

  const serveDisposable = vscode.commands.registerCommand('ng-generate.serveAngular', () =>
    serveAngularProject(),
  );
  context.subscriptions.push(serveDisposable);

  const buildDisposable = vscode.commands.registerCommand('ng-generate.buildAngular', () =>
    buildAngularProject(),
  );
  context.subscriptions.push(buildDisposable);

  const buildWatchDisposable = vscode.commands.registerCommand(
    'ng-generate.buildAngularWatch',
    () => buildAngularProjectWatch(),
  );
  context.subscriptions.push(buildWatchDisposable);

  const restartDisposable = vscode.commands.registerCommand('ng-generate.restartAngularServe', () =>
    restartAngularServe(),
  );
  context.subscriptions.push(restartDisposable);

  const testDisposable = vscode.commands.registerCommand('ng-generate.testAngular', () =>
    testAngularProject(),
  );
  context.subscriptions.push(testDisposable);

  const lintDisposable = vscode.commands.registerCommand('ng-generate.lintAngular', () =>
    lintAngularProject(),
  );
  context.subscriptions.push(lintDisposable);

  const updateDisposable = vscode.commands.registerCommand('ng-generate.updateAngular', () =>
    updateAngularPackages(),
  );
  context.subscriptions.push(updateDisposable);

  context.subscriptions.push(
    vscode.commands.registerCommand('ng-generate.npmInstall', () => runNpmInstall(false)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('ng-generate.npmCleanInstall', () => runNpmInstall(true)),
  );

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    setupDependencyCheck(context, folder.uri.fsPath);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.added) {
        setupDependencyCheck(context, folder.uri.fsPath);
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      for (const [key, entry] of activeServeTerminals) {
        if (entry.terminal === closed) {
          activeServeTerminals.delete(key);
          break;
        }
      }
    }),
  );

  context.subscriptions.push(npmOutput);
  context.subscriptions.push(ngOutput);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ngGenerate.checkDependencies.enabled')) {
        const enabled = vscode.workspace
          .getConfiguration('ngGenerate')
          .get<boolean>('checkDependencies.enabled', true);
        if (enabled) {
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            scheduleDependencyCheck(folder.uri.fsPath, 500);
          }
        } else {
          for (const [key, timeout] of depCheckTimeouts) {
            clearTimeout(timeout);
            depCheckTimeouts.delete(key);
          }
        }
      }
    }),
  );
}

async function generatengSchematic(schematic: SchematicType, uri: vscode.Uri) {
  // Get the folder path
  const folderPath = uri.fsPath;

  // Prompt for name
  const name = await vscode.window.showInputBox({
    prompt: `Enter the name for the ${schematic}`,
    placeHolder: `my-${schematic}`,
    validateInput: (value) => {
      if (!value || value.trim() === '') {
        return 'Name cannot be empty';
      }
      if (!/^[a-z][a-z0-9-]*$/.test(value)) {
        return 'Name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens';
      }
      return null;
    },
  });

  if (!name) {
    return; // User cancelled
  }

  // Get workspace root
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Could not determine workspace folder');
    return;
  }

  // Detect project from angular.json based on the selected folder
  const detectedProject = await detectAngularProject(folderPath, workspaceFolder.uri.fsPath);

  if (detectedProject === null) {
    return; // User cancelled the quick pick or free-text input
  }

  // Get configuration options
  const config = vscode.workspace.getConfiguration('ngGenerate');
  const options = getOptionsForSchematic(schematic, config);

  // Add project option if provided
  if (detectedProject && detectedProject.trim() !== '') {
    options.project = detectedProject.trim();
  }

  // Build the ng generate command
  const command = buildNgGenerateCommand(schematic, name, options);

  // Build final command with just the name (Angular CLI will use cwd)
  const finalCommand = `${command} ${name}`;

  // Create and show terminal with cwd set to the selected folder
  const terminal = vscode.window.createTerminal({
    name: `ng Generate ${schematic}`,
    cwd: folderPath,
  });

  terminal.show();
  terminal.sendText(finalCommand);

  vscode.window.showInformationMessage(`Generating ${schematic}: ${name}`);
}

/**
 * Reads angular.json from the workspace root and returns the project name
 * that contains the selected folder.
 *
 * Returns:
 *   - A project name string if one was selected/auto-detected
 *   - An empty string if the user wants the default project
 *   - null if the user cancelled
 */
async function detectAngularProject(
  selectedFolderPath: string,
  workspaceRoot: string,
): Promise<string | null> {
  // Locate angular.json
  const angularJsonPath = path.join(workspaceRoot, 'angular.json');

  if (!fs.existsSync(angularJsonPath)) {
    // No angular.json found – fall back to free-text input
    return promptForProjectName();
  }

  let angularJson: AngularJson;
  try {
    const raw = fs.readFileSync(angularJsonPath, 'utf-8');
    angularJson = JSON.parse(raw) as AngularJson;
  } catch {
    // Malformed angular.json – fall back to free-text input
    return promptForProjectName();
  }

  const projects = angularJson.projects ?? {};
  const projectNames = Object.keys(projects);

  if (projectNames.length === 0) {
    return promptForProjectName();
  }

  // Normalise the selected folder to an absolute path with a trailing separator
  const normalised = selectedFolderPath.endsWith(path.sep)
    ? selectedFolderPath
    : selectedFolderPath + path.sep;

  // Find projects whose root or sourceRoot contains the selected folder
  const matching = projectNames.filter((name) => {
    const project = projects[name];
    const roots = [project.root, project.sourceRoot].filter(Boolean) as string[];

    return roots.some((r) => {
      const absRoot = path.isAbsolute(r) ? r : path.join(workspaceRoot, r);
      const absRootNormalised = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
      // The selected folder is inside this project root (or is the root itself)
      return normalised.startsWith(absRootNormalised) || normalised === absRootNormalised;
    });
  });

  if (matching.length === 1) {
    // Exactly one match – use it automatically
    vscode.window.showInformationMessage(`Using Angular project: ${matching[0]}`);
    return matching[0];
  }

  if (matching.length > 1) {
    // Multiple matches – let the user choose
    const picked = await vscode.window.showQuickPick(matching, {
      placeHolder: 'Select the Angular project',
      title: 'Multiple Angular projects contain this folder',
    });
    // showQuickPick returns undefined when the user presses Escape
    return picked ?? null;
  }

  // No matching projects – ask the user to type the name
  return promptForProjectName();
}

/** Shows a free-text input for the project name. Returns null when cancelled. */
async function promptForProjectName(): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    prompt: 'Enter the project name (optional)',
    placeHolder: 'Leave empty to use default project',
  });
  // undefined means the user pressed Escape (cancel)
  return value === undefined ? null : value;
}

function getOptionsForSchematic(
  schematic: SchematicType,
  config: vscode.WorkspaceConfiguration,
): GenerateOptions {
  const options: GenerateOptions = {};
  const schematicConfig = config.get<any>(schematic);

  if (schematicConfig) {
    Object.keys(schematicConfig).forEach((key) => {
      const value = schematicConfig[key];
      if (value !== undefined && value !== null) {
        options[key] = value;
      }
    });
  }

  return options;
}

function buildNgGenerateCommand(
  schematic: SchematicType,
  name: string,
  options: GenerateOptions,
): string {
  let command = `ng generate ${schematic}`;

  // Add options as flags
  Object.keys(options).forEach((key) => {
    const value = options[key];
    const kebabKey = toKebabCase(key);

    if (typeof value === 'boolean') {
      if (value === true) {
        command += ` --${kebabKey}`;
      } else {
        command += ` --${kebabKey}=false`;
      }
    } else if (typeof value === 'string') {
      command += ` --${kebabKey}=${value}`;
    }
  });

  return command;
}

function toKebabCase(str: string): string {
  return str.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function resolveWorkspaceAndAngularJson(): Promise<{
  workspaceFolder: vscode.WorkspaceFolder;
  workspaceRoot: string;
  projects: { [name: string]: AngularProject };
} | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return null;
  }

  let workspaceFolder: vscode.WorkspaceFolder;
  if (workspaceFolders.length === 1) {
    workspaceFolder = workspaceFolders[0];
  } else {
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Select workspace folder',
    });
    if (!picked) {
      return null;
    }
    workspaceFolder = picked;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const angularJsonPath = path.join(workspaceRoot, 'angular.json');

  if (!fs.existsSync(angularJsonPath)) {
    vscode.window.showErrorMessage('No angular.json found in workspace root');
    return null;
  }

  let angularJson: AngularJson;
  try {
    angularJson = JSON.parse(fs.readFileSync(angularJsonPath, 'utf-8')) as AngularJson;
  } catch {
    vscode.window.showErrorMessage('Failed to parse angular.json');
    return null;
  }

  return { workspaceFolder, workspaceRoot, projects: angularJson.projects ?? {} };
}

async function pickProject(projectNames: string[], title: string): Promise<string | null> {
  if (projectNames.length === 0) {
    vscode.window.showErrorMessage('No projects found in angular.json');
    return null;
  }
  if (projectNames.length === 1) {
    return projectNames[0];
  }
  const picked = await vscode.window.showQuickPick(projectNames, {
    placeHolder: 'Select Angular project',
    title,
  });
  return picked ?? null;
}

function detectActiveFileProject(
  workspaceRoot: string,
  projects: { [name: string]: AngularProject },
): string | null {
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!activeFile) return null;

  const fileDir = path.dirname(activeFile);
  const fileDirNorm = fileDir.endsWith(path.sep) ? fileDir : fileDir + path.sep;

  let bestMatch: { name: string; rootLen: number } | null = null;
  for (const [name, project] of Object.entries(projects)) {
    const roots = [project.root, project.sourceRoot].filter(Boolean) as string[];
    for (const r of roots) {
      const absRoot = path.isAbsolute(r) ? r : path.join(workspaceRoot, r);
      const absRootNorm = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
      if (fileDirNorm.startsWith(absRootNorm)) {
        if (!bestMatch || absRootNorm.length > bestMatch.rootLen) {
          bestMatch = { name, rootLen: absRootNorm.length };
        }
      }
    }
  }
  return bestMatch?.name ?? null;
}

async function pickProjectWithCurrentFile(
  workspaceRoot: string,
  projects: { [name: string]: AngularProject },
  projectNames: string[],
  title: string,
): Promise<string | null> {
  if (projectNames.length === 0) {
    vscode.window.showErrorMessage('No projects found in angular.json');
    return null;
  }
  if (projectNames.length === 1) {
    return projectNames[0];
  }

  const current = detectActiveFileProject(workspaceRoot, projects);
  const currentInList = current && projectNames.includes(current) ? current : null;
  const CURRENT_LABEL = currentInList ? `$(file)  Current project (${currentInList})` : null;

  const choices = [...(CURRENT_LABEL ? [CURRENT_LABEL] : []), ...projectNames];
  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select Angular project',
    title,
  });
  if (!picked) return null;
  if (CURRENT_LABEL && picked === CURRENT_LABEL) return currentInList!;
  return picked;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function serveAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const appProjects = Object.entries(projects)
    .filter(([, p]) => !p.projectType || p.projectType === 'application')
    .map(([n]) => n);

  const projectName = await pickProjectWithCurrentFile(workspaceRoot, projects, appProjects, 'Angular Serve: Select Project');
  if (!projectName) {
    return;
  }

  const serveCommand = `ng serve --project ${projectName}`;
  const terminalName = `ng serve (${projectName})`;
  const terminal = vscode.window.createTerminal({ name: terminalName, cwd: workspaceRoot });
  activeServeTerminals.set(terminalName, { terminal, command: serveCommand, cwd: workspaceRoot });
  terminal.show();
  terminal.sendText(serveCommand);
}

async function testAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  // Include only projects that have a test architect configured, plus an "All" option
  const testableProjects = Object.entries(projects)
    .filter(([, p]) => p.architect?.test !== undefined)
    .map(([n]) => n);

  if (testableProjects.length === 0) {
    vscode.window.showWarningMessage('No projects with a test architect found in angular.json.');
    return;
  }

  const ALL_PROJECTS = '$(list-flat)  All projects';

  // Check if the currently focused tab is a *.spec.ts file
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const isSpecFile = activeFile?.endsWith('.spec.ts') ?? false;
  const CURRENT_FILE = '$(file)  Run current test file';

  const currentProject = detectActiveFileProject(workspaceRoot, projects);
  const currentInTestable = currentProject && testableProjects.includes(currentProject) ? currentProject : null;
  const CURRENT_PROJECT_LABEL = currentInTestable ? `$(file)  Current project (${currentInTestable})` : null;

  const choices = [
    ...(isSpecFile ? [CURRENT_FILE] : []),
    ...(CURRENT_PROJECT_LABEL ? [CURRENT_PROJECT_LABEL] : []),
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

  const config = vscode.workspace.getConfiguration('ngGenerate');
  const watchMode = config.get<boolean>('test.watch', false);
  const watchFlag = watchMode ? ' --watch' : ' --watch=false';
  const uiMode = config.get<boolean>('test.ui', false);
  const uiFlag = uiMode ? ' --ui' : '';

  if (picked === CURRENT_FILE && activeFile) {
    // Path relative to workspace root, forward slashes for the CLI glob
    const relPath = path.relative(workspaceRoot, activeFile).replaceAll(path.sep, '/');
    testCommand = `ng test --include ${relPath}${watchFlag}${uiFlag}`;
    terminalName = `ng test (${path.basename(activeFile)})`;
  } else if (CURRENT_PROJECT_LABEL && picked === CURRENT_PROJECT_LABEL) {
    testCommand = `ng test --project ${currentInTestable}${watchFlag}${uiFlag}`;
    terminalName = `ng test (${currentInTestable})`;
  } else if (picked === ALL_PROJECTS) {
    testCommand = `ng test${watchFlag}${uiFlag}`;
    terminalName = 'ng test (all)';
  } else {
    testCommand = `ng test --project ${picked}${watchFlag}${uiFlag}`;
    terminalName = `ng test (${picked})`;
  }

  const terminal = vscode.window.createTerminal({ name: terminalName, cwd: workspaceRoot });
  terminal.show();
  terminal.sendText(testCommand);
}

async function lintAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const allProjects = Object.keys(projects);
  const projectName = await pickProjectWithCurrentFile(workspaceRoot, projects, allProjects, 'Angular Lint: Select Project');
  if (!projectName) {
    return;
  }

  const terminalName = `ng lint (${projectName})`;
  const lintCommand = `ng lint --project ${projectName}`;
  const terminal = vscode.window.createTerminal({ name: terminalName, cwd: workspaceRoot });
  terminal.show();
  terminal.sendText(lintCommand);
}

async function buildAngularProject() {
  await runNgBuild(false);
}

async function buildAngularProjectWatch() {
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
  const projectName = await pickProjectWithCurrentFile(workspaceRoot, projects, allProjects, title);
  if (!projectName) {
    return;
  }

  const config = vscode.workspace.getConfiguration('ngGenerate');
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
  const buildCommand = `ng build --project ${projectName}${configFlag}${watchFlag}`;
  const terminal = vscode.window.createTerminal({ name: terminalName, cwd: workspaceRoot });
  if (watch) {
    activeServeTerminals.set(terminalName, { terminal, command: buildCommand, cwd: workspaceRoot });
  }
  terminal.show();
  terminal.sendText(buildCommand);
}

async function debugAngularProject(context: vscode.ExtensionContext) {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceFolder, workspaceRoot, projects } = resolved;

  const appProjects = Object.entries(projects)
    .filter(([, p]) => !p.projectType || p.projectType === 'application')
    .map(([n]) => n);

  const projectName = await pickProjectWithCurrentFile(workspaceRoot, projects, appProjects, 'Angular Debug: Select Project');
  if (!projectName) {
    return;
  }

  const port = projects[projectName]?.architect?.serve?.options?.port ?? 4200;

  const config = vscode.workspace.getConfiguration('ngGenerate');
  const browserSetting = config.get<string>('debug.browser', 'chrome');
  const browserType = browserSetting === 'edge' ? 'msedge' : 'chrome';
  const sessionName = `Angular Debug (${projectName})`;

  const serveCommand = `ng serve --project ${projectName}`;
  const serveTerminalName = `ng serve (${projectName})`;
  const terminal = vscode.window.createTerminal({ name: serveTerminalName, cwd: workspaceRoot });
  activeServeTerminals.set(serveTerminalName, {
    terminal,
    command: serveCommand,
    cwd: workspaceRoot,
  });
  terminal.show();
  terminal.sendText(serveCommand);

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Starting ng serve for "${projectName}" on port ${port}…`,
      cancellable: true,
    },
    async (progress, token) => {
      const ready = await waitForPort(port, 600_000, token);

      if (token.isCancellationRequested) {
        terminal.sendText('\x03');
        terminal.dispose();
        return;
      }

      if (!ready) {
        vscode.window.showErrorMessage(
          `ng serve did not become ready on port ${port} within 10 minutes`,
        );
        terminal.sendText('\x03');
        terminal.dispose();
        return;
      }

      progress.report({ message: 'Server ready — launching debugger…' });

      let targetSession: vscode.DebugSession | undefined;

      const startListener = vscode.debug.onDidStartDebugSession((session) => {
        if (session.name === sessionName) {
          targetSession = session;
          startListener.dispose();
        }
      });
      context.subscriptions.push(startListener);

      const started = await vscode.debug.startDebugging(workspaceFolder, {
        type: browserType,
        request: 'launch',
        name: sessionName,
        url: `http://localhost:${port}`,
        webRoot: '${workspaceFolder}',
      });

      if (!started) {
        startListener.dispose();
        vscode.window.showErrorMessage(
          `Failed to start debug session. Make sure the ${browserSetting} debugger is available in VS Code.`,
        );
        terminal.sendText('\x03');
        terminal.dispose();
        return;
      }

      const endListener = vscode.debug.onDidTerminateDebugSession((session) => {
        if (targetSession && session.id === targetSession.id) {
          terminal.sendText('\x03');
          setTimeout(() => terminal.dispose(), 2000);
          endListener.dispose();
        }
      });
      context.subscriptions.push(endListener);
    },
  );
}

async function runNpmInstall(clean: boolean, force = false, workspaceRoot?: string) {
  if (!workspaceRoot) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    let workspaceFolder: vscode.WorkspaceFolder;
    if (workspaceFolders.length === 1) {
      workspaceFolder = workspaceFolders[0];
    } else {
      const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: 'Select workspace folder',
      });
      if (!picked) {
        return;
      }
      workspaceFolder = picked;
    }
    workspaceRoot = workspaceFolder.uri.fsPath;
  }

  npmOutput.clear();
  npmOutput.show(true);

  if (clean) {
    npmOutput.appendLine('Removing node_modules and package-lock.json…');
    try {
      await fs.promises.rm(path.join(workspaceRoot, 'node_modules'), {
        recursive: true,
        force: true,
      });
      await fs.promises.rm(path.join(workspaceRoot, 'package-lock.json'), { force: true });
      npmOutput.appendLine('Done.\n');
    } catch (err) {
      npmOutput.appendLine(`\nFailed to clean: ${err}`);
      vscode.window.showErrorMessage(`Failed to clean project: ${err}`);
      return;
    }
  }

  const args = force ? ['install', '--force'] : ['install'];
  const exitCode = await spawnNpm(args, workspaceRoot);

  if (exitCode === 0) {
    vscode.window.showInformationMessage('npm install completed successfully.');
    return;
  }

  if (!clean && !force) {
    const action = await vscode.window.showErrorMessage(
      'npm install failed. Try a clean install?',
      'Run Clean Install',
    );
    if (action === 'Run Clean Install') {
      await runNpmInstall(true, false, workspaceRoot);
    }
  } else if (clean && !force) {
    const action = await vscode.window.showErrorMessage(
      'Clean install failed. Try with --force?',
      'Run with --force',
    );
    if (action === 'Run with --force') {
      await runNpmInstall(false, true, workspaceRoot);
    }
  } else {
    vscode.window.showErrorMessage(
      'npm install --force also failed. Check the "ng Generate: npm" output for details.',
    );
  }
}

function spawnNpm(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    npmOutput.appendLine(`> npm ${args.join(' ')}\n`);
    const proc = cp.spawn('npm', args, { cwd, shell: true });
    proc.stdout.on('data', (d: Buffer) => npmOutput.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => npmOutput.append(d.toString()));
    proc.on('close', (code) => resolve(code ?? 1));
  });
}

function spawnNg(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    ngOutput.appendLine(`> ng ${args.join(' ')}
`);
    const proc = cp.spawn('ng', args, { cwd, shell: true });
    proc.stdout.on('data', (d: Buffer) => ngOutput.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => ngOutput.append(d.toString()));
    proc.on('close', (code) => resolve(code ?? 1));
  });
}

function spawnCapture(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    let out = '';
    const proc = cp.spawn(cmd, args, { cwd, shell: true });
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', (code) => resolve({ stdout: out, exitCode: code ?? 1 }));
  });
}

function parseNgUpdateOutput(output: string): Array<{ name: string; versions: string }> {
  const clean = output.replace(/\[[0-9;]*[mGKHF]/g, '');
  const results: Array<{ name: string; versions: string }> = [];
  for (const line of clean.split('
')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(@?[\w/.-]+)\s+(\S+\s*->\s*\S+)/);
    if (match) {
      results.push({ name: match[1], versions: match[2].replace(/\s+/g, ' ') });
    }
  }
  return results;
}

async function updateAngularPackages() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot } = resolved;

  let capturedOutput = '';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking for Angular package updates…', cancellable: false },
    async () => {
      const result = await spawnCapture('ng', ['update'], workspaceRoot);
      capturedOutput = result.stdout;
    },
  );

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

  const config = vscode.workspace.getConfiguration('ngGenerate');
  const allowDirty = config.get<boolean>('update.allowDirty', false);

  await runNgUpdate(selected.map((s) => s.label), allowDirty, false, workspaceRoot);
}

async function runNgUpdate(packages: string[], allowDirty: boolean, force: boolean, workspaceRoot: string) {
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
      "ng update --force also failed. Check the 'ng Generate: ng' output for details.",
    );
  }
}

async function restartAngularServe() {
  if (activeServeTerminals.size === 0) {
    vscode.window.showErrorMessage('No active ng serve / ng build --watch terminals found.');
    return;
  }

  let projectName: string;
  if (activeServeTerminals.size === 1) {
    projectName = [...activeServeTerminals.keys()][0];
  } else {
    const picked = await vscode.window.showQuickPick([...activeServeTerminals.keys()], {
      placeHolder: 'Select terminal to restart',
      title: 'Angular Restart',
    });
    if (!picked) {
      return;
    }
    projectName = picked;
  }

  const entry = activeServeTerminals.get(projectName)!;
  entry.terminal.show();
  entry.terminal.sendText('\x03');
  await new Promise<void>((r) => setTimeout(r, 300));
  entry.terminal.sendText('y');
  await new Promise<void>((r) => setTimeout(r, 700));
  entry.terminal.sendText(entry.command);
}

function waitForPort(
  port: number,
  timeout: number,
  token: vscode.CancellationToken,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;

    function attempt() {
      if (token.isCancellationRequested || Date.now() >= deadline) {
        resolve(false);
        return;
      }

      const socket = new net.Socket();
      socket.setTimeout(1000);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      const onFail = () => {
        socket.destroy();
        setTimeout(attempt, 1000);
      };

      socket.on('timeout', onFail);
      socket.on('error', onFail);
      socket.connect(port, 'localhost');
    }

    attempt();
  });
}

function setupDependencyCheck(context: vscode.ExtensionContext, workspaceRoot: string) {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return;
  }

  // Check shortly after startup (only if enabled)
  const config = vscode.workspace.getConfiguration('ngGenerate');
  if (config.get<boolean>('checkDependencies.enabled', true)) {
    scheduleDependencyCheck(workspaceRoot, 3000);
  }

  // Re-check whenever .git/HEAD changes (branch switch).
  // Use fs.watch directly because VS Code's file system watcher excludes .git/ by default.
  const gitHead = path.join(workspaceRoot, '.git', 'HEAD');
  if (fs.existsSync(gitHead)) {
    try {
      const fsWatcher = fs.watch(gitHead, () => scheduleDependencyCheck(workspaceRoot, 2000));
      context.subscriptions.push({ dispose: () => fsWatcher.close() });
    } catch {
      // fs.watch unavailable on this platform – fall back to VS Code watcher
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.join(workspaceRoot, '.git')), 'HEAD'),
      );
      watcher.onDidChange(() => scheduleDependencyCheck(workspaceRoot, 2000));
      context.subscriptions.push(watcher);
    }
  }

  // Re-check when package.json itself is saved (dependencies may have been edited manually)
  const pkgWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(workspaceRoot), 'package.json'),
  );
  pkgWatcher.onDidChange(() => scheduleDependencyCheck(workspaceRoot, 2000));
  context.subscriptions.push(pkgWatcher);
}

function scheduleDependencyCheck(workspaceRoot: string, delayMs: number) {
  const existing = depCheckTimeouts.get(workspaceRoot);
  if (existing) {
    clearTimeout(existing);
  }
  depCheckTimeouts.set(
    workspaceRoot,
    setTimeout(() => {
      depCheckTimeouts.delete(workspaceRoot);
      checkDependencies(workspaceRoot);
    }, delayMs),
  );
}

async function checkDependencies(workspaceRoot: string) {
  const config = vscode.workspace.getConfiguration('ngGenerate');
  if (!config.get<boolean>('checkDependencies.enabled', true)) {
    return;
  }

  const pkgPath = path.join(workspaceRoot, 'package.json');
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'));
  } catch {
    return;
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (Object.keys(allDeps).length === 0) {
    return;
  }

  // Fast-path: if node_modules doesn't exist at all
  const nmDir = path.join(workspaceRoot, 'node_modules');
  if (!fs.existsSync(nmDir)) {
    const action = await vscode.window.showWarningMessage(
      'node_modules not found. Run npm install?',
      'Run npm install',
    );
    if (action === 'Run npm install') {
      await runNpmInstall(false, false, workspaceRoot);
    }
    return;
  }

  const missing: string[] = [];
  const outdated: string[] = [];

  await Promise.all(
    Object.entries(allDeps).map(async ([name, required]) => {
      const nmPkg = path.join(nmDir, name, 'package.json');
      try {
        const { version } = JSON.parse(await fs.promises.readFile(nmPkg, 'utf-8'));
        if (!semverSatisfies(version as string, required)) {
          outdated.push(name);
        }
      } catch {
        missing.push(name);
      }
    }),
  );

  if (missing.length === 0 && outdated.length === 0) {
    return;
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${missing.length} package(s) missing`);
  }
  if (outdated.length > 0) {
    parts.push(`${outdated.length} package(s) outdated`);
  }

  const folderLabel =
    (vscode.workspace.workspaceFolders?.length ?? 0) > 1
      ? ` in ${path.basename(workspaceRoot)}`
      : '';

  const action = await vscode.window.showWarningMessage(
    `${parts.join(' and ')}${folderLabel}. Run npm install?`,
    'Run npm install',
  );
  if (action === 'Run npm install') {
    await runNpmInstall(false, false, workspaceRoot);
  }
}

function semverSatisfies(installed: string, required: string): boolean {
  const req = required.trim();
  if (!req || req === '*' || req === 'latest') {
    return true;
  }
  // Skip non-semver specs (git, file, workspace, URLs)
  if (/^(git|file:|workspace:|https?:|github:)/.test(req)) {
    return true;
  }

  const parseVer = (s: string): [number, number, number] => {
    const parts = s
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n) || 0);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };

  const cmp = (a: [number, number, number], b: [number, number, number]): number => {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] - b[2];
  };

  const iv = parseVer(installed);

  if (req.startsWith('^')) {
    const rv = parseVer(req.slice(1));
    if (rv[0] === 0 && rv[1] === 0) return iv[0] === 0 && iv[1] === 0 && iv[2] >= rv[2];
    if (rv[0] === 0) return iv[0] === 0 && iv[1] === rv[1] && iv[2] >= rv[2];
    return iv[0] === rv[0] && cmp(iv, rv) >= 0;
  }
  if (req.startsWith('~')) {
    const rv = parseVer(req.slice(1));
    return iv[0] === rv[0] && iv[1] === rv[1] && iv[2] >= rv[2];
  }
  if (req.startsWith('>=')) {
    return cmp(iv, parseVer(req.slice(2))) >= 0;
  }
  if (req.startsWith('>')) {
    return cmp(iv, parseVer(req.slice(1))) > 0;
  }
  if (req.startsWith('<=')) {
    return cmp(iv, parseVer(req.slice(2))) <= 0;
  }
  if (req.startsWith('<')) {
    return cmp(iv, parseVer(req.slice(1))) < 0;
  }

  // Exact (strip leading = or v)
  return cmp(iv, parseVer(req.replace(/^[=v]+/, ''))) === 0;
}

export function deactivate() {
  for (const timeout of depCheckTimeouts.values()) {
    clearTimeout(timeout);
  }
  depCheckTimeouts.clear();
}
