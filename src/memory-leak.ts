import * as vscode from 'vscode';
import * as path from 'path';
import {
  resolveWorkspaceAndAngularJson,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
} from './utils';
import { findMemoryLeaksInFile, MemoryLeakLocation, MemoryLeakKind } from './ast-utils';

const COMMAND_KEY = 'checkMemoryLeaks';

// ── Entry point ────────────────────────────────────────────────────────────────

export async function checkMemoryLeaks(): Promise<void> {
  const resolved = await resolveWorkspaceAndAngularJson();
  if (!resolved) {
    return;
  }
  const { workspaceRoot, projects } = resolved;

  const projectNames = Object.keys(projects);

  // ── Build quick-pick choices ───────────────────────────────────────────────

  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const isTypeScriptFile =
    !!activeFile && activeFile.endsWith('.ts') && !activeFile.endsWith('.spec.ts');
  const CURRENT_FILE_LABEL = isTypeScriptFile
    ? `$(file)  Current file (${path.basename(activeFile!)})`
    : null;

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
    ...(CURRENT_FILE_LABEL ? [CURRENT_FILE_LABEL] : []),
    ...(CURRENT_PROJECT_LABEL ? [CURRENT_PROJECT_LABEL] : []),
    ...(LAST_LABEL ? [LAST_LABEL] : []),
    ...projectNames,
  ];

  if (choices.length === 0) {
    vscode.window.showErrorMessage('No Angular projects found and no TypeScript file is open.');
    return;
  }

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select a file or project to check for memory leaks',
    title: 'Angular: Check Memory Leaks',
  });

  if (!picked) {
    return;
  }

  // ── Resolve file list from selection ──────────────────────────────────────

  let filesToCheck: string[] = [];

  if (CURRENT_FILE_LABEL && picked === CURRENT_FILE_LABEL) {
    filesToCheck = [activeFile!];
  } else {
    let projectName: string;
    if (CURRENT_PROJECT_LABEL && picked === CURRENT_PROJECT_LABEL) {
      projectName = currentInList!;
      setLastProject(COMMAND_KEY, projectName);
    } else if (LAST_LABEL && picked === LAST_LABEL) {
      projectName = lastInList!;
    } else {
      projectName = picked;
      setLastProject(COMMAND_KEY, projectName);
    }

    const project = projects[projectName];
    const projectRoot = project?.sourceRoot ?? project?.root ?? projectName;
    const absoluteProjectRoot = path.isAbsolute(projectRoot)
      ? projectRoot
      : path.join(workspaceRoot, projectRoot);

    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(absoluteProjectRoot, '**/*.ts'),
      new vscode.RelativePattern(absoluteProjectRoot, '**/*.spec.ts'),
    );
    filesToCheck = uris.map((u) => u.fsPath);
  }

  if (filesToCheck.length === 0) {
    vscode.window.showWarningMessage('No TypeScript files found for the selected scope.');
    return;
  }

  // ── Run AST analysis with progress ────────────────────────────────────────

  const results = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Checking for memory leaks…',
      cancellable: false,
    },
    async (progress) => {
      const leaks: MemoryLeakLocation[] = [];
      const total = filesToCheck.length;
      for (let i = 0; i < total; i++) {
        const file = filesToCheck[i];
        progress.report({
          increment: (1 / total) * 100,
          message: path.basename(file),
        });
        const fileLeaks = findMemoryLeaksInFile(file);
        leaks.push(...fileLeaks);
      }
      return leaks;
    },
  );

  // ── Show results ──────────────────────────────────────────────────────────

  if (results.length === 0) {
    vscode.window.showInformationMessage('No memory leaks detected. Great job!');
    return;
  }

  showMemoryLeaksWebview(results, workspaceRoot, filesToCheck);
}

// ── Webview ────────────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;

