/**
 * angular.json editor webview. Splits configuration by project and architect
 * target, showing a curated option catalog chosen by the detected Angular
 * version + builder, plus any extra keys present. The target's `options` and
 * each named `configuration` can be edited. Edits preserve comments.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { readJsonc, setKey, removeKey, JsonPath } from './jsonc-io';
import { getAngularTargetCatalog, OptionDef } from './json-config-catalogs';
import { detectCliVersion } from './version';
import { escapeHtml, baseStyles, convertValue, inferType } from './webview-utils';

interface ArchitectTarget {
  builder?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, Record<string, unknown>>;
}

interface Project {
  architect?: Record<string, ArchitectTarget>;
  targets?: Record<string, ArchitectTarget>;
}

interface AngularJsonFull {
  projects?: Record<string, Project>;
}

interface WebviewMessage {
  command: string;
  project?: string;
  target?: string;
  scope?: string;
  key?: string;
  type?: OptionDef['type'];
  value?: string;
}

// ── Entry point ────────────────────────────────────────────────────────────────

let activePanel: vscode.WebviewPanel | undefined;
let lastWorkspaceRoot = '';
let cliMajor: number | null = null;
let currentProject = '';
let currentTarget = '';
let currentScope = 'options';

export async function showAngularJsonEditor(workspaceRoot: string): Promise<void> {
  cliMajor = await detectCliVersion(workspaceRoot);
  currentProject = '';
  currentTarget = '';
  currentScope = 'options';
  showWebview(workspaceRoot);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function filePathFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'angular.json');
}

/** angular.json uses `architect`; some workspaces use `targets`. */
function archKeyFor(project: Project): 'architect' | 'targets' {
  return project.targets && !project.architect ? 'targets' : 'architect';
}

function targetsOf(project: Project): Record<string, ArchitectTarget> {
  return project.architect ?? project.targets ?? {};
}

function scopeBasePath(archKey: string, target: string, scope: string): JsonPath {
  return scope === 'options'
    ? [archKey, target, 'options']
    : [archKey, target, 'configurations', scope];
}

// ── Saving ─────────────────────────────────────────────────────────────────────

function pathForMessage(workspaceRoot: string, m: WebviewMessage): JsonPath | null {
  const parsed = readJsonc<AngularJsonFull>(filePathFor(workspaceRoot));
  const project = parsed?.projects?.[m.project ?? ''];
  if (!project || !m.target || !m.key) {
    return null;
  }
  const archKey = archKeyFor(project);
  return ['projects', m.project!, ...scopeBasePath(archKey, m.target, m.scope ?? 'options'), m.key];
}

// ── Webview ──────────────────────────────────────────────────────────────────

