import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractTokensFromSelector, resolveImportedSymbolTokens } from './clean-imports';
import type { FileContentsReader } from './clean-imports';
import { logDiagnostic } from './state';

/**
 * "Angular: Auto Import Missing Imports" (`Ctrl+Shift+A I`).
 *
 * Scans the template corpus of the active file's component(s) — inline
 * `template:` strings plus external `templateUrl` HTML — for element tags,
 * attribute/structural directives and pipes that are not covered by any entry
 * of the decorators' `imports: [...]` array, then adds the missing pieces in
 * one WorkspaceEdit:
 *   - a new `import { Symbol } from '...';` statement
 *   - appended entries inside the existing `imports` array, or a freshly
 *     created array when the decorator does not have one yet
 *
 * Resolution sources:
 *   1. A workspace index of exported @Component/@Directive/@Pipe classes built
 *      with the TypeScript Compiler API (relative imports).
 *   2. A built-in map for common Angular exports (NgIf, RouterLink, AsyncPipe,
 *      FormsModule, ...) whose module specifiers are known ahead of time.
 *
 * Safety policy mirrors the Auto-clean feature: anything that cannot be
 * confidently resolved is skipped rather than guessed.
 */

// ── Types ────────────────────────────────────────────────────────────────────

type DecoratorKind = 'Component' | 'Directive' | 'Pipe';

interface SymbolEntry {
  className: string;
  filePath: string;
  kind: DecoratorKind;
  /** selector / pipe-name tokens (original case; compared lowercased) */
  tokens: string[];
}

interface SymbolIndex {
  /** lowercased token → matching entries */
  byToken: Map<string, SymbolEntry[]>;
  /** normalized templateUrl targets → owner .ts files */
  templateUrlOwners: Map<string, string[]>;
}

interface DecoratedOwner {
  className: string;
  kind: DecoratorKind;
  standaloneExplicitFalse: boolean;
  importsArray: ts.ArrayLiteralExpression | undefined;
  decoratorObject: ts.ObjectLiteralExpression;
  inlineTemplate: string | null;
  templateUrl: string | null;
}

interface PlannedImport {
  className: string;
  moduleSpecifier: string;
}

interface ClassPlan {
  /** array to append into, or object literal to create the array on */
  array?: ts.ArrayLiteralExpression;
  createForObject?: ts.ObjectLiteralExpression;
  classNames: string[];
}

interface PlanOutcome {
  addedCount: number;
  skippedClasses: Array<{ className: string; reason: string }>;
}

interface TextSpan {
  start: number;
  end: number;
  text: string;
}

// ── Built-in Angular knowledge ────────────────────────────────────────────────

interface BuiltInExport {
  module: string;
  /** selector / pipe-name tokens this symbol provides (lowercase) */
  tokens?: string[];
}

const COMMON_MODULE = '@angular/common';

const BUILTIN_EXPORTS: Record<string, BuiltInExport> = {
  NgIf: { module: COMMON_MODULE, tokens: ['ngif'] },
  NgFor: { module: COMMON_MODULE, tokens: ['ngfor'] },
  NgClass: { module: COMMON_MODULE, tokens: ['ngclass'] },
  NgStyle: { module: COMMON_MODULE, tokens: ['ngstyle'] },
  NgSwitch: { module: COMMON_MODULE, tokens: ['ngswitch'] },
  NgSwitchCase: { module: COMMON_MODULE, tokens: ['ngswitchcase'] },
  NgSwitchDefault: { module: COMMON_MODULE, tokens: ['ngswitchdefault'] },
  NgTemplateOutlet: { module: COMMON_MODULE, tokens: ['ngtemplateoutlet'] },
  NgComponentOutlet: { module: COMMON_MODULE, tokens: ['ngcomponentoutlet'] },
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
  I18nPluralPipe: { module: COMMON_MODULE, tokens: ['i18nplural'] },
  I18nSelectPipe: { module: COMMON_MODULE, tokens: ['i18nselect'] },
  CommonModule: { module: COMMON_MODULE },
  FormsModule: {
    module: '@angular/forms',
    tokens: ['ngmodel', 'formgroup', 'formcontrolname', 'formcontrol'],
  },
  RouterOutlet: { module: '@angular/router', tokens: ['router-outlet'] },
  RouterLink: { module: '@angular/router', tokens: ['routerlink'] },
  RouterLinkActive: { module: '@angular/router', tokens: ['routerlinkactive'] },
};

// CommonModule provides every directive and pipe exported from @angular/common
{
  const commonTokens = new Set<string>();
  for (const def of Object.values(BUILTIN_EXPORTS)) {
    if (def.module === COMMON_MODULE && def.tokens) {
      for (const token of def.tokens) {
        commonTokens.add(token);
      }
    }
  }
  BUILTIN_EXPORTS.CommonModule.tokens = [...commonTokens];
}

