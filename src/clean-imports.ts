import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { collectTemplateCandidates } from './auto-imports-scan';
import {
  normalizeFs,
  peekAutoImportIndex,
  resolveEntryInfo,
  warmAutoImportIndex,
} from './auto-imports-index';
import type { AutoImportIndex } from './auto-imports-index';
import {
  collectImportBindingDetails,
  collectImportBindings,
  countReferences,
  parseDecoratedOwners,
  planImportStatements,
  planImportsArray,
} from './import-edits';
import type { DecoratedOwner, TextSpan } from './import-edits';
import { logDiagnostic } from './state';

/**
 * Auto-clean unused imports.
 *
 * Two independent cleanups, both offered by `Ctrl+Shift+A I` and applied
 * automatically on save when `angularCliPlus.autoCleanImports.enabled` is on:
 *
 *   1. **`imports: [...]` entries** of standalone `@Component`s whose selector
 *      or pipe name is not used by the component's template, and which are not
 *      referenced anywhere else in the file.
 *   2. **`import` statements** whose local binding is never referenced — taking
 *      into account the array entries removed by (1), so dropping the last use
 *      of a symbol also drops its import.
 *
 * Safety policy: an entry is removed only when what it provides is *known*.
 * Anything unresolvable (a spread element, a symbol whose declaration cannot be
 * read, a template that cannot be loaded) is kept. NgModules that expose no
 * template tokens at all are never suggested either, because they are usually
 * there for the providers they carry (`HttpClientModule`).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface UnusedArrayEntry {
  /** identifier as written in the `imports: [...]` array */
  name: string;
  /** decorated class the entry belongs to */
  ownerClassName: string;
  /** what the entry resolves to, when known */
  kind: 'Component' | 'Directive' | 'Pipe' | 'NgModule';
  moduleSpecifier: string | undefined;
  /** true once the import binding has no other use either */
  bindingBecomesUnused: boolean;
}

export interface UnusedImportBinding {
  name: string;
  moduleSpecifier: string;
  kind: 'named' | 'default' | 'namespace';
}

export interface CleanupPlan {
  arrayEntries: UnusedArrayEntry[];
  bindings: UnusedImportBinding[];
  /** components whose analysis was skipped, for diagnostics */
  skipped: string[];
  /**
   * owner class → tokens its `imports: [...]` already provides. Computed as a
   * by-product of the same pass, so the auto-import command can reuse it
   * instead of resolving every entry a second time.
   */
  coverage: Map<string, Set<string>>;
  /** owner class → entries whose provider could not be determined */
  unresolved: Map<string, string[]>;
}

export interface CleanupInput {
  filePath: string;
  sourceFile: ts.SourceFile;
  owners: DecoratedOwner[];
  index: AutoImportIndex | null;
  /** overrides the template of one owner (the HTML editor's live buffer) */
  htmlOverride?: { ownerClassName: string; text: string };
  /** include NgModule entries that provide no used token */
  includeModules: boolean;
  /** analyse `imports: [...]` arrays */
  cleanArrays: boolean;
  /** analyse `import` statements */
  cleanBindings: boolean;
}

/** Import statements that must never be removed automatically. */
const PROTECTED_MODULES = new Set(['reflect-metadata', 'zone.js', 'zone.js/testing']);

function readFileOrNull(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Reads a file, preferring the editor's buffer.
 *
 * This matters for templates: cleaning a component while its HTML has unsaved
 * changes must judge usage by what the user sees, not by what is on disk.
 */
export function readCurrentText(absPath: string): string | null {
  const wanted = normalizeFs(absPath);
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === 'file' && normalizeFs(document.uri.fsPath) === wanted,
  );
  return open ? open.getText() : readFileOrNull(absPath);
}

export function templateOf(owner: DecoratedOwner, ownerFilePath: string): string | null {
  if (owner.inlineTemplate !== null) {
    return owner.inlineTemplate;
  }
  if (owner.templateUrl !== null) {
    return readCurrentText(path.resolve(path.dirname(ownerFilePath), owner.templateUrl));
  }
  return null;
}

// ── Analysis ─────────────────────────────────────────────────────────────────

