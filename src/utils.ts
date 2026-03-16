import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { AngularJson, AngularProject } from './types';
import { activeServeTerminals, extensionTerminals, getExtensionContext } from './state';

export { toKebabCase, findMatchingProjects } from './pure-utils';
import { findBestProjectForPath } from './pure-utils';
export { findBestProjectForPath };

// ── angular.json cache ────────────────────────────────────────────────────────

interface AngularJsonCacheEntry {
  projects: { [name: string]: AngularProject };
  mtimeMs: number;
}

const angularJsonCache = new Map<string, AngularJsonCacheEntry>();

/** Invalidate the cache for a workspace root (called when the file changes). */
export function invalidateAngularJsonCache(workspaceRoot: string): void {
  angularJsonCache.delete(workspaceRoot);
}

/**
 * Reads and parses angular.json for the given workspace root.
 * Returns the cached result if the file has not changed since the last read.
 */
function readAngularJson(workspaceRoot: string): AngularJson | null {
  const filePath = path.join(workspaceRoot, 'angular.json');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }

  const cached = angularJsonCache.get(workspaceRoot);
  if (cached && cached.mtimeMs === mtimeMs) {
    return { projects: cached.projects };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AngularJson;
    angularJsonCache.set(workspaceRoot, { projects: parsed.projects ?? {}, mtimeMs });
    return parsed;
  } catch {
    return null;
  }
}

// ── Workspace helpers ──────────────────────────────────────────────────────────

export async function resolveWorkspaceAndAngularJson(): Promise<{
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

  const angularJson = readAngularJson(workspaceRoot);
  if (!angularJson) {
    vscode.window.showErrorMessage('Failed to parse angular.json');
    return null;
  }

  return { workspaceFolder, workspaceRoot, projects: angularJson.projects ?? {} };
}

export async function pickWorkspaceFolder(): Promise<string | null> {
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

// ── Project selection helpers ──────────────────────────────────────────────────

export function getLastProject(commandKey: string): string | undefined {
  return getExtensionContext().globalState.get<string>(`lastProject.${commandKey}`);
}

export function setLastProject(commandKey: string, project: string): void {
  void getExtensionContext().globalState.update(`lastProject.${commandKey}`, project);
}

export async function pickProject(projectNames: string[], title: string): Promise<string | null> {
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

export function detectActiveFileProject(
  workspaceRoot: string,
  projects: { [name: string]: AngularProject },
): string | null {
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!activeFile) { return null; }
  return findBestProjectForPath(activeFile, workspaceRoot, projects);
}

export async function pickProjectWithCurrentFile(
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
  if (!picked) { return null; }
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

// ── Terminal helpers ───────────────────────────────────────────────────────────

/**
 * Creates a terminal, runs a command, and shows a success notification on exit
 * code 0 or a warning notification with an optional Retry button on non-zero
 * exit. When `retryLabel` is set and no `onRetry` handler is provided, the
 * exact same command is re-launched automatically.
 */
export function runInTerminal(
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

