/**
 * Shared helpers for the JSON-config webview editors. Existing webviews each
 * redefine their own `escapeHtml`; the config editors share these instead since
 * several panels are added at once and they all use the same chrome.
 */
import type { OptionType } from './json-config-catalogs';

/** Escapes a string for safe interpolation into HTML text/attributes. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Base CSS shared by all config editors. Uses VS Code theme variables so the
 * panels follow the active color theme. Editor-specific rules are appended by
 * each webview after this block.
 */
export function baseStyles(): string {
  return /* css */ `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 24px 48px;
      line-height: 1.5;
    }
    a { color: var(--vscode-textLink-foreground); }
    .header {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      margin-bottom: 18px; padding-bottom: 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    h1 { font-size: 1.15em; font-weight: 600; }
    h2 { font-size: 1em; font-weight: 600; }
    .subtitle { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
    .badge {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 22px; height: 18px; padding: 0 6px; border-radius: 9px;
      font-size: 0.72em; font-weight: 700;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    .spacer { flex: 1; }
    .file-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em; color: var(--vscode-descriptionForeground);
    }
    button {
      display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px;
      border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
      font-size: 0.8em; font-family: var(--vscode-font-family); cursor: pointer;
      white-space: nowrap;
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25)); }
    button:disabled { opacity: 0.5; cursor: default; }
    input[type="text"], input[type="number"], select {
      font-family: var(--vscode-font-family); font-size: 0.85em;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px; padding: 3px 6px;
    }
    input[type="text"]:focus, input[type="number"]:focus, select:focus {
      outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
    }
    .section { margin-bottom: 26px; }
    .section-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .empty-note { font-size: 0.85em; color: var(--vscode-descriptionForeground); padding: 4px 0; }
    .opt-table { width: 100%; border-collapse: collapse; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
    .opt-table tbody tr { border-bottom: 1px solid var(--vscode-panel-border); }
    .opt-table tbody tr:last-child { border-bottom: none; }
    .opt-table tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .opt-table td { padding: 6px 12px; font-size: 0.88em; vertical-align: middle; }
    .opt-name { font-family: var(--vscode-editor-font-family, monospace); }
    .opt-doc { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
    .toggle-cell { width: 34px; text-align: center; }
    .value-cell { width: 38%; }
    .value-cell input[type="text"], .value-cell input[type="number"] { width: 100%; }
  `;
}

/** Converts a raw string value from a webview control into a typed JSON value. */
export function convertValue(type: OptionType, raw: string): unknown {
  switch (type) {
    case 'boolean':
      return raw === 'true';
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'array':
      return parseArray(raw);
    default:
      return raw;
  }
}

/** Parses a comma-separated list or a JSON array literal into a string array. */
export function parseArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch {
      // fall through to comma splitting
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Infers a render type from an existing JSON value (for non-catalog keys). */
export function inferType(value: unknown): OptionType {
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
    return 'array';
  }
  return 'readonly';
}
