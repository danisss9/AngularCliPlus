import * as vscode from 'vscode';
import * as path from 'path';
import {
  resolveWorkspaceAndAngularJson,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
} from './utils';
import { findOptimizationsInFile, OptimizationLocation, OptimizationKind } from './optimizations-ast';

const COMMAND_KEY = 'checkOptimizations';

// ── Entry point ────────────────────────────────────────────────────────────────

export async function checkOptimizations(): Promise<void> {
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
    placeHolder: 'Select a file or project to check for optimizations',
    title: 'Angular: Check Optimizations',
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
      title: 'Checking for optimizations…',
      cancellable: false,
    },
    async (progress) => {
      const issues: OptimizationLocation[] = [];
      const total = filesToCheck.length;
      for (let i = 0; i < total; i++) {
        const file = filesToCheck[i];
        progress.report({
          increment: (1 / total) * 100,
          message: path.basename(file),
        });
        const fileIssues = findOptimizationsInFile(file);
        issues.push(...fileIssues);
      }
      return issues;
    },
  );

  // ── Show results ──────────────────────────────────────────────────────────

  if (results.length === 0) {
    vscode.window.showInformationMessage('No optimization issues detected. Great job!');
    return;
  }

  showOptimizationsWebview(results, workspaceRoot, filesToCheck);
}

// ── Webview ────────────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;

function showOptimizationsWebview(
  issues: OptimizationLocation[],
  workspaceRoot: string,
  filesToCheck: string[],
): void {
  if (activePanel) {
    activePanel.title = `Optimizations (${issues.length})`;
    activePanel.webview.html = buildWebviewHtml(issues, workspaceRoot);
    activePanel.reveal(undefined, true);
  } else {
    activePanel = vscode.window.createWebviewPanel(
      'angularOptimizations',
      `Optimizations (${issues.length})`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    activePanel.webview.html = buildWebviewHtml(issues, workspaceRoot);
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
        const freshIssues = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Checking for optimizations…',
            cancellable: false,
          },
          async (progress) => {
            const found: OptimizationLocation[] = [];
            const total = filesToCheck.length;
            for (let i = 0; i < total; i++) {
              progress.report({
                increment: (1 / total) * 100,
                message: path.basename(filesToCheck[i]),
              });
              found.push(...findOptimizationsInFile(filesToCheck[i]));
            }
            return found;
          },
        );
        if (activePanel) {
          activePanel.title = `Optimizations (${freshIssues.length})`;
          activePanel.webview.html = buildWebviewHtml(freshIssues, workspaceRoot);
        }
      }
    },
  );
}

