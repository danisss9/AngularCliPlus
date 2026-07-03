import * as vscode from 'vscode';
import * as path from 'path';
import {
  resolveWorkspaceAndAngularJson,
  detectActiveFileProject,
  getLastProject,
  setLastProject,
} from './utils';
import { findOptimizationsInFile, OptimizationLocation, OptimizationKind } from './optimizations-ast';
import { sendCopilotAutoFix, sendCopilotAutoFixForFile } from './copilot-fix';

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
  let scopeLabel = '';

  if (CURRENT_FILE_LABEL && picked === CURRENT_FILE_LABEL) {
    filesToCheck = [activeFile!];
    scopeLabel = path.basename(activeFile!);
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
    scopeLabel = projectName;

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

  showOptimizationsWebview(results, workspaceRoot, filesToCheck, scopeLabel);
}

// ── Webview ────────────────────────────────────────────────────────────────────

function optimizationsTitle(scopeLabel: string, count: number): string {
  return `Optimizations: ${scopeLabel} (${count})`;
}

/**
 * Creates a fresh panel for the given results. Each run opens its own tab; the
 * panel's Reload button re-scans the same files and refreshes that tab in place.
 */
function showOptimizationsWebview(
  issues: OptimizationLocation[],
  workspaceRoot: string,
  filesToCheck: string[],
  scopeLabel: string,
): void {
  const autoFixEnabled = (): boolean =>
    vscode.workspace
      .getConfiguration('angularCliPlus')
      .get<boolean>('copilot.autoFixEnabled', true);

  const panel = vscode.window.createWebviewPanel(
    'angularOptimizations',
    optimizationsTitle(scopeLabel, issues.length),
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = buildWebviewHtml(issues, workspaceRoot, autoFixEnabled());

  panel.webview.onDidReceiveMessage(
    async (message: {
      command: string;
      file: string;
      line: number;
      kind?: string;
      kindLabel?: string;
      snippet?: string;
      description?: string;
      fixHint?: string;
      issues?: Array<{ line: number; kind: string; kindLabel: string; snippet: string; description: string; fixHint: string }>;
    }) => {
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
        panel.title = optimizationsTitle(scopeLabel, freshIssues.length);
        panel.webview.html = buildWebviewHtml(freshIssues, workspaceRoot, autoFixEnabled());
      } else if (message.command === 'copilotFix') {
        await sendCopilotAutoFix({
          file: message.file,
          line: message.line,
          kind: message.kind ?? '',
          kindLabel: message.kindLabel ?? message.kind ?? '',
          snippet: message.snippet ?? '',
          description: message.description ?? '',
          fixHint: message.fixHint ?? '',
        });
      } else if (message.command === 'copilotFixFile') {
        await sendCopilotAutoFixForFile({
          file: message.file,
          issues: message.issues ?? [],
          issueType: 'Optimization',
        });
      }
    },
  );
}

