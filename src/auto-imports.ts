import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { collectTemplateCandidates } from './auto-imports-scan';
import type { TemplateCandidate } from './auto-imports-scan';
import { getAutoImportIndex, normalizeFs } from './auto-imports-index';
import type { AutoImportIndex, AutoImportSymbol } from './auto-imports-index';
import { computeCleanupPlan, readCurrentText, templateOf } from './clean-imports';
import type { CleanupPlan } from './clean-imports';
import {
  collectImportBindings,
  importsArrayNames,
  isLocalBindingTaken,
  parseDecoratedOwners,
  planImportStatements,
  planImportsArray,
} from './import-edits';
import type { DecoratedOwner, TextSpan } from './import-edits';
import { logDiagnostic } from './state';

/**
 * "Angular: Auto Import Missing Imports" (`Ctrl+Shift+A I`).
 *
 * Reconciles a component with its template in one pass and lets the user pick
 * what to apply from a single quick pick:
 *
 *   - **Add** — element tags, attribute / structural directives, bindings and
 *     pipes the template uses that no entry of the decorator's `imports: [...]`
 *     provides, with every matching component, directive, pipe or NgModule from
 *     the workspace and from `node_modules` offered as an option; plus the
 *     identifiers the TypeScript server reports as unresolved in a `.ts` file.
 *   - **Remove** — entries of `imports: [...]` the template no longer uses, and
 *     `import` statements nothing references any more (see `clean-imports.ts`,
 *     which powers the same analysis on save).
 *
 * Everything the user confirms is applied as one `WorkspaceEdit`. Additions and
 * removals that touch the same array or the same import statement are merged
 * into a single span, so they can never conflict.
 *
 * The symbol index lives in `auto-imports-index.ts`; it is cached across runs
 * and refreshed per changed file, so only the first invocation pays for a scan.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** One way to satisfy — or clean up — a reference. */
export interface ImportOption {
  action: 'add' | 'remove';
  className: string;
  /** null when the symbol is declared in the owner file itself */
  moduleSpecifier: string | null;
  /** decorator class whose `imports: [...]` this option changes */
  ownerClassName?: string;
  /** remove: also drop the `import` binding of `className` */
  dropBinding?: boolean;
  label: string;
  description: string;
  detail: string;
  /** ticked when the quick pick opens */
  preselected: boolean;
  /** relative ranking; lower is offered first */
  rank: number;
}

/** One missing (or unused) reference plus every way of resolving it. */
export interface Suggestion {
  title: string;
  options: ImportOption[];
}

// ── Built-in fallback knowledge ──────────────────────────────────────────────

/**
 * Minimal map used when `node_modules` cannot be scanned (fresh clone without
 * an install). The real metadata always wins when it is available.
 */
const COMMON_MODULE = '@angular/common';

const BUILTIN_EXPORTS: Record<string, { module: string; tokens: string[] }> = {
  NgIf: { module: COMMON_MODULE, tokens: ['ngif'] },
  NgFor: { module: COMMON_MODULE, tokens: ['ngfor', 'ngforof'] },
  NgClass: { module: COMMON_MODULE, tokens: ['ngclass'] },
  NgStyle: { module: COMMON_MODULE, tokens: ['ngstyle'] },
  NgSwitch: { module: COMMON_MODULE, tokens: ['ngswitch'] },
  NgSwitchCase: { module: COMMON_MODULE, tokens: ['ngswitchcase'] },
  NgSwitchDefault: { module: COMMON_MODULE, tokens: ['ngswitchdefault'] },
  NgTemplateOutlet: { module: COMMON_MODULE, tokens: ['ngtemplateoutlet'] },
  NgComponentOutlet: { module: COMMON_MODULE, tokens: ['ngcomponentoutlet'] },
  NgOptimizedImage: { module: COMMON_MODULE, tokens: ['ngsrc'] },
  AsyncPipe: { module: COMMON_MODULE, tokens: ['async'] },
  DatePipe: { module: COMMON_MODULE, tokens: ['date'] },
  JsonPipe: { module: COMMON_MODULE, tokens: ['json'] },
  UpperCasePipe: { module: COMMON_MODULE, tokens: ['uppercase'] },
  LowerCasePipe: { module: COMMON_MODULE, tokens: ['lowercase'] },
  TitleCasePipe: { module: COMMON_MODULE, tokens: ['titlecase'] },
  SlicePipe: { module: COMMON_MODULE, tokens: ['slice'] },
  KeyValuePipe: { module: COMMON_MODULE, tokens: ['keyvalue'] },
  CurrencyPipe: { module: COMMON_MODULE, tokens: ['currency'] },
  DecimalPipe: { module: COMMON_MODULE, tokens: ['number'] },
  PercentPipe: { module: COMMON_MODULE, tokens: ['percent'] },
  FormsModule: {
    module: '@angular/forms',
    tokens: ['ngmodel', 'ngmodelgroup', 'ngform', 'ngsubmit'],
  },
  ReactiveFormsModule: {
    module: '@angular/forms',
    tokens: ['formgroup', 'formgroupname', 'formcontrol', 'formcontrolname', 'formarrayname'],
  },
  RouterOutlet: { module: '@angular/router', tokens: ['router-outlet'] },
  RouterLink: { module: '@angular/router', tokens: ['routerlink'] },
  RouterLinkActive: { module: '@angular/router', tokens: ['routerlinkactive'] },
};