function buildWebviewHtml(issues: OptimizationLocation[], workspaceRoot: string): string {
  // Group issues by relative file path
  const byFile = new Map<string, OptimizationLocation[]>();
  for (const issue of issues) {
    const rel = path.relative(workspaceRoot, issue.file).replaceAll(path.sep, '/');
    const group = byFile.get(rel) ?? [];
    group.push(issue);
    byFile.set(rel, group);
  }

  const kindLabel: Record<OptimizationKind, string> = {
    'missing-on-push': 'Missing OnPush',
    'missing-track-by': 'Missing trackBy',
    'function-in-template': 'Function in Template',
    'unnecessary-zone-work': 'Unnecessary Zone.js Work',
    'large-component': 'Large Component',
  };

  const fileGroups = Array.from(byFile.entries())
    .map(([relPath, fileIssues]) => {
      const dir = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/') + 1) : '';
      const filename = path.basename(relPath);
      const absolutePath = escapeHtml(fileIssues[0].file);
      const countLabel = fileIssues.length === 1 ? '1 issue' : `${fileIssues.length} issues`;

      const issueRows = fileIssues
        .map((issue) => {
          const highlightedSnippet = escapeHtml(issue.snippet)
            .replace(/(@Component)/g, '<mark>$1</mark>')
            .replace(/(\*ngFor)/g, '<mark>$1</mark>')
            .replace(/(\{\{.*?\}\})/g, '<mark>$1</mark>')
            .replace(/(setTimeout\s*\()/g, '<mark>$1</mark>')
            .replace(/(setInterval\s*\()/g, '<mark>$1</mark>')
            .replace(/(requestAnimationFrame\s*\()/g, '<mark>$1</mark>');
            
          return /* html */ `
          <div class="issue-item leak-item" data-kind="${issue.kind}">
            <a class="line-num" href="#" data-file="${absolutePath}" data-line="${issue.line}">Line ${issue.line}</a>
            <span class="kind-pill kind-${issue.kind}">${kindLabel[issue.kind]}</span>
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
        <div class="issue-list leak-list">${issueRows}</div>
      </div>`;
    })
    .join('\n');

  const filesCount = byFile.size;
  const onPushCount = issues.filter((i) => i.kind === 'missing-on-push').length;
  const trackByCount = issues.filter((i) => i.kind === 'missing-track-by').length;
  const fnTemplateCount = issues.filter((i) => i.kind === 'function-in-template').length;
  const zoneWorkCount = issues.filter((i) => i.kind === 'unnecessary-zone-work').length;
  const largeCompCount = issues.filter((i) => i.kind === 'large-component').length;

  const statsParts: string[] = [`${filesCount} file${filesCount !== 1 ? 's' : ''} affected`];
  if (onPushCount > 0) {statsParts.push(`${onPushCount} missing OnPush`);}
  if (trackByCount > 0) {statsParts.push(`${trackByCount} missing trackBy`);}
  if (fnTemplateCount > 0) {statsParts.push(`${fnTemplateCount} fn in template`);}
  if (zoneWorkCount > 0) {statsParts.push(`${zoneWorkCount} zone.js work`);}
  if (largeCompCount > 0) {statsParts.push(`${largeCompCount} large component`);}
  
  const statsLabel = statsParts.join(' &middot; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Angular Optimizations</title>
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
      background: var(--vscode-inputValidation-infoBackground, #006b6b);
      color: var(--vscode-inputValidation-infoForeground, #00ccff);
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

    .kind-missing-on-push {
      background: rgba(240, 100, 80, 0.15);
      color: var(--vscode-problemsErrorIcon-foreground, #f06450);
      border: 1px solid rgba(240, 100, 80, 0.3);
    }

    .kind-missing-track-by {
      background: rgba(204, 167, 0, 0.18);
      color: var(--vscode-problemsWarningIcon-foreground, #cca700);
      border: 1px solid rgba(204, 167, 0, 0.35);
    }

    .kind-function-in-template {
      background: rgba(180, 100, 240, 0.15);
      color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
      border: 1px solid rgba(180, 100, 240, 0.3);
    }

    .kind-unnecessary-zone-work {
      background: rgba(100, 160, 240, 0.15);
      color: var(--vscode-terminal-ansiBrightBlue, #6aa0f0);
      border: 1px solid rgba(100, 160, 240, 0.3);
    }

    .kind-large-component {
      background: rgba(240, 140, 60, 0.15);
      color: var(--vscode-terminal-ansiBrightYellow, #e8a020);
      border: 1px solid rgba(240, 140, 60, 0.3);
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

    /* ── Issue items ── */
    .issue-list {
      display: flex;
      flex-direction: column;
    }

    .issue-item {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 7px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      transition: background 0.1s;
    }

    .issue-item:last-child {
      border-bottom: none;
    }

    .issue-item:hover {
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
      <span class="warn-icon">i</span>
      <h1>Angular Optimizations</h1>
      <span class="badge">${issues.length}</span>
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
        <span class="kind-pill kind-missing-on-push" data-kind="missing-on-push">Missing OnPush</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Component does not use <code class="hint-code">ChangeDetectionStrategy.OnPush</code></span>
          <span class="legend-fix"><strong>Fix:</strong> Add <code class="hint-code">changeDetection: ChangeDetectionStrategy.OnPush</code> to the @Component decorator.</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-missing-track-by" data-kind="missing-track-by">Missing trackBy</span>
        <span class="legend-desc-group">
          <span class="legend-desc"><code class="hint-code">*ngFor</code> loop used without a <code class="hint-code">trackBy</code> function</span>
          <span class="legend-fix"><strong>Fix:</strong> Add <code class="hint-code">trackBy: trackByFn</code> to improve rendering performance.</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-function-in-template" data-kind="function-in-template">Function in Template</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Function call found in template interpolation or binding</span>
          <span class="legend-fix"><strong>Fix:</strong> Use a pure pipe or a signal instead to avoid evaluating the function on every change detection cycle.</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-unnecessary-zone-work" data-kind="unnecessary-zone-work">Unnecessary Zone.js Work</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Asynchronous task like <code class="hint-code">setTimeout</code> triggered inside the Angular zone</span>
          <span class="legend-fix"><strong>Fix:</strong> Wrap it inside <code class="hint-code">this.ngZone.runOutsideAngular(() => ...)</code> if it doesn't need to trigger change detection.</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-large-component" data-kind="large-component">Large Component</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Combined size of Component TS and HTML exceeds the threshold</span>
          <span class="legend-fix"><strong>Fix:</strong> Consider splitting the component into smaller, more manageable sub-components.</span>
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
        document.querySelectorAll('.issue-item[data-kind="' + kind + '"]').forEach(function(item) {
          item.style.display = isOff ? 'none' : '';
        });

        // Hide file groups where every leak item is hidden
        document.querySelectorAll('.file-group').forEach(function(group) {
          var items = group.querySelectorAll('.issue-item');
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
    .replace(/'/g, '&#039;');
}
