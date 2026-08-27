/**
 * Pure scanners used by the auto-import feature.
 *
 * Everything in this file is side-effect free and VS Code independent so it
 * can be unit tested directly:
 *   - `collectTemplateCandidates` extracts the tokens of an Angular template
 *     that may require a directive / component / pipe import.
 *   - `extractSelectorTokens` turns an Angular selector (or pipe name) into the
 *     tokens a template would use it with.
 *   - `parseDtsModule` reads Angular's compiled `.d.ts` metadata
 *     (`ɵɵComponentDeclaration`, `ɵɵNgModuleDeclaration`, ...) plus the export
 *     and re-export graph, so symbols that live in `node_modules` can be
 *     indexed under their public name and import path without a type check.
 */

// ── Template candidates ───────────────────────────────────────────────────────

export type CandidateKind =
  | 'element'
  | 'attribute'
  | 'input'
  | 'output'
  | 'two-way'
  | 'structural'
  | 'pipe';

export interface TemplateCandidate {
  /** lowercased token used for index lookups */
  token: string;
  /** the token as written in the template (for the quick pick label) */
  display: string;
  kind: CandidateKind;
}

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
  // Angular built-ins that never need an import
  'ng-template', 'ng-container', 'ng-content',
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

/** Plain HTML attributes / DOM properties that never require an import */
const STANDARD_ATTRS = new Set<string>([
  'src', 'srcset', 'sizes', 'href', 'alt', 'id', 'name', 'type', 'value',
  'disabled', 'readonly', 'required', 'checked', 'hidden', 'target', 'rel',
  'placeholder', 'title', 'role', 'tabindex', 'min', 'max', 'step', 'pattern',
  'maxlength', 'minlength', 'size', 'rows', 'cols', 'colspan', 'rowspan',
  'headers', 'scope', 'span', 'start', 'reversed', 'multiple', 'list',
  'label', 'selected', 'autoplay', 'controls', 'loop', 'muted', 'preload',
  'poster', 'action', 'method', 'enctype', 'novalidate', 'autocomplete',
  'autofocus', 'dir', 'draggable', 'lang', 'spellcheck', 'translate',
  'contenteditable', 'download', 'hreflang', 'media', 'kind', 'srclang',
  'wrap', 'accept', 'acceptcharset', 'capture', 'inputmode', 'enterkeyhint',
  'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'frameborder',
  'height', 'width', 'class', 'style', 'slot', 'is', 'part', 'popover',
  'inert', 'itemprop', 'itemscope', 'itemtype', 'accesskey', 'autocapitalize',
  'crossorigin', 'decoding', 'loading', 'referrerpolicy', 'sandbox',
  'allowfullscreen', 'allow', 'nonce', 'integrity', 'defer', 'async',
  'charset', 'content', 'http-equiv', 'property', 'coords', 'shape', 'usemap',
  'ismap', 'formaction', 'formmethod', 'formtarget', 'formnovalidate', 'form',
  'for', 'open', 'datetime', 'cite', 'high', 'low', 'optimum',
  'innerhtml', 'innertext', 'textcontent', 'ngprojectas', 'ngnonbindable',
  'xmlns', 'viewbox', 'fill', 'stroke', 'transform', 'd', 'cx',
  'cy', 'r', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points', 'offset', 'version',
]);

/** Binding prefixes that address the DOM directly instead of a directive */
const BINDING_NAMESPACES = new Set<string>(['attr', 'class', 'style', 'animate']);