const BUILTIN_BY_TOKEN: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [name, def] of Object.entries(BUILTIN_EXPORTS)) {
    for (const token of def.tokens) {
      const list = map.get(token);
      if (list) {
        list.push(name);
      } else {
        map.set(token, [name]);
      }
    }
  }
  return map;
})();

const CANDIDATE_KIND_LABEL: Record<TemplateCandidate['kind'], string> = {
  element: 'element',
  attribute: 'attribute directive',
  input: 'input binding',
  output: 'output binding',
  'two-way': 'two-way binding',
  structural: 'structural directive',
  pipe: 'pipe',
};

function relativeImportSpecifier(ownerFilePath: string, targetFilePath: string): string {
  const rel = path.relative(path.dirname(ownerFilePath), targetFilePath).replace(/\\/g, '/');
  let spec = rel.replace(/\.ts$/, '');
  if (spec.endsWith('/index')) {
    spec = spec.slice(0, -'/index'.length);
  }
  if (spec.length === 0 || !spec.startsWith('.')) {
    spec = `./${spec}`;
  }
  return spec;
}

// ── Options for one template token ───────────────────────────────────────────

function kindLabel(symbol: AutoImportSymbol): string {
  switch (symbol.kind) {
    case 'Component':
      return 'component';
    case 'Directive':
      return 'directive';
    case 'Pipe':
      return 'pipe';
    default:
      return 'module';
  }
}

/**
 * Ranks the ways of providing a token. Selector specificity dominates — a
 * symbol whose whole selector is the token (`[ngModel]`) beats one that merely
 * mentions it among others (`mat-checkbox[required][ngModel]`) — and within
 * the same specificity, workspace symbols come before library ones and plain
 * declarations before the NgModules that export them.
 */
function rankOf(symbol: AutoImportSymbol, token: string): number {
  const isModule = symbol.kind === 'NgModule';
  const origin = symbol.origin === 'workspace' ? (isModule ? 20 : 0) : isModule ? 30 : 10;
  const weight = symbol.weights?.[token] ?? 1;
  return origin + (1 - weight) * 100;
}