/**
 * Finds what can be removed from a file. Pure apart from reading external
 * templates: everything else comes from the parsed source and the (already
 * built) symbol index.
 */
export function computeCleanupPlan(input: CleanupInput): CleanupPlan {
  const { filePath, sourceFile, owners, index, htmlOverride } = input;
  const arrayEntries: UnusedArrayEntry[] = [];
  const skipped: string[] = [];
  const coverage = new Map<string, Set<string>>();
  const unresolved = new Map<string, string[]>();

  /** array-element spans of removable entries, ignored when counting uses */
  const removedSpans: Array<{ start: number; end: number }> = [];

  if (index) {
    const importBindings = collectImportBindings(sourceFile);

    for (const owner of owners) {
      if (owner.kind !== 'Component' || !owner.importsArray) {
        continue;
      }

      const provided = new Set<string>();
      const unknown: string[] = [];
      coverage.set(owner.className, provided);

      const template =
        htmlOverride && htmlOverride.ownerClassName === owner.className
          ? htmlOverride.text
          : templateOf(owner, filePath);
      const used = template === null ? null : collectTemplateCandidates(template);
      if (used === null && owner.importsArray.elements.length > 0) {
        // A `templateUrl` that cannot be read tells us nothing about usage
        skipped.push(`${owner.className} (template not readable)`);
      }

      for (const element of owner.importsArray.elements) {
        if (!ts.isIdentifier(element)) {
          unknown.push(ts.isSpreadElement(element) ? '<spread>' : '<expression>');
          continue; // spreads and expressions are left alone
        }
        const name = element.text;
        const moduleSpecifier = importBindings.get(name);
        const info = resolveEntryInfo(filePath, name, moduleSpecifier, index);
        if (info === null) {
          unknown.push(name);
          continue; // unknown provider: keep
        }
        for (const token of info.tokens) {
          provided.add(token);
        }

        if (!input.cleanArrays || used === null || info.kind === null) {
          continue;
        }
        if (info.tokens.length === 0) {
          continue; // provides nothing the template could reference (providers)
        }
        if (info.tokens.some((token) => used.has(token))) {
          continue; // still used
        }
        if (info.kind === 'NgModule' && !input.includeModules) {
          continue;
        }
        arrayEntries.push({
          name,
          ownerClassName: owner.className,
          kind: info.kind,
          moduleSpecifier,
          bindingBecomesUnused: false,
        });
        removedSpans.push({ start: element.getStart(sourceFile), end: element.getEnd() });
      }

      if (unknown.length > 0) {
        unresolved.set(owner.className, unknown);
      }
    }
  }

  // References that survive once the entries above are gone
  const counts = countReferences(sourceFile, removedSpans);
  const bindings: UnusedImportBinding[] = [];
  const unusedNames = new Set<string>();

  for (const binding of collectImportBindingDetails(sourceFile)) {
    if ((counts.get(binding.name) ?? 0) > 0 || PROTECTED_MODULES.has(binding.moduleSpecifier)) {
      continue;
    }
    unusedNames.add(binding.name);
    if (input.cleanBindings) {
      bindings.push({
        name: binding.name,
        moduleSpecifier: binding.moduleSpecifier,
        kind: binding.kind,
      });
    }
  }

  for (const entry of arrayEntries) {
    entry.bindingBecomesUnused = unusedNames.has(entry.name);
  }

  return { arrayEntries, bindings, skipped, coverage, unresolved };
}

/**
 * Turns a plan into edit spans. `bindings` are the import bindings to drop;
 * `arrayEntries` the decorator entries. Both are rendered per statement / per
 * array so the spans never overlap.
 */