function showMemoryLeaksWebview(
  leaks: MemoryLeakLocation[],
  workspaceRoot: string,
  filesToCheck: string[],
): void {
  if (activePanel) {
    activePanel.title = `Memory Leaks (${leaks.length})`;
    activePanel.webview.html = buildWebviewHtml(leaks, workspaceRoot);
    activePanel.reveal(undefined, true);
  } else {
    activePanel = vscode.window.createWebviewPanel(
      'angularMemoryLeaks',
      `Memory Leaks (${leaks.length})`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    activePanel.webview.html = buildWebviewHtml(leaks, workspaceRoot);
    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });
  }

  activePanel.webview.onDidReceiveMessage(
    async (message: { command: string; file: string; line: number }) => {
      if (message.command === 'openFile') {
        const uri = vscode.Uri.file(message.file);
        void vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(
            new vscode.Position(message.line - 1, 0),
            new vscode.Position(message.line - 1, 0),
          ),
          preview: false,
        });
      } else if (message.command === 'reload') {
        const freshLeaks = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Checking for memory leaks…',
            cancellable: false,
          },
          async (progress) => {
            const found: MemoryLeakLocation[] = [];
            const total = filesToCheck.length;
            for (let i = 0; i < total; i++) {
              progress.report({
                increment: (1 / total) * 100,
                message: path.basename(filesToCheck[i]),
              });
              found.push(...findMemoryLeaksInFile(filesToCheck[i]));
            }
            return found;
          },
        );
        if (activePanel) {
          activePanel.title = `Memory Leaks (${freshLeaks.length})`;
          activePanel.webview.html = buildWebviewHtml(freshLeaks, workspaceRoot);
        }
      }
    },
  );
}