function buildWebviewHtml(issues: OptimizationLocation[], workspaceRoot: string, autoFixEnabled: boolean): string {
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
    'getter-in-template': 'Getter in Template',
    'heavy-lifecycle-hook': 'Heavy Lifecycle Hook',
    'index-as-trackby': 'Index as trackBy',
    'unshared-async-pipe': 'Unshared Async Pipe',
    'high-frequency-event': 'High Frequency Event',
    'complex-template': 'Complex Template',
  };

  const kindDescription: Record<OptimizationKind, string> = {
    'missing-on-push': 'Component does not use ChangeDetectionStrategy.OnPush',
    'missing-track-by': '*ngFor loop used without a trackBy function',
    'function-in-template': 'Function call found in template interpolation or binding',
    'unnecessary-zone-work': 'Asynchronous task like setTimeout triggered inside the Angular zone',
    'large-component': 'Combined size of Component TS and HTML exceeds the threshold',
    'getter-in-template': 'Class getter called from template bindings',
    'heavy-lifecycle-hook': 'Loops or heavy array operations inside high-frequency lifecycle hooks',
    'index-as-trackby': 'Loop index used as the trackBy identifier',
    'unshared-async-pipe': 'Multiple async pipes subscribing to the same unshared Observable',
    'high-frequency-event': 'High-frequency DOM events bound directly in the template',
    'complex-template': 'Template has too many bindings or directives',
  };

  const kindFixHint: Record<OptimizationKind, string> = {
    'missing-on-push': 'Add changeDetection: ChangeDetectionStrategy.OnPush to the @Component decorator.',
    'missing-track-by': 'Add trackBy: trackByFn to improve rendering performance.',
    'function-in-template': 'Use a pure pipe or a signal instead to avoid evaluating the function on every change detection cycle.',
    'unnecessary-zone-work': 'Wrap it inside this.ngZone.runOutsideAngular(() => ...) if it does not need to trigger change detection.',
    'large-component': 'Consider splitting the component into smaller, more manageable sub-components.',
    'getter-in-template': 'Use a pure pipe or signal, as getters evaluate on every change detection cycle.',
    'heavy-lifecycle-hook': 'Move heavy logic out of ngDoCheck, ngAfterContentChecked, and ngAfterViewChecked.',
    'index-as-trackby': 'Track by a unique identifier (e.g., item.id) instead of the index.',
    'unshared-async-pipe': 'Add shareReplay(1) to the Observable to prevent redundant executions.',
    'high-frequency-event': 'Use fromEvent outside the Angular zone for events like scroll or mousemove.',
    'complex-template': 'Extract parts of the template into smaller, targeted components.',
  };

  const copilotIconSvg = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z" fill="currentColor"/>
    <path d="M13 1L13.75 3.25L16 4L13.75 4.75L13 7L12.25 4.75L10 4L12.25 3.25L13 1Z" fill="currentColor" opacity="0.7"/>
    <path d="M3 10L3.5 11.5L5 12L3.5 12.5L3 14L2.5 12.5L1 12L2.5 11.5L3 10Z" fill="currentColor" opacity="0.7"/>
  </svg>`;

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
            .replace(/(requestAnimationFrame\s*\()/g, '<mark>$1</mark>')
            .replace(/(@for)/g, '<mark>$1</mark>')
            .replace(/(\|\s*async)/g, '<mark>$1</mark>')
            .replace(/(get\s+)/g, '<mark>$1</mark>')
            .replace(/(scroll|mousemove|wheel|drag|dragover)/g, '<mark>$1</mark>');

          const copilotBtn = autoFixEnabled
            ? /* html */ `<button class="copilot-fix-btn" title="Auto Fix with Copilot"
                data-file="${absolutePath}"
                data-line="${issue.line}"
                data-kind="${escapeHtml(issue.kind)}"
                data-kind-label="${escapeHtml(kindLabel[issue.kind])}"
                data-snippet="${escapeHtml(issue.snippet)}"
                data-description="${escapeHtml(kindDescription[issue.kind])}"
                data-fix-hint="${escapeHtml(kindFixHint[issue.kind])}"
              >${copilotIconSvg}</button>`
            : '';

          return /* html */ `
          <div class="issue-item leak-item" data-kind="${issue.kind}">
            <a class="line-num" href="#" data-file="${absolutePath}" data-line="${issue.line}">Line ${issue.line}</a>
            <span class="kind-pill kind-${issue.kind}">${kindLabel[issue.kind]}</span>
            <code class="snippet">${highlightedSnippet}</code>
            ${copilotBtn}
          </div>`;
        })
        .join('');

      const fileFixAllBtn = autoFixEnabled
        ? /* html */ `<button class="copilot-fix-file-btn" title="Auto Fix all ${fileIssues.length} issue${fileIssues.length !== 1 ? 's' : ''} in this file with Copilot"
            data-file="${absolutePath}"
            data-issues="${escapeHtml(JSON.stringify(fileIssues.map((i) => ({
              line: i.line,
              kind: i.kind,
              kindLabel: kindLabel[i.kind],
              snippet: i.snippet,
              description: kindDescription[i.kind],
              fixHint: kindFixHint[i.kind],
            }))))}"
          >${copilotIconSvg}<span>Fix all</span></button>`
        : '';

      return /* html */ `
      <div class="file-group">
        <div class="file-header">
          <svg class="file-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
            <path d="M9 1v5h5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
          <span class="file-path"><span class="file-dir">${escapeHtml(dir)}</span><span class="file-name">${escapeHtml(filename)}</span></span>
          <span class="file-badge">${countLabel}</span>
          ${fileFixAllBtn}
          <button class="toggle-group-btn" title="Collapse/expand this file">
            <svg class="chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
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
  const getterCount = issues.filter((i) => i.kind === 'getter-in-template').length;
  const heavyHookCount = issues.filter((i) => i.kind === 'heavy-lifecycle-hook').length;
  const indexTrackByCount = issues.filter((i) => i.kind === 'index-as-trackby').length;
  const unsharedAsyncCount = issues.filter((i) => i.kind === 'unshared-async-pipe').length;
  const highFreqEventCount = issues.filter((i) => i.kind === 'high-frequency-event').length;
  const complexTemplateCount = issues.filter((i) => i.kind === 'complex-template').length;

  const statsParts: string[] = [`${filesCount} file${filesCount !== 1 ? 's' : ''} affected`];
  if (onPushCount > 0) {statsParts.push(`${onPushCount} missing OnPush`);}
  if (trackByCount > 0) {statsParts.push(`${trackByCount} missing trackBy`);}
  if (fnTemplateCount > 0) {statsParts.push(`${fnTemplateCount} fn in template`);}
  if (zoneWorkCount > 0) {statsParts.push(`${zoneWorkCount} zone.js work`);}
  if (largeCompCount > 0) {statsParts.push(`${largeCompCount} large component`);}
  if (getterCount > 0) {statsParts.push(`${getterCount} getter in template`);}
  if (heavyHookCount > 0) {statsParts.push(`${heavyHookCount} heavy hook`);}
  if (indexTrackByCount > 0) {statsParts.push(`${indexTrackByCount} index as trackBy`);}
  if (unsharedAsyncCount > 0) {statsParts.push(`${unsharedAsyncCount} unshared async`);}
  if (highFreqEventCount > 0) {statsParts.push(`${highFreqEventCount} high freq event`);}
  if (complexTemplateCount > 0) {statsParts.push(`${complexTemplateCount} complex template`);}
  
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

    .kind-getter-in-template {
      background: rgba(180, 100, 240, 0.15);
      color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
      border: 1px solid rgba(180, 100, 240, 0.3);
    }

    .kind-heavy-lifecycle-hook {
      background: rgba(240, 100, 80, 0.15);
      color: var(--vscode-problemsErrorIcon-foreground, #f06450);
      border: 1px solid rgba(240, 100, 80, 0.3);
    }

    .kind-index-as-trackby {
      background: rgba(204, 167, 0, 0.18);
      color: var(--vscode-problemsWarningIcon-foreground, #cca700);
      border: 1px solid rgba(204, 167, 0, 0.35);
    }

    .kind-unshared-async-pipe {
      background: rgba(100, 160, 240, 0.15);
      color: var(--vscode-terminal-ansiBrightBlue, #6aa0f0);
      border: 1px solid rgba(100, 160, 240, 0.3);
    }

    .kind-high-frequency-event {
      background: rgba(240, 140, 60, 0.15);
      color: var(--vscode-terminal-ansiBrightYellow, #e8a020);
      border: 1px solid rgba(240, 140, 60, 0.3);
    }

    .kind-complex-template {
      background: rgba(240, 100, 80, 0.15);
      color: var(--vscode-problemsErrorIcon-foreground, #f06450);
      border: 1px solid rgba(240, 100, 80, 0.3);
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
      cursor: pointer;
    }

    .file-header:hover {
      background: var(--vscode-list-hoverBackground, var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.12)));
    }

    .toggle-group-btn {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--vscode-icon-foreground);
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 3px;
    }

    .toggle-group-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
    }

    .chevron {
      width: 16px;
      height: 16px;
      transition: transform 0.15s ease-in-out;
      transform: rotate(90deg);
    }

    .file-group.collapsed .chevron {
      transform: rotate(0deg);
    }

    .file-group.collapsed .issue-list {
      display: none;
    }

    .file-group.collapsed .file-header {
      border-bottom: none;
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

    .collapse-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
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

    .collapse-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25));
    }

    .reload-btn.spinning svg {
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* ── Copilot fix button ── */
    .copilot-fix-btn {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 3px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s, background 0.15s, color 0.15s;
      margin-left: 4px;
    }

    .issue-item:hover .copilot-fix-btn {
      opacity: 0.7;
    }

    .copilot-fix-btn:hover {
      opacity: 1 !important;
      background: rgba(180, 100, 240, 0.15);
      color: #c084fc;
    }

    .copilot-fix-btn:active {
      background: rgba(180, 100, 240, 0.28);
    }

    /* ── Per-file Fix all button ── */
    .copilot-fix-file-btn {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border: 1px solid rgba(180, 100, 240, 0.35);
      border-radius: 4px;
      background: rgba(180, 100, 240, 0.08);
      color: var(--vscode-terminal-ansiBrightMagenta, #b464f0);
      cursor: pointer;
      font-size: 0.75em;
      font-family: var(--vscode-font-family);
      white-space: nowrap;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
      margin-left: auto;
    }
    .copilot-fix-file-btn:hover {
      background: rgba(180, 100, 240, 0.18);
      border-color: rgba(180, 100, 240, 0.6);
      color: #c084fc;
    }
    .copilot-fix-file-btn:active {
      background: rgba(180, 100, 240, 0.28);
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
      <button class="collapse-btn" id="toggleTablesBtn" title="Collapse or expand all files">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13">
          <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <span id="toggleTablesLabel">Collapse all</span>
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
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-getter-in-template" data-kind="getter-in-template">Getter in Template</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Class getter called from template bindings</span>
          <span class="legend-fix"><strong>Fix:</strong> Use a pure pipe or signal, as getters evaluate on every change detection cycle.</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-heavy-lifecycle-hook" data-kind="heavy-lifecycle-hook">Heavy Lifecycle Hook</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Loops or heavy array operations inside high-frequency lifecycle hooks</span>
          <span class="legend-fix"><strong>Fix:</strong> Move heavy logic out of ngDoCheck, ngAfterContentChecked, and ngAfterViewChecked.</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-index-as-trackby" data-kind="index-as-trackby">Index as trackBy</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Loop index used as the trackBy identifier</span>
          <span class="legend-fix"><strong>Fix:</strong> Track by a unique identifier (e.g., item.id) instead of the index.</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-unshared-async-pipe" data-kind="unshared-async-pipe">Unshared Async Pipe</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Multiple async pipes subscribing to the same unshared Observable</span>
          <span class="legend-fix"><strong>Fix:</strong> Add <code>shareReplay(1)</code> to the Observable to prevent redundant executions.</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-high-frequency-event" data-kind="high-frequency-event">High Frequency Event</span>
        <span class="legend-desc-group">
          <span class="legend-desc">High-frequency DOM events bound directly in the template</span>
          <span class="legend-fix"><strong>Fix:</strong> Use <code>fromEvent</code> outside the Angular zone for events like scroll or mousemove.</span>
        </span>
      </span>
      <hr class="legend-sep">
      <span class="legend-item">
        <span class="kind-pill kind-complex-template" data-kind="complex-template">Complex Template</span>
        <span class="legend-desc-group">
          <span class="legend-desc">Template has too many bindings or directives</span>
          <span class="legend-fix"><strong>Fix:</strong> Extract parts of the template into smaller, targeted components.</span>
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

    // Preserve scroll position when jumping to a file and back: VS Code can
    // reset a webview's scroll when a text editor takes over its column.
    (function () {
      function saveScroll() {
        var s = vscode.getState() || {};
        s.scrollY = window.scrollY;
        vscode.setState(s);
      }
      function restoreScroll() {
        var s = vscode.getState();
        if (s && typeof s.scrollY === 'number') {
          window.scrollTo(0, s.scrollY);
        }
      }
      var timer;
      window.addEventListener('scroll', function () {
        clearTimeout(timer);
        timer = setTimeout(saveScroll, 100);
      }, { passive: true });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          requestAnimationFrame(restoreScroll);
        }
      });
      restoreScroll();
    })();

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

    // ── Copilot fix buttons (per-issue) ───────────────────────────────────────
    document.querySelectorAll('.copilot-fix-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({
          command: 'copilotFix',
          file: btn.getAttribute('data-file'),
          line: parseInt(btn.getAttribute('data-line'), 10),
          kind: btn.getAttribute('data-kind'),
          kindLabel: btn.getAttribute('data-kind-label'),
          snippet: btn.getAttribute('data-snippet'),
          description: btn.getAttribute('data-description'),
          fixHint: btn.getAttribute('data-fix-hint')
        });
      });
    });

    // ── Copilot fix all buttons (per-file) ────────────────────────────────────
    document.querySelectorAll('.copilot-fix-file-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({
          command: 'copilotFixFile',
          file: btn.getAttribute('data-file'),
          issues: JSON.parse(btn.getAttribute('data-issues') || '[]')
        });
      });
    });

    // ── Collapse / expand file groups ─────────────────────────────────────────
    document.querySelectorAll('.file-group .file-header').forEach(function(header) {
      header.addEventListener('click', function(e) {
        if (e.target.closest('a, .copilot-fix-file-btn')) { return; }
        header.parentElement.classList.toggle('collapsed');
      });
    });

    var toggleTablesBtn = document.getElementById('toggleTablesBtn');
    var toggleTablesLabel = document.getElementById('toggleTablesLabel');
    toggleTablesBtn.addEventListener('click', function() {
      var groups = document.querySelectorAll('.file-group');
      var anyExpanded = Array.prototype.some.call(groups, function(g) {
        return !g.classList.contains('collapsed');
      });
      groups.forEach(function(g) { g.classList.toggle('collapsed', anyExpanded); });
      toggleTablesLabel.textContent = anyExpanded ? 'Expand all' : 'Collapse all';
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
