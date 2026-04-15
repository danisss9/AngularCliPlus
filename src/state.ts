import * as vscode from 'vscode';
import type { PersistedTerminalEntry, ServeEntry } from './types';

export const npmOutput = vscode.window.createOutputChannel('Angular CLI Plus: npm');
export const ngOutput = vscode.window.createOutputChannel('Angular CLI Plus: ng');
export const diagnosticOutput = vscode.window.createOutputChannel('Angular CLI Plus: diagnostics');

export const activeServeTerminals = new Map<string, ServeEntry>();
export const extensionTerminals = new Set<vscode.Terminal>();
export const depCheckTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

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
