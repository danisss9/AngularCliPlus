import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logDiagnostic } from './state';

/**
 * Automatically clean unused standalone imports on save.
 *
 * Finds identifiers listed in the `imports: [...]` array of `@Component`,
 * `@Directive` and `@Pipe` decorators that are not used anywhere else in the
 * file and whose resolved declaration (selector / pipe name) does not appear
 * in any of the file's templates (inline or external). Matching text spans
 * are returned so callers can apply them as edits.
 *
 * Safety policy: anything that cannot be confidently resolved (non-relative
 * module specifiers such as `@angular/common`, NgModule re-export barrels,
 * exotic selectors, spread elements, ...) is KEPT. The feature errs towards
 * leaving entries alone rather than breaking working components.
 */

export interface UnusedImportRemoval {
  /** Local identifier that was listed in the `imports` array */
  name: string;
  /** Absolute start offset of the text to remove */
  start: number;
  /** Absolute end offset (exclusive) of the text to remove */
  end: number;
}

export type FileContentsReader = (absolutePath: string) => string | null;

const DECORATOR_NAMES = new Set(['Component', 'Directive', 'Pipe']);

/** Maximum hops followed through named re-export chains (barrels). */
const MAX_REEXPORT_DEPTH = 5;

interface DecoratedClass {
  decoratorName: string;
  importsArray: ts.ArrayLiteralExpression | undefined;
  inlineTemplate: string | null;
  templateUrl: string | null;
}

interface ImportedBinding {
  moduleSpecifier: string;
  propertyName: string;
}

interface ResolvedTokens {
  tokens: string[];
}

/** Escapes a plain selector/pipe token for safe embedding in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts matched class declarations with supported decorators. */
function findDecoratedClasses(sourceFile: ts.SourceFile): DecoratedClass[] {
  const classes: DecoratedClass[] = [];

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.modifiers) {
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
        if (!ts.isIdentifier(callee) || !DECORATOR_NAMES.has(callee.text)) {
          continue;
        }

        let importsArray: ts.ArrayLiteralExpression | undefined;
        let inlineTemplate: string | null = null;
        let templateUrl: string | null = null;

        for (const prop of modifier.expression.arguments[0].properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
            continue;
          }
          if (prop.name.text === 'imports' && ts.isArrayLiteralExpression(prop.initializer)) {
            importsArray = prop.initializer;
          } else if (
            prop.name.text === 'template' &&
            (ts.isStringLiteral(prop.initializer) ||
              ts.isNoSubstitutionTemplateLiteral(prop.initializer))
          ) {
            inlineTemplate = prop.initializer.text;
          } else if (prop.name.text === 'templateUrl' && ts.isStringLiteral(prop.initializer)) {
            templateUrl = prop.initializer.text;
          }
        }

        classes.push({
          decoratorName: callee.text,
          importsArray,
          inlineTemplate,
          templateUrl,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return classes;
}

/**
 * Extracts searchable tokens from an Angular selector.
 * Returns null for structures this analyser does not confidently understand
 * (pseudo selectors, attribute values, dynamic parts, ...) so callers keep
 * the entry.
 */
export function extractTokensFromSelector(selector: string): string[] | null {
  const tokens: string[] = [];
  for (const rawPart of selector.split(',')) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    // Pseudo selectors (:host, :not, ::ng-deep...) and attribute values
    // ([type=text]) are deliberately treated as unresolvable.
    if (part.includes(':') || /[^\w\-.[\]\s]/.test(part)) {
      return null;
    }
    for (const match of part.matchAll(/[\w-]+/g)) {
      tokens.push(match[0]);
    }
  }
  return tokens.length > 0 ? tokens : null;
}

/** Collects identifier-based elements of an imports array. */
function getImportArrayIdentifiers(array: ts.ArrayLiteralExpression): ts.Identifier[] {
  return array.elements.filter(ts.isIdentifier);
}

/** Builds local-name → binding info for every named value import in the file. */
function collectImportedBindings(sourceFile: ts.SourceFile): Map<string, ImportedBinding> {
  const bindings = new Map<string, ImportedBinding>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const named = statement.importClause.namedBindings;
    if (!named || !ts.isNamedImports(named)) {
      continue;
    }
    for (const element of named.elements) {
      bindings.set(element.name.text, {
        moduleSpecifier: statement.moduleSpecifier.text,
        propertyName: element.propertyName ? element.propertyName.text : element.name.text,
      });
    }
  }
  return bindings;
}