/** Removes comments and the bodies of script / style blocks. */
function stripNonTemplate(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

/** Matches an opening tag while tolerating `>` inside quoted attribute values. */
const TAG_RE = /<\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;

/** Matches one attribute (with optional quoted or bare value) inside a tag. */
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;

/** Pipes: `| name`, but never the `||` operator. */
const PIPE_RE = /(?<!\|)\|(?!\|)\s*([a-zA-Z_$][\w$]*)/g;

function isSkippableAttributeName(base: string): boolean {
  return (
    base === '' ||
    STANDARD_ATTRS.has(base) ||
    base.startsWith('data-') ||
    base.startsWith('aria-') ||
    base.startsWith('i18n') ||
    base.includes(':')
  );
}

/** Classifies one raw attribute name into an import candidate, or null. */
export function classifyAttribute(raw: string): TemplateCandidate | null {
  const name = raw.trim();
  if (name === '' || name.startsWith('#') || name.startsWith('/') || name.startsWith('@')) {
    return null;
  }

  let kind: CandidateKind = 'attribute';
  let inner = name;
  if (inner.startsWith('*')) {
    kind = 'structural';
    inner = inner.slice(1);
  } else if (inner.startsWith('[(') && inner.endsWith(')]')) {
    kind = 'two-way';
    inner = inner.slice(2, -2);
  } else if (inner.startsWith('[') && inner.endsWith(']')) {
    kind = 'input';
    inner = inner.slice(1, -1);
  } else if (inner.startsWith('(') && inner.endsWith(')')) {
    kind = 'output';
    inner = inner.slice(1, -1);
  }

  // Animation bindings ([@fade]) and leftovers of malformed syntax
  if (inner.startsWith('@') || inner === '') {
    return null;
  }

  const segments = inner.split('.');
  const base = segments[0].toLowerCase();
  if (BINDING_NAMESPACES.has(base) && segments.length > 1) {
    return null;
  }

  if (kind === 'structural') {
    if (CONTROL_FLOW_KEYWORDS.has(base)) {
      return null;
    }
  } else if (kind === 'output') {
    // `(keydown.enter)` is still a native event
    if (NATIVE_EVENTS.has(base)) {
      return null;
    }
  } else if (isSkippableAttributeName(base)) {
    return null;
  }

  if (!/^[a-z][\w-]*$/.test(base)) {
    return null;
  }
  return { token: base, display: segments[0], kind };
}

/**
 * Extracts every token of a template that could require an import: custom
 * element tags, attribute directives (plain, bound, two-way, structural),
 * non-native outputs and pipes.
 *
 * The result is keyed by the lowercased token so callers look each one up in
 * the symbol index exactly once.
 */
export function collectTemplateCandidates(html: string): Map<string, TemplateCandidate> {
  const out = new Map<string, TemplateCandidate>();
  const add = (candidate: TemplateCandidate | null): void => {
    if (candidate && !out.has(candidate.token)) {
      out.set(candidate.token, candidate);
    }
  };

  const text = stripNonTemplate(html);

  for (const tagMatch of text.matchAll(TAG_RE)) {
    const tagName = tagMatch[1];
    const lowerTag = tagName.toLowerCase();
    if (!STANDARD_TAGS.has(lowerTag) && !lowerTag.includes(':')) {
      add({ token: lowerTag, display: tagName, kind: 'element' });
    }

    const attrBlob = tagMatch[2] ?? '';
    for (const attrMatch of attrBlob.matchAll(ATTR_RE)) {
      add(classifyAttribute(attrMatch[1]));
    }
  }

  for (const pipeMatch of text.matchAll(PIPE_RE)) {
    const name = pipeMatch[1];
    add({ token: name.toLowerCase(), display: name, kind: 'pipe' });
  }

  return out;
}

// ── Selector tokens ───────────────────────────────────────────────────────────

/**
 * Extracts the lowercased tokens an Angular selector responds to.
 *
 * Unlike the strict variant used by the auto-clean feature this one never
 * bails out: pseudo selectors and attribute values are stripped so exotic
 * library selectors (`button[mat-button]:not([disabled])`) still contribute
 * their useful tokens. Being permissive here is the safe direction — a token
 * recognised as "already provided" only ever removes a suggestion.
 */
export function extractSelectorTokens(selector: string): string[] {
  return [...extractSelectorTokenWeights(selector).keys()];
}

/**
 * Same as `extractSelectorTokens`, but each token also carries how much of the
 * selector it accounts for: 1 when it is a selector on its own (`[ngModel]`,
 * `mat-icon`), 1/n when it is one of n parts that must all match
 * (`mat-checkbox[required][ngModel]` → 1/3).
 *
 * The weight is what keeps `FormsModule` ahead of a component that merely
 * *also* reacts to `ngModel` when the token is looked up.
 */
export function extractSelectorTokenWeights(selector: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const rawPart of selector.split(',')) {
    const part = rawPart
      // :not([disabled]) / :host-context(...) and other pseudo groups
      .replace(/::?[\w-]+\([^)]*\)/g, ' ')
      .replace(/::?[\w-]+/g, ' ')
      // [type="text"] → [type]
      .replace(/\[\s*([\w-]+)\s*[~|^$*]?=\s*(?:"[^"]*"|'[^']*'|[^\]]*)\]/g, '[$1]')
      .trim();
    if (part === '') {
      continue;
    }
    const tokens = [...part.matchAll(/[a-zA-Z][\w-]*/g)].map((match) => match[0].toLowerCase());
    if (tokens.length === 0) {
      continue;
    }
    const weight = 1 / tokens.length;
    for (const token of tokens) {
      weights.set(token, Math.max(weights.get(token) ?? 0, weight));
    }
  }
  return weights;
}


// ── Angular library metadata (.d.ts) ─────────────────────────────────────────

export interface LibraryDeclaration {
  /** name as declared inside the file (may be re-exported under an alias) */
  className: string;
  kind: 'Component' | 'Directive' | 'Pipe' | 'NgModule';
  /** selector / pipe-name tokens (lowercase); empty for modules */
  tokens: string[];
  /** how much of the selector each token accounts for (see weights above) */
  weights: Record<string, number>;
  /** local names re-exported by an NgModule */
  exports: string[];
  /**
   * Whether the declaration is standalone (and therefore importable on its
   * own). `undefined` when the package predates the flag.
   */
  standalone: boolean | undefined;
}

/** One `export … from '…'` statement of a `.d.ts`. */
export interface DtsReExport {
  from: string;
  /** `export * from '…'` */
  star: boolean;
  /** `export { source as exported } from '…'` */
  names: Array<{ source: string; exported: string }>;
}

export interface DtsModule {
  /** local class name → Angular metadata */
  declarations: Map<string, LibraryDeclaration>;
  /** exported alias → local name (`export { MatIcon as f }` → `f` → `MatIcon`) */
  aliasToLocal: Map<string, string>;
  reExports: DtsReExport[];
}

const DECLARATION_RE = /ɵɵ(Component|Directive|Pipe|NgModule)(?:Declaration|DefWithMeta)\s*</g;

/**
 * Position of the `IsStandalone` generic argument of Angular's declaration
 * metadata types.
 */
const STANDALONE_ARG_INDEX: Record<string, number> = {
  Component: 7,
  Directive: 7,
  Pipe: 2,
};

/**
 * Reads the top-level generic arguments starting at the `<` found at
 * `openIndex`. Returns null when the brackets are unbalanced.
 */
function readGenericArgs(text: string, openIndex: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;

  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '<' || ch === '[' || ch === '{' || ch === '(') {
      depth += 1;
      if (depth === 1) {
        continue; // the opening '<' itself
      }
      current += ch;
      continue;
    }

    if (ch === '>' || ch === ']' || ch === '}' || ch === ')') {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args;
      }
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 1) {
      args.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  return null;
}

