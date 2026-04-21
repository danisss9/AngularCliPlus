import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { AngularJson, AngularProject } from './types';
import {
  activeServeTerminals,
  clearTrackedTerminalState,
  extensionTerminals,
  getTrackedTerminalState,
  getExtensionContext,
  logDiagnostic,
  persistTerminalEntry,
  removePersistedTerminalEntry,
  setTrackedTerminalRunning,
} from './state';

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
async function readAngularJson(workspaceRoot: string): Promise<AngularJson | null> {
  const filePath = path.join(workspaceRoot, 'angular.json');
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }

  const cached = angularJsonCache.get(workspaceRoot);
  if (cached && cached.mtimeMs === mtimeMs) {
    return { projects: cached.projects };
  }

  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf-8')) as AngularJson;
    angularJsonCache.set(workspaceRoot, { projects: parsed.projects ?? {}, mtimeMs });
    return parsed;
  } catch (err) {
    logDiagnostic(`Failed to parse angular.json at ${filePath}: ${err}`);
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

  const angularJson = await readAngularJson(workspaceRoot);
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
  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select workspace folder',
  });
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
  if (!activeFile) {
    return null;
  }
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
  if (!picked) {
    return null;
  }
  if (CURRENT_LABEL && picked === CURRENT_LABEL) {
    if (commandKey) {
      setLastProject(commandKey, currentInList!);
    }
    return currentInList!;
  }
  if (LAST_LABEL && picked === LAST_LABEL) {
    return lastInList!;
  }
  if (commandKey) {
    setLastProject(commandKey, picked);
  }
  return picked;
}

// ── Angular CLI helpers ──────────────────────────────────────────────────────

function getLocalAngularCliPath(workspaceRoot: string): string | null {
  const executable = process.platform === 'win32' ? 'ng.cmd' : 'ng';
  const cliPath = path.join(workspaceRoot, 'node_modules', '.bin', executable);
  return fs.existsSync(cliPath) ? cliPath : null;
}

function quoteShellPath(filePath: string): string {
  return /\s/.test(filePath) ? `"${filePath.replace(/"/g, '\\"')}"` : filePath;
}

export function buildAngularCliTerminalCommand(workspaceRoot: string, command: string): string {
  if (!command.startsWith('ng ')) {
    return command;
  }

  const localCli = getLocalAngularCliPath(workspaceRoot);
  if (!localCli) {
    return command;
  }

  return `${quoteShellPath(localCli)} ${command.slice(3)}`;
}

export function resolveAngularCliSpawn(
  workspaceRoot: string,
  args: string[],
): { command: string; args: string[]; shell: boolean; displayCommand: string } {
  const localCli = getLocalAngularCliPath(workspaceRoot);
  if (localCli) {
    return {
      command: localCli,
      args,
      shell: process.platform === 'win32',
      displayCommand: `${quoteShellPath(localCli)} ${args.join(' ')}`,
    };
  }

  return {
    command: 'ng',
    args,
    shell: true,
    displayCommand: `ng ${args.join(' ')}`,
  };
}

// ── Terminal helpers ───────────────────────────────────────────────────────────

const RESTART_CTRL_C_DELAY_MS = 500;

/**
 * Creates a terminal, runs a command, and shows a success notification on exit
 * code 0 or a warning notification with an optional Retry button on non-zero
 * exit. When `retryLabel` is set and no `onRetry` handler is provided, the
 * exact same command is re-launched automatically.
 *
 * If a terminal with the same name already exists in `extensionTerminals`:
 * - Running: for serve/watch terminals the user is offered to restart; for
 *   others the existing terminal is focused and returned as-is.
 * - Terminated/errored: the old terminal is disposed and a fresh one is opened.
 */
export async function runInTerminal(
  name: string,
  command: string,
  cwd: string,
  options?: {
    trackAsServe?: boolean;
    successMessage?: string;
    retryLabel?: string;
    onRetry?: () => void;
  },
): Promise<vscode.Terminal> {
  // ── Reuse check ────────────────────────────────────────────────────────────
  const existing = [...extensionTerminals].find((t) => t.name === name);
  if (existing) {
    const isRunning = getTrackedTerminalState(existing) === 'running';
    if (isRunning) {
      if (options?.trackAsServe) {
        // Serve/watch terminal already running — offer restart
        const action = await vscode.window.showInformationMessage(
          `"${name}" is already running. Restart it?`,
          'Restart',
          'Show',
        );
        // Re-check terminal is still valid after awaiting user input
        if (getTrackedTerminalState(existing) !== 'running') {
          extensionTerminals.delete(existing);
          clearTrackedTerminalState(existing);
          removePersistedTerminalEntry(name);
          // Fall through to create a new terminal below
        } else if (action === 'Restart') {
          existing.show();
          existing.sendText('\x03');
          await new Promise<void>((r) => setTimeout(r, RESTART_CTRL_C_DELAY_MS));
          setTrackedTerminalRunning(existing);
          existing.sendText(command);
          return existing;
        } else if (action === 'Show') {
          existing.show();
          return existing;
        } else {
          return existing;
        }
      } else {
        // Non-serve terminal already running — just show it
        existing.show();
        return existing;
      }
    } else {
      // Terminated or errored — clean up before creating fresh
      existing.dispose();
      extensionTerminals.delete(existing);
      clearTrackedTerminalState(existing);
      removePersistedTerminalEntry(name);
    }
  }

  // ── Create new terminal ────────────────────────────────────────────────────
  const terminal = vscode.window.createTerminal({ name, cwd });
  extensionTerminals.add(terminal);
  persistTerminalEntry(name, { command, cwd, trackAsServe: options?.trackAsServe ?? false });

  if (options?.trackAsServe) {
    activeServeTerminals.set(name, { terminal, command, cwd });
  }
  terminal.show();
  setTrackedTerminalRunning(terminal);
  terminal.sendText(command);

  const disposable = vscode.window.onDidCloseTerminal(async (closed) => {
    if (closed !== terminal) {
      return;
    }
    disposable.dispose();
    extensionTerminals.delete(closed);
    clearTrackedTerminalState(closed);
    removePersistedTerminalEntry(name);

    // Also clean up activeServeTerminals here so we don't rely solely on the
    // extension.ts handler
    for (const [key, entry] of activeServeTerminals) {
      if (entry.terminal === closed) {
        activeServeTerminals.delete(key);
        break;
      }
    }

    const exitStatus = closed.exitStatus;
    if (exitStatus === undefined) {
      // Should not happen (we're inside onDidCloseTerminal), but guard anyway
      return;
    }

    const code = exitStatus.code;
    if (code === undefined) {
      // Terminal was killed without a proper exit (e.g. user closed the tab
      // mid-run or the process was force-killed).
      logDiagnostic(`Terminal "${name}" closed without an exit code (killed/forced close).`);
      return;
    }

    if (code === 0) {
      if (options?.successMessage) {
        vscode.window.showInformationMessage(options.successMessage);
      }
    } else {
      const retryLabel = options?.retryLabel;
      if (retryLabel) {
        const action = await vscode.window.showWarningMessage(
          `${name} failed (exit code ${code}).`,
          retryLabel,
        );
        if (action === retryLabel) {
          if (options.onRetry) {
            options.onRetry();
          } else {
            void runInTerminal(name, command, cwd, options);
          }
        }
      } else {
        vscode.window.showWarningMessage(`${name} failed (exit code ${code}).`);
      }
    }
  });

  return terminal;
}
