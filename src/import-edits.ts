/**
 * Shared editing primitives for the import features.
 *
 * Both "Auto Import Missing Imports" and "Auto-clean unused imports" end up
 * doing the same three things — rewrite the named bindings of an `import`
 * statement, rewrite the contents of an `imports: [...]` array, or drop an
 * import statement entirely — so the planning lives here and each feature only
 * decides *what* to add and remove.
 *
 * Planning is done per statement / per array, never per element: a single span
 * carries the final list. That is what lets one `WorkspaceEdit` add and remove
 * entries in the same array without overlapping ranges.
 */

import * as ts from 'typescript';

export interface TextSpan {
  start: number;
  end: number;
  text: string;
}

export type DecoratorKind = 'Component' | 'Directive' | 'Pipe';

export interface DecoratedOwner {
  className: string;
  kind: DecoratorKind;
  standaloneExplicitFalse: boolean;
  importsArray: ts.ArrayLiteralExpression | undefined;
  decoratorObject: ts.ObjectLiteralExpression;
  inlineTemplate: string | null;
  templateUrl: string | null;
}

/** What should happen to the `import` statements of a file. */
export interface ImportStatementPlan {
  /** module specifier → local names to import from it */
  add: Map<string, string[]>;
  /** local names whose binding should disappear */
  remove: Set<string>;
}

/** What should happen to one decorator's `imports: [...]` array. */
export interface ImportsArrayPlan {
  add: string[];
  remove: Set<string>;
}

const DECORATOR_KINDS: ReadonlySet<string> = new Set(['Component', 'Directive', 'Pipe']);

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

/** Identifier elements of an `imports: [...]` array, in source order. */
export function importsArrayNames(array: ts.ArrayLiteralExpression | undefined): string[] {
  const names: string[] = [];
  for (const element of array?.elements ?? []) {
    if (ts.isIdentifier(element)) {
      names.push(element.text);
    }
  }
  return names;
}

// ── Import bindings ──────────────────────────────────────────────────────────

export interface ImportBinding {
  /** local name introduced in this file */
  name: string;
  moduleSpecifier: string;
  /** name in the exporting module (differs when the import is aliased) */
  propertyName: string;
  kind: 'named' | 'default' | 'namespace';
  statement: ts.ImportDeclaration;
}

/** Every value/type binding introduced by the file's `import` statements. */
export function collectImportBindingDetails(sourceFile: ts.SourceFile): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;

    if (clause.name) {
      bindings.push({
        name: clause.name.text,
        moduleSpecifier,
        propertyName: 'default',
        kind: 'default',
        statement,
      });
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        bindings.push({
          name: clause.namedBindings.name.text,
          moduleSpecifier,
          propertyName: '*',
          kind: 'namespace',
          statement,
        });
      } else {
        for (const element of clause.namedBindings.elements) {
          bindings.push({
            name: element.name.text,
            moduleSpecifier,
            propertyName: element.propertyName?.text ?? element.name.text,
            kind: 'named',
            statement,
          });
        }
      }
    }
  }

  return bindings;
}

/** local name → module specifier for every named value import in the file. */
export function collectImportBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const binding of collectImportBindingDetails(sourceFile)) {
    if (binding.kind === 'named') {
      bindings.set(binding.name, binding.moduleSpecifier);
    }
  }
  return bindings;
}

/**
 * Checks whether `localName` is already bound locally (imported elsewhere or
 * declared in this file), in which case adding a second binding would clash.
 */
export function isLocalBindingTaken(sourceFile: ts.SourceFile, localName: string): boolean {
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

// ── Reference counting ───────────────────────────────────────────────────────

/**
 * True when an identifier stands for a *use* of a binding rather than a place
 * where a name is merely written down (a declaration, a property key, the
 * right-hand side of a dotted access, an import specifier, ...).
 *
 * Unknown positions deliberately count as a use: over-counting only ever keeps
 * an import that could have been removed, while under-counting would delete a
 * needed one.
 */
function isReferencePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return true;
  }

  // Import bindings themselves
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent)
  ) {
    return false;
  }

  // `export { A } from './x'` re-exports nothing local; `export { A }` does
  if (ts.isExportSpecifier(parent)) {
    const exportDeclaration = parent.parent.parent;
    return !(ts.isExportDeclaration(exportDeclaration) && exportDeclaration.moduleSpecifier);
  }

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return false;
  }
  if (
    (ts.isClassDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent)) &&
    parent.name === node
  ) {
    return false;
  }

  return true;
}