/** Builds the pick list for one missing template token. */
function optionsForToken(
  candidate: TemplateCandidate,
  ownerFilePath: string,
  ownerClassName: string,
  index: AutoImportIndex,
): ImportOption[] {
  const options: ImportOption[] = [];
  const seen = new Set<string>();

  for (const symbol of index.byToken.get(candidate.token) ?? []) {
    // A non-standalone declaration can only be reached through its NgModule
    if (symbol.kind !== 'NgModule' && symbol.standalone === false) {
      continue;
    }

    let moduleSpecifier: string | null;
    if (symbol.origin === 'library') {
      moduleSpecifier = symbol.moduleSpecifier ?? null;
      if (moduleSpecifier === null) {
        continue;
      }
    } else if (symbol.filePath && normalizeFs(symbol.filePath) === normalizeFs(ownerFilePath)) {
      moduleSpecifier = null; // declared right here (self-reference)
    } else if (symbol.filePath) {
      moduleSpecifier = relativeImportSpecifier(ownerFilePath, symbol.filePath);
    } else {
      continue;
    }

    const key = `${symbol.className}|${moduleSpecifier ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    options.push({
      action: 'add',
      className: symbol.className,
      moduleSpecifier,
      ownerClassName,
      label: symbol.className,
      description: moduleSpecifier ?? 'this file',
      detail: `${kindLabel(symbol)}${symbol.standalone === true ? ' · standalone' : ''}`,
      preselected: false,
      rank: rankOf(symbol, candidate.token),
    });
  }

  if (options.length === 0) {
    for (const name of BUILTIN_BY_TOKEN.get(candidate.token) ?? []) {
      options.push({
        action: 'add',
        className: name,
        moduleSpecifier: BUILTIN_EXPORTS[name].module,
        ownerClassName,
        label: name,
        description: BUILTIN_EXPORTS[name].module,
        detail: 'Angular built-in',
        preselected: false,
        rank: 40,
      });
    }
  }

  options.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  if (options.length > 0) {
    options[0].preselected = true;
  }
  return options;
}

// ── Template analysis ────────────────────────────────────────────────────────

interface TemplateAnalysis {
  suggestions: Suggestion[];
  skipped: string[];
}

/**
 * Produces one suggestion per template token that is referenced but not yet
 * provided by the component's `imports: [...]`.
 *
 * `coverage` — what each component's existing entries already provide — comes
 * from the cleanup pass, so every entry is resolved once per run.
 */
export function analyzeTemplates(input: {
  ownerFilePath: string;
  owners: DecoratedOwner[];
  index: AutoImportIndex;
  coverage: Map<string, Set<string>>;
  /** overrides the template text of the owner the open HTML file belongs to */
  htmlOverride?: { ownerClassName: string; text: string };
}): TemplateAnalysis {
  const { ownerFilePath, owners, index, coverage, htmlOverride } = input;
  const suggestions: Suggestion[] = [];
  const skipped: string[] = [];

  for (const owner of owners) {
    if (owner.kind !== 'Component') {
      continue;
    }
    if (owner.standaloneExplicitFalse) {
      skipped.push(`${owner.className} (not standalone)`);
      continue;
    }

    const template =
      htmlOverride && htmlOverride.ownerClassName === owner.className
        ? htmlOverride.text
        : templateOf(owner, ownerFilePath);
    if (template === null || template.trim() === '') {
      continue;
    }

    const provided = coverage.get(owner.className) ?? new Set<string>();
    const present = new Set(importsArrayNames(owner.importsArray));

    for (const candidate of collectTemplateCandidates(template).values()) {
      if (provided.has(candidate.token)) {
        continue;
      }
      const options = optionsForToken(candidate, ownerFilePath, owner.className, index).filter(
        (option) => !present.has(option.className),
      );
      if (options.length === 0) {
        continue;
      }
      suggestions.push({
        title: `${candidate.display}  ·  ${CANDIDATE_KIND_LABEL[candidate.kind]}${
          owners.length > 1 ? ` in ${owner.className}` : ''
        }`,
        options,
      });
    }
  }

  return { suggestions, skipped };
}

// ── Cleanup suggestions ──────────────────────────────────────────────────────

const ENTRY_KIND_LABEL: Record<string, string> = {
  Component: 'component',
  Directive: 'directive',
  Pipe: 'pipe',
  NgModule: 'module',
};

/**
 * Turns the cleanup analysis into quick pick entries. Declarations and plain
 * unused imports are ticked by default; NgModules are offered but left
 * unticked, since a module may be there for the providers it carries.
 */
export function cleanupSuggestions(plan: CleanupPlan): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const merged = new Set<string>();

  for (const entry of plan.arrayEntries) {
    merged.add(entry.name);
    const alsoImport = entry.bindingBecomesUnused;
    suggestions.push({
      title: `${entry.name}  ·  unused in ${entry.ownerClassName}'s template`,
      options: [
        {
          action: 'remove',
          className: entry.name,
          moduleSpecifier: entry.moduleSpecifier ?? null,
          ownerClassName: entry.ownerClassName,
          dropBinding: alsoImport,
          label: `Remove ${entry.name}`,
          description: entry.moduleSpecifier ?? '',
          detail: `${ENTRY_KIND_LABEL[entry.kind] ?? 'entry'} · drops the imports array entry${
            alsoImport ? ' and its import statement' : ''
          }${entry.kind === 'NgModule' ? ' — check it provides no services you need' : ''}`,
          preselected: entry.kind !== 'NgModule',
          rank: 0,
        },
      ],
    });
  }

  for (const binding of plan.bindings) {
    if (merged.has(binding.name)) {
      continue; // already covered by the array entry above
    }
    suggestions.push({
      title: `${binding.name}  ·  unused import`,
      options: [
        {
          action: 'remove',
          className: binding.name,
          moduleSpecifier: binding.moduleSpecifier,
          dropBinding: true,
          label: `Remove ${binding.name}`,
          description: binding.moduleSpecifier,
          detail: 'nothing in this file references it',
          preselected: true,
          rank: 0,
        },
      ],
    });
  }

  return suggestions;
}

