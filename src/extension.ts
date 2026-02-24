import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface GenerateOptions {
  [key: string]: boolean | string;
}

interface AngularProject {
  root?: string;
  sourceRoot?: string;
  projectType?: string;
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
      (uri: vscode.Uri) => generatengSchematic(schematic, uri)
    );
    context.subscriptions.push(disposable);
  });
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
  workspaceRoot: string
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
  config: vscode.WorkspaceConfiguration
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
  options: GenerateOptions
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

export function deactivate() {
  // Extension cleanup
}
