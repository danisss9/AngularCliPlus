import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import type { AngularProject, BrowserDebugConfig, DebugConfig } from './types';
import { activeServeTerminals, logDiagnostic } from './state';
import {
  resolveWorkspaceAndAngularJson,
  runInTerminal,
  pickProjectWithCurrentFile,
  getLastProject,
  setLastProject,
} from './utils';

// ── Timing constants ───────────────────────────────────────────────────────────
const RESTART_DEBUG_STOP_DELAY_MS = 500;
const RESTART_CTRL_C_DELAY_MS = 300;
const RESTART_CONFIRM_DELAY_MS = 700;
const PORT_CHECK_INTERVAL_MS = 1000;
const PORT_CHECK_SOCKET_TIMEOUT_MS = 1000;
const STOP_ALL_DELAYED_MS = 2000;

// ── Browser helpers ────────────────────────────────────────────────────────────

function findExecutable(candidates: string[]): string | undefined {
  return candidates.find((p) => fs.existsSync(p));
}

export function getBrowserDebugConfig(browser: string, executableOverride: string): BrowserDebugConfig | null {
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

// ── Debug commands ─────────────────────────────────────────────────────────────

export async function debugAngularProject(context: vscode.ExtensionContext) {
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

  logDiagnostic(`Starting debug session for ${projectName} on port ${port}`);

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

export async function debugStorybookProject(context: vscode.ExtensionContext) {
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

  const angularJsonPath = path.join(workspaceRoot, 'angular.json');
  if (fs.existsSync(angularJsonPath)) {
    try {
      const angularJson = JSON.parse(fs.readFileSync(angularJsonPath, 'utf-8')) as { projects?: Record<string, AngularProject> };
      for (const [projectName, project] of Object.entries(angularJson.projects ?? {})) {
        if (project.architect?.storybook) {
          entries.push({
            label: projectName,
            command: `ng run ${projectName}:storybook`,
            port: project.architect.storybook.options?.port ?? 6006,
          });
        }
      }
    } catch (err) {
      logDiagnostic(`Failed to parse angular.json for storybook detection: ${err}`);
    }
  }

  if (entries.length === 0) {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
        if (pkg.scripts?.storybook) {
          entries.push({ label: 'storybook', command: 'npm run storybook', port: 6006 });
        }
      } catch (err) {
        logDiagnostic(`Failed to parse package.json for storybook detection: ${err}`);
      }
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

  logDiagnostic(`Starting storybook debug session for ${entry.label} on port ${port}`);

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

export function resolveOutputPath(project: AngularProject, projectName: string, workspaceRoot: string): string {
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

export async function debugBuildWatchProject(context: vscode.ExtensionContext) {
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

  logDiagnostic(`Starting build watch debug session for ${projectName} on port ${port}`);

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

export async function restartAngularServe(context: vscode.ExtensionContext) {
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

  if (entry.activeDebugSession) {
    await vscode.debug.stopDebugging(entry.activeDebugSession);
    entry.activeDebugSession = undefined;
    await new Promise<void>((r) => setTimeout(r, RESTART_DEBUG_STOP_DELAY_MS));
  }

  entry.terminal.show();
  entry.terminal.sendText('\x03');
  await new Promise<void>((r) => setTimeout(r, RESTART_CTRL_C_DELAY_MS));
  entry.terminal.sendText('y');
  await new Promise<void>((r) => setTimeout(r, RESTART_CONFIRM_DELAY_MS));
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

// ── Core debug session launcher ───────────────────────────────────────────────

export function launchBrowserDebugSession(
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
    setTimeout(() => allTerminals.forEach((t) => t.dispose()), STOP_ALL_DELAYED_MS);
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

// ── Port waiting ──────────────────────────────────────────────────────────────

export function waitForPort(
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
      socket.setTimeout(PORT_CHECK_SOCKET_TIMEOUT_MS);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      const onFail = () => {
        socket.destroy();
        setTimeout(attempt, PORT_CHECK_INTERVAL_MS);
      };

      socket.on('timeout', onFail);
      socket.on('error', onFail);
      socket.connect(port, 'localhost');
    }

    attempt();
  });
}

// ── Debug config helper ───────────────────────────────────────────────────────

export function resolveBrowserConfig(vsConfig: vscode.WorkspaceConfiguration): { browserSetting: string; browserDebugConfig: BrowserDebugConfig } | null {
  const browserSetting = vsConfig.get<string>('debug.browser', 'chrome');
  const executableOverride = (vsConfig.get<string>('debug.browserExecutablePath') ?? '').trim();
  const browserDebugConfig = getBrowserDebugConfig(browserSetting, executableOverride);
  if (!browserDebugConfig) { return null; }
  return { browserSetting, browserDebugConfig };
}

// ── Re-export DebugConfig for use in commands ─────────────────────────────────
export type { DebugConfig };