/**
 * Builds spans that must NOT count as identifier usages: import declarations
 * (their local names are bindings, not usages) and the identifier elements
 * sitting inside any `imports: [...]` arrays.
 */
function collectProtectedSpans(
  sourceFile: ts.SourceFile,
  importArrayElements: ReadonlySet<ts.Identifier>,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      spans.push({ start: node.getStart(sourceFile), end: node.getEnd() });
    }
    if (ts.isIdentifier(node) && importArrayElements.has(node)) {
      spans.push({ start: node.getStart(sourceFile), end: node.getEnd() });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return spans.sort((a, b) => a.start - b.start);
}

function isPositionWithin(pos: number, spans: Array<{ start: number; end: number }>): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (pos < span.start) {
      hi = mid - 1;
    } else if (pos >= span.end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/** Counts identifier usages of `name` outside protected spans. */
function countUsagesOutsideProtectedSpans(
  sourceFile: ts.SourceFile,
  name: string,
  protectedSpans: Array<{ start: number; end: number }>,
): number {
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === name) {
      const start = node.getStart(sourceFile);
      if (!isPositionWithin(start, protectedSpans)) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

/**
 * Reads selectors/pipe names from a resolved file and follows named
 * re-exports (`export { Foo } from './foo'`) through barrels, bounded by
 * depth. Returns null whenever nothing confident can be determined.
 */
function resolveTokensFromFile(
  absolutePath: string,
  propertyName: string,
  readFile: FileContentsReader,
  visited: Set<string>,
): ResolvedTokens | null {
  if (visited.size >= MAX_REEXPORT_DEPTH || visited.has(absolutePath)) {
    return null;
  }
  visited.add(absolutePath);

  const content = readFile(absolutePath);
  if (content === null) {
    return null;
  }

  const sourceFile = ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, true);

  let sawMatchingClass = false;
  const tokens: string[] = [];

  // Direct decorator metadata
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== propertyName) {
      continue;
    }
    sawMatchingClass = true;
    const found = extractDecoratedMetadataForClass(statement);
    if (found === null) {
      return null;
    }
    tokens.push(...found);
  }
  if (sawMatchingClass && tokens.length > 0) {
    return { tokens };
  }

  // Named re-export chain
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      for (const element of statement.exportClause.elements) {
        const exportedName = element.name.text;
        if (exportedName !== propertyName) {
          continue;
        }
        const originalName = element.propertyName ? element.propertyName.text : element.name.text;
        const targetPath = resolveModuleToTsFile(
          path.dirname(absolutePath),
          statement.moduleSpecifier.text,
          readFile,
        );
        if (targetPath === null) {
          return null;
        }
        return resolveTokensFromFile(targetPath, originalName, readFile, visited);
      }
    }
  }

  return null;
}

/** Reads selector/pipe tokens directly off one class declaration. */
function extractDecoratedMetadataForClass(classNode: ts.ClassDeclaration): string[] | null {
  const tokens: string[] = [];
  let sawSupportedDecorator = false;
  if (!classNode.modifiers) {
    return null;
  }
  for (const modifier of classNode.modifiers) {
    if (
      !ts.isDecorator(modifier) ||
      !ts.isCallExpression(modifier.expression) ||
      modifier.expression.arguments.length === 0 ||
      !ts.isObjectLiteralExpression(modifier.expression.arguments[0])
    ) {
      continue;
    }
    const callee = modifier.expression.expression;
    if (!ts.isIdentifier(callee) || !DECORATOR_NAMES.has(callee.text)) {
      continue;
    }
    sawSupportedDecorator = true;
    let foundMetadata = false;
    for (const prop of modifier.expression.arguments[0].properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
        continue;
      }
      if (callee.text === 'Pipe' && prop.name.text === 'name' && ts.isStringLiteral(prop.initializer)) {
        const extracted = extractTokensFromSelector(prop.initializer.text);
        if (extracted !== null) {
          tokens.push(...extracted);
          foundMetadata = true;
        }
      } else if (
        prop.name.text === 'selector' &&
        ts.isStringLiteral(prop.initializer)
      ) {
        const extracted = extractTokensFromSelector(prop.initializer.text);
        if (extracted !== null) {
          tokens.push(...extracted);
          foundMetadata = true;
        }
      }
    }
    if (!foundMetadata) {
      return null;
    }
  }
  if (!sawSupportedDecorator) {
    return null;
  }
  return tokens;
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