/**
 * Counts how often each name is referenced in the file. Identifiers inside the
 * spans listed in `ignoreSpans` are not counted — the auto-clean feature uses
 * that to ask "would this import still be used once these `imports: [...]`
 * entries are gone?".
 */
export function countReferences(
  sourceFile: ts.SourceFile,
  ignoreSpans: ReadonlyArray<{ start: number; end: number }> = [],
): Map<string, number> {
  const counts = new Map<string, number>();
  const sorted = [...ignoreSpans].sort((a, b) => a.start - b.start);

  const isIgnored = (position: number): boolean => {
    let low = 0;
    let high = sorted.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const span = sorted[mid];
      if (position < span.start) {
        high = mid - 1;
      } else if (position >= span.end) {
        low = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  };

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && isReferencePosition(node) && !isIgnored(node.getStart(sourceFile))) {
      counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return counts;
}

// ── Rendering helpers ────────────────────────────────────────────────────────

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

/**
 * Replaces the contents between two brackets with `names`, preserving the
 * original single-line / multi-line layout, indentation and trailing comma.
 */
function renderBracketedList(input: {
  sourceFile: ts.SourceFile;
  /** offset of the opening bracket */
  open: number;
  /** offset of the closing bracket */
  close: number;
  names: string[];
  /** spacing used when the list is single line and was previously empty */
  defaultPadding: string;
  /** offset of the first existing element, for indentation detection */
  firstElementStart?: number;
}): TextSpan {
  const { sourceFile, open, close, names, defaultPadding, firstElementStart } = input;
  const fullText = sourceFile.getFullText();
  const body = fullText.slice(open + 1, close);

  if (names.length === 0) {
    return { start: open + 1, end: close, text: '' };
  }

  const compressed = body.replace(/\s+/g, '');
  const hadTrailingComma = compressed.endsWith(',');

  if (/[\r\n]/.test(body)) {
    const elementIndent =
      (firstElementStart !== undefined ? indentAt(sourceFile, firstElementStart) : '') || '  ';
    let closeIndent = '';
    let index = close - 1;
    while (index >= 0 && (fullText[index] === ' ' || fullText[index] === '\t')) {
      closeIndent = fullText[index] + closeIndent;
      index -= 1;
    }
    const lines = names.map(
      (name, position) =>
        `${elementIndent}${name}${position < names.length - 1 || hadTrailingComma ? ',' : ''}`,
    );
    return { start: open + 1, end: close, text: `\n${lines.join('\n')}\n${closeIndent}` };
  }

  const padding = body.trim() === '' ? defaultPadding : /^\s/.test(body) ? ' ' : '';
  return {
    start: open + 1,
    end: close,
    text: `${padding}${names.join(', ')}${hadTrailingComma ? ',' : ''}${padding}`,
  };
}

/**
 * Computes the offset right after the last import declaration (or after any
 * leading trivia when there are no imports) and whether that point already
 * sits at the beginning of a line.
 */
function computeImportInsertionOffset(sourceFile: ts.SourceFile): {
  offset: number;
  atLineStart: boolean;
} {
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

  return { offset, atLineStart: offset === 0 || fullText[offset - 1] === '\n' };
}

/** Span that deletes a whole statement together with its own line. */
function statementDeletionSpan(sourceFile: ts.SourceFile, statement: ts.Statement): TextSpan {
  const fullText = sourceFile.getFullText();
  let start = statement.getStart(sourceFile);
  let lineStart = start;
  while (lineStart > 0 && fullText[lineStart - 1] !== '\n') {
    lineStart -= 1;
  }
  if (fullText.slice(lineStart, start).trim() === '') {
    start = lineStart;
  }

  let end = statement.getEnd();
  while (end < fullText.length && (fullText[end] === ' ' || fullText[end] === '\t' || fullText[end] === '\r')) {
    end += 1;
  }
  if (fullText[end] === '\n') {
    end += 1;
  }
  return { start, end, text: '' };
}

// ── Planning ─────────────────────────────────────────────────────────────────

/**
 * Turns an add/remove plan into spans over the file's `import` statements:
 * names are merged into an existing statement for the same module, statements
 * that lose every binding are deleted, and anything left over becomes new
 * import lines after the last existing import.
 */
export function planImportStatements(
  sourceFile: ts.SourceFile,
  plan: ImportStatementPlan,
): TextSpan[] {
  const spans: TextSpan[] = [];
  const pendingAdds = new Map(plan.add);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause) {
      continue; // side-effect import: never touched
    }

    const specifier = statement.moduleSpecifier.text;
    const additions = pendingAdds.get(specifier) ?? [];
    const named =
      clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings
        : undefined;
    const namespace =
      clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)
        ? clause.namedBindings
        : undefined;

    const keptNames = (named?.elements ?? [])
      .filter((element) => !plan.remove.has(element.name.text))
      .map((element) => sourceFile.getFullText().slice(element.getStart(sourceFile), element.getEnd()));
    const removedNamed = (named?.elements ?? []).length - keptNames.length;

    const defaultRemoved = Boolean(clause.name && plan.remove.has(clause.name.text));
    const namespaceRemoved = Boolean(namespace && plan.remove.has(namespace.name.text));
    const keepsDefault = Boolean(clause.name) && !defaultRemoved;
    const keepsNamespace = Boolean(namespace) && !namespaceRemoved;

    // A namespace import cannot coexist with named imports, so additions for
    // that module have to go to a fresh statement.
    const canReceive = !keepsNamespace;
    const finalNames = canReceive ? [...keptNames, ...additions] : keptNames;
    if (canReceive && additions.length > 0) {
      pendingAdds.delete(specifier);
    }

    if (finalNames.length === 0 && !keepsDefault && !keepsNamespace) {
      spans.push(statementDeletionSpan(sourceFile, statement));
      continue;
    }

    if (removedNamed === 0 && (!canReceive || additions.length === 0)) {
      continue; // nothing changes in this statement
    }

    if (named) {
      if (finalNames.length === 0) {
        // Only a default import is left: drop the whole `, { … }` group in one
        // span — editing inside the braces as well would overlap it.
        const start = clause.name ? clause.name.getEnd() : named.getStart(sourceFile);
        spans.push({ start, end: named.getEnd(), text: '' });
      } else {
        spans.push(
          renderBracketedList({
            sourceFile,
            open: named.getStart(sourceFile),
            close: named.getEnd() - 1,
            names: finalNames,
            defaultPadding: ' ',
            firstElementStart: named.elements[0]?.getStart(sourceFile),
          }),
        );
      }
    } else if (finalNames.length > 0) {
      // Only a default import existed so far
      const anchor = clause.name?.getEnd() ?? clause.getEnd();
      spans.push({ start: anchor, end: anchor, text: `, { ${finalNames.join(', ')} }` });
    }
  }

  const newLines: string[] = [];
  for (const [specifier, names] of pendingAdds) {
    if (names.length > 0) {
      newLines.push(`import { ${names.join(', ')} } from '${specifier}';`);
    }
  }
  if (newLines.length > 0) {
    const insertion = computeImportInsertionOffset(sourceFile);
    spans.push({
      start: insertion.offset,
      end: insertion.offset,
      text: insertion.atLineStart ? `${newLines.join('\n')}\n` : `\n${newLines.join('\n')}`,
    });
  }

  return spans;
}

