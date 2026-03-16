import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as semver from 'semver';
import { npmOutput, depCheckTimeouts, logDiagnostic } from './state';

// ── Timing constants ───────────────────────────────────────────────────────────
const DEP_CHECK_STARTUP_DELAY_MS = 3000;
const DEP_CHECK_CHANGE_DELAY_MS = 2000;

// ── Input validation ──────────────────────────────────────────────────────────

/**
 * Validates a user-provided shell command before execution.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateCustomCommand(command: string): string | null {
  if (!command || command.trim() === '') {
    return 'Command cannot be empty';
  }
  // Block obviously dangerous patterns: command chaining with unescaped operators
  // that could be injected via settings (e.g. "npm install; rm -rf /")
  if (/;\s*(rm|del|format|mkfs|dd)\b/i.test(command)) {
    return `Command contains potentially dangerous operations`;
  }
  return null;
}

// ── Semver check (delegates to battle-tested semver package) ──────────────────

export function semverSatisfies(installed: string, required: string): boolean {
  const req = required.trim();
  if (!req || req === '*' || req === 'latest') {
    return true;
  }
  // Skip non-semver specs (git, file, workspace, URLs)
  if (/^(git|file:|workspace:|https?:|github:)/.test(req)) {
    return true;
  }

  try {
    const coerced = semver.coerce(installed);
    if (!coerced) { return false; }
    return semver.satisfies(coerced, req);
  } catch {
    // If semver can't parse it, fall back to allowing the version
    logDiagnostic(`semver parse failed for installed="${installed}" required="${req}"`);
    return true;
  }
}

// ── npm / ng spawning ─────────────────────────────────────────────────────────

export function spawnNpm(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    npmOutput.appendLine(`> npm ${args.join(' ')}\n`);
    const proc = cp.spawn('npm', args, { cwd, shell: true });
    proc.stdout.on('data', (d: Buffer) => npmOutput.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => npmOutput.append(d.toString()));
    proc.on('close', (code) => resolve(code ?? 1));
  });
}

export function spawnShellCommand(command: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    npmOutput.appendLine(`> ${command}\n`);
    const proc = cp.spawn(command, [], { cwd, shell: true });
    proc.stdout.on('data', (d: Buffer) => npmOutput.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => npmOutput.append(d.toString()));
    proc.on('close', (code) => resolve(code ?? 1));
  });
}

// ── npm install ───────────────────────────────────────────────────────────────

export async function runNpmInstall(clean: boolean, force = false, workspaceRoot?: string) {
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
    const validationError = validateCustomCommand(customCleanInstall);
    if (validationError) {
      vscode.window.showErrorMessage(`Invalid clean install command: ${validationError}`);
      return;
    }
    npmOutput.appendLine(`> ${customCleanInstall}\n`);
    const exitCode = await spawnShellCommand(customCleanInstall, workspaceRoot);
    if (exitCode === 0) {
      vscode.window.showInformationMessage('Clean install completed successfully.');
    } else {
      vscode.window.showErrorMessage("Custom clean install failed. Check the 'Angular CLI Plus: npm' output for details.");
    }
    return;
  }

  if (!clean && !force && customInstall) {
    const validationError = validateCustomCommand(customInstall);
    if (validationError) {
      vscode.window.showErrorMessage(`Invalid install command: ${validationError}`);
      return;
    }
    npmOutput.appendLine(`> ${customInstall}\n`);
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

// ── Dependency checking ───────────────────────────────────────────────────────

export function setupDependencyCheck(context: vscode.ExtensionContext, workspaceRoot: string) {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return;
  }

  const config = vscode.workspace.getConfiguration('angularCliPlus');
  if (config.get<boolean>('checkDependencies.enabled', true)) {
    scheduleDependencyCheck(workspaceRoot, DEP_CHECK_STARTUP_DELAY_MS);
  }

  const gitHead = path.join(workspaceRoot, '.git', 'HEAD');
  if (fs.existsSync(gitHead)) {
    try {
      const fsWatcher = fs.watch(gitHead, () => scheduleDependencyCheck(workspaceRoot, DEP_CHECK_CHANGE_DELAY_MS));
      context.subscriptions.push({ dispose: () => fsWatcher.close() });
    } catch (err) {
      logDiagnostic(`fs.watch unavailable for .git/HEAD (${err}), falling back to VS Code watcher`);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.join(workspaceRoot, '.git')), 'HEAD'),
      );
      watcher.onDidChange(() => scheduleDependencyCheck(workspaceRoot, DEP_CHECK_CHANGE_DELAY_MS));
      context.subscriptions.push(watcher);
    }
  }

  const pkgWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(workspaceRoot), 'package.json'),
  );
  pkgWatcher.onDidChange(() => scheduleDependencyCheck(workspaceRoot, DEP_CHECK_CHANGE_DELAY_MS));
  context.subscriptions.push(pkgWatcher);
}

export function scheduleDependencyCheck(workspaceRoot: string, delayMs: number) {
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

export async function checkDependencies(workspaceRoot: string) {
  const config = vscode.workspace.getConfiguration('angularCliPlus');
  if (!config.get<boolean>('checkDependencies.enabled', true)) {
    return;
  }

  const pkgPath = path.join(workspaceRoot, 'package.json');
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'));
  } catch (err) {
    logDiagnostic(`Failed to read package.json for dependency check: ${err}`);
    return;
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (Object.keys(allDeps).length === 0) {
    return;
  }

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

export async function runCheckDependencies(workspaceRoot: string) {
  await checkDependencies(workspaceRoot);
}

// ── Tool version checking ─────────────────────────────────────────────────────

export function spawnCapture(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    let out = '';
    const proc = cp.spawn(cmd, args, { cwd, shell: true });
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', (code) => resolve({ stdout: out, exitCode: code ?? 1 }));
  });
}

export async function attemptToolUpdate(
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

export async function checkToolVersions(workspaceRoot: string) {
  const config = vscode.workspace.getConfiguration('angularCliPlus');
  if (!config.get<boolean>('checkToolVersions.enabled', true)) {
    return;
  }

  const pkgPath = path.join(workspaceRoot, 'package.json');
  let pkg: { engines?: Record<string, string> };
  try {
    pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'));
  } catch (err) {
    logDiagnostic(`Failed to read package.json for tool version check: ${err}`);
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

export async function runCheckToolVersions(workspaceRoot: string) {
  await checkToolVersions(workspaceRoot);
}