// ── TypeScript analysis (unresolved identifiers) ─────────────────────────────

/** TypeScript error codes that mean "this name has no import". */
const UNRESOLVED_NAME_CODES = new Set([2304, 2552, 2503, 2686]);

function diagnosticCode(diagnostic: vscode.Diagnostic): number | null {
  const { code } = diagnostic;
  if (typeof code === 'number') {
    return code;
  }
  if (typeof code === 'object' && code !== null && typeof code.value === 'number') {
    return code.value;
  }
  return null;
}

/**
 * Reads the module specifier an "add import" code action would insert.
 *
 * Returns null for anything that is not a single import for `name` — notably
 * TypeScript's "Add all missing imports", which would otherwise be recorded
 * under whichever module happened to come first in its edit.
 */
function moduleSpecifierOfAction(action: vscode.CodeAction, name: string): string | null {
  const inserted: string[] = [];
  const specifiers = new Set<string>();
  for (const [, edits] of action.edit?.entries() ?? []) {
    for (const edit of edits) {
      inserted.push(edit.newText);
      for (const match of edit.newText.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
        specifiers.add(match[1]);
      }
    }
  }

  if (inserted.length > 0) {
    const wordBoundary = new RegExp(`\\b${name}\\b`);
    if (!inserted.some((text) => wordBoundary.test(text))) {
      return null;
    }
    if (specifiers.size > 1) {
      return null; // a fix-all action
    }
    if (specifiers.size === 1) {
      return [...specifiers][0];
    }
  }

  // "Update import from './x'" merges into an existing statement, so the
  // module only appears in the title.
  const fromTitle = /['"]([^'"]+)['"]\s*$/.exec(action.title);
  return fromTitle ? fromTitle[1] : null;
}

/**
 * Asks the TypeScript server which identifiers of the open file are unresolved
 * and which modules could provide them.
 */