/** token → built-in symbol names that provide it */
const BUILTIN_TOKEN_TO_SYMBOLS: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [name, def] of Object.entries(BUILTIN_EXPORTS)) {
    if (!def.tokens) {
      continue;
    }
    for (const token of def.tokens) {
      const existing = map.get(token);
      if (!existing) {
        map.set(token, [name]);
      } else if (!existing.includes(name)) {
        existing.push(name);
      }
    }
  }
  return map;
})();

// ── Standard HTML/SVG tags & attributes (never imported) ─────────────────────

const STANDARD_TAGS = new Set<string>([
  // HTML
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base',
  'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption',
  'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map',
  'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress',
  'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section',
  'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot',
  'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video',
  'wbr', 'center', 'font', 'strike',
  // SVG
  'svg', 'g', 'defs', 'circle', 'ellipse', 'rect', 'line', 'polyline',
  'polygon', 'path', 'text', 'tspan', 'textpath', 'marker', 'clippath',
  'mask', 'pattern', 'lineargradient', 'radialgradient', 'stop', 'image',
  'use', 'symbol', 'foreignobject', 'filter', 'fedropshadow', 'fegaussianblur',
  'animate', 'animatetransform', 'view', 'desc', 'metadata',
]);

const NATIVE_EVENTS = new Set<string>([
  'click', 'dblclick', 'auxclick', 'contextmenu', 'blur', 'focus', 'focusin',
  'focusout', 'input', 'change', 'submit', 'reset', 'invalid', 'keydown',
  'keyup', 'keypress', 'mousedown', 'mouseup', 'mousemove', 'mouseenter',
  'mouseleave', 'mouseout', 'mouseover', 'wheel', 'scroll', 'drag',
  'dragstart', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop',
  'copy', 'cut', 'paste', 'load', 'error', 'abort', 'play', 'pause', 'ended',
  'volumechange', 'timeupdate', 'progress', 'canplay', 'canplaythrough',
  'waiting', 'loadedmetadata', 'emptied', 'stalled', 'suspend', 'select',
  'selectionchange', 'selectstart', 'toggle', 'pointerdown', 'pointerup',
  'pointermove', 'pointerenter', 'pointerleave', 'pointercancel',
  'pointerover', 'pointerout', 'gotpointercapture', 'lostpointercapture',
  'animationstart', 'animationend', 'animationiteration', 'transitionstart',
  'transitionend', 'transitionrun', 'transitioncancel', 'touchstart',
  'touchmove', 'touchend', 'touchcancel', 'compositionstart',
  'compositionupdate', 'compositionend', 'storage', 'online', 'offline',
  'message', 'open', 'close', 'show', 'popstate', 'hashchange', 'resize',
  'search', 'beforeprint', 'afterprint', 'beforeunload', 'unload',
]);

/** Control-flow block keywords that must never be treated as directives */
const CONTROL_FLOW_KEYWORDS = new Set<string>([
  'if', 'else', 'for', 'empty', 'switch', 'case', 'default', 'defer',
  'placeholder', 'loading', 'error', 'let',
]);