/** `typeof i3.MatButton<T>` → `MatButton` */
function cleanTypeName(raw: string): string {
  let value = raw.trim().replace(/^typeof\s+/, '');
  const generic = value.indexOf('<');
  if (generic >= 0) {
    value = value.slice(0, generic);
  }
  value = value.replace(/import\([^)]*\)\./g, '');
  const parts = value.split('.');
  return parts[parts.length - 1].trim();
}

/** Reads a `"selector"` generic argument, ignoring `never` and unions. */
function readStringArg(raw: string): string | null {
  const match = /^["'`]([\s\S]*)["'`]$/.exec(raw.trim());
  return match ? match[1] : null;
}

function readBooleanArg(args: string[], position: number): boolean | undefined {
  if (position >= args.length) {
    return undefined;
  }
  const value = args[position].trim();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

function readTypeList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'never' || trimmed === 'any') {
    return [];
  }
  const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((entry) => cleanTypeName(entry))
    .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry));
}

/** Splits the body of an `export { … }` clause into source/exported pairs. */
function parseExportClause(body: string): Array<{ source: string; exported: string }> {
  const pairs: Array<{ source: string; exported: string }> = [];
  for (const rawEntry of body.split(',')) {
    const entry = rawEntry.trim();
    if (entry === '' || entry.startsWith('type ')) {
      continue;
    }
    const aliased = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(entry);
    if (aliased) {
      pairs.push({ source: aliased[1], exported: aliased[2] });
    } else if (/^[\w$]+$/.test(entry)) {
      pairs.push({ source: entry, exported: entry });
    }
  }
  return pairs;
}

