import * as vscode from 'vscode';
import type { ServeEntry } from './types';

export const npmOutput = vscode.window.createOutputChannel('Angular CLI Plus: npm');
export const ngOutput = vscode.window.createOutputChannel('Angular CLI Plus: ng');
export const diagnosticOutput = vscode.window.createOutputChannel('Angular CLI Plus: diagnostics');

export const activeServeTerminals = new Map<string, ServeEntry>();
export const extensionTerminals = new Set<vscode.Terminal>();
export const depCheckTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

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