/** Plain HTML attributes that never require a directive import */
const STANDARD_ATTRS = new Set<string>([
  'src', 'href', 'alt', 'id', 'name', 'type', 'value', 'disabled', 'readonly',
  'required', 'checked', 'hidden', 'target', 'rel', 'placeholder', 'title',
  'role', 'tabindex', 'min', 'max', 'step', 'pattern', 'maxlength',
  'minlength', 'size', 'rows', 'cols', 'colspan', 'rowspan', 'headers',
  'scope', 'span', 'start', 'reversed', 'multiple', 'list', 'label',
  'selected', 'autoplay', 'controls', 'loop', 'muted', 'preload', 'poster',
  'action', 'method', 'enctype', 'novalidate', 'autocomplete', 'autofocus',
  'dir', 'draggable', 'lang', 'spellcheck', 'translate', 'contenteditable',
  'download', 'hreflang', 'media', 'kind', 'srclang', 'wrap', 'accept',
  'capture', 'inputmode', 'enterkeyhint', 'align', 'bgcolor', 'border',
  'cellpadding', 'cellspacing', 'frameborder', 'height', 'width',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.git', '.vscode', '.angular']);

/** True when any path segment lives inside a build/tooling directory. */
function isInsideSkippedDir(filePath: string): boolean {
  return filePath.split(/[\\/]/).some((segment) => SKIP_DIRS.has(segment));
}

const DECORATOR_KINDS: ReadonlySet<string> = new Set(['Component', 'Directive', 'Pipe']);

// ── Small helpers ────────────────────────────────────────────────────────────

function normalizeFs(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function readFileOrNull(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/** Attempts common location variants for a relative module specifier. */
function resolveModuleToTsFile(
  baseDir: string,
  specifier: string,
  readFile: FileContentsReader,
): string | null {
  const joined = path.resolve(baseDir, specifier);
  const candidates = [joined];
  if (!joined.endsWith('.ts')) {
    candidates.push(`${joined}.ts`);
    candidates.push(path.join(joined, 'index.ts'));
  }
  for (const candidate of candidates) {
    if (candidate.endsWith('.ts') && readFile(candidate) !== null) {
      return candidate;
    }
  }
  return null;
}

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

/**
 * Checks whether `localName` is already bound locally (imported elsewhere /
 * declared in this file), in which case adding a second binding would
 * conflict.
 */
function isLocalBindingTaken(sourceFile: ts.SourceFile, localName: string): boolean {
  let taken = false;
  function visit(node: ts.Node): void {
    if (taken) {
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === localName
    ) {
      taken = true;
      return;
    }
    if (
      (ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node)) &&
      node.name.text === localName
    ) {
      taken = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return taken;
}

// ── Decorator parsing ────────────────────────────────────────────────────────

/** Extracts decorated @Component/@Directive/@Pipe owners from a source file. */
export function parseDecoratedOwners(sourceFile: ts.SourceFile): DecoratedOwner[] {
  const owners: DecoratedOwner[] = [];

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name && node.modifiers) {
      for (const modifier of node.modifiers) {
        if (
          !ts.isDecorator(modifier) ||
          !ts.isCallExpression(modifier.expression) ||
          modifier.expression.arguments.length === 0 ||
          !ts.isObjectLiteralExpression(modifier.expression.arguments[0])
        ) {
          continue;
        }
        const callee = modifier.expression.expression;
        if (!ts.isIdentifier(callee) || !DECORATOR_KINDS.has(callee.text)) {
          continue;
        }

        let importsArray: ts.ArrayLiteralExpression | undefined;
        let standaloneExplicitFalse = false;
        let inlineTemplate: string | null = null;
        let templateUrl: string | null = null;

        for (const prop of modifier.expression.arguments[0].properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
            continue;
          }
          switch (prop.name.text) {
            case 'imports':
              if (ts.isArrayLiteralExpression(prop.initializer)) {
                importsArray = prop.initializer;
              }
              break;
            case 'standalone':
              standaloneExplicitFalse = prop.initializer.kind === ts.SyntaxKind.FalseKeyword;
              break;
            case 'template':
              if (
                ts.isStringLiteral(prop.initializer) ||
                ts.isNoSubstitutionTemplateLiteral(prop.initializer)
              ) {
                inlineTemplate = prop.initializer.text;
              }
              break;
            case 'templateUrl':
              if (ts.isStringLiteral(prop.initializer)) {
                templateUrl = prop.initializer.text;
              }
              break;
            default:
              break;
          }
        }

        owners.push({
          className: node.name.text,
          kind: callee.text as DecoratorKind,
          standaloneExplicitFalse,
          importsArray,
          decoratorObject: modifier.expression.arguments[0],
          inlineTemplate,
          templateUrl,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return owners;
}

function isExported(node: ts.ClassDeclaration): boolean {
  return Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * Builds local-name → module-specifier bindings for every named value import
 * in the given (already parsed) owner source.
 */
function collectImportBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const named = statement.importClause.namedBindings;
    if (!named || !ts.isNamedImports(named)) {
      continue;
    }
    for (const element of named.elements) {
      bindings.set(element.name.text, statement.moduleSpecifier.text);
    }
  }
  return bindings;
}

// ── Workspace symbol index ────────────────────────────────────────────────────

/**
 * Indexes every exported @Component/@Directive/@Pipe class in workspace `.ts`
 * files by their selector / pipe-name tokens, and records `templateUrl`
 * targets so an open HTML file can find its owning component file.
 */
async function buildSymbolIndex(workspaceRoot: string): Promise<SymbolIndex> {
  const index: SymbolIndex = {
    byToken: new Map(),
    templateUrlOwners: new Map(),
  };

  const rootUri = vscode.Uri.file(workspaceRoot);
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootUri, '**/*.ts'),
    new vscode.RelativePattern(rootUri, '{node_modules,dist,out,.git,.vscode,.angular}/**'),
  );

  for (const uri of uris) {
    const filePath = uri.fsPath;
    if (filePath.endsWith('.d.ts')) {
      continue;
    }
    if (isInsideSkippedDir(filePath)) {
      continue;
    }
    const content = readFileOrNull(filePath);
    if (content === null) {
      continue;
    }

    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    // templateUrl → owner map
    for (const owner of parseDecoratedOwners(sourceFile)) {
      if (owner.templateUrl) {
        const abs = normalizeFs(path.resolve(path.dirname(filePath), owner.templateUrl));
        const list = index.templateUrlOwners.get(abs) ?? [];
        list.push(filePath);
        index.templateUrlOwners.set(abs, list);
      }
    }

    // Selector / pipe-name tokens of exported classes
    for (const entry of collectExportedDecoratedEntries(sourceFile)) {
      for (const token of entry.tokens) {
        const key = token.toLowerCase();
        const list = index.byToken.get(key) ?? [];
        if (
          !list.some(
            (e) =>
              e.className === entry.className &&
              normalizeFs(e.filePath) === normalizeFs(entry.filePath),
          )
        ) {
          list.push(entry);
          index.byToken.set(key, list);
        }
      }
    }
  }

  return index;
}

/** Collects exported decorated classes with resolvable selector/pipe metadata. */
function collectExportedDecoratedEntries(sourceFile: ts.SourceFile): SymbolEntry[] {
  const results: SymbolEntry[] = [];

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && isExported(node) && node.name && node.modifiers) {
      for (const modifier of node.modifiers) {
        if (
          !ts.isDecorator(modifier) ||
          !ts.isCallExpression(modifier.expression) ||
          modifier.expression.arguments.length === 0 ||
          !ts.isObjectLiteralExpression(modifier.expression.arguments[0])
        ) {
          continue;
        }
        const callee = modifier.expression.expression;
        if (!ts.isIdentifier(callee) || !DECORATOR_KINDS.has(callee.text)) {
          continue;
        }
        const metaPropertyName = callee.text === 'Pipe' ? 'name' : 'selector';

        for (const prop of modifier.expression.arguments[0].properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
            continue;
          }
          if (prop.name.text !== metaPropertyName || !ts.isStringLiteral(prop.initializer)) {
            continue;
          }
          const tokens = extractTokensFromSelector(prop.initializer.text);
          if (tokens !== null && tokens.length > 0) {
            results.push({
              className: node.name!.text,
              filePath: sourceFile.fileName,
              kind: callee.text as DecoratorKind,
              tokens,
            });
          }
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

/**
 * Resolves a candidate token to exactly one workspace symbol, or null when it
 * matches nothing or several distinct classes (ambiguous).
 */
function pickUniqueEntry(entries: SymbolEntry[]): SymbolEntry | null {
  if (entries.length === 0) {
    return null;
  }
  const first = entries[0];
  const same = entries.every(
    (e) =>
      e.className === first.className && normalizeFs(e.filePath) === normalizeFs(first.filePath),
  );
  return same ? first : null;
}

// ── Template candidate extraction ─────────────────────────────────────────────

/**
 * Extracts import-relevant tokens from one template corpus: custom element
 * tags, attribute bindings ([x], [(x)]), event bindings that are not native
 * DOM events, structural directives (*x) and pipes (| x).
 */
export function collectTemplateCandidates(html: string): Set<string> {
  const out = new Set<string>();

  // Element tags
  for (const match of html.matchAll(/<\s*([a-zA-Z][\w-]*)/g)) {
    if (!STANDARD_TAGS.has(match[1].toLowerCase())) {
      out.add(match[1].toLowerCase());
    }
  }

  // Two-way bindings [(x)]
  for (const match of html.matchAll(/\[\(([\w.$-]+)\)\]/g)) {
    const base = match[1].split('.')[0].toLowerCase();
    if (!STANDARD_ATTRS.has(base) && !CONTROL_FLOW_KEYWORDS.has(base)) {
      out.add(base);
    }
  }

  // Property/bound attributes [x] or [x.suffix]
  for (const match of html.matchAll(/\[([\w.$-]+)(?:\.[\w$]+)?\]/g)) {
    const base = match[1].split('.')[0].toLowerCase();
    if (
      !STANDARD_ATTRS.has(base) &&
      !CONTROL_FLOW_KEYWORDS.has(base) &&
      base !== 'attr' &&
      base !== 'class' &&
      base !== 'style'
    ) {
      out.add(base);
    }
  }

  // Event bindings (x) — skip native DOM events and host-prefixed targets
  for (const match of html.matchAll(/(?:^|[\s"{(])\(([\w.$-]+)(?:\.[\w$]+)?\)/g)) {
    const base = match[1];
    if (base.includes(':')) {
      continue;
    }
    const eventName = base.split('.')[0].toLowerCase();
    if (!NATIVE_EVENTS.has(eventName)) {
      out.add(eventName);
    }
  }

  // Structural directives *x
  for (const match of html.matchAll(/\*\s*([a-zA-Z][\w-]*)/g)) {
    const name = match[1];
    if (!CONTROL_FLOW_KEYWORDS.has(name.toLowerCase())) {
      out.add(name.toLowerCase());
    }
  }

  // Pipes | x (excluding logical OR "||")
  for (const match of html.matchAll(/(?<!\|)\|\s*([a-zA-Z][\w]*)/g)) {
    out.add(match[1].toLowerCase());
  }

  return out;
}

// ── Coverage analysis ─────────────────────────────────────────────────────────

interface CoverageResult {
  coveredTokens: Set<string>;
  unresolvedEntryNames: string[];
}

/**
 * Determines which template tokens are already provided by the given imports
 * array, resolving relative entries to their declaring files. Entries whose
 * provider set cannot be confidently determined surface as unresolved.
 */
function computeCoverage(
  ownerFilePath: string,
  array: ts.ArrayLiteralExpression,
  importBindings: Map<string, string>,
  readFile: FileContentsReader,
): CoverageResult {
  const coveredTokens = new Set<string>();
  const unresolvedEntryNames: string[] = [];

  for (const element of array.elements) {
    if (!ts.isIdentifier(element)) {
      unresolvedEntryNames.push('<spread>');
      continue;
    }
    const localName = element.text;

    const builtIn = BUILTIN_EXPORTS[localName];
    if (builtIn) {
      for (const token of builtIn.tokens ?? []) {
        coveredTokens.add(token);
      }
      continue;
    }

    const moduleSpecifier = importBindings.get(localName);
    if (
      !moduleSpecifier ||
      !(moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../'))
    ) {
      unresolvedEntryNames.push(localName);
      continue;
    }

    const targetFile = resolveModuleToTsFile(
      path.dirname(ownerFilePath),
      moduleSpecifier,
      readFile,
    );
    if (targetFile === null) {
      unresolvedEntryNames.push(localName);
      continue;
    }

    const tokens = resolveImportedSymbolTokens(targetFile, localName, readFile);
    if (tokens === null) {
      unresolvedEntryNames.push(localName);
      continue;
    }
    for (const token of tokens) {
      coveredTokens.add(token.toLowerCase());
    }
  }

  return { coveredTokens, unresolvedEntryNames };
}

// ── Planning ──────────────────────────────────────────────────────────────────

interface PlannedEdits {
  spans: TextSpan[];
  outcome: PlanOutcome;
}

/**
 * Plans all edits for the given owner file: computes missing candidates per
 * component class, resolves them, and returns replacement spans (offsets into
 * the exact `ownerSource` snapshot passed in) plus import statements.
 */
export function planAutoImportEdits(input: {
  ownerFilePath: string;
  ownerSource: string;
  owners: DecoratedOwner[];
  candidateTokens: Set<string>;
  index: SymbolIndex;
  readFile: FileContentsReader;
}): PlannedEdits {
  const { ownerFilePath, ownerSource, owners, candidateTokens, index, readFile } = input;
  const sourceFile = ts.createSourceFile(ownerFilePath, ownerSource, ts.ScriptTarget.Latest, true);
  const importBindings = collectImportBindings(sourceFile);

  const plannedImports = new Map<string, PlannedImport>();
  const classPlans = new Map<string, ClassPlan>();
  const skippedClasses: Array<{ className: string; reason: string }> = [];

  for (const owner of owners) {
    if (owner.kind !== 'Component') {
      continue;
    }
    if (owner.standaloneExplicitFalse) {
      skippedClasses.push({ className: owner.className, reason: 'non-standalone component' });
      continue;
    }

    const ownerCorpus: string[] = [];
    if (owner.inlineTemplate !== null) {
      ownerCorpus.push(owner.inlineTemplate.toLowerCase());
    } else if (owner.templateUrl !== null) {
      const html = readFile(path.resolve(path.dirname(ownerFilePath), owner.templateUrl));
      if (html !== null) {
        ownerCorpus.push(html.toLowerCase());
      }
    }
    if (ownerCorpus.length === 0) {
      continue;
    }

    let coveredTokens = new Set<string>();
    let skipReason: string | undefined;

    if (owner.importsArray) {
      const coverage = computeCoverage(ownerFilePath, owner.importsArray, importBindings, readFile);
      coveredTokens = coverage.coveredTokens;
      if (coverage.unresolvedEntryNames.length > 0) {
        skipReason = `unresolvable entries in imports array: ${coverage.unresolvedEntryNames.join(', ')}`;
      }
    }

    if (skipReason) {
      skippedClasses.push({ className: owner.className, reason: skipReason });
      continue;
    }

    for (const normalized of candidateTokens) {
      if (coveredTokens.has(normalized)) {
        continue;
      }
      // This class must actually reference the token somewhere
      if (!ownerCorpus.some((corpus) => corpus.includes(normalized))) {
        continue;
      }

      let chosenClassName: string | null = null;
      let moduleSpecifier: string | null = null;

      const entries = index.byToken.get(normalized);
      const matched = entries ? pickUniqueEntry(entries) : null;
      if (matched) {
        chosenClassName = matched.className;
        moduleSpecifier = relativeImportSpecifier(ownerFilePath, matched.filePath);
      } else {
        const builtins = BUILTIN_TOKEN_TO_SYMBOLS.get(normalized);
        if (builtins && builtins.length === 1) {
          chosenClassName = builtins[0];
          moduleSpecifier = BUILTIN_EXPORTS[chosenClassName]?.module ?? null;
        }
      }

      if (!chosenClassName || !moduleSpecifier) {
        continue;
      }

      if (!plannedImports.has(chosenClassName)) {
        plannedImports.set(chosenClassName, { className: chosenClassName, moduleSpecifier });
      }

      let plan = classPlans.get(owner.className);
      if (!plan) {
        plan = { classNames: [] };
        if (owner.importsArray) {
          plan.array = owner.importsArray;
        } else {
          plan.createForObject = owner.decoratorObject;
        }
        classPlans.set(owner.className, plan);
      }
      if (!plan.classNames.includes(chosenClassName)) {
        plan.classNames.push(chosenClassName);
      }
    }
  }

  // Drop planned identifiers that are already present in their target array
  for (const [, plan] of classPlans) {
    if (plan.array) {
      const existing = plan.array.elements.filter(ts.isIdentifier).map((e) => e.text);
      plan.classNames = plan.classNames.filter((cn) => !existing.includes(cn));
    }
  }
  for (const [className, plan] of [...classPlans]) {
    if (plan.classNames.length === 0) {
      classPlans.delete(className);
    }
  }

  // Symbols that survive after filtering determine what gets imported
  const classNamesInUse = new Set<string>();
  for (const [, plan] of classPlans) {
    for (const cn of plan.classNames) {
      classNamesInUse.add(cn);
    }
  }

  // Emit import-statement spans, but only for symbols that end up referenced
  const newImportLines: string[] = [];
  for (const [className, plan] of plannedImports) {
    if (!classNamesInUse.has(className)) {
      continue;
    }
    if (isLocalBindingTaken(sourceFile, className)) {
      logDiagnostic(
        `Auto-import: skipped "${className}" — a binding with that name already exists in ${ownerFilePath}`,
      );
      continue;
    }
    newImportLines.push(`import { ${className} } from '${plan.moduleSpecifier}';`);
  }

  const spans: TextSpan[] = [];

  if (newImportLines.length > 0) {
    const insertion = computeImportInsertionOffset(sourceFile);
    if (insertion.atLineStart) {
      spans.push({
        start: insertion.offset,
        end: insertion.offset,
        text: `${newImportLines.join('\n')}\n`,
      });
    } else {
      spans.push({
        start: insertion.offset,
        end: insertion.offset,
        text: `\n${newImportLines.join('\n')}`,
      });
    }
  }

  for (const [, plan] of classPlans) {
    if (plan.array) {
      spans.push(...computeArrayAppendSpans(sourceFile, plan.array, plan.classNames));
    } else if (plan.createForObject) {
      spans.push(...computeCreateImportsArraySpans(sourceFile, plan.createForObject, plan.classNames));
    }
  }

  return {
    spans,
    outcome: { addedCount: classNamesInUse.size, skippedClasses },
  };
}

/**
 * Computes the offset right after the last import declaration (or after any
 * leading trivia when there are no imports) and whether the insertion point
 * already sits at the beginning of a line.
 */
function computeImportInsertionOffset(
  sourceFile: ts.SourceFile,
): { offset: number; atLineStart: boolean } {
  const fullText = sourceFile.getFullText();
  let lastImportEnd = -1;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      lastImportEnd = Math.max(lastImportEnd, statement.getEnd());
    }
  }

  let offset: number;
  if (lastImportEnd >= 0) {
    offset = lastImportEnd;
  } else if (sourceFile.statements.length > 0) {
    const first = sourceFile.statements[0];
    offset = first.getFullStart() + first.getLeadingTriviaWidth(sourceFile);
  } else {
    offset = 0;
  }

  const atLineStart = offset === 0 || fullText[offset - 1] === '\n';
  return { offset, atLineStart };
}

function indentAt(sourceFile: ts.SourceFile, position: number): string {
  const fullText = sourceFile.getFullText();
  let indent = '';
  for (let i = position - 1; i >= 0; i -= 1) {
    const ch = fullText[i];
    if (ch === '\n') {
      break;
    }
    if (ch === ' ' || ch === '\t') {
      indent = ch + indent;
    } else {
      indent = '';
    }
  }
  return indent;
}

/** Computes where and how to append identifiers into an existing imports array. */
function computeArrayAppendSpans(
  sourceFile: ts.SourceFile,
  array: ts.ArrayLiteralExpression,
  classNames: string[],
): TextSpan[] {
  const fullText = sourceFile.getFullText();
  const opening = array.getStart(sourceFile);
  const closing = array.getEnd() - 1; // index of ']'

  const names = [...array.elements.filter(ts.isIdentifier).map((e) => e.text), ...classNames];

  if (array.elements.length > 0) {
    const body = fullText.slice(opening + 1, closing);
    const compressed = body.replace(/\s+/g, '');
    const hadTrailingComma = compressed !== '' && compressed.endsWith(',');
    const multiline = /[\r\n]/.test(body);

    if (multiline) {
      const elemIndent = indentAt(sourceFile, array.elements[0].getStart(sourceFile)) || '  ';
      let closeIndent = '';
      {
        let i = closing - 1;
        while (i >= 0 && (fullText[i] === ' ' || fullText[i] === '\t')) {
          closeIndent = fullText[i] + closeIndent;
          i -= 1;
        }
      }
      const lines = names.map(
        (name, i) => `${elemIndent}${name}${i < names.length - 1 || hadTrailingComma ? ',' : ''}`,
      );
      const inner = `\n${lines.join('\n')}\n${closeIndent}`;
      return [{ start: opening + 1, end: closing, text: inner }];
    }

    // Single-line array
    const inner = `${names.join(', ')}${hadTrailingComma ? ',' : ''}`;
    return [{ start: opening + 1, end: closing, text: inner }];
  }

  // Empty array — fill inline
  return [{ start: opening + 1, end: closing, text: classNames.join(', ') }];
}

/**
 * Computes replacements that create a whole `imports: [...]` property in a
 * decorator object literal, formatted consistently with its surroundings.
 * Returns an empty array when the object's formatting is not supported.
 */
function computeCreateImportsArraySpans(
  sourceFile: ts.SourceFile,
  objectLiteral: ts.ObjectLiteralExpression,
  classNames: string[],
): TextSpan[] {
  const fullText = sourceFile.getFullText();

  if (objectLiteral.properties.length === 0) {
    const opening = objectLiteral.getStart(sourceFile); // '{'
    return [{ start: opening + 1, end: opening + 1, text: `imports: [${classNames.join(', ')}]` }];
  }

  const literalText = fullText.slice(objectLiteral.getStart(sourceFile), objectLiteral.getEnd());

  if (!/[\r\n]/.test(literalText)) {
    // Single-line object: "@Component({ selector: 'x' })"
    const lastProp = objectLiteral.properties[objectLiteral.properties.length - 1];
    const between = fullText.slice(lastProp.getEnd(), objectLiteral.getEnd()).replace(/\s/g, '');
    const needsComma = !between.startsWith(',');
    return [
      {
        start: lastProp.getEnd(),
        end: lastProp.getEnd(),
        text: `${needsComma ? ', ' : ''}imports: [${classNames.join(', ')}]`,
      },
    ];
  }

  const lastProp = objectLiteral.properties[objectLiteral.properties.length - 1];
  const closingBrace = objectLiteral.getEnd() - 1;
  const tailAfterLastProp = fullText.slice(lastProp.getEnd(), closingBrace);
  const trimmedTail = tailAfterLastProp.trim();

  if (trimmedTail !== '' && trimmedTail !== ',') {
    // Comments or exotic content between the last property and '}'
    logDiagnostic('Auto-import: skipped creating imports array (unsupported decorator formatting)');
    return [];
  }

  const indent = indentAt(sourceFile, objectLiteral.properties[0].getStart(sourceFile));
  const importsProperty = `${indent}imports: [${classNames.join(', ')}]`;

  // Missing trailing comma after the last property?
  const spans: TextSpan[] = [];
  if (trimmedTail === '') {
    spans.push({ start: lastProp.getEnd(), end: lastProp.getEnd(), text: ',' });
  }

  let propInsertStart: number;
  let propText: string;
  if (/[\r\n]/.test(tailAfterLastProp)) {
    // Closing brace sits on its own line: insert above it and preserve the
    // indentation of the '}' itself
    const nlAbs = fullText.lastIndexOf('\n', closingBrace - 1);
    const wsStart = Math.max(nlAbs + 1, objectLiteral.getStart(sourceFile));
    const originalBraceIndent = fullText.slice(wsStart, closingBrace);
    propInsertStart = wsStart;
    propText = `${importsProperty},\n${originalBraceIndent}`;
  } else {
    // Exotic same-line ending: introduce proper lines anyway
    propInsertStart = closingBrace;
    propText = `\n${importsProperty},\n`;
  }
  spans.push({ start: propInsertStart, end: propInsertStart, text: propText });
  return spans;
}

// ── Command implementation ────────────────────────────────────────────────────

/** Returns the latest text of a file, preferring the open editor buffer. */
async function getCurrentFileText(filePath: string): Promise<string | null> {
  const wanted = normalizeFs(filePath);
  const openDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === 'file' && normalizeFs(d.uri.fsPath) === wanted,
  );
  if (openDoc) {
    return openDoc.getText();
  }
  return readFileOrNull(filePath);
}

/** Locates the owning `.ts` file for an open HTML template. */
function findOwnerTsFileForHtml(htmlUri: vscode.Uri, index: SymbolIndex): string | null {
  const owners = index.templateUrlOwners.get(normalizeFs(htmlUri.fsPath)) ?? [];
  if (owners.length > 0) {
    return owners[0];
  }

  // Fallback: sibling .component.ts next to the template
  const htmlPath = htmlUri.fsPath;
  if (htmlPath.endsWith('.component.html')) {
    return htmlPath.replace(/\.component\.html$/, '.component.ts');
  }
  if (htmlPath.endsWith('.html')) {
    return htmlPath.slice(0, -'.html'.length) + '.ts';
  }
  return null;
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

/** Runs the command body and returns a human-readable summary. */
async function runAutoImport(): Promise<string> {
  const { document, workspaceRoot } = validateContext();
  const isHtml = document.languageId === 'html';

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Angular CLI Plus: finding missing imports…',
      cancellable: false,
    },
    async () => {
      const index = await buildSymbolIndex(workspaceRoot);

      let ownerFilePath: string;
      if (isHtml) {
        const found = findOwnerTsFileForHtml(document.uri, index);
        if (!found) {
          throw new Error('Could not locate the owning component TypeScript file for this template');
        }
        ownerFilePath = found;
      } else {
        ownerFilePath = document.uri.fsPath;
      }

      const ownerSource = await getCurrentFileText(ownerFilePath);
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

      // Build the union of template corpora for candidate extraction
      let corpusText = '';
      if (isHtml) {
        corpusText = document.getText();
      } else {
        for (const owner of owners) {
          if (owner.inlineTemplate !== null) {
            corpusText += `\n${owner.inlineTemplate}`;
          } else if (owner.templateUrl !== null) {
            const html = readFileOrNull(path.resolve(path.dirname(ownerFilePath), owner.templateUrl));
            if (html !== null) {
              corpusText += `\n${html}`;
            }
          }
        }
      }

      if (!corpusText.trim()) {
        return 'No templates found to analyze';
      }

      const candidateTokens = collectTemplateCandidates(corpusText);
      const planned = planAutoImportEdits({
        ownerFilePath,
        ownerSource,
        owners,
        candidateTokens,
        index,
        readFile: readFileOrNull,
      });

      for (const skip of planned.outcome.skippedClasses) {
        logDiagnostic(`Auto-import: skipped ${skip.className} (${skip.reason})`);
      }

      if (planned.spans.length === 0 || planned.outcome.addedCount === 0) {
        if (planned.outcome.skippedClasses.length > 0) {
          return `No missing imports could be verified (${planned.outcome.skippedClasses.length} component(s) skipped — see diagnostics)`;
        }
        return 'No missing imports found';
      }

      // Apply the edits against the exact snapshot they were computed on
      const edit = new vscode.WorkspaceEdit();
      const targetUri = vscode.Uri.file(ownerFilePath);
      for (const span of planned.spans) {
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
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error('Failed to apply the edits');
      }

      if (isHtml) {
        const ownerDoc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(ownerDoc, { preview: true });
      }

      const suffix =
        planned.outcome.skippedClasses.length > 0
          ? ` (${planned.outcome.skippedClasses.length} component(s) skipped)`
          : '';
      const noun = planned.outcome.addedCount === 1 ? 'import' : 'imports';
      return `Added ${planned.outcome.addedCount} missing ${noun}${suffix}`;
    },
  );
}

/** Registers "Angular: Auto Import Missing Imports" (`Ctrl+Shift+A I`). */
export async function autoImportMissingImports(): Promise<void> {
  let failure = false;
  let summary: string;
  try {
    summary = await runAutoImport();
  } catch (error) {
    failure = true;
    summary = error instanceof Error ? error.message : String(error);
    logDiagnostic(`Auto-import failed: ${summary}`);
  }

  const prefixed = `Angular CLI Plus: ${summary}`;
  if (failure) {
    void vscode.window.showErrorMessage(prefixed);
  } else {
    void vscode.window.showInformationMessage(prefixed);
  }
}