export function buildCleanupSpans(
  sourceFile: ts.SourceFile,
  owners: DecoratedOwner[],
  plan: { arrayEntries: readonly UnusedArrayEntry[]; bindings: readonly UnusedImportBinding[] },
): TextSpan[] {
  const spans: TextSpan[] = [];

  const byOwner = new Map<string, Set<string>>();
  for (const entry of plan.arrayEntries) {
    const set = byOwner.get(entry.ownerClassName) ?? new Set<string>();
    set.add(entry.name);
    byOwner.set(entry.ownerClassName, set);
  }
  for (const [ownerClassName, remove] of byOwner) {
    const owner = owners.find((candidate) => candidate.className === ownerClassName);
    if (owner) {
      spans.push(...planImportsArray(sourceFile, owner, { add: [], remove }, logDiagnostic));
    }
  }

  if (plan.bindings.length > 0) {
    spans.push(
      ...planImportStatements(sourceFile, {
        add: new Map(),
        remove: new Set(plan.bindings.map((binding) => binding.name)),
      }),
    );
  }

  return spans;
}

// ── On-save integration ──────────────────────────────────────────────────────

export interface CleanSettings {
  enabled: boolean;
  cleanBindings: boolean;
  cleanArrays: boolean;
  includeModules: boolean;
}

function readSettings(): CleanSettings {
  const config = vscode.workspace.getConfiguration('angularCliPlus');
  return {
    enabled: config.get<boolean>('autoCleanImports.enabled', false),
    cleanBindings: config.get<boolean>('autoCleanImports.unusedTypeScriptImports', true),
    cleanArrays: config.get<boolean>('autoCleanImports.unusedStandaloneImports', true),
    includeModules: config.get<boolean>('autoCleanImports.removeUnusedModules', false),
  };
}

/** Computes the edits to apply while saving `document`. */
export function computeCleanupEdits(
  document: vscode.TextDocument,
  settings: CleanSettings,
  index: AutoImportIndex | null,
): vscode.TextEdit[] {
  const source = document.getText();
  const sourceFile = ts.createSourceFile(
    document.fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const owners = parseDecoratedOwners(sourceFile);

  const plan = computeCleanupPlan({
    filePath: document.fileName,
    sourceFile,
    owners,
    index,
    includeModules: settings.includeModules,
    cleanArrays: settings.cleanArrays,
    cleanBindings: settings.cleanBindings,
  });

  const spans = buildCleanupSpans(sourceFile, owners, plan);
  if (spans.length === 0) {
    return [];
  }

  logDiagnostic(
    `Auto-clean imports: ${document.fileName} — removed ` +
      `${plan.arrayEntries.length} imports array entry/entries ` +
      `(${plan.arrayEntries.map((entry) => entry.name).join(', ') || 'none'}) and ` +
      `${plan.bindings.length} import binding(s) ` +
      `(${plan.bindings.map((binding) => binding.name).join(', ') || 'none'})`,
  );

  return spans.map((span) =>
    vscode.TextEdit.replace(
      new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
      span.text,
    ),
  );
}

/**
 * Registers the on-save participant that removes unused imports when
 * `angularCliPlus.autoCleanImports.enabled` is turned on.
 *
 * The edits are handed to VS Code through `waitUntil` so they become part of
 * the save itself — applying them with `applyEdit` from here races the save and
 * is silently dropped. Everything runs synchronously off the in-memory buffer,
 * and the `imports: [...]` half is skipped (rather than waited for) while the
 * symbol index is still building, so a save is never held up.
 */
export function setupAutoCleanImports(context: vscode.ExtensionContext): void {
  const disposable = vscode.workspace.onWillSaveTextDocument((event) => {
    const settings = readSettings();
    if (!settings.enabled || (!settings.cleanArrays && !settings.cleanBindings)) {
      return;
    }
    const document = event.document;
    if (
      document.languageId !== 'typescript' ||
      !document.fileName.endsWith('.ts') ||
      document.fileName.endsWith('.d.ts')
    ) {
      return;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder || !fs.existsSync(path.join(workspaceFolder.uri.fsPath, 'angular.json'))) {
      return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const index = peekAutoImportIndex(workspaceRoot);
    if (index === null && settings.cleanArrays) {
      // Build it for the next save instead of blocking this one
      warmAutoImportIndex(workspaceRoot);
    }

    try {
      const edits = computeCleanupEdits(document, settings, index);
      if (edits.length > 0) {
        event.waitUntil(Promise.resolve(edits));
      }
    } catch (error) {
      logDiagnostic(
        `Auto-clean imports failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  context.subscriptions.push(disposable);
}