/**
 * Removes text spans that are superseded by longer overlapping spans, sorts
 * the remainder descending and de-duplicates identical spans.
 */
function normalizeOverlappingRanges(ranges: UnusedImportRemoval[]): UnusedImportRemoval[] {
  const filtered = ranges.filter(
    (outer) =>
      !ranges.some(
        (other) =>
          other !== outer && other.start <= outer.start && other.end >= outer.end && other.end - other.start > outer.end - outer.start,
      ),
  );
  const seen = new Set<string>();
  const result: UnusedImportRemoval[] = [];
  for (const range of [...filtered].sort((a, b) => b.start - a.start)) {
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(range);
  }
  return result;
}

/**
 * Computes the removal text spans for every provably-unused entry in the
 * `imports` arrays of this file's standalone decorators. Returns empty when
 * the feature finds nothing safe to remove.
 */
export function computeUnusedImportsRemovals(
  source: string,
  filePath: string,
  readFile?: FileContentsReader,
): UnusedImportRemoval[] {
  const read: FileContentsReader =
    readFile ??
    ((absPath) => {
      try {
        return fs.readFileSync(absPath, 'utf-8');
      } catch {
        return null;
      }
    });

  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const decoratedClasses = findDecoratedClasses(sourceFile);
  if (decoratedClasses.length === 0) {
    return [];
  }

  const classesWithImports = decoratedClasses.filter((c) => c.importsArray !== undefined);
  if (classesWithImports.length === 0) {
    return [];
  }

  const importedBindings = collectImportedBindings(sourceFile);

  const importArrayElements = new Set<ts.Identifier>();
  for (const cls of classesWithImports) {
    for (const id of getImportArrayIdentifiers(cls.importsArray as ts.ArrayLiteralExpression)) {
      importArrayElements.add(id);
    }
  }

  const protectedSpans = collectProtectedSpans(sourceFile, importArrayElements);

  // Combined template corpus of the whole file (inline + external)
  let templateCorpus = '';
  for (const cls of decoratedClasses) {
    if (cls.inlineTemplate !== null) {
      templateCorpus += `\n${cls.inlineTemplate}`;
    }
    if (cls.templateUrl !== null) {
      const htmlPath = path.resolve(path.dirname(filePath), cls.templateUrl);
      const html = read(htmlPath);
      if (html !== null) {
        templateCorpus += `\n${html}`;
      }
    }
  }
  const templateCache = new Map<string, boolean>();
  const isTokenUsedInTemplates = (token: string): boolean => {
    const cached = templateCache.get(token);
    if (cached !== undefined) {
      return cached;
    }
    const used = new RegExp(`\\b${escapeRegExp(token)}\\b`).test(templateCorpus);
    templateCache.set(token, used);
    return used;
  };

  const resolvedTokenCache = new Map<string, ResolvedTokens | null>();
  const resolveTokens = (localName: string): ResolvedTokens | null => {
    const cached = resolvedTokenCache.get(localName);
    if (cached !== undefined) {
      return cached;
    }
    const binding = importedBindings.get(localName);
    let result: ResolvedTokens | null = null;
    if (binding) {
      const { moduleSpecifier, propertyName } = binding;
      if (moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')) {
        const targetFile = resolveModuleToTsFile(path.dirname(filePath), moduleSpecifier, read);
        if (targetFile !== null) {
          result = resolveTokensFromFile(targetFile, propertyName, read, new Set());
        }
      }
      // Non-relative specifiers (libraries, NgModules) intentionally stay.
    }
    resolvedTokenCache.set(localName, result);
    return result;
  };

  const removals: UnusedImportRemoval[] = [];

  for (const cls of classesWithImports) {
    const array = cls.importsArray as ts.ArrayLiteralExpression;
    const elements = array.elements;

    // Decide per identifier element whether it is provably removable
    const removable: boolean[] = [];
    const namesByIndex: Array<string | null> = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      namesByIndex.push(element && ts.isIdentifier(element) ? element.text : null);
      if (!element || !ts.isIdentifier(element)) {
        removable.push(false);
        continue;
      }
      const localName = element.text;
      if (countUsagesOutsideProtectedSpans(sourceFile, localName, protectedSpans) > 0) {
        removable.push(false);
        continue;
      }
      const resolved = resolveTokens(localName);
      if (resolved === null) {
        removable.push(false);
        continue;
      }
      const usedSomewhere = resolved.tokens.some((token) => isTokenUsedInTemplates(token));
      removable.push(!usedSomewhere);
    }

    // Group consecutive removable elements into runs so their edit spans
    // never overlap and separators collapse cleanly.
    let runStart = -1;
    for (let index = 0; index <= elements.length; index += 1) {
      const inRun = index < elements.length && removable[index];
      if (inRun && runStart === -1) {
        runStart = index;
      }
      if (!inRun && runStart !== -1) {
        const range = computeRemovalSpan(array, runStart, index - 1);
        if (range !== null) {
          const firstName = namesByIndex[runStart];
          removals.push({
            name: firstName ?? '',
            ...range,
          });
        }
        runStart = -1;
      }
    }
  }

  return normalizeOverlappingRanges(removals);
}