/**
 * Parses one compiled `.d.ts`: the Angular metadata it declares, the aliases
 * it exports them under, and the files it re-exports from.
 *
 * Modern Angular packages emit shared "chunk" files whose declarations are
 * re-exported under mangled aliases (`export { MatIcon as f }`) by the public
 * entry point (`export { f as MatIcon } from '../chunk.js'`), so both halves
 * are needed to know a symbol's real name and import path.
 */
export function parseDtsModule(text: string): DtsModule {
  const declarations = new Map<string, LibraryDeclaration>();
  const aliasToLocal = new Map<string, string>();
  const reExports: DtsReExport[] = [];

  // `export { … } from '…'` / `export * from '…'`
  for (const match of text.matchAll(
    /export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    if (match[1]) {
      continue; // type-only re-export
    }
    reExports.push({ from: match[3], star: false, names: parseExportClause(match[2]) });
  }
  for (const match of text.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
    reExports.push({ from: match[1], star: true, names: [] });
  }

  // `export { … }` without a module specifier, and `export declare class X`
  const localExports = text.replace(/export\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]/g, ' ');
  for (const match of localExports.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    if (match[1]) {
      continue;
    }
    for (const pair of parseExportClause(match[2])) {
      aliasToLocal.set(pair.exported, pair.source);
    }
  }
  for (const match of text.matchAll(
    /export\s+declare\s+(?:abstract\s+)?(?:class|function|const)\s+([\w$]+)/g,
  )) {
    aliasToLocal.set(match[1], match[1]);
  }

  if (!text.includes('ɵɵ')) {
    return { declarations, aliasToLocal, reExports };
  }

  DECLARATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null = DECLARATION_RE.exec(text);
  while (match !== null) {
    const kind = match[1] as LibraryDeclaration['kind'];
    const openIndex = match.index + match[0].length - 1;
    const args = readGenericArgs(text, openIndex);
    DECLARATION_RE.lastIndex = match.index + match[0].length;

    if (args && args.length > 0) {
      const className = cleanTypeName(args[0]);
      if (/^[A-Za-z_$][\w$]*$/.test(className) && !declarations.has(className)) {
        let weights = new Map<string, number>();
        let exports: string[] = [];
        let standalone: boolean | undefined;

        if (kind === 'NgModule') {
          exports = args.length > 3 ? readTypeList(args[3]) : [];
        } else if (args.length > 1) {
          const selector = readStringArg(args[1]);
          if (selector !== null) {
            weights =
              kind === 'Pipe'
                ? new Map([[selector.toLowerCase(), 1]])
                : extractSelectorTokenWeights(selector);
          }
          standalone = readBooleanArg(args, STANDALONE_ARG_INDEX[kind]);
        }

        if (weights.size > 0 || exports.length > 0) {
          declarations.set(className, {
            className,
            kind,
            tokens: [...weights.keys()],
            weights: Object.fromEntries(weights),
            exports,
            standalone,
          });
        }
      }
    }

    match = DECLARATION_RE.exec(text);
  }

  return { declarations, aliasToLocal, reExports };
}
