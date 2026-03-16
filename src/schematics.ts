import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { AngularJson, GenerateOptions, SchematicType } from './types';
import { runInTerminal, toKebabCase } from './utils';
import { logDiagnostic } from './state';

export async function generatengSchematic(schematic: SchematicType, uri: vscode.Uri) {
  const folderPath = uri.fsPath;

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

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Could not determine workspace folder');
    return;
  }

  const detectedProject = await detectAngularProject(folderPath, workspaceFolder.uri.fsPath);

  if (detectedProject === null) {
    return; // User cancelled
  }

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  const options = getOptionsForSchematic(schematic, config);

  if (detectedProject && detectedProject.trim() !== '') {
    options.project = detectedProject.trim();
  }

  const command = buildNgGenerateCommand(schematic, name, options);
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
export async function detectAngularProject(
  selectedFolderPath: string,
  workspaceRoot: string,
): Promise<string | null> {
  const angularJsonPath = path.join(workspaceRoot, 'angular.json');

  if (!fs.existsSync(angularJsonPath)) {
    logDiagnostic(`angular.json not found at ${angularJsonPath}, falling back to free-text input`);
    return promptForProjectName();
  }

  let angularJson: AngularJson;
  try {
    const raw = fs.readFileSync(angularJsonPath, 'utf-8');
    angularJson = JSON.parse(raw) as AngularJson;
  } catch (err) {
    logDiagnostic(`Failed to parse angular.json: ${err}`);
    return promptForProjectName();
  }

  const projects = angularJson.projects ?? {};
  const projectNames = Object.keys(projects);

  if (projectNames.length === 0) {
    return promptForProjectName();
  }

  const normalised = selectedFolderPath.endsWith(path.sep)
    ? selectedFolderPath
    : selectedFolderPath + path.sep;

  const matching = projectNames.filter((name) => {
    const project = projects[name];
    const roots = [project.root, project.sourceRoot].filter(Boolean) as string[];

    return roots.some((r) => {
      const absRoot = path.isAbsolute(r) ? r : path.join(workspaceRoot, r);
      const absRootNormalised = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
      return normalised.startsWith(absRootNormalised) || normalised === absRootNormalised;
    });
  });

  if (matching.length === 1) {
    vscode.window.showInformationMessage(`Using Angular project: ${matching[0]}`);
    return matching[0];
  }

  if (matching.length > 1) {
    const picked = await vscode.window.showQuickPick(matching, {
      placeHolder: 'Select the Angular project',
      title: 'Multiple Angular projects contain this folder',
    });
    return picked ?? null;
  }

  return promptForProjectName();
}

/** Shows a free-text input for the project name. Returns null when cancelled. */
async function promptForProjectName(): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    prompt: 'Enter the project name (optional)',
    placeHolder: 'Leave empty to use default project',
  });
  return value === undefined ? null : value;
}

export function getOptionsForSchematic(
  schematic: SchematicType,
  config: vscode.WorkspaceConfiguration,
): GenerateOptions {
  const options: GenerateOptions = {};
  const schematicConfig = config.get<Record<string, boolean | string>>(schematic);

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

export function buildNgGenerateCommand(
  schematic: SchematicType,
  name: string,
  options: GenerateOptions,
): string {
  let command = `ng generate ${schematic}`;

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

  // The caller appends the name; we don't duplicate it here
  // Strip the trailing " <name>" if buildNgGenerateCommand ever added it
  return command;
}
