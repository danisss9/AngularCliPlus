import * as vscode from 'vscode';
import type { PersistedTerminalEntry, ServeEntry, TerminalCommandState } from './types';

export const npmOutput = vscode.window.createOutputChannel('Angular CLI Plus: npm');
export const ngOutput = vscode.window.createOutputChannel('Angular CLI Plus: ng');
export const diagnosticOutput = vscode.window.createOutputChannel('Angular CLI Plus: diagnostics');

export const activeServeTerminals = new Map<string, ServeEntry>();
export const extensionTerminals = new Set<vscode.Terminal>();
export const terminalCommandStates = new Map<vscode.Terminal, TerminalCommandState>();
export const depCheckTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
export const cliVersionCache = new Map<string, number | null>();

export function setTrackedTerminalRunning(terminal: vscode.Terminal): void {
  terminalCommandStates.set(terminal, 'running');
}

export function setTrackedTerminalFinished(
  terminal: vscode.Terminal,
  exitCode: number | undefined,
): void {
  if (exitCode === undefined) {
    terminalCommandStates.set(terminal, 'killed');
    return;
  }
  if (exitCode === 0) {
    terminalCommandStates.set(terminal, 'terminated');
    return;
  }
  terminalCommandStates.set(terminal, 'errored');
}

export function getTrackedTerminalState(
  terminal: vscode.Terminal,
): TerminalCommandState | undefined {
  return terminalCommandStates.get(terminal);
}

export function clearTrackedTerminalState(terminal: vscode.Terminal): void {
  terminalCommandStates.delete(terminal);
}

export function invalidateCliVersionCache(workspaceRoot: string): void {
  cliVersionCache.delete(workspaceRoot);
}

const TERMINAL_ENTRIES_KEY = 'terminalEntries';

let _extensionContext: vscode.ExtensionContext;

export function setExtensionContext(ctx: vscode.ExtensionContext): void {
  _extensionContext = ctx;
}

export function getExtensionContext(): vscode.ExtensionContext {
  return _extensionContext;
}

export function logDiagnostic(message: string): void {
  diagnosticOutput.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function persistTerminalEntry(name: string, entry: PersistedTerminalEntry): void {
  const map =
    _extensionContext.workspaceState.get<Record<string, PersistedTerminalEntry>>(
      TERMINAL_ENTRIES_KEY,
    ) ?? {};
  map[name] = entry;
  void _extensionContext.workspaceState.update(TERMINAL_ENTRIES_KEY, map);
}

export function removePersistedTerminalEntry(name: string): void {
  const map =
    _extensionContext.workspaceState.get<Record<string, PersistedTerminalEntry>>(
      TERMINAL_ENTRIES_KEY,
    ) ?? {};
  if (Object.prototype.hasOwnProperty.call(map, name)) {
    delete map[name];
    void _extensionContext.workspaceState.update(TERMINAL_ENTRIES_KEY, map);
  }
}

export function loadPersistedTerminalEntries(): Record<string, PersistedTerminalEntry> {
  return (
    _extensionContext.workspaceState.get<Record<string, PersistedTerminalEntry>>(
      TERMINAL_ENTRIES_KEY,
    ) ?? {}
  );
}