/**
 * Rewrites one decorator's `imports: [...]` array, creating the property when
 * the decorator does not have one yet. Returns an empty array when nothing
 * changes or the decorator's formatting is not supported.
 */
export function planImportsArray(
  sourceFile: ts.SourceFile,
  owner: DecoratedOwner,
  plan: ImportsArrayPlan,
  onUnsupported?: (reason: string) => void,
): TextSpan[] {
  if (owner.importsArray) {
    const existing = owner.importsArray.elements;
    const hasUnsupportedElement = existing.some((element) => !ts.isIdentifier(element));
    const names: string[] = [];
    for (const element of existing) {
      if (!ts.isIdentifier(element)) {
        names.push(sourceFile.getFullText().slice(element.getStart(sourceFile), element.getEnd()));
        continue;
      }
      if (!plan.remove.has(element.text)) {
        names.push(element.text);
      }
    }
    for (const name of plan.add) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }

    const unchanged =
      names.length === existing.length &&
      names.every((name, index) => {
        const element = existing[index];
        return ts.isIdentifier(element) ? element.text === name : true;
      });
    if (unchanged) {
      return [];
    }
    if (hasUnsupportedElement && plan.remove.size > 0) {
      // Spread elements and call expressions are re-emitted verbatim, but
      // their contents are unknown — only additions are safe here.
      onUnsupported?.(`${owner.className}: imports array contains non-identifier entries`);
    }

    return [
      renderBracketedList({
        sourceFile,
        open: owner.importsArray.getStart(sourceFile),
        close: owner.importsArray.getEnd() - 1,
        names,
        defaultPadding: '',
        firstElementStart: existing[0]?.getStart(sourceFile),
      }),
    ];
  }

  if (plan.add.length === 0) {
    return [];
  }
  return createImportsArraySpans(sourceFile, owner.decoratorObject, plan.add, onUnsupported);
}