function showWebview(workspaceRoot: string): void {
  lastWorkspaceRoot = workspaceRoot;
  const html = buildHtml(workspaceRoot);
  const title = 'angular.json';

  if (activePanel) {
    activePanel.webview.html = html;
    activePanel.reveal(undefined, true);
  } else {
    activePanel = vscode.window.createWebviewPanel('angularJsonConfig', title, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    activePanel.webview.html = html;
    activePanel.onDidDispose(() => {
      activePanel = undefined;
    });
    activePanel.webview.onDidReceiveMessage((m: WebviewMessage) => {
      void handleMessage(m);
    });
  }
}

async function handleMessage(message: WebviewMessage): Promise<void> {
  switch (message.command) {
    case 'reload':
      cliMajor = await detectCliVersion(lastWorkspaceRoot);
      showWebview(lastWorkspaceRoot);
      return;
    case 'selectProject':
      currentProject = message.project ?? currentProject;
      currentTarget = '';
      currentScope = 'options';
      showWebview(lastWorkspaceRoot);
      return;
    case 'selectTarget':
      currentTarget = message.target ?? currentTarget;
      currentScope = 'options';
      showWebview(lastWorkspaceRoot);
      return;
    case 'selectScope':
      currentScope = message.scope ?? 'options';
      showWebview(lastWorkspaceRoot);
      return;
    case 'removeOption': {
      const jsonPath = pathForMessage(lastWorkspaceRoot, message);
      if (jsonPath) {
        removeKey(filePathFor(lastWorkspaceRoot), jsonPath);
        showWebview(lastWorkspaceRoot);
      }
      return;
    }
    case 'setOption':
    case 'addOption': {
      if (!message.type) {
        return;
      }
      const jsonPath = pathForMessage(lastWorkspaceRoot, message);
      if (!jsonPath) {
        return;
      }
      const value = convertValue(message.type, message.value ?? '');
      if (value === undefined) {
        vscode.window.showErrorMessage(`Invalid value for ${message.key}`);
        return;
      }
      const ok = setKey(filePathFor(lastWorkspaceRoot), jsonPath, value);
      if (ok) {
        vscode.window.setStatusBarMessage(`Saved ${message.key}`, 2000);
      } else {
        vscode.window.showErrorMessage(`Failed to save ${message.key}`);
      }
      showWebview(lastWorkspaceRoot);
      return;
    }
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function valueControl(def: OptionDef, value: unknown, present: boolean): string {
  const data = `data-project="${escapeHtml(currentProject)}" data-target="${escapeHtml(currentTarget)}" data-scope="${escapeHtml(currentScope)}" data-key="${escapeHtml(def.key)}" data-type="${def.type}"`;
  switch (def.type) {
    case 'boolean': {
      const v = present ? String(value) : 'true';
      return `<select class="opt-value" ${data}>
          <option value="true"${v === 'true' ? ' selected' : ''}>true</option>
          <option value="false"${v === 'false' ? ' selected' : ''}>false</option>
        </select>`;
    }
    case 'enum': {
      const opts = (def.enum ?? [])
        .map((e) => `<option value="${escapeHtml(e)}"${e === value ? ' selected' : ''}>${escapeHtml(e)}</option>`)
        .join('');
      return `<select class="opt-value" ${data}>${opts}</select>`;
    }
    case 'number':
      return `<input type="number" class="opt-value" ${data} value="${present ? escapeHtml(String(value)) : ''}">`;
    case 'array': {
      const text = Array.isArray(value) ? (value as unknown[]).join(', ') : '';
      return `<input type="text" class="opt-value" ${data} value="${escapeHtml(text)}" placeholder="comma-separated or JSON array">`;
    }
    default:
      return `<input type="text" class="opt-value" ${data} value="${present ? escapeHtml(String(value)) : ''}">`;
  }
}

function optionRow(def: OptionDef, value: unknown, present: boolean): string {
  if (def.type === 'readonly') {
    return /* html */ `
      <tr>
        <td class="toggle-cell"></td>
        <td class="opt-name">${escapeHtml(def.key)}<div class="opt-doc">${escapeHtml(def.doc ?? 'object/array value — edit in file')}</div></td>
        <td class="value-cell opt-doc">${escapeHtml(JSON.stringify(value))}</td>
      </tr>`;
  }
  return /* html */ `
    <tr>
      <td class="toggle-cell"><input type="checkbox" class="opt-toggle" data-project="${escapeHtml(currentProject)}" data-target="${escapeHtml(currentTarget)}" data-scope="${escapeHtml(currentScope)}" data-key="${escapeHtml(def.key)}"${present ? ' checked' : ''}></td>
      <td class="opt-name">${escapeHtml(def.key)}${def.doc ? `<div class="opt-doc">${escapeHtml(def.doc)}</div>` : ''}</td>
      <td class="value-cell">${valueControl(def, value, present)}</td>
    </tr>`;
}

function optionsTable(catalog: OptionDef[], values: Record<string, unknown>): string {
  const catalogKeys = new Set(catalog.map((d) => d.key));
  const rows = catalog.map((def) => optionRow(def, values[def.key], def.key in values)).join('');
  const extras = Object.keys(values)
    .filter((k) => !catalogKeys.has(k))
    .map((k) => optionRow({ key: k, type: inferType(values[k]), doc: 'custom option' }, values[k], true))
    .join('');
  return /* html */ `<table class="opt-table"><tbody>${rows}${extras}</tbody></table>`;
}

function selector(id: string, command: string, options: string[], selected: string, label: string): string {
  const opts = options
    .map((o) => `<option value="${escapeHtml(o)}"${o === selected ? ' selected' : ''}>${escapeHtml(o)}</option>`)
    .join('');
  return /* html */ `<label class="picker"><span class="subtitle">${escapeHtml(label)}</span>
    <select id="${id}" data-command="${command}">${opts}</select></label>`;
}

function buildHtml(workspaceRoot: string): string {
  const parsed = readJsonc<AngularJsonFull>(filePathFor(workspaceRoot)) ?? {};
  const projectNames = Object.keys(parsed.projects ?? {});
  const versionNote = `Angular CLI ${cliMajor === null ? 'version unknown — modern defaults' : `v${cliMajor}`}`;

  if (projectNames.length === 0) {
    return shell(workspaceRoot, versionNote, '<p class="empty-note">No projects found in angular.json.</p>');
  }

  if (!projectNames.includes(currentProject)) {
    currentProject = projectNames[0];
  }
  const project = parsed.projects![currentProject];
  const archKey = archKeyFor(project);
  const targets = targetsOf(project);
  const targetNames = Object.keys(targets);

  if (targetNames.length === 0) {
    const body = `${selector('projectSel', 'selectProject', projectNames, currentProject, 'Project')}
      <p class="empty-note">This project has no ${archKey} targets.</p>`;
    return shell(workspaceRoot, versionNote, body);
  }

  if (!targetNames.includes(currentTarget)) {
    currentTarget = targetNames[0];
  }
  const target = targets[currentTarget];
  const builder = target.builder;
  const configNames = Object.keys(target.configurations ?? {});
  const scopeNames = ['options', ...configNames];
  if (!scopeNames.includes(currentScope)) {
    currentScope = 'options';
  }

  const values =
    currentScope === 'options'
      ? target.options ?? {}
      : target.configurations?.[currentScope] ?? {};
  const catalog = getAngularTargetCatalog(currentTarget, builder, cliMajor);

  const body = /* html */ `
    <div class="pickers">
      ${selector('projectSel', 'selectProject', projectNames, currentProject, 'Project')}
      ${selector('targetSel', 'selectTarget', targetNames, currentTarget, 'Target')}
      ${selector('scopeSel', 'selectScope', scopeNames, currentScope, 'Scope')}
    </div>
    <div class="builder-note">builder: <code>${escapeHtml(builder ?? '(none)')}</code></div>
    ${optionsTable(catalog, values)}
    <div class="section">
      <div class="section-header"><h2>Add option</h2></div>
      <div class="add-row">
        <input type="text" id="addKey" placeholder="option name">
        <select id="addType">
          <option value="string">string</option>
          <option value="boolean">boolean</option>
          <option value="number">number</option>
          <option value="array">array</option>
        </select>
        <input type="text" id="addValue" placeholder="value">
        <button id="addBtn">Add</button>
      </div>
    </div>`;

  return shell(workspaceRoot, versionNote, body);
}

function shell(workspaceRoot: string, versionNote: string, body: string): string {
  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>angular.json</title>
    <style>
      ${baseStyles()}
      code { font-family: var(--vscode-editor-font-family, monospace); }
      .pickers { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
      .picker { display: flex; flex-direction: column; gap: 3px; }
      .builder-note { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
      .add-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
      .add-row input[type="text"] { min-width: 140px; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>angular.json</h1>
      <span class="subtitle">${escapeHtml(versionNote)}</span>
      <span class="spacer"></span>
      <button id="reloadBtn">Reload</button>
    </div>
    <div class="file-path">${escapeHtml(filePathFor(workspaceRoot))}</div>
    <div style="height:14px"></div>
    ${body}
    <script>
      const vscode = acquireVsCodeApi();

      document.getElementById('reloadBtn').addEventListener('click', function () {
        vscode.postMessage({ command: 'reload' });
      });

      document.querySelectorAll('select[data-command]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          vscode.postMessage({ command: sel.getAttribute('data-command'), project: sel.value, target: sel.value, scope: sel.value });
        });
      });

      document.querySelectorAll('.opt-toggle').forEach(function (cb) {
        cb.addEventListener('change', function () {
          const base = {
            project: cb.getAttribute('data-project'),
            target: cb.getAttribute('data-target'),
            scope: cb.getAttribute('data-scope'),
            key: cb.getAttribute('data-key')
          };
          if (cb.checked) {
            const valueEl = cb.closest('tr').querySelector('.opt-value');
            vscode.postMessage(Object.assign({ command: 'setOption',
              type: valueEl ? valueEl.getAttribute('data-type') : 'boolean',
              value: valueEl ? valueEl.value : 'true' }, base));
          } else {
            vscode.postMessage(Object.assign({ command: 'removeOption' }, base));
          }
        });
      });

      document.querySelectorAll('.opt-value').forEach(function (el) {
        el.addEventListener('change', function () {
          const toggle = el.closest('tr').querySelector('.opt-toggle');
          if (toggle) { toggle.checked = true; }
          vscode.postMessage({
            command: 'setOption',
            project: el.getAttribute('data-project'),
            target: el.getAttribute('data-target'),
            scope: el.getAttribute('data-scope'),
            key: el.getAttribute('data-key'),
            type: el.getAttribute('data-type'),
            value: el.value
          });
        });
      });

      const addBtn = document.getElementById('addBtn');
      if (addBtn) {
        addBtn.addEventListener('click', function () {
          const key = document.getElementById('addKey').value.trim();
          if (!key) { return; }
          vscode.postMessage({
            command: 'addOption',
            project: ${JSON.stringify(currentProject)},
            target: ${JSON.stringify(currentTarget)},
            scope: ${JSON.stringify(currentScope)},
            key: key,
            type: document.getElementById('addType').value,
            value: document.getElementById('addValue').value
          });
        });
      }
    </script>
  </body>
  </html>`;
}
