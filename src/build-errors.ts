import * as vscode from 'vscode';
import * as path from 'path';
import {
  resolveWorkspaceAndAngularJson,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
  resolveAngularCliSpawn,
} from './utils';
import type { AngularProject } from './types';
import { spawnCapture } from './dependencies';
import { detectCliVersion } from './version';
import { getBuildConfigFlag } from './version-adapter';

const COMMAND_KEY = 'checkBuildErrors';

export interface BuildError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function checkBuildErrors(): Promise<void> {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const projectNames = Object.keys(projects);

  const currentProject = detectActiveFileProject(workspaceRoot, projects);
  const currentInList =
    currentProject && projectNames.includes(currentProject) ? currentProject : null;
  const CURRENT_PROJECT_LABEL = currentInList
    ? `$(folder)  Current project (${currentInList})`
    : null;

  const last = getLastProject(COMMAND_KEY);
  const lastInList = last && projectNames.includes(last) && last !== currentInList ? last : null;
  const LAST_LABEL = lastInList ? `$(history)  Last used (${lastInList})` : null;

  const choices = [
    ...(CURRENT_PROJECT_LABEL ? [CURRENT_PROJECT_LABEL] : []),
    ...(LAST_LABEL ? [LAST_LABEL] : []),
    ...projectNames,
  ];

  if (choices.length === 0) {
    vscode.window.showErrorMessage('No Angular projects found.');
    return;
  }

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select a project to check for build errors',
    title: 'Angular: Check Build Errors',
  });

  if (!picked) {
    return;
  }

  let projectName: string;
  if (CURRENT_PROJECT_LABEL && picked === CURRENT_PROJECT_LABEL) {
    projectName = currentInList!;
  } else if (LAST_LABEL && picked === LAST_LABEL) {
    projectName = lastInList!;
  } else {
    projectName = picked;
  }
  setLastProject(COMMAND_KEY, projectName);

  await runAndCheckBuildErrors(workspaceRoot, projectName, projects[projectName]);
}

// ── Build Execution ────────────────────────────────────────────────────────────

async function runAndCheckBuildErrors(
  workspaceRoot: string,
  projectName: string,
  projectDef: AngularProject,
) {
  let capturedOutput = '';
  let builderType: 'esbuild' | 'webpack' = 'webpack';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Building ${projectName} to check for errors…`,
      cancellable: false,
    },
    async (progress) => {
      const cliVersion = await detectCliVersion(workspaceRoot);
      const builder = projectDef.architect?.build?.builder;

      if (
        builder === '@angular-devkit/build-angular:application' ||
        builder === '@angular-devkit/build-angular:browser-esbuild'
      ) {
        builderType = 'esbuild';
      } else if (builder === '@angular-devkit/build-angular:browser') {
        builderType = 'webpack';
      } else {
        builderType = cliVersion && cliVersion >= 17 ? 'esbuild' : 'webpack';
      }

      const config = vscode.workspace.getConfiguration('angularCliPlus');
      const effectiveConfig = config.get<string>('build.configuration', 'production');
      const configFlag = getBuildConfigFlag(effectiveConfig, cliVersion);

      const args = ['build', '--project', projectName];
      if (configFlag) {
        args.push(configFlag.trim());
      }

      const ngCommand = resolveAngularCliSpawn(workspaceRoot, args);
      const result = await spawnCapture(
        ngCommand.command,
        ngCommand.args,
        workspaceRoot,
        ngCommand.shell,
      );
      capturedOutput = result.stdout; // Usually errors can go to either
    },
  );

  const errors = parseBuildErrors(capturedOutput, builderType);
  showBuildErrorsWebview(errors, workspaceRoot, projectName);
}

// ── Parsing ────────────────────────────────────────────────────────────────────

function parseBuildErrors(rawOutput: string, builderType: 'esbuild' | 'webpack'): BuildError[] {
  // Strip ANSI color codes that esbuild or Angular CLI might inject
  const output = rawOutput.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = output.split(/\r?\n/);
  const errors: BuildError[] = [];
  let currentError: BuildError | null = null;

  const errorRegexWebpack =
    /^(?:Error:\s*)?((?:[A-Za-z]:)?[^:]+):(\d+):(\d+)\s*-\s*error\s+([A-Z0-9]+):\s*(.*)/;
  const errorRegexEsbuild = /^(?:X|✘) \[ERROR\] ([A-Z0-9]+):\s*(.*)/;
  const esbuildLocationRegex = /^\s+((?:[A-Za-z]:)?[^:]+):(\d+):(\d+):?\s*$/;

  for (const line of lines) {
    if (builderType === 'webpack') {
      const match = line.match(errorRegexWebpack);
      if (match) {
        if (currentError && currentError.file) {
          errors.push(currentError);
        }
        currentError = {
          file: match[1].trim(),
          line: parseInt(match[2], 10),
          col: parseInt(match[3], 10),
          code: match[4],
          message: match[5],
        };
      } else if (currentError) {
        if (line.trim() === '' || line.startsWith('✖') || line.startsWith('Warning:')) {
          if (currentError.file) {
            errors.push(currentError);
          }
          currentError = null;
        } else {
          currentError.message += '\n' + line;
        }
      }
    } else {
      const match = line.match(errorRegexEsbuild);
      if (match) {
        if (currentError && currentError.file) {
          errors.push(currentError);
        }
        currentError = {
          file: '', // will be extracted from subsequent lines
          line: 0,
          col: 0,
          code: match[1],
          message: match[2],
        };
      } else if (currentError) {
        if (!currentError.file) {
          const locMatch = line.match(esbuildLocationRegex);
          if (locMatch) {
            currentError.file = locMatch[1].trim();
            currentError.line = parseInt(locMatch[2], 10);
            currentError.col = parseInt(locMatch[3], 10);
          }
        }

        if (line.startsWith('Warning:') || line.match(/^(?:X|✘|⚠) \[WARNING\]/)) {
          if (currentError.file) {
            errors.push(currentError);
          }
          currentError = null;
          continue;
        }

        currentError.message += '\n' + line;
      }
    }
  }

  if (currentError && currentError.file) {
    errors.push(currentError);
  }

  // Deduplicate errors that are exactly the same on the same line and file
  const uniqueErrors: BuildError[] = [];
  const seen = new Set<string>();

  for (const err of errors) {
    const key = `${err.file}:${err.line}:${err.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueErrors.push(err);
    }
  }

  return uniqueErrors;
}