/**
 * Creates a whole `imports: [...]` property in a decorator object literal,
 * formatted consistently with its surroundings.
 */
function createImportsArraySpans(
  sourceFile: ts.SourceFile,
  objectLiteral: ts.ObjectLiteralExpression,
  classNames: string[],
  onUnsupported?: (reason: string) => void,
): TextSpan[] {
  const fullText = sourceFile.getFullText();

  if (objectLiteral.properties.length === 0) {
    const opening = objectLiteral.getStart(sourceFile); // '{'
    return [{ start: opening + 1, end: opening + 1, text: `imports: [${classNames.join(', ')}]` }];
  }

  const literalText = fullText.slice(objectLiteral.getStart(sourceFile), objectLiteral.getEnd());
  const lastProp = objectLiteral.properties[objectLiteral.properties.length - 1];

  if (!/[\r\n]/.test(literalText)) {
    // Single-line object: "@Component({ selector: 'x' })"
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

  const closingBrace = objectLiteral.getEnd() - 1;
  const tailAfterLastProp = fullText.slice(lastProp.getEnd(), closingBrace);
  const trimmedTail = tailAfterLastProp.trim();

  if (trimmedTail !== '' && trimmedTail !== ',') {
    onUnsupported?.('unsupported decorator formatting (comments before the closing brace)');
    return [];
  }

  const indent = indentAt(sourceFile, objectLiteral.properties[0].getStart(sourceFile));
  const importsProperty = `${indent}imports: [${classNames.join(', ')}]`;

  const spans: TextSpan[] = [];
  if (trimmedTail === '') {
    spans.push({ start: lastProp.getEnd(), end: lastProp.getEnd(), text: ',' });
  }

  let propInsertStart: number;
  let propText: string;
  if (/[\r\n]/.test(tailAfterLastProp)) {
    // Closing brace sits on its own line: insert above it, preserving the
    // indentation of the '}' itself
    const newline = fullText.lastIndexOf('\n', closingBrace - 1);
    const whitespaceStart = Math.max(newline + 1, objectLiteral.getStart(sourceFile));
    propInsertStart = whitespaceStart;
    propText = `${importsProperty},\n${fullText.slice(whitespaceStart, closingBrace)}`;
  } else {
    propInsertStart = closingBrace;
    propText = `\n${importsProperty},\n`;
  }
  spans.push({ start: propInsertStart, end: propInsertStart, text: propText });
  return spans;
}

/** Applies spans to a string, for tests and previews. */
export function applySpans(source: string, spans: readonly TextSpan[]): string {
  let result = source;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, span.start) + span.text + result.slice(span.end);
  }
  return result;
}
