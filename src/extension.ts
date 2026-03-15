import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as cp from 'child_process';

const npmOutput = vscode.window.createOutputChannel('Angular CLI Plus: npm');
const ngOutput = vscode.window.createOutputChannel('Angular CLI Plus: ng');

let extensionContext: vscode.ExtensionContext;

interface DebugConfig {
  workspaceFolder: vscode.WorkspaceFolder;
  port: number;
  sessionName: string;
  browserSetting: string;
  browserDebugConfig: BrowserDebugConfig;
}

interface ServeEntry {
  terminal: vscode.Terminal;
  command: string;
  cwd: string;
  debugConfig?: DebugConfig;
  activeDebugSession?: vscode.DebugSession;
}

const activeServeTerminals = new Map<string, ServeEntry>();
const extensionTerminals = new Set<vscode.Terminal>();
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
    storybook?: {
      options?: {
        port?: number;
      };
    };
    build?: {
      options?: {
        outputPath?: string | { base?: string; browser?: string };
      };
    };
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
  extensionContext = context;

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
      `angular-cli-plus.${schematic}`,
      (uri: vscode.Uri) => generatengSchematic(schematic, uri),
    );
    context.subscriptions.push(disposable);
  });

  const debugDisposable = vscode.commands.registerCommand('angular-cli-plus.debugAngular', () =>
    debugAngularProject(context),
  );
  context.subscriptions.push(debugDisposable);

  context.subscriptions.push(
    vscode.commands.registerCommand('angular-cli-plus.debugStorybook', () => debugStorybookProject(context)),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('angular-cli-plus.debugBuildWatch', () => debugBuildWatchProject(context)),
  );

  const serveDisposable = vscode.commands.registerCommand('angular-cli-plus.serveAngular', () =>
    serveAngularProject(),
  );
  context.subscriptions.push(serveDisposable);

  const buildDisposable = vscode.commands.registerCommand('angular-cli-plus.buildAngular', () =>
    buildAngularProject(),
  );
  context.subscriptions.push(buildDisposable);

  const buildWatchDisposable = vscode.commands.registerCommand(
    'angular-cli-plus.buildAngularWatch',
    () => buildAngularProjectWatch(),
  );
  context.subscriptions.push(buildWatchDisposable);

  const restartDisposable = vscode.commands.registerCommand('angular-cli-plus.restartAngularServe', () =>
    restartAngularServe(context),
  );
  context.subscriptions.push(restartDisposable);

  const testDisposable = vscode.commands.registerCommand('angular-cli-plus.testAngular', () =>
    testAngularProject(),
  );
  context.subscriptions.push(testDisposable);

  const lintDisposable = vscode.commands.registerCommand('angular-cli-plus.lintAngular', () =>
    lintAngularProject(),
  );
  context.subscriptions.push(lintDisposable);

  const updateDisposable = vscode.commands.registerCommand('angular-cli-plus.updateAngular', () =>
    updateAngularPackages(),
  );
  context.subscriptions.push(updateDisposable);

  context.subscriptions.push(
    vscode.commands.registerCommand('angular-cli-plus.clearTerminals', () => clearFinishedTerminals()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('angular-cli-plus.npmInstall', () => runNpmInstall(false)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('angular-cli-plus.npmCleanInstall', () => runNpmInstall(true)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('angular-cli-plus.checkDependencies', () => runCheckDependencies()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('angular-cli-plus.checkToolVersions', () => runCheckToolVersions()),
  );

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    setupDependencyCheck(context, folder.uri.fsPath);
    checkToolVersions(folder.uri.fsPath);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.added) {
        setupDependencyCheck(context, folder.uri.fsPath);
        checkToolVersions(folder.uri.fsPath);
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
      if (e.affectsConfiguration('angularCliPlus.checkToolVersions.enabled')) {
        const tvEnabled = vscode.workspace
          .getConfiguration('angularCliPlus')
          .get<boolean>('checkToolVersions.enabled', true);
        if (tvEnabled) {
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            checkToolVersions(folder.uri.fsPath);
          }
        }
      }
      if (e.affectsConfiguration('angularCliPlus.checkDependencies.enabled')) {
        const enabled = vscode.workspace
          .getConfiguration('angularCliPlus')
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
  const config = vscode.workspace.getConfiguration('angularCliPlus');
  const options = getOptionsForSchematic(schematic, config);

  // Add project option if provided
  if (detectedProject && detectedProject.trim() !== '') {
    options.project = detectedProject.trim();
  }

  // Build the ng generate command
  const command = buildNgGenerateCommand(schematic, name, options);

  // Build final command with just the name (Angular CLI will use cwd)
  const finalCommand = `${command} ${name}`;

  runInTerminal(`Angular CLI Plus: ${schematic}`, finalCommand, folderPath, {
    successMessage: `${schematic} "${name}" generated successfully.`,
  });
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

function getLastProject(commandKey: string): string | undefined {
  return extensionContext.globalState.get<string>(`lastProject.${commandKey}`);
}

function setLastProject(commandKey: string, project: string): void {
  void extensionContext.globalState.update(`lastProject.${commandKey}`, project);
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
  commandKey?: string,
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

  const last = commandKey ? getLastProject(commandKey) : undefined;
  const lastInList = last && projectNames.includes(last) && last !== currentInList ? last : null;
  const LAST_LABEL = lastInList ? `$(history)  Last used (${lastInList})` : null;

  const choices = [
    ...(CURRENT_LABEL ? [CURRENT_LABEL] : []),
    ...(LAST_LABEL ? [LAST_LABEL] : []),
    ...projectNames,
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select Angular project',
    title,
  });
  if (!picked) return null;
  if (CURRENT_LABEL && picked === CURRENT_LABEL) {
    if (commandKey) { setLastProject(commandKey, currentInList!); }
    return currentInList!;
  }
  if (LAST_LABEL && picked === LAST_LABEL) {
    return lastInList!;
  }
  if (commandKey) { setLastProject(commandKey, picked); }
  return picked;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a terminal, runs a command, and shows a success notification on exit
 * code 0 or a warning notification with an optional Retry button on non-zero
 * exit. When `retryLabel` is set and no `onRetry` handler is provided, the
 * exact same command is re-launched automatically.
 */
function runInTerminal(
  name: string,
  command: string,
  cwd: string,
  options?: {
    trackAsServe?: boolean;
    successMessage?: string;
    retryLabel?: string;
    onRetry?: () => void;
  },
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name, cwd });
  extensionTerminals.add(terminal);
  if (options?.trackAsServe) {
    activeServeTerminals.set(name, { terminal, command, cwd });
  }
  terminal.show();
  terminal.sendText(command);

  const disposable = vscode.window.onDidCloseTerminal(async (closed) => {
    if (closed !== terminal) {
      return;
    }
    disposable.dispose();
    extensionTerminals.delete(closed);

    const code = closed.exitStatus?.code;
    if (code === undefined) {
      return; // terminal was killed without a proper exit (e.g. user closed the tab mid-run)
    }

    if (code === 0) {
      if (options?.successMessage) {
        vscode.window.showInformationMessage(options.successMessage);
      }
    } else {
      const retryLabel = options?.retryLabel;
      if (retryLabel) {
        const action = await vscode.window.showWarningMessage(`${name} failed (exit code ${code}).`, retryLabel);
        if (action === retryLabel) {
          if (options.onRetry) {
            options.onRetry();
          } else {
            runInTerminal(name, command, cwd, options);
          }
        }
      } else {
        vscode.window.showWarningMessage(`${name} failed (exit code ${code}).`);
      }
    }
  });

  return terminal;
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

  const projectName = await pickProjectWithCurrentFile(workspaceRoot, projects, appProjects, 'Angular Serve: Select Project', 'serve');
  if (!projectName) {
    return;
  }

  const serveCommand = `ng serve --project ${projectName}`;
  const terminalName = `ng serve (${projectName})`;
  runInTerminal(terminalName, serveCommand, workspaceRoot, { trackAsServe: true });
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

  const lastTest = getLastProject('test');
  const lastInTestable = lastTest && testableProjects.includes(lastTest) && lastTest !== currentInTestable ? lastTest : null;
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
    // Path relative to workspace root, forward slashes for the CLI glob
    const relPath = path.relative(workspaceRoot, activeFile).replaceAll(path.sep, '/');
    testCommand = `ng test --include ${relPath}${watchFlag}${uiFlag}`;
    terminalName = `ng test (${path.basename(activeFile)})`;
  } else if (CURRENT_PROJECT_LABEL && picked === CURRENT_PROJECT_LABEL) {
    setLastProject('test', currentInTestable!);
    testCommand = `ng test --project ${currentInTestable}${watchFlag}${uiFlag}`;
    terminalName = `ng test (${currentInTestable})`;
  } else if (LAST_LABEL && picked === LAST_LABEL) {
    testCommand = `ng test --project ${lastInTestable}${watchFlag}${uiFlag}`;
    terminalName = `ng test (${lastInTestable})`;
  } else if (picked === ALL_PROJECTS) {
    testCommand = `ng test${watchFlag}${uiFlag}`;
    terminalName = 'ng test (all)';
  } else {
    setLastProject('test', picked);
    testCommand = `ng test --project ${picked}${watchFlag}${uiFlag}`;
    terminalName = `ng test (${picked})`;
  }

  runInTerminal(terminalName, testCommand, workspaceRoot, {
    successMessage: watchMode ? undefined : `${terminalName} completed successfully.`,
    retryLabel: watchMode ? undefined : 'Retry',
  });
}

async function lintAngularProject() {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const allProjects = Object.keys(projects);
  const projectName = await pickProjectWithCurrentFile(workspaceRoot, projects, allProjects, 'Angular Lint: Select Project', 'lint');
  if (!projectName) {
    return;
  }

  const terminalName = `ng lint (${projectName})`;
  const lintCommand = `ng lint --project ${projectName}`;
  runInTerminal(terminalName, lintCommand, workspaceRoot, {
    successMessage: `ng lint (${projectName}) completed successfully.`,
    retryLabel: 'Retry',
  });
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
  const projectName = await pickProjectWithCurrentFile(workspaceRoot, projects, allProjects, title, watch ? 'buildWatch' : 'build');
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
  const buildCommand = `ng build --project ${projectName}${configFlag}${watchFlag}`;
  runInTerminal(terminalName, buildCommand, workspaceRoot, {
    trackAsServe: watch,
    successMessage: watch ? undefined : `ng build (${projectName}) completed successfully.`,
    retryLabel: watch ? undefined : 'Retry',
  });
}

interface BrowserDebugConfig {
  type: string;
  runtimeExecutable?: string;
}

function findExecutable(candidates: string[]): string | undefined {
  return candidates.find((p) => fs.existsSync(p));
}

function getBrowserDebugConfig(browser: string, executableOverride: string): BrowserDebugConfig | null {
  if (executableOverride) {
    if (!fs.existsSync(executableOverride)) {
      vscode.window.showErrorMessage(`Browser executable not found: ${executableOverride}`);
      return null;
    }
    const type = browser === 'edge' ? 'msedge' : browser === 'firefox' ? 'firefox' : 'chrome';
    return { type, runtimeExecutable: executableOverride };
  }

  switch (browser) {
    case 'chrome':
      return { type: 'chrome' };
    case 'edge':
      return { type: 'msedge' };
    case 'brave': {
      const exe = findExecutable(
        process.platform === 'win32'
          ? [
              path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
              path.join(process.env['LOCALAPPDATA'] ?? '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
            ]
          : process.platform === 'darwin'
            ? ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
            : ['/usr/bin/brave-browser', '/usr/bin/brave'],
      );
      if (!exe) {
        vscode.window.showErrorMessage('Brave browser not found. Install it or set "angularCliPlus.debug.browserExecutablePath".');
        return null;
      }
      return { type: 'chrome', runtimeExecutable: exe };
    }
    case 'opera': {
      const exe = findExecutable(
        process.platform === 'win32'
          ? [
              path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs\\Opera\\opera.exe'),
              path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Opera\\opera.exe'),
            ]
          : process.platform === 'darwin'
            ? ['/Applications/Opera.app/Contents/MacOS/Opera']
            : ['/usr/bin/opera'],
      );
      if (!exe) {
        vscode.window.showErrorMessage('Opera not found. Install it or set "angularCliPlus.debug.browserExecutablePath".');
        return null;
      }
      return { type: 'chrome', runtimeExecutable: exe };
    }
    case 'opera-gx': {
      const exe = findExecutable(
        process.platform === 'win32'
          ? [path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs\\Opera GX\\opera.exe')]
          : process.platform === 'darwin'
            ? ['/Applications/Opera GX.app/Contents/MacOS/Opera GX']
            : [],
      );
      if (!exe) {
        vscode.window.showErrorMessage('Opera GX not found. Install it or set "angularCliPlus.debug.browserExecutablePath".');
        return null;
      }
      return { type: 'chrome', runtimeExecutable: exe };
    }
    case 'firefox':
      return { type: 'firefox' };
    case 'safari':
      if (process.platform !== 'darwin') {
        vscode.window.showErrorMessage('Safari debugging is only supported on macOS.');
        return null;
      }
      return { type: 'safari' };
    default:
      return { type: 'chrome' };
  }
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

  const projectName = await pickProjectWithCurrentFile(workspaceRoot, projects, appProjects, 'Angular Debug: Select Project', 'debug');
  if (!projectName) {
    return;
  }

  const port = projects[projectName]?.architect?.serve?.options?.port ?? 4200;

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  const browserSetting = config.get<string>('debug.browser', 'chrome');
  const executableOverride = (config.get<string>('debug.browserExecutablePath') ?? '').trim();
  const browserDebugConfig = getBrowserDebugConfig(browserSetting, executableOverride);
  if (!browserDebugConfig) {
    return;
  }
  const sessionName = `Angular Debug (${projectName})`;

  const serveCommand = `ng serve --project ${projectName}`;
  const serveTerminalName = `ng serve (${projectName})`;
  const terminal = runInTerminal(serveTerminalName, serveCommand, workspaceRoot, { trackAsServe: true });

  const serveEntry = activeServeTerminals.get(serveTerminalName);
  if (serveEntry) {
    serveEntry.debugConfig = { workspaceFolder, port, sessionName, browserSetting, browserDebugConfig };
  }

  launchBrowserDebugSession(context, workspaceFolder, terminal, {
    port,
    sessionName,
    browserSetting,
    browserDebugConfig,
    progressTitle: `Starting ng serve for "${projectName}" on port ${port}…`,
    serverName: 'ng serve',
    onSessionStarted: (session) => {
      const e = activeServeTerminals.get(serveTerminalName);
      if (e) { e.activeDebugSession = session; }
    },
  });
}

function launchBrowserDebugSession(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
  terminal: vscode.Terminal,
  options: {
    port: number;
    sessionName: string;
    browserSetting: string;
    browserDebugConfig: BrowserDebugConfig;
    progressTitle: string;
    serverName: string;
    additionalTerminals?: vscode.Terminal[];
    onSessionStarted?: (session: vscode.DebugSession) => void;
  },
): void {
  const allTerminals = [terminal, ...(options.additionalTerminals ?? [])];

  const stopAll = () => {
    for (const t of allTerminals) {
      t.sendText('\x03');
      t.dispose();
    }
  };

  const stopAllDelayed = () => {
    for (const t of allTerminals) {
      t.sendText('\x03');
    }
    setTimeout(() => allTerminals.forEach((t) => t.dispose()), 2000);
  };

  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: options.progressTitle, cancellable: true },
    async (progress, token) => {
      const ready = await waitForPort(options.port, 600_000, token);

      if (token.isCancellationRequested) {
        stopAll();
        return;
      }

      if (!ready) {
        vscode.window.showErrorMessage(
          `${options.serverName} did not become ready on port ${options.port} within 10 minutes`,
        );
        stopAll();
        return;
      }

      progress.report({ message: 'Server ready — launching debugger…' });

      let targetSession: vscode.DebugSession | undefined;

      const startListener = vscode.debug.onDidStartDebugSession((session) => {
        if (session.name === options.sessionName) {
          targetSession = session;
          options.onSessionStarted?.(session);
          startListener.dispose();
        }
      });
      context.subscriptions.push(startListener);

      const started = await vscode.debug.startDebugging(workspaceFolder, {
        ...options.browserDebugConfig,
        request: 'launch',
        name: options.sessionName,
        url: `http://localhost:${options.port}`,
        webRoot: '${workspaceFolder}',
      });

      if (!started) {
        startListener.dispose();
        const extensionHint: Record<string, string> = {
          firefox: 'Make sure the "Debugger for Firefox" extension is installed in VS Code.',
          safari: 'Make sure the "Safari Debugger" extension is installed in VS Code.',
        };
        const hint = extensionHint[options.browserDebugConfig.type] ?? `Make sure the ${options.browserSetting} debugger extension is available in VS Code.`;
        vscode.window.showErrorMessage(`Failed to start ${options.browserSetting} debug session. ${hint}`);
        stopAll();
        return;
      }

      const endListener = vscode.debug.onDidTerminateDebugSession((session) => {
        if (targetSession && session.id === targetSession.id) {
          // Clear the stored session reference from whichever serve entry holds it
          for (const e of activeServeTerminals.values()) {
            if (e.activeDebugSession?.id === session.id) {
              e.activeDebugSession = undefined;
            }
          }
          stopAllDelayed();
          endListener.dispose();
        }
      });
      context.subscriptions.push(endListener);
    },
  );
}

async function debugStorybookProject(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  let workspaceFolder: vscode.WorkspaceFolder;
  if (workspaceFolders.length === 1) {
    workspaceFolder = workspaceFolders[0];
  } else {
    const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select workspace folder' });
    if (!picked) {
      return;
    }
    workspaceFolder = picked;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  interface StorybookEntry {
    label: string;
    command: string;
    port: number;
  }

  const entries: StorybookEntry[] = [];

  // Detect via angular.json storybook architect targets
  const angularJsonPath = path.join(workspaceRoot, 'angular.json');
  if (fs.existsSync(angularJsonPath)) {
    try {
      const angularJson = JSON.parse(fs.readFileSync(angularJsonPath, 'utf-8')) as AngularJson;
      for (const [projectName, project] of Object.entries(angularJson.projects ?? {})) {
        if (project.architect?.storybook) {
          entries.push({
            label: projectName,
            command: `ng run ${projectName}:storybook`,
            port: project.architect.storybook.options?.port ?? 6006,
          });
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Fallback: detect via package.json storybook script
  if (entries.length === 0) {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
        if (pkg.scripts?.storybook) {
          entries.push({ label: 'storybook', command: 'npm run storybook', port: 6006 });
        }
      } catch { /* ignore parse errors */ }
    }
  }

  if (entries.length === 0) {
    vscode.window.showErrorMessage(
      'No Storybook configuration found. Make sure @storybook/angular is set up and has a storybook architect target or an npm "storybook" script.',
    );
    return;
  }

  let entry: StorybookEntry;
  if (entries.length === 1) {
    entry = entries[0];
  } else {
    const lastStorybook = getLastProject('storybookDebug');
    const lastEntry = lastStorybook ? entries.find((e) => e.label === lastStorybook) : null;
    const labels = entries.map((e) => e.label);
    const items = [
      ...(lastEntry ? [`$(history)  Last used (${lastEntry.label})`] : []),
      ...labels,
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Storybook Debug: Select Project',
      placeHolder: 'Select a project',
    });
    if (!picked) {
      return;
    }
    if (lastEntry && picked === `$(history)  Last used (${lastEntry.label})`) {
      entry = lastEntry;
    } else {
      entry = entries.find((e) => e.label === picked)!;
      setLastProject('storybookDebug', entry.label);
    }
  }

  const vsConfig = vscode.workspace.getConfiguration('angularCliPlus');
  const portOverride = vsConfig.get<number>('storybook.port', 0);
  const port = portOverride > 0 ? portOverride : entry.port;

  const browserSetting = vsConfig.get<string>('debug.browser', 'chrome');
  const executableOverride = (vsConfig.get<string>('debug.browserExecutablePath') ?? '').trim();
  const browserDebugConfig = getBrowserDebugConfig(browserSetting, executableOverride);
  if (!browserDebugConfig) {
    return;
  }

  const sessionName = `Storybook Debug (${entry.label})`;
  const storybookTerminalName = `storybook (${entry.label})`;
  const terminal = runInTerminal(storybookTerminalName, entry.command, workspaceRoot, { trackAsServe: true });

  const storybookEntry = activeServeTerminals.get(storybookTerminalName);
  if (storybookEntry) {
    storybookEntry.debugConfig = { workspaceFolder, port, sessionName, browserSetting, browserDebugConfig };
  }

  launchBrowserDebugSession(context, workspaceFolder, terminal, {
    port,
    sessionName,
    browserSetting,
    browserDebugConfig,
    progressTitle: `Starting Storybook for "${entry.label}" on port ${port}…`,
    serverName: 'Storybook',
    onSessionStarted: (session) => {
      const e = activeServeTerminals.get(storybookTerminalName);
      if (e) { e.activeDebugSession = session; }
    },
  });
}

function resolveOutputPath(project: AngularProject, projectName: string, workspaceRoot: string): string {
  const outputPath = project.architect?.build?.options?.outputPath;

  if (typeof outputPath === 'string') {
    return path.isAbsolute(outputPath) ? outputPath : path.join(workspaceRoot, outputPath);
  }

  if (outputPath && typeof outputPath === 'object') {
    const base = outputPath.base ?? `dist/${projectName}`;
    const browser = outputPath.browser || 'browser';
    const combined = path.join(base, browser);
    return path.isAbsolute(combined) ? combined : path.join(workspaceRoot, combined);
  }

  // Default: Angular 17+ uses dist/<project>/browser, older uses dist/<project>
  const newStyle = path.join(workspaceRoot, 'dist', projectName, 'browser');
  return fs.existsSync(newStyle) ? newStyle : path.join(workspaceRoot, 'dist', projectName);
}

async function debugBuildWatchProject(context: vscode.ExtensionContext) {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceFolder, workspaceRoot, projects } = resolved;

  const appProjects = Object.entries(projects)
    .filter(([, p]) => !p.projectType || p.projectType === 'application')
    .map(([n]) => n);

  const projectName = await pickProjectWithCurrentFile(workspaceRoot, projects, appProjects, 'Angular Debug Build Watch: Select Project', 'debugBuildWatch');
  if (!projectName) {
    return;
  }

  const vsConfig = vscode.workspace.getConfiguration('angularCliPlus');

  const watchConfig = vsConfig.get<string>('watch.configuration', 'development');
  const effectiveConfig =
    watchConfig === 'inherit'
      ? vsConfig.get<string>('build.configuration', 'production')
      : watchConfig;
  const configFlag = effectiveConfig !== 'default' ? ` --configuration=${effectiveConfig}` : '';
  const buildCommand = `ng build --project ${projectName}${configFlag} --watch`;

  const outputPath = resolveOutputPath(projects[projectName], projectName, workspaceRoot);
  const port = vsConfig.get<number>('buildWatch.servePort', 4201);
  const serverCommandTemplate = vsConfig.get<string>('buildWatch.staticServerCommand', 'npx serve {outputPath} -l {port}');
  const serverCommand = serverCommandTemplate
    .replace('{outputPath}', `"${outputPath}"`)
    .replace('{port}', String(port));

  const browserSetting = vsConfig.get<string>('debug.browser', 'chrome');
  const executableOverride = (vsConfig.get<string>('debug.browserExecutablePath') ?? '').trim();
  const browserDebugConfig = getBrowserDebugConfig(browserSetting, executableOverride);
  if (!browserDebugConfig) {
    return;
  }

  const buildTerminalName = `ng build --watch (${projectName})`;
  const serveTerminalName = `serve (${projectName})`;
  const sessionName = `Angular Debug Build Watch (${projectName})`;

  const buildTerminal = runInTerminal(buildTerminalName, buildCommand, workspaceRoot, { trackAsServe: true });
  const serveTerminal = runInTerminal(serveTerminalName, serverCommand, workspaceRoot, { trackAsServe: true });

  const serveEntry = activeServeTerminals.get(serveTerminalName);
  if (serveEntry) {
    serveEntry.debugConfig = { workspaceFolder, port, sessionName, browserSetting, browserDebugConfig };
  }

  launchBrowserDebugSession(context, workspaceFolder, serveTerminal, {
    port,
    sessionName,
    browserSetting,
    browserDebugConfig,
    progressTitle: `Starting build watch + static server for "${projectName}" on port ${port}…`,
    serverName: 'static server',
    additionalTerminals: [buildTerminal],
    onSessionStarted: (session) => {
      const e = activeServeTerminals.get(serveTerminalName);
      if (e) { e.activeDebugSession = session; }
    },
  });
}

async function clearFinishedTerminals() {
  if (extensionTerminals.size === 0) {
    vscode.window.showInformationMessage('No extension terminals to close.');
    return;
  }

  function getTerminalState(terminal: vscode.Terminal): { label: string; icon: string } {
    if (terminal.exitStatus === undefined) {
      return { label: 'running', icon: '$(play)' };
    }
    if (terminal.exitStatus.code === 0) {
      return { label: 'terminated', icon: '$(check)' };
    }
    return { label: 'errored', icon: '$(error)' };
  }

  type TerminalItem = vscode.QuickPickItem & { terminal: vscode.Terminal };

  const terminals = [...extensionTerminals];
  const terminalItems: TerminalItem[] = terminals.map((t) => {
    const state = getTerminalState(t);
    return {
      label: `${state.icon} ${t.name}`,
      description: state.label,
      terminal: t,
    };
  });

  const qp = vscode.window.createQuickPick<TerminalItem>();
  qp.items = terminalItems;
  qp.canSelectMany = true;
  qp.placeholder = 'Search and select terminals to close...';
  qp.title = 'Close Terminals';

  const chosen = await new Promise<TerminalItem[]>((resolve) => {
    qp.onDidAccept(() => {
      resolve([...qp.selectedItems]);
      qp.hide();
    });
    qp.onDidHide(() => resolve([]));
    qp.show();
  });

  for (const item of chosen) {
    item.terminal.dispose();
    extensionTerminals.delete(item.terminal);
  }

  if (chosen.length > 0) {
    vscode.window.showInformationMessage(`Closed ${chosen.length} terminal${chosen.length > 1 ? 's' : ''}.`);
  }
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

  const ngConfig = vscode.workspace.getConfiguration('angularCliPlus');
  const customInstall = (ngConfig.get<string>('npm.installCommand') ?? '').trim();
  const customCleanInstall = (ngConfig.get<string>('npm.cleanInstallCommand') ?? '').trim();

  if (clean && customCleanInstall) {
    npmOutput.appendLine(`> ${customCleanInstall}
`);
    const exitCode = await spawnShellCommand(customCleanInstall, workspaceRoot);
    if (exitCode === 0) {
      vscode.window.showInformationMessage('Clean install completed successfully.');
    } else {
      vscode.window.showErrorMessage("Custom clean install failed. Check the 'Angular CLI Plus: npm' output for details.");
    }
    return;
  }

  if (!clean && !force && customInstall) {
    npmOutput.appendLine(`> ${customInstall}
`);
    const exitCode = await spawnShellCommand(customInstall, workspaceRoot);
    if (exitCode === 0) {
      vscode.window.showInformationMessage('Install completed successfully.');
    } else {
      vscode.window.showErrorMessage("Custom install failed. Check the 'Angular CLI Plus: npm' output for details.");
    }
    return;
  }

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
      'npm install --force also failed. Check the "Angular CLI Plus: npm" output for details.',
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

function spawnShellCommand(command: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    npmOutput.appendLine(`> ${command}
`);
    const proc = cp.spawn(command, [], { cwd, shell: true });
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
  const clean = output.replace(/\x1b\[[\d;]*[A-Za-z]/g, '');
  const results: Array<{ name: string; versions: string }> = [];
  for (const line of clean.split('\n')) {
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
  let checkExitCode = 0;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking for Angular package updates…', cancellable: false },
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
    vscode.window.showErrorMessage("Failed to check for Angular updates. See 'Angular CLI Plus: ng' output for details.");
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
      "ng update --force also failed. Check the 'Angular CLI Plus: ng' output for details.",
    );
  }
}

async function restartAngularServe(context: vscode.ExtensionContext) {
  if (activeServeTerminals.size === 0) {
    vscode.window.showErrorMessage('No active ng serve / ng build --watch terminals found.');
    return;
  }

  let projectName: string;
  if (activeServeTerminals.size === 1) {
    projectName = [...activeServeTerminals.keys()][0];
  } else {
    const items = [...activeServeTerminals.entries()].map(([name, e]) => ({
      label: name,
      description: e.debugConfig ? '$(debug) debug session active' : undefined,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select terminal to restart',
      title: 'Angular Restart',
    });
    if (!picked) {
      return;
    }
    projectName = picked.label;
  }

  const entry = activeServeTerminals.get(projectName)!;

  // Stop any running debug session for this entry before restarting
  if (entry.activeDebugSession) {
    await vscode.debug.stopDebugging(entry.activeDebugSession);
    entry.activeDebugSession = undefined;
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  entry.terminal.show();
  entry.terminal.sendText('\x03');
  await new Promise<void>((r) => setTimeout(r, 300));
  entry.terminal.sendText('y');
  await new Promise<void>((r) => setTimeout(r, 700));
  entry.terminal.sendText(entry.command);

  if (entry.debugConfig) {
    const { workspaceFolder, port, sessionName, browserSetting, browserDebugConfig } = entry.debugConfig;
    launchBrowserDebugSession(context, workspaceFolder, entry.terminal, {
      port,
      sessionName,
      browserSetting,
      browserDebugConfig,
      progressTitle: `Reattaching debugger for "${projectName}" on port ${port}…`,
      serverName: projectName,
    });
  }
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
  const config = vscode.workspace.getConfiguration('angularCliPlus');
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
  const config = vscode.workspace.getConfiguration('angularCliPlus');
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

async function pickWorkspaceFolder(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return null;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select workspace folder' });
  return picked?.uri.fsPath ?? null;
}

async function runCheckDependencies() {
  const workspaceRoot = await pickWorkspaceFolder();
  if (!workspaceRoot) { return; }
  await checkDependencies(workspaceRoot);
}

async function runCheckToolVersions() {
  const workspaceRoot = await pickWorkspaceFolder();
  if (!workspaceRoot) { return; }
  await checkToolVersions(workspaceRoot);
}

async function attemptToolUpdate(
  tool: string,
  selfUpdate: { cmd: string; args: string[] } | undefined,
  npmGlobalPkg: string | undefined,
  url: string,
  workspaceRoot: string,
): Promise<void> {
  npmOutput.clear();
  npmOutput.show(true);

  const tryCmd = async (cmd: string, args: string[]): Promise<boolean> => {
    let exitCode = 1;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Updating ${tool}…`, cancellable: false },
      async () => {
        exitCode = await spawnShellCommand(`${cmd} ${args.join(' ')}`, workspaceRoot);
      },
    );
    return exitCode === 0;
  };

  if (selfUpdate && await tryCmd(selfUpdate.cmd, selfUpdate.args)) {
    vscode.window.showInformationMessage(`${tool} updated successfully.`);
    return;
  }

  if (npmGlobalPkg && await tryCmd('npm', ['install', '-g', npmGlobalPkg])) {
    vscode.window.showInformationMessage(`${tool} updated successfully via npm.`);
    return;
  }

  const action = await vscode.window.showErrorMessage(
    `Failed to update ${tool}. Please install it manually.`,
    'Open Download Page',
  );
  if (action === 'Open Download Page') {
    vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

async function checkToolVersions(workspaceRoot: string) {
  const config = vscode.workspace.getConfiguration('angularCliPlus');
  if (!config.get<boolean>('checkToolVersions.enabled', true)) {
    return;
  }

  const pkgPath = path.join(workspaceRoot, 'package.json');
  let pkg: { engines?: Record<string, string> };
  try {
    pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'));
  } catch {
    return;
  }

  const engines = pkg.engines ?? {};
  const toolInfo: Record<string, {
    cmd: string;
    args: string[];
    url: string;
    selfUpdate?: { cmd: string; args: string[] };
    npmGlobalPkg?: string;
  }> = {
    node: {
      cmd: 'node',
      args: ['--version'],
      url: 'https://nodejs.org/en/download/',
    },
    npm: {
      cmd: 'npm',
      args: ['--version'],
      url: 'https://docs.npmjs.com/downloading-and-installing-node-js-and-npm',
      selfUpdate: { cmd: 'npm', args: ['install', '-g', 'npm'] },
    },
    yarn: {
      cmd: 'yarn',
      args: ['--version'],
      url: 'https://yarnpkg.com/getting-started/install',
      selfUpdate: { cmd: 'yarn', args: ['set', 'version', 'latest'] },
      npmGlobalPkg: 'yarn',
    },
    pnpm: {
      cmd: 'pnpm',
      args: ['--version'],
      url: 'https://pnpm.io/installation',
      selfUpdate: { cmd: 'pnpm', args: ['self-update'] },
      npmGlobalPkg: 'pnpm',
    },
  };

  const invalid: Array<{
    tool: string;
    required: string;
    installed: string | null;
    url: string;
    selfUpdate?: { cmd: string; args: string[] };
    npmGlobalPkg?: string;
  }> = [];

  await Promise.all(
    Object.entries(engines)
      .filter(([tool]) => tool in toolInfo)
      .map(async ([tool, required]) => {
        const info = toolInfo[tool];
        const { stdout, exitCode } = await spawnCapture(info.cmd, info.args, workspaceRoot);
        if (exitCode !== 0) {
          invalid.push({ tool, required, installed: null, url: info.url, selfUpdate: info.selfUpdate, npmGlobalPkg: info.npmGlobalPkg });
          return;
        }
        const installed = stdout.trim().replace(/^v\//, '');
        if (!semverSatisfies(installed, required)) {
          invalid.push({ tool, required, installed, url: info.url, selfUpdate: info.selfUpdate, npmGlobalPkg: info.npmGlobalPkg });
        }
      }),
  );

  for (const { tool, required, installed, url, selfUpdate, npmGlobalPkg } of invalid) {
    if (!installed) {
      if (npmGlobalPkg) {
        const npmAvailable = (await spawnCapture('npm', ['--version'], workspaceRoot)).exitCode === 0;
        if (npmAvailable) {
          npmOutput.clear();
          npmOutput.show(true);
          let exitCode = 1;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Installing ${tool}…`, cancellable: false },
            async () => { exitCode = await spawnShellCommand(`npm install -g ${npmGlobalPkg}`, workspaceRoot); },
          );
          if (exitCode === 0) {
            vscode.window.showInformationMessage(`${tool} installed successfully.`);
          } else {
            const action = await vscode.window.showErrorMessage(
              `Failed to install ${tool}. Please install it manually.`,
              'Open Download Page',
            );
            if (action === 'Open Download Page') {
              vscode.env.openExternal(vscode.Uri.parse(url));
            }
          }
          continue;
        }
      }
      const action = await vscode.window.showWarningMessage(
        `${tool} is not installed (required: ${required})`,
        'Open Download Page',
      );
      if (action === 'Open Download Page') {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
      continue;
    }

    const canAutoUpdate = !!(selfUpdate || npmGlobalPkg);
    const buttons: string[] = canAutoUpdate ? ['Update', 'Open Download Page'] : ['Open Download Page'];
    const action = await vscode.window.showWarningMessage(
      `${tool} ${installed} does not satisfy required version ${required}`,
      ...buttons,
    );
    if (action === 'Open Download Page') {
      vscode.env.openExternal(vscode.Uri.parse(url));
    } else if (action === 'Update') {
      await attemptToolUpdate(tool, selfUpdate, npmGlobalPkg, url, workspaceRoot);
    }
  }
}

export function deactivate() {
  for (const timeout of depCheckTimeouts.values()) {
    clearTimeout(timeout);
  }
  depCheckTimeouts.clear();
}