/**
 * Computes one disjoint removal span for a maximal run of removable elements
 * `[runStart..runEnd]` inside the array literal so separators collapse
 * cleanly:
 * - interior run: drop itself plus the following separator (preceding one kept)
 * - trailing run: drop the preceding separator plus itself (+ trailing ws)
 * - whole-array run: drop everything between the brackets
 */
function computeRemovalSpan(
  array: ts.ArrayLiteralExpression,
  runStart: number,
  runEnd: number,
): { start: number; end: number } | null {
  const sourceFile = array.getSourceFile();
  const elements = array.elements;
  if (runStart > runEnd || runEnd >= elements.length) {
    return null;
  }
  const first = elements[runStart];
  const last = elements[runEnd];
  if (!first || !last) {
    return null;
  }

  const closingBracket = array.getEnd() - 1;
  const fullText = sourceFile.getFullText();
  let end = last.getEnd();
  let swallowedComma = false;
  while (end < closingBracket) {
    const ch = fullText[end];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      end += 1;
      continue;
    }
    // Whole-array / trailing runs may own a trailing comma before `]`
    if (ch === ',' && !swallowedComma && runEnd === elements.length - 1) {
      swallowedComma = true;
      end += 1;
      continue;
    }
    break;
  }

  if (runStart === 0 && runEnd === elements.length - 1) {
    // Whole array is being emptied: leave `imports: []`
    let start = first.getStart(sourceFile);
    while (start > array.getStart(sourceFile) + 1) {
      const ch = sourceFile.getFullText()[start - 1];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        start -= 1;
      } else {
        break;
      }
    }
    return { start, end };
  }

  if (runEnd === elements.length - 1) {
    // Trailing run: also swallow the preceding separator
    const previous = elements[runStart - 1];
    if (!previous) {
      return null;
    }
    return { start: previous.getEnd(), end };
  }

  // Interior run: keep the preceding separator, eat this run + next separator
  const next = elements[runEnd + 1];
  if (!next) {
    return null;
  }
  return { start: first.getStart(sourceFile), end: next.getStart(sourceFile) };
}

/**
 * Registers the on-save listener that removes unused standalone imports
 * when `angularCliPlus.autoCleanImports.enabled` is turned on. The feature
 * is disabled by default and only touches `.ts` files inside workspace
 * folders that contain an `angular.json`.
 */
export function setupAutoCleanImports(context: vscode.ExtensionContext): void {
  const disposable = vscode.workspace.onWillSaveTextDocument((event) => {
    const document = event.document;
    if (!vscode.workspace.getConfiguration('angularCliPlus').get<boolean>('autoCleanImports.enabled', false)) {
      return;
    }
    if (document.languageId !== 'typescript' || !document.fileName.endsWith('.ts') || document.fileName.endsWith('.d.ts')) {
      return;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return;
    }
    if (!fs.existsSync(path.join(workspaceFolder.uri.fsPath, 'angular.json'))) {
      return;
    }

    const application = (async () => {
      try {
        const source = document.getText();
        const removals = computeUnusedImportsRemovals(source, document.fileName);
        if (removals.length === 0) {
          return;
        }
        const edit = new vscode.WorkspaceEdit();
        for (const removal of removals) {
          edit.delete(document.uri, new vscode.Range(
            document.positionAt(removal.start),
            document.positionAt(removal.end),
          ));
        }
        const applied = await vscode.workspace.applyEdit(edit);
        logDiagnostic(
          `Auto-clean imports: removed ${removals.length} unused imports ${applied ? 'from' : '(apply failed)'} ${document.fileName}`,
        );
      } catch (error) {
        logDiagnostic(`Auto-clean imports failed: ${String(error)}`);
      }
    })();

    event.waitUntil(application);
  });
  context.subscriptions.push(disposable);
}