async function analyzeTypeScript(document: vscode.TextDocument): Promise<Suggestion[]> {
  if (document.isDirty) {
    // Give the TypeScript server a moment to publish diagnostics for edits
    // that were made right before the command ran.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const diagnostics = vscode.languages.getDiagnostics(document.uri).filter((diagnostic) => {
    const code = diagnosticCode(diagnostic);
    return code !== null && UNRESOLVED_NAME_CODES.has(code);
  });

  const suggestions: Suggestion[] = [];
  const handled = new Set<string>();

  for (const diagnostic of diagnostics) {
    const name = document.getText(diagnostic.range).trim();
    if (name === '' || handled.has(name) || !/^[A-Za-z_$][\w$]*$/.test(name)) {
      continue;
    }
    handled.add(name);

    let actions: vscode.CodeAction[] = [];
    try {
      actions =
        (await vscode.commands.executeCommand<vscode.CodeAction[]>(
          'vscode.executeCodeActionProvider',
          document.uri,
          diagnostic.range,
          vscode.CodeActionKind.QuickFix.value,
          16,
        )) ?? [];
    } catch (error) {
      logDiagnostic(
        `Auto-import: code actions for "${name}" failed (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    const options: ImportOption[] = [];
    const seen = new Set<string>();
    for (const action of actions) {
      if (!/import/i.test(action.title) || /\ball\b/i.test(action.title)) {
        continue;
      }
      const moduleSpecifier = moduleSpecifierOfAction(action, name);
      if (moduleSpecifier === null || seen.has(moduleSpecifier)) {
        continue;
      }
      seen.add(moduleSpecifier);
      options.push({
        action: 'add',
        className: name,
        moduleSpecifier,
        label: name,
        description: moduleSpecifier,
        detail: 'TypeScript import',
        preselected: options.length === 0,
        rank: options.length,
      });
    }

    if (options.length > 0) {
      suggestions.push({ title: `${name}  ·  unresolved identifier`, options });
    }
  }

  return suggestions;
}

// ── Quick pick ───────────────────────────────────────────────────────────────

interface OptionItem extends vscode.QuickPickItem {
  option: ImportOption;
}

/**
 * Shows every suggestion grouped under a separator, additions first, with the
 * recommended option of each group ticked.
 */
async function pickImports(suggestions: Suggestion[]): Promise<ImportOption[] | null> {
  const items: Array<OptionItem | vscode.QuickPickItem> = [];

  for (const suggestion of suggestions) {
    items.push({ label: suggestion.title, kind: vscode.QuickPickItemKind.Separator });
    for (const option of suggestion.options) {
      items.push({
        label: option.label,
        description: option.description,
        detail: option.detail,
        picked: option.preselected,
        option,
      });
    }
  }

  const additions = suggestions.filter((entry) => entry.options[0]?.action === 'add').length;
  const removals = suggestions.length - additions;
  const summary =
    [additions > 0 ? `${additions} to add` : '', removals > 0 ? `${removals} to remove` : '']
      .filter(Boolean)
      .join(', ') || 'nothing to do';

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
    title: `Angular CLI Plus — ${summary}`,
    placeHolder: 'Select what to apply (space toggles, enter confirms)',
  });

  if (!picked) {
    return null;
  }
  return picked.filter((item): item is OptionItem => 'option' in item).map((item) => item.option);
}

// ── Edit construction ────────────────────────────────────────────────────────

export interface BuiltEdits {
  spans: TextSpan[];
  addedImports: number;
  addedEntries: number;
  removedEntries: number;
  removedImports: number;
  conflicts: string[];
}

/**
 * Turns the user's selection into text spans over `sourceFile`.
 *
 * Additions and removals are merged per import statement and per `imports`
 * array before any span is produced, so the two can never overlap.
 */
export function buildEditsForSelection(
  ownerFilePath: string,
  sourceFile: ts.SourceFile,
  owners: DecoratedOwner[],
  selection: readonly ImportOption[],
): BuiltEdits {
  const addByModule = new Map<string, string[]>();
  const addByOwner = new Map<string, string[]>();
  const removeByOwner = new Map<string, Set<string>>();
  const removeBindings = new Set<string>();
  const conflicts: string[] = [];
  const importedNames = new Set<string>();
  const bindings = collectImportBindings(sourceFile);

  for (const option of selection) {
    if (option.action === 'remove') {
      if (option.ownerClassName) {
        const set = removeByOwner.get(option.ownerClassName) ?? new Set<string>();
        set.add(option.className);
        removeByOwner.set(option.ownerClassName, set);
      }
      if (option.dropBinding) {
        removeBindings.add(option.className);
      }
      continue;
    }

    if (option.moduleSpecifier !== null && !importedNames.has(option.className)) {
      if (isLocalBindingTaken(sourceFile, option.className)) {
        if (bindings.get(option.className) !== option.moduleSpecifier) {
          conflicts.push(option.className);
          continue;
        }
        // Already imported from that module: only the array entry is missing
      } else {
        const names = addByModule.get(option.moduleSpecifier) ?? [];
        names.push(option.className);
        addByModule.set(option.moduleSpecifier, names);
        importedNames.add(option.className);
      }
    }

    if (option.ownerClassName) {
      const entries = addByOwner.get(option.ownerClassName) ?? [];
      if (!entries.includes(option.className)) {
        entries.push(option.className);
      }
      addByOwner.set(option.ownerClassName, entries);
    }
  }

  const spans = planImportStatements(sourceFile, { add: addByModule, remove: removeBindings });

  let addedEntries = 0;
  let removedEntries = 0;

  for (const ownerClassName of new Set([...addByOwner.keys(), ...removeByOwner.keys()])) {
    const owner = owners.find((candidate) => candidate.className === ownerClassName);
    if (!owner) {
      continue;
    }
    const existing = importsArrayNames(owner.importsArray);
    const remove = removeByOwner.get(ownerClassName) ?? new Set<string>();
    const add = (addByOwner.get(ownerClassName) ?? []).filter((name) => !existing.includes(name));

    const arraySpans = planImportsArray(sourceFile, owner, { add, remove }, (reason) =>
      logDiagnostic(`Auto-import: ${reason}`),
    );
    if (arraySpans.length > 0) {
      spans.push(...arraySpans);
      addedEntries += add.length;
      removedEntries += remove.size;
    }
  }

  return {
    spans,
    addedImports: [...addByModule.values()].reduce((total, names) => total + names.length, 0),
    addedEntries,
    removedEntries,
    removedImports: removeBindings.size,
    conflicts,
  };
}

// ── Command implementation ───────────────────────────────────────────────────

/** Locates the owning `.ts` file for an open HTML template. */
function findOwnerTsFileForHtml(htmlUri: vscode.Uri, index: AutoImportIndex): string | null {
  const owners = index.templateUrlOwners.get(normalizeFs(htmlUri.fsPath)) ?? [];
  if (owners.length > 0) {
    return owners[0];
  }

  // Fallback: sibling .ts next to the template
  const htmlPath = htmlUri.fsPath;
  const sibling = htmlPath.endsWith('.component.html')
    ? htmlPath.replace(/\.component\.html$/, '.component.ts')
    : `${htmlPath.slice(0, -'.html'.length)}.ts`;
  return fs.existsSync(sibling) ? sibling : null;
}

/** Validates the command context. Throws with a user-friendly message. */
function validateContext(): { document: vscode.TextDocument; workspaceRoot: string } {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error('No active editor');
  }
  const document = editor.document;
  if (document.languageId !== 'typescript' && document.languageId !== 'html') {
    throw new Error('Only TypeScript and HTML files are supported');
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    throw new Error('The file is not part of the workspace');
  }
  const workspaceRoot = workspaceFolder.uri.fsPath;
  if (!fs.existsSync(path.join(workspaceRoot, 'angular.json'))) {
    throw new Error('No angular.json found in the workspace folder');
  }
  return { document, workspaceRoot };
}

/** Picks the component owner an open HTML template belongs to. */
function ownerForHtml(
  owners: DecoratedOwner[],
  ownerFilePath: string,
  htmlPath: string,
): DecoratedOwner | undefined {
  const wanted = normalizeFs(htmlPath);
  const matching = owners.find(
    (owner) =>
      owner.templateUrl !== null &&
      normalizeFs(path.resolve(path.dirname(ownerFilePath), owner.templateUrl)) === wanted,
  );
  return matching ?? owners.find((owner) => owner.kind === 'Component');
}

function describe(built: BuiltEdits, fileName: string): string {
  const parts: string[] = [];
  if (built.addedImports > 0 || built.addedEntries > 0) {
    parts.push(`added ${built.addedImports} import(s), ${built.addedEntries} array entry/entries`);
  }
  if (built.removedImports > 0 || built.removedEntries > 0) {
    parts.push(
      `removed ${built.removedImports} import(s), ${built.removedEntries} array entry/entries`,
    );
  }
  const conflictSuffix =
    built.conflicts.length > 0 ? ` — ${built.conflicts.length} skipped (name clash)` : '';
  return `${parts.join('; ')} in ${fileName}${conflictSuffix}`;
}

/** Runs the command body and returns a summary, or null when cancelled. */
async function runAutoImport(): Promise<string | null> {
  const { document, workspaceRoot } = validateContext();
  const isHtml = document.languageId === 'html';

  const index = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Angular CLI Plus: scanning imports…',
      cancellable: true,
    },
    (progress, token) => getAutoImportIndex(workspaceRoot, progress, token),
  );

  let ownerFilePath: string;
  if (isHtml) {
    const found = findOwnerTsFileForHtml(document.uri, index);
    if (!found) {
      throw new Error('Could not locate the component TypeScript file for this template');
    }
    ownerFilePath = found;
  } else {
    ownerFilePath = document.uri.fsPath;
  }

  const ownerSource = readCurrentText(ownerFilePath);
  if (ownerSource === null) {
    throw new Error(`Could not read ${path.basename(ownerFilePath)}`);
  }
  const ownerSourceFile = ts.createSourceFile(
    ownerFilePath,
    ownerSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const owners = parseDecoratedOwners(ownerSourceFile);

  let htmlOverride: { ownerClassName: string; text: string } | undefined;
  if (isHtml) {
    const owner = ownerForHtml(owners, ownerFilePath, document.uri.fsPath);
    if (!owner) {
      throw new Error(`No @Component found in ${path.basename(ownerFilePath)}`);
    }
    htmlOverride = { ownerClassName: owner.className, text: document.getText() };
  }

  // One pass resolves every existing entry: it yields both what the templates
  // already have (coverage) and what they no longer need (cleanup).
  const cleanup = computeCleanupPlan({
    filePath: ownerFilePath,
    sourceFile: ownerSourceFile,
    owners,
    index,
    htmlOverride,
    includeModules: true,
    cleanArrays: true,
    cleanBindings: true,
  });

  for (const [ownerClassName, names] of cleanup.unresolved) {
    logDiagnostic(
      `Auto-import: could not resolve what these entries of ${ownerClassName} provide: ${names.join(', ')}`,
    );
  }

  const templates = analyzeTemplates({
    ownerFilePath,
    owners,
    index,
    coverage: cleanup.coverage,
    htmlOverride,
  });
  const typescriptSuggestions = isHtml ? [] : await analyzeTypeScript(document);
  const suggestions = [
    ...templates.suggestions,
    ...typescriptSuggestions,
    ...cleanupSuggestions(cleanup),
  ];

  if (suggestions.length === 0) {
    const skipped = [...templates.skipped, ...cleanup.skipped];
    const suffix = skipped.length > 0 ? ` (skipped ${skipped.join(', ')})` : '';
    return `Imports are up to date${suffix}`;
  }

  const selection = await pickImports(suggestions);
  if (selection === null) {
    return null;
  }
  if (selection.length === 0) {
    return 'Nothing selected';
  }

  const built = buildEditsForSelection(ownerFilePath, ownerSourceFile, owners, selection);
  for (const conflict of built.conflicts) {
    logDiagnostic(
      `Auto-import: skipped "${conflict}" — a different binding with that name already exists in ${ownerFilePath}`,
    );
  }
  if (built.spans.length === 0) {
    return 'Nothing to change — the selection is already applied';
  }

  const edit = new vscode.WorkspaceEdit();
  const targetUri = vscode.Uri.file(ownerFilePath);
  for (const span of built.spans) {
    const startPos = ownerSourceFile.getLineAndCharacterOfPosition(span.start);
    const endPos = ownerSourceFile.getLineAndCharacterOfPosition(span.end);
    edit.replace(
      targetUri,
      new vscode.Range(
        new vscode.Position(startPos.line, startPos.character),
        new vscode.Position(endPos.line, endPos.character),
      ),
      span.text,
    );
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error('Failed to apply the edits');
  }

  if (isHtml) {
    const ownerDoc = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(ownerDoc, { preview: true });
  }

  return describe(built, path.basename(ownerFilePath));
}

/** Entry point of "Angular: Auto Import Missing Imports" (`Ctrl+Shift+A I`). */
export async function autoImportMissingImports(): Promise<void> {
  let summary: string | null;
  try {
    summary = await runAutoImport();
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logDiagnostic(`Auto-import failed: ${message}`);
    void vscode.window.showErrorMessage(`Angular CLI Plus: ${message}`);
    return;
  }

  if (summary !== null) {
    void vscode.window.showInformationMessage(`Angular CLI Plus: ${summary}`);
  }
}