// ── Webview ────────────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;

function showBuildErrorsWebview(
  errors: BuildError[],
  workspaceRoot: string,
  projectName: string,
): void {
  if (activePanel) {
    activePanel.title = `Build Errors (${errors.length})`;
    activePanel.webview.html = buildWebviewHtml(errors, workspaceRoot, projectName);
    activePanel.reveal(undefined, true);
  } else {
    activePanel = vscode.window.createWebviewPanel(
      'angularBuildErrors',
      `Build Errors (${errors.length})`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    activePanel.webview.html = buildWebviewHtml(errors, workspaceRoot, projectName);
    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });

    activePanel.webview.onDidReceiveMessage(
      async (message: { command: string; file: string; line: number }) => {
        if (message.command === 'openFile') {
          const uri = vscode.Uri.file(path.join(workspaceRoot, message.file));
          try {
            await vscode.window.showTextDocument(uri, {
              selection: new vscode.Range(
                new vscode.Position(message.line - 1, 0),
                new vscode.Position(message.line - 1, 0),
              ),
              preview: false,
            });
          } catch (e) {
            vscode.window.showErrorMessage(`Could not open file: ${message.file}`);
          }
        } else if (message.command === 'reload') {
          const resolved = await resolveWorkspaceAndAngularJson();
          if (resolved) {
            await runAndCheckBuildErrors(
              workspaceRoot,
              projectName,
              resolved.projects[projectName],
            );
          }
        }
      },
    );
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildWebviewHtml(
  errors: BuildError[],
  workspaceRoot: string,
  projectName: string,
): string {
  if (errors.length === 0) {
    const funnyMessages = [
      '0 build errors! Time for a coffee break. ☕',
      "0 build errors! You're a wizard, Harry! 🧙‍♂️",
      "0 build errors! The code compiles on the first try... Wait, that's illegal! 🚔",
      '0 build errors! Ship it! 🚢',
      '0 build errors! Your code is flawless. 💎',
      '0 build errors! No bugs here, just happy little accidents. 🎨',
      '0 build errors! This is fine. 🔥',
      '0 build errors! Just Features. ✨',
      '0 build errors! Even Linus Torvalds would approve! 🐧',
      "0 build errors! You've achieved code enlightenment. ✨",
      '0 build errors! Did you just solve world peace? 🕊️',
      '0 build errors! Your code is so clean, Marie Kondo is jealous. 📦',
      "0 build errors! Congratulations, you're a digital wizard! 🪄",
      '0 build errors! No errors, no drama, just vibes. 😎',
      '0 build errors! You must have made a deal with the coding gods. 🙏',
      '0 build errors! You are the chosen one. 🌟',
      '0 build errors! You have transcended coding. 🧘‍♂️',
      '0 build errors! Your code is so perfect, it has its own fan club. 🎉',
      '0 build errors! You are the hero we deserve. 🦸‍♂️',
      '0 build errors! You are the code ninja. 🥷',
      '0 build errors! Your code is so clean, it sparkles. ✨',
    ];
    const randomMsg = funnyMessages[Math.floor(Math.random() * funnyMessages.length)];

    return /* html */ `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Build Errors</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-foreground);
          background: var(--vscode-editor-background);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          text-align: center;
          margin: 0;
        }
        h1 { font-size: 2em; color: var(--vscode-testing-iconPassed); }
        .reload-btn {
          margin-top: 20px;
          padding: 8px 16px;
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .reload-btn:hover {
          background: var(--vscode-button-hoverBackground);
        }
      </style>
    </head>
    <body>
      <h1>${randomMsg}</h1>
      <button class="reload-btn" id="reloadBtn">Build Again</button>
      <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('reloadBtn').addEventListener('click', () => {
          vscode.postMessage({ command: 'reload' });
        });
      </script>
    </body>
    </html>`;
  }

  // Group by file
  const byFile = new Map<string, BuildError[]>();
  for (const err of errors) {
    const group = byFile.get(err.file) ?? [];
    group.push(err);
    byFile.set(err.file, group);
  }

  const fileGroups = Array.from(byFile.entries())
    .map(([file, fileErrors]) => {
      const dir = file.includes('/') ? file.substring(0, file.lastIndexOf('/') + 1) : '';
      const filename = path.basename(file);
      const countLabel = fileErrors.length === 1 ? '1 error' : `${fileErrors.length} errors`;

      const issueRows = fileErrors
        .map((err) => {
          const codeLink = err.code.startsWith('NG')
            ? `<a href="https://angular.dev/errors/${err.code}" class="code-pill">Angular: ${err.code}</a>`
            : `<span class="code-pill ts-pill">TS: ${err.code}</span>`;

          const safeMessage = escapeHtml(err.message);
          const firstLine = escapeHtml(err.message.split(/\r?\n/)[0]);

          return /* html */ `
      <div class="issue-item">
        <div class="issue-header" title="Click to expand/collapse&#10;&#10;${safeMessage}">
          <a class="line-num" href="#" data-file="${escapeHtml(err.file)}" data-line="${err.line}">Line ${err.line}</a>
          ${codeLink}
          <div class="issue-summary">${firstLine}</div>
          <button class="toggle-btn" title="Expand/Collapse">
            <svg class="chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <div class="message">${safeMessage}</div>
      </div>`;
        })
        .join('');

      return /* html */ `
    <div class="file-group">
      <div class="file-header">
        <svg class="file-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M9 1v5h5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
        <span class="file-path"><span class="file-dir">${escapeHtml(dir)}</span><span class="file-name">${escapeHtml(filename)}</span></span>
        <span class="file-badge">${countLabel}</span>
        <button class="toggle-all-btn" title="Expand/Collapse All in file">
          <svg class="chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="issue-list">${issueRows}</div>
    </div>`;
    })
    .join('\n');

  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Build Errors</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px 24px 40px;
        line-height: 1.5;
      }
      .header {
        margin-bottom: 20px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .header-title {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 6px;
      }
      .error-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: rgba(240, 100, 80, 0.15);
        color: var(--vscode-problemsErrorIcon-foreground, #f06450);
        flex-shrink: 0;
        font-size: 14px;
        font-weight: 700;
        line-height: 1;
      }
      h1 {
        font-size: 1.15em;
        font-weight: 600;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        height: 18px;
        padding: 0 6px;
        border-radius: 9px;
        font-size: 0.75em;
        font-weight: 700;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
      .stats {
        font-size: 0.82em;
        color: var(--vscode-descriptionForeground);
      }
      .reload-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-left: auto;
        padding: 3px 10px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 4px;
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        font-size: 0.8em;
        font-family: var(--vscode-font-family);
        cursor: pointer;
        white-space: nowrap;
      }
      .reload-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25));
      }
      .file-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .file-group {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        overflow: hidden;
      }
      .file-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background, rgba(128,128,128,0.08)));
        border-bottom: 1px solid var(--vscode-panel-border);
        user-select: none;
      }
      .file-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: var(--vscode-descriptionForeground);
      }
      .file-path {
        flex: 1;
        font-size: 0.88em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .file-dir { color: var(--vscode-descriptionForeground); }
      .file-name { font-weight: 600; }
      .file-badge {
        flex-shrink: 0;
        font-size: 0.75em;
        font-weight: 600;
        padding: 1px 8px;
        border-radius: 8px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
      .issue-list {
        display: flex;
        flex-direction: column;
      }
      .issue-item {
        display: flex;
        flex-direction: column;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .issue-item:last-child {
        border-bottom: none;
      }
      .issue-header {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        cursor: pointer;
        transition: background 0.1s;
      }
      .issue-header:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .issue-summary {
        flex: 1;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.88em;
        color: var(--vscode-editor-foreground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-top: 1px;
      }
      .line-num {
        flex-shrink: 0;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.8em;
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
        min-width: 52px;
        text-align: right;
        margin-top: 2px;
      }
      .line-num:hover { text-decoration: underline; }
      .code-pill {
        flex-shrink: 0;
        font-size: 0.72em;
        font-weight: 700;
        text-transform: uppercase;
        padding: 2px 7px;
        border-radius: 8px;
        white-space: nowrap;
        background: rgba(240, 100, 80, 0.15);
        color: var(--vscode-problemsErrorIcon-foreground, #f06450);
        border: 1px solid rgba(240, 100, 80, 0.3);
        text-decoration: none;
        margin-top: 1px;
      }
      .code-pill:hover { opacity: 0.8; text-decoration: underline; }
      .ts-pill {
        background: rgba(100, 160, 240, 0.15);
        color: var(--vscode-terminal-ansiBrightBlue, #6aa0f0);
        border: 1px solid rgba(100, 160, 240, 0.3);
      }
      .message {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.88em;
        color: var(--vscode-editor-foreground);
        word-wrap: break-word;
        white-space: pre-wrap;
        display: none;
        padding: 4px 12px 12px 12px;
        margin-left: 72px;
      }
      .issue-item.expanded .message {
        display: block;
      }
      .issue-item.expanded .issue-summary {
        display: none;
      }
      .toggle-btn, .toggle-all-btn {
        background: transparent;
        border: none;
        color: var(--vscode-icon-foreground);
        cursor: pointer;
        padding: 2px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 3px;
        outline-offset: -1px;
      }
      .toggle-btn:hover, .toggle-all-btn:hover {
        background: var(--vscode-toolbar-hoverBackground);
      }
      .toggle-btn, .toggle-all-btn {
        margin-left: auto;
      }
      .chevron {
        width: 16px;
        height: 16px;
        transition: transform 0.15s ease-in-out;
      }
      .issue-item.expanded .chevron, .toggle-all-btn.expanded .chevron {
        transform: rotate(90deg);
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="header-title">
        <span class="error-icon">✕</span>
        <h1>Angular Build Errors</h1>
        <span class="badge">${errors.length}</span>
        <button class="reload-btn" id="reloadBtn">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13">
            <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L11 6h3.5V2.5L13 4a7 7 0 1 0 .5 4H13.5z" fill="currentColor"/>
          </svg>
          Reload
        </button>
      </div>
      <p class="stats">Project: ${escapeHtml(projectName)}</p>
    </div>
    <div class="file-list">
      ${fileGroups}
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      document.querySelectorAll('a[data-file]').forEach(function(link) {
        link.addEventListener('click', function(e) {
          e.preventDefault();
          vscode.postMessage({
            command: 'openFile',
            file: link.getAttribute('data-file'),
            line: parseInt(link.getAttribute('data-line'), 10)
          });
        });
      });
      document.getElementById('reloadBtn').addEventListener('click', function() {
        vscode.postMessage({ command: 'reload' });
      });
      document.querySelectorAll('.issue-header').forEach(function(header) {
        header.addEventListener('click', function(e) {
          if (e.target.closest('a') || e.target.closest('button')) {
            // Let the button click handler do its thing, or follow the link
            if (e.target.closest('a')) return;
          }
          const item = header.closest('.issue-item');
          item.classList.toggle('expanded');
        });
      });
      document.querySelectorAll('.toggle-all-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          const fileGroup = btn.closest('.file-group');
          const items = fileGroup.querySelectorAll('.issue-item');
          const isExpanded = btn.classList.contains('expanded');
          
          if (isExpanded) {
            btn.classList.remove('expanded');
            items.forEach(function(i) { i.classList.remove('expanded'); });
          } else {
            btn.classList.add('expanded');
            items.forEach(function(i) { i.classList.add('expanded'); });
          }
        });
      });
    </script>
  </body>
  </html>`;
}