function buildWebviewHtml(leaks: MemoryLeakLocation[], workspaceRoot: string): string {
  // Group leaks by relative file path
  const byFile = new Map<string, MemoryLeakLocation[]>();
  for (const leak of leaks) {
    const rel = path.relative(workspaceRoot, leak.file).replaceAll(path.sep, '/');
    const group = byFile.get(rel) ?? [];
    group.push(leak);
    byFile.set(rel, group);
  }

  const kindLabel: Record<MemoryLeakKind, string> = {
    'unguarded-subscribe': 'Unguarded',
    'nested-subscribe': 'Nested',
    'uncleared-interval': 'Interval',
    'uncleared-timeout': 'Timeout',
    'unremoved-event-listener': 'Event Listener',
    'unremoved-renderer-listener': 'Renderer Listener',
    'retained-dom-reference': 'DOM Reference',
    'incomplete-destroy-subject': 'Destroy Subject',
  };

  const fileGroups = Array.from(byFile.entries())
    .map(([relPath, fileleaks]) => {
      const dir = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/') + 1) : '';
      const filename = path.basename(relPath);
      const absolutePath = escapeHtml(fileleaks[0].file);
      const countLabel = fileleaks.length === 1 ? '1 leak' : `${fileleaks.length} leaks`;

      const leakRows = fileleaks
        .map((leak) => {
          const highlightedSnippet = escapeHtml(leak.snippet)
            .replace(/(\.\s*subscribe\s*\()/g, '<mark>$1</mark>')
            .replace(/(setInterval\s*\()/g, '<mark>$1</mark>')
            .replace(/(setTimeout\s*\()/g, '<mark>$1</mark>')
            .replace(/(addEventListener\s*\()/g, '<mark>$1</mark>')
            .replace(/(\.listen\s*\()/g, '<mark>$1</mark>')
            .replace(
              /(getElementById|querySelector(?:All)?|getElementsByClassName|getElementsByTagName|getElementsByName)(\s*\()/g,
              '<mark>$1$2</mark>',
            )
            .replace(
              /(new\s+(?:Subject|BehaviorSubject|ReplaySubject|AsyncSubject)\s*[<(])/g,
              '<mark>$1</mark>',
            );
          return /* html */ `
          <div class="leak-item" data-kind="${leak.kind}">
            <a class="line-num" href="#" data-file="${absolutePath}" data-line="${leak.line}">Line ${leak.line}</a>
            <span class="kind-pill kind-${leak.kind}">${kindLabel[leak.kind]}</span>
            <code class="snippet">${highlightedSnippet}</code>
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
        </div>
        <div class="leak-list">${leakRows}</div>
      </div>`;
    })
    .join('\n');

  const filesCount = byFile.size;
  const unguardedCount = leaks.filter((l) => l.kind === 'unguarded-subscribe').length;
  const nestedCount = leaks.filter((l) => l.kind === 'nested-subscribe').length;
  const intervalCount = leaks.filter((l) => l.kind === 'uncleared-interval').length;
  const listenerCount = leaks.filter((l) => l.kind === 'unremoved-event-listener').length;
  const domRefCount = leaks.filter((l) => l.kind === 'retained-dom-reference').length;
  const timeoutCount = leaks.filter((l) => l.kind === 'uncleared-timeout').length;
  const rendererListenerCount = leaks.filter(
    (l) => l.kind === 'unremoved-renderer-listener',
  ).length;
  const destroySubjectCount = leaks.filter((l) => l.kind === 'incomplete-destroy-subject').length;

  const statsParts: string[] = [`${filesCount} file${filesCount !== 1 ? 's' : ''} affected`];
  if (unguardedCount > 0) statsParts.push(`${unguardedCount} unguarded`);
  if (nestedCount > 0) statsParts.push(`${nestedCount} nested`);
  if (intervalCount > 0)
    statsParts.push(`${intervalCount} interval${intervalCount !== 1 ? 's' : ''}`);
  if (timeoutCount > 0) statsParts.push(`${timeoutCount} timeout${timeoutCount !== 1 ? 's' : ''}`);
  if (listenerCount > 0)
    statsParts.push(`${listenerCount} event listener${listenerCount !== 1 ? 's' : ''}`);
  if (rendererListenerCount > 0)
    statsParts.push(
      `${rendererListenerCount} renderer listener${rendererListenerCount !== 1 ? 's' : ''}`,
    );
  if (domRefCount > 0) statsParts.push(`${domRefCount} DOM ref${domRefCount !== 1 ? 's' : ''}`);
  if (destroySubjectCount > 0)
    statsParts.push(
      `${destroySubjectCount} destroy subject${destroySubjectCount !== 1 ? 's' : ''}`,
    );
  const statsLabel = statsParts.join(' &middot; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Memory Leaks</title>
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

    /* ── Header ── */
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

    .warn-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--vscode-inputValidation-warningBackground, #6b5000);
      color: var(--vscode-inputValidation-warningForeground, #ffcc00);
      flex-shrink: 0;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
    }

    h1 {
      font-size: 1.15em;
      font-weight: 600;
      color: var(--vscode-foreground);
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

    .legend {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }

    .legend-desc {
    }

    .legend-desc-group {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
    }

    .legend-fix {
      font-size: 0.78em;
      color: var(--vscode-foreground, #ccc);
      opacity: 0.6;
    }

    .legend-sep {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.18));
      margin: 5px 0;
    }

    .hint {
      display: inline;
      font-size: 0.82em;
      color: var(--vscode-descriptionForeground);
    }

    .hint code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.95em;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 0 4px;
      border-radius: 3px;
      color: var(--vscode-foreground);
    }

    /* ── Kind pills ── */
    .kind-pill {
      flex-shrink: 0;
      font-size: 0.72em;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      padding: 1px 7px;
      border-radius: 8px;
      white-space: nowrap;
    }

    .kind-unguarded-subscribe {
      background: rgba(204, 167, 0, 0.18);
      color: var(--vscode-problemsWarningIcon-foreground, #cca700);
      border: 1px solid rgba(204, 167, 0, 0.35);
    }

    .kind-nested-subscribe {
      background: rgba(240, 100, 80, 0.15);
      color: var(--vscode-problemsErrorIcon-foreground, #f06450);
      border: 1px solid rgba(240, 100, 80, 0.3);
    }

    .kind-uncleared-interval {
      background: rgba(100, 160, 240, 0.15);
      color: var(--vscode-terminal-ansiBrightBlue, #6aa0f0);
      border: 1px solid rgba(100, 160, 240, 0.3);
    }

    .kind-unremoved-event-listener {
      background: rgba(180, 100, 240, 0.15);
      color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
      border: 1px solid rgba(180, 100, 240, 0.3);
    }

    .kind-retained-dom-reference {
      background: rgba(60, 180, 140, 0.15);
      color: var(--vscode-terminal-ansiBrightGreen, #3cb48c);
      border: 1px solid rgba(60, 180, 140, 0.3);
    }

    .kind-uncleared-timeout {
      background: rgba(100, 160, 240, 0.12);
      color: var(--vscode-terminal-ansiBrightCyan, #5bb8d4);
      border: 1px solid rgba(100, 160, 240, 0.28);
    }

    .kind-unremoved-renderer-listener {
      background: rgba(240, 140, 60, 0.15);
      color: var(--vscode-terminal-ansiBrightYellow, #e8a020);
      border: 1px solid rgba(240, 140, 60, 0.3);
    }

    .kind-incomplete-destroy-subject {
      background: rgba(220, 80, 160, 0.15);
      color: var(--vscode-terminal-ansiBrightMagenta, #dc50a0);
      border: 1px solid rgba(220, 80, 160, 0.3);
    }

    /* ── File groups ── */
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

    .file-dir {
      color: var(--vscode-descriptionForeground);
    }

    .file-name {
      color: var(--vscode-foreground);
      font-weight: 600;
    }

    .file-badge {
      flex-shrink: 0;
      font-size: 0.75em;
      font-weight: 600;
      padding: 1px 8px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* ── Leak items ── */
    .leak-list {
      display: flex;
      flex-direction: column;
    }

    .leak-item {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 7px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      transition: background 0.1s;
    }

    .leak-item:last-child {
      border-bottom: none;
    }

    .leak-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .line-num {
      flex-shrink: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      min-width: 52px;
      text-align: right;
      opacity: 0.85;
    }

    .line-num:hover {
      text-decoration: underline;
      opacity: 1;
    }

    .snippet {
      flex: 1;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.88em;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
      padding: 3px 8px;
      border-radius: 4px;
      white-space: pre;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }

    mark {
      background: transparent;
      color: var(--vscode-problemsWarningIcon-foreground, #cca700);
      font-weight: 600;
    }

    /* ── Reload button ── */
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

    .reload-btn.spinning svg {
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* ── Filter toggle pills ── */
    .legend-item .kind-pill {
      cursor: pointer;
      user-select: none;
      transition: opacity 0.15s, text-decoration 0.15s;
    }

    .legend-item .kind-pill:hover {
      opacity: 0.8;
    }

    .legend-item .kind-pill.pill-off {
      opacity: 0.35;
      text-decoration: line-through;
    }

    .file-group.all-hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-title">
      <span class="warn-icon">!</span>
      <h1>Angular Memory Leaks</h1>
      <span class="badge">${leaks.length}</span>
      <button class="reload-btn" id="reloadBtn" title="Re-run analysis">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13">
          <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L11 6h3.5V2.5L13 4a7 7 0 1 0 .5 4H13.5z" fill="currentColor"/>
        </svg>
        Reload
      </button>
    </div>
    <p class="stats">${statsLabel}</p>
    <div class="legend">
      <span class="legend-item">
        <span class="kind-pill kind-unguarded-subscribe" data-kind="unguarded-subscribe">Unguarded</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Missing <code class="hint-code">untilDestroyed()</code> or <code class="hint-code">takeUntilDestroyed()</code> as the last operator in <code class="hint-code">.pipe()</code></span>
          <span class="legend-fix"><strong>Fix:</strong> add <code class="hint-code">.pipe(takeUntilDestroyed())</code> (Angular 16+) or <code class="hint-code">.pipe(untilDestroyed(this))</code> before <code class="hint-code">.subscribe()</code></span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-nested-subscribe" data-kind="nested-subscribe">Nested</span>
        <span class="legend-desc-group">
          <span class="legend-desc"><code class="hint-code">.subscribe()</code> called inside another <code class="hint-code">.subscribe()</code> callback</span>
          <span class="legend-fix"><strong>Fix:</strong> flatten with <code class="hint-code">switchMap</code>, <code class="hint-code">mergeMap</code>, or <code class="hint-code">concatMap</code> instead of nesting subscriptions</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-uncleared-interval" data-kind="uncleared-interval">Interval</span>
        <span class="legend-desc-group">
          <span class="legend-desc"><code class="hint-code">setInterval()</code> whose return value is never passed to <code class="hint-code">clearInterval()</code> in <code class="hint-code">ngOnDestroy()</code></span>
          <span class="legend-fix"><strong>Fix:</strong> store the ID and call <code class="hint-code">clearInterval(this.intervalId)</code> inside <code class="hint-code">ngOnDestroy()</code></span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-unremoved-event-listener" data-kind="unremoved-event-listener">Event Listener</span>
        <span class="legend-desc-group">
          <span class="legend-desc"><code class="hint-code">addEventListener()</code> with no matching <code class="hint-code">removeEventListener()</code> in <code class="hint-code">ngOnDestroy()</code></span>
          <span class="legend-fix"><strong>Fix:</strong> call <code class="hint-code">removeEventListener()</code> with the same handler reference in <code class="hint-code">ngOnDestroy()</code>; prefer <code class="hint-code">@HostListener</code> or <code class="hint-code">Renderer2.listen()</code></span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-retained-dom-reference" data-kind="retained-dom-reference">DOM Reference</span>
        <span class="legend-desc-group">
          <span class="legend-desc"><code class="hint-code">document.querySelector()</code> / <code class="hint-code">getElementById()</code> result stored on <code class="hint-code">this</code> but never nulled out in <code class="hint-code">ngOnDestroy()</code></span>
          <span class="legend-fix"><strong>Fix:</strong> set the property to <code class="hint-code">null</code> in <code class="hint-code">ngOnDestroy()</code>; prefer <code class="hint-code">@ViewChild</code> for template elements</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-uncleared-timeout" data-kind="uncleared-timeout">Timeout</span>
        <span class="legend-desc-group">
          <span class="legend-desc"><code class="hint-code">setTimeout()</code> whose return value is stored but never passed to <code class="hint-code">clearTimeout()</code> in <code class="hint-code">ngOnDestroy()</code></span>
          <span class="legend-fix"><strong>Fix:</strong> call <code class="hint-code">clearTimeout(this.timeoutId)</code> inside <code class="hint-code">ngOnDestroy()</code></span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-unremoved-renderer-listener" data-kind="unremoved-renderer-listener">Renderer Listener</span>
        <span class="legend-desc-group">
          <span class="legend-desc"><code class="hint-code">renderer.listen()</code> return value stored on <code class="hint-code">this</code> but the cleanup function is never called in <code class="hint-code">ngOnDestroy()</code></span>
          <span class="legend-fix"><strong>Fix:</strong> call the stored cleanup function (e.g. <code class="hint-code">this.unlisten()</code>) inside <code class="hint-code">ngOnDestroy()</code></span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-incomplete-destroy-subject" data-kind="incomplete-destroy-subject">Destroy Subject</span>
        <span class="legend-desc-group">
          <span class="legend-desc"><code class="hint-code">Subject</code> used in <code class="hint-code">takeUntil()</code> but <code class="hint-code">.next()</code> / <code class="hint-code">.complete()</code> is never called in <code class="hint-code">ngOnDestroy()</code></span>
          <span class="legend-fix"><strong>Fix:</strong> add <code class="hint-code">this.destroy$.next(); this.destroy$.complete();</code> to <code class="hint-code">ngOnDestroy()</code>, or switch to <code class="hint-code">takeUntilDestroyed()</code></span>
        </span>
      </span>
    </div>
  </div>

  <div class="file-list">
    ${fileGroups}
  </div>

  <style>
    .hint-code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 0 4px;
      border-radius: 3px;
      color: var(--vscode-foreground);
    }
  </style>

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

    // ── Reload button ──────────────────────────────────────────────────
    var reloadBtn = document.getElementById('reloadBtn');
    reloadBtn.addEventListener('click', function() {
      reloadBtn.classList.add('spinning');
      reloadBtn.disabled = true;
      vscode.postMessage({ command: 'reload' });
    });

    // ── Kind filter toggles ──────────────────────────────────────────────────
    document.querySelectorAll('.legend-item .kind-pill[data-kind]').forEach(function(pill) {
      pill.addEventListener('click', function() {
        var kind = pill.getAttribute('data-kind');
        var isOff = pill.classList.toggle('pill-off');

        // Show/hide all leak items of this kind
        document.querySelectorAll('.leak-item[data-kind="' + kind + '"]').forEach(function(item) {
          item.style.display = isOff ? 'none' : '';
        });

        // Hide file groups where every leak item is hidden
        document.querySelectorAll('.file-group').forEach(function(group) {
          var items = group.querySelectorAll('.leak-item');
          var allHidden = Array.prototype.every.call(items, function(item) {
            return item.style.display === 'none';
          });
          group.classList.toggle('all-hidden', allHidden);
        });
      });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
