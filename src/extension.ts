import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { SchematicType } from './types';
import {
  npmOutput,
  ngOutput,
  diagnosticOutput,
  activeServeTerminals,
  clearTrackedTerminalState,
  extensionTerminals,
  setTrackedTerminalFinished,
  setTrackedTerminalRunning,
  depCheckTimeouts,
  setExtensionContext,
  loadPersistedTerminalEntries,
  removePersistedTerminalEntry,
} from './state';
import { generatengSchematic } from './schematics';
import {
  debugAngularProject,
  debugStorybookProject,
  debugBuildWatchProject,
  restartAngularServe,
} from './debug';
import {
  serveAngularProject,
  testAngularProject,
  lintAngularProject,
  buildAngularProject,
  buildAngularProjectWatch,
  clearFinishedTerminals,
  updateAngularPackages,
  switchComponentFile,
  runNpmScript,
  showSignalGraph,
} from './commands';
import {
  runNpmInstall,
  setupDependencyCheck,
  scheduleDependencyCheck,
  checkToolVersions,
  checkDependencies,
} from './dependencies';
import { pickWorkspaceFolder } from './utils';
import { checkMemoryLeaks } from './memory-leak';
import { setupNpmrcCommand } from './npmrc';

export function activate(context: vscode.ExtensionContext) {
  setExtensionContext(context);

  // ── Clear stale terminal entries from previous sessions ───────────────────
  const persisted = loadPersistedTerminalEntries();
  for (const name of Object.keys(persisted)) {
    removePersistedTerminalEntry(name);
  }

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
      (uri?: vscode.Uri) => generatengSchematic(schematic, uri),
    );
    context.subscriptions.push(disposable);
  });

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (extensionTerminals.has(event.terminal)) {
        setTrackedTerminalRunning(event.terminal);
      }
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      if (extensionTerminals.has(event.terminal)) {
        setTrackedTerminalFinished(event.terminal, event.exitCode);
      }
    }),
    vscode.commands.registerCommand('angular-cli-plus.debugAngular', () =>
      debugAngularProject(context),
    ),
    vscode.commands.registerCommand('angular-cli-plus.debugStorybook', () =>
      debugStorybookProject(context),
    ),
    vscode.commands.registerCommand('angular-cli-plus.debugBuildWatch', () =>
      debugBuildWatchProject(context),
    ),
    vscode.commands.registerCommand('angular-cli-plus.serveAngular', () => serveAngularProject()),
    vscode.commands.registerCommand('angular-cli-plus.buildAngular', () => buildAngularProject()),
    vscode.commands.registerCommand('angular-cli-plus.buildAngularWatch', () =>
      buildAngularProjectWatch(),
    ),
    vscode.commands.registerCommand('angular-cli-plus.restartAngularServe', () =>
      restartAngularServe(context),
    ),
    vscode.commands.registerCommand('angular-cli-plus.testAngular', () => testAngularProject()),
    vscode.commands.registerCommand('angular-cli-plus.lintAngular', () => lintAngularProject()),
    vscode.commands.registerCommand('angular-cli-plus.updateAngular', () =>
      updateAngularPackages(),
    ),
    vscode.commands.registerCommand('angular-cli-plus.switchComponentFile', () =>
      switchComponentFile(),
    ),
    vscode.commands.registerCommand('angular-cli-plus.clearTerminals', () =>
      clearFinishedTerminals(),
    ),
    vscode.commands.registerCommand('angular-cli-plus.runNpmScript', () => runNpmScript()),
    vscode.commands.registerCommand('angular-cli-plus.checkMemoryLeaks', () => checkMemoryLeaks()),
    vscode.commands.registerCommand('angular-cli-plus.showSignalGraph', () => showSignalGraph()),
    vscode.commands.registerCommand('angular-cli-plus.setupNpmrc', () => setupNpmrcCommand()),
    vscode.commands.registerCommand('angular-cli-plus.npmInstall', () => runNpmInstall(false)),
    vscode.commands.registerCommand('angular-cli-plus.npmCleanInstall', () => runNpmInstall(true)),
    vscode.commands.registerCommand('angular-cli-plus.checkDependencies', async () => {
      const workspaceRoot = await pickWorkspaceFolder();
      if (workspaceRoot) {
        await checkDependencies(workspaceRoot);
      }
    }),
    vscode.commands.registerCommand('angular-cli-plus.checkToolVersions', async () => {
      const workspaceRoot = await pickWorkspaceFolder();
      if (workspaceRoot) {
        await checkToolVersions(workspaceRoot);
      }
    }),
  );

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    setupDependencyCheck(context, folder.uri.fsPath);
    if (fs.existsSync(path.join(folder.uri.fsPath, 'angular.json'))) {
      void checkToolVersions(folder.uri.fsPath);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.added) {
        setupDependencyCheck(context, folder.uri.fsPath);
        if (fs.existsSync(path.join(folder.uri.fsPath, 'angular.json'))) {
          void checkToolVersions(folder.uri.fsPath);
        }
      }
    }),
  );

  // activeServeTerminals / extensionTerminals cleanup is handled inside
  // runInTerminal()'s onDidCloseTerminal listener. Nothing extra needed here.

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      clearTrackedTerminalState(terminal);
    }),
  );

  context.subscriptions.push(npmOutput, ngOutput, diagnosticOutput);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('angularCliPlus.checkToolVersions.enabled')) {
        const tvEnabled = vscode.workspace
          .getConfiguration('angularCliPlus')
          .get<boolean>('checkToolVersions.enabled', true);
        if (tvEnabled) {
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            void checkToolVersions(folder.uri.fsPath);
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

export function deactivate() {
  for (const timeout of depCheckTimeouts.values()) {
    clearTimeout(timeout);
  }
  depCheckTimeouts.clear();
}
