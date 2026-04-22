import * as ts from 'typescript';
import * as fs from 'fs';

export type MemoryLeakKind =
  | 'unguarded-subscribe'
  | 'nested-subscribe'
  | 'uncleared-interval'
  | 'uncleared-timeout'
  | 'unremoved-event-listener'
  | 'unremoved-renderer-listener'
  | 'retained-dom-reference'
  | 'incomplete-destroy-subject';

export interface MemoryLeakLocation {
  file: string;
  line: number;
  character: number;
  snippet: string;
  kind: MemoryLeakKind;
}

// Operator name per package:
//   @ngneat/until-destroy      → untilDestroyed()
//   @angular/core/rxjs-interop → takeUntilDestroyed()
const GUARD_OPERATORS = new Set(['untilDestroyed', 'takeUntilDestroyed']);

/**
 * Checks whether a node is a guarded destroy call:
 * - `untilDestroyed(...)` from `@ngneat/until-destroy`
 * - `takeUntilDestroyed(...)` from `@angular/core/rxjs-interop`
 */
function isDestroyGuardCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    return GUARD_OPERATORS.has(expr.text);
  }
  return false;
}

const UNTIL_DESTROY_PACKAGES = new Map<string, string>([
  ['@ngneat/until-destroy', 'untilDestroyed'],
  ['@angular/core/rxjs-interop', 'takeUntilDestroyed'],
]);

/**
 * Returns true when the file imports the appropriate destroy guard operator
 * from either `@ngneat/until-destroy` or `@angular/core/rxjs-interop`.
 * Used to contextualise results: leaks in files that have already opted in
 * to the pattern are higher-priority findings.
 */
export function importsUntilDestroy(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const expectedOperator = UNTIL_DESTROY_PACKAGES.get(statement.moduleSpecifier.text);
      if (!expectedOperator) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === expectedOperator) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Analyses a single TypeScript file and returns all `.subscribe()` call sites
 * that are potentially leaking (i.e. not guarded by `takeUntilDestroyed` as
 * the last operator in a preceding `.pipe()` call).
 *
 * The check recognises `takeUntilDestroyed` imported from either
 * `@ngneat/until-destroy` or `@angular/core/rxjs-interop` as a valid guard.
 * Subscribe calls in files that do NOT import from either package are still
 * flagged so that missing leaks are surfaced even in files that have not yet
 * adopted the pattern.
 */
/** Returns the snippet text for the line containing `pos` in `source`. */
function snippetAt(source: string, pos: number): string {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = source.indexOf('\n', pos);
  return source.substring(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}

/**
 * Builds a map of function/method name → body nodes from all declarations
 * in the source file. Used for inter-procedural nested-subscribe detection.
 */
function buildFunctionBodyMap(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const map = new Map<string, ts.Node>();

  function collect(node: ts.Node): void {
    // Method declarations inside a class
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.body) {
      map.set(node.name.text, node.body);
    }
    // Top-level / nested function declarations
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      map.set(node.name.text, node.body);
    }
    // Arrow / function expression assigned to a variable or property
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      map.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, collect);
  }

  collect(sourceFile);
  return map;
}

const MAX_TRAVERSE_DEPTH = 10;

/**
 * Returns true if `node` contains a `.subscribe(...)` call anywhere in its
 * subtree, following `this.method()` / `method()` call sites into their
 * declared bodies up to MAX_TRAVERSE_DEPTH levels deep.
 */
function containsNestedSubscribe(
  node: ts.Node,
  bodyMap: Map<string, ts.Node>,
  depth: number,
  visited: Set<string>,
): boolean {
  let found = false;

  function walk(n: ts.Node): void {
    if (found) {
      return;
    }

    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'subscribe'
    ) {
      found = true;
      return;
    }

    // Follow this.method() or method() calls into their bodies
    if (!found && depth < MAX_TRAVERSE_DEPTH && ts.isCallExpression(n)) {
      const calleeName = resolveCalleeName(n);
      if (calleeName && !visited.has(calleeName)) {
        const body = bodyMap.get(calleeName);
        if (body) {
          visited.add(calleeName);
          if (containsNestedSubscribe(body, bodyMap, depth + 1, visited)) {
            found = true;
            return;
          }
        }
      }
    }

    ts.forEachChild(n, walk);
  }

  walk(node);
  return found;
}

/** Extracts the method/function name from a call expression, if resolvable. */
function resolveCalleeName(call: ts.CallExpression): string | null {
  const expr = call.expression;
  // this.method()
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return expr.name.text;
  }
  // Plain method() call
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  return null;
}

/** Finds and returns the body of `ngOnDestroy`, if declared in the file. */
function findNgOnDestroyBody(sourceFile: ts.SourceFile): ts.Block | null {
  let body: ts.Block | null = null;
  function visit(node: ts.Node): void {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ngOnDestroy' &&
      node.body
    ) {
      body = node.body;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return body;
}

/**
 * Walks `startNode` and all method/function bodies transitively called from it
 * (via bodyMap), up to maxDepth levels, invoking `collector` on every visited node.
 */
function walkReachableNodes(
  startNode: ts.Node,
  bodyMap: Map<string, ts.Node>,
  collector: (n: ts.Node) => void,
  maxDepth: number,
  depth: number = 0,
  visited: Set<string> = new Set(),
): void {
  function walk(n: ts.Node): void {
    collector(n);
    if (depth < maxDepth && ts.isCallExpression(n)) {
      const calleeName = resolveCalleeName(n);
      if (calleeName && !visited.has(calleeName)) {
        const calledBody = bodyMap.get(calleeName);
        if (calledBody) {
          visited.add(calleeName);
          walkReachableNodes(calledBody, bodyMap, collector, maxDepth, depth + 1, visited);
        }
      }
    }
    ts.forEachChild(n, walk);
  }
  walk(startNode);
}

/**
 * Collects all keys passed to `clearInterval` that are reachable from `ngOnDestroy`.
 * If `ngOnDestroyBody` is null (no ngOnDestroy found), returns an empty set.
 */
function collectClearedIntervalKeys(
  ngOnDestroyBody: ts.Block | null,
  bodyMap: Map<string, ts.Node>,
): Set<string> {
  const keys = new Set<string>();
  if (!ngOnDestroyBody) return keys;
  walkReachableNodes(
    ngOnDestroyBody,
    bodyMap,
    (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'clearInterval' &&
        n.arguments.length > 0
      ) {
        const key = expressionToKey(n.arguments[0] as ts.Expression);
        if (key) keys.add(key);
      }
    },
    MAX_TRAVERSE_DEPTH,
  );
  return keys;
}

/**
 * Collects all listener keys passed to `removeEventListener` that are reachable from `ngOnDestroy`.
 * If `ngOnDestroyBody` is null (no ngOnDestroy found), returns an empty set.
 */
function collectRemovedListenerKeys(
  ngOnDestroyBody: ts.Block | null,
  bodyMap: Map<string, ts.Node>,
): Set<string> {
  const keys = new Set<string>();
  if (!ngOnDestroyBody) return keys;
  walkReachableNodes(
    ngOnDestroyBody,
    bodyMap,
    (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'removeEventListener' &&
        n.arguments.length >= 2
      ) {
        const key = listenerKey(n.arguments[0] as ts.Expression, n.arguments[1] as ts.Expression);
        if (key) keys.add(key);
      }
    },
    MAX_TRAVERSE_DEPTH,
  );
  return keys;
}

/** Collects `clearTimeout(arg)` argument keys reachable from `ngOnDestroy`. */
function collectClearedTimeoutKeys(
  ngOnDestroyBody: ts.Block | null,
  bodyMap: Map<string, ts.Node>,
): Set<string> {
  const keys = new Set<string>();
  if (!ngOnDestroyBody) return keys;
  walkReachableNodes(
    ngOnDestroyBody,
    bodyMap,
    (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'clearTimeout' &&
        n.arguments.length > 0
      ) {
        const key = expressionToKey(n.arguments[0] as ts.Expression);
        if (key) keys.add(key);
      }
    },
    MAX_TRAVERSE_DEPTH,
  );
  return keys;
}

/**
 * Collects `this.x` keys where `this.x()` is called anywhere reachable from `ngOnDestroy`.
 * Used to detect Renderer2 listener cleanup functions being invoked.
 */
function collectCalledThisPropertyKeys(
  ngOnDestroyBody: ts.Block | null,
  bodyMap: Map<string, ts.Node>,
): Set<string> {
  const keys = new Set<string>();
  if (!ngOnDestroyBody) return keys;
  walkReachableNodes(
    ngOnDestroyBody,
    bodyMap,
    (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        keys.add(`this.${n.expression.name.text}`);
      }
    },
    MAX_TRAVERSE_DEPTH,
  );
  return keys;
}

/**
 * Collects `this.x` keys where `this.x.next()` or `this.x.complete()` is called
 * anywhere reachable from `ngOnDestroy`. Used to verify destroy-Subject cleanup.
 */
function collectCompletedSubjectKeys(
  ngOnDestroyBody: ts.Block | null,
  bodyMap: Map<string, ts.Node>,
): Set<string> {
  const keys = new Set<string>();
  if (!ngOnDestroyBody) return keys;
  walkReachableNodes(
    ngOnDestroyBody,
    bodyMap,
    (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const methodName = n.expression.name.text;
        if (methodName === 'next' || methodName === 'complete') {
          const key = expressionToKey(n.expression.expression as ts.Expression);
          if (key) keys.add(key);
        }
      }
    },
    MAX_TRAVERSE_DEPTH,
  );
  return keys;
}

export function findMemoryLeaksInFile(filePath: string): MemoryLeakLocation[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

  const bodyMap = buildFunctionBodyMap(sourceFile);
  const ngOnDestroyBody = findNgOnDestroyBody(sourceFile);

  // Track positions already reported as nested so we don't double-report them
  // as unguarded-subscribe as well.
  const nestedPositions = new Set<number>();
  const results: MemoryLeakLocation[] = [];

  // ── Pass 1: find nested subscribes ────────────────────────────────────────
  function visitForNested(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'subscribe'
    ) {
      // Check each callback argument for an inner .subscribe()
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          if (containsNestedSubscribe(arg, bodyMap, 0, new Set())) {
            const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            nestedPositions.add(node.getStart());
            results.push({
              file: filePath,
              line: pos.line + 1,
              character: pos.character + 1,
              snippet: snippetAt(source, node.getStart()),
              kind: 'nested-subscribe',
            });
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visitForNested);
  }

  // ── Pass 2: find unguarded subscribes (skip already flagged nested ones) ──
  function visitForUnguarded(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'subscribe') {
        if (!nestedPositions.has(node.getStart())) {
          const receiver = expr.expression;
          let guarded = false;

          if (
            ts.isCallExpression(receiver) &&
            ts.isPropertyAccessExpression(receiver.expression) &&
            receiver.expression.name.text === 'pipe'
          ) {
            const pipeArgs = receiver.arguments;
            if (pipeArgs.length > 0 && isDestroyGuardCall(pipeArgs[pipeArgs.length - 1])) {
              guarded = true;
            }
          }

          if (!guarded) {
            const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            results.push({
              file: filePath,
              line: pos.line + 1,
              character: pos.character + 1,
              snippet: snippetAt(source, node.getStart()),
              kind: 'unguarded-subscribe',
            });
          }
        }
      }
    }

    ts.forEachChild(node, visitForUnguarded);
  }

  visitForNested(sourceFile);
  visitForUnguarded(sourceFile);

  // ── Pass 3: find uncleared intervals ──────────────────────────────────────
  const clearedKeys = collectClearedIntervalKeys(ngOnDestroyBody, bodyMap);
  results.push(...findUnclearedIntervals(sourceFile, source, clearedKeys));

  // ── Pass 4: find unremoved event listeners ────────────────────────────────
  const removedListenerKeys = collectRemovedListenerKeys(ngOnDestroyBody, bodyMap);
  results.push(...findUnremovedEventListeners(sourceFile, source, removedListenerKeys));

  // ── Pass 5: find retained DOM references ──────────────────────────────────
  const nulledDomKeys = collectNulledDomKeys(ngOnDestroyBody, bodyMap);
  results.push(...findRetainedDomReferences(sourceFile, source, nulledDomKeys));

  // ── Pass 6: find uncleared timeouts ───────────────────────────────────────
  const clearedTimeoutKeys = collectClearedTimeoutKeys(ngOnDestroyBody, bodyMap);
  results.push(...findUnclearedTimeouts(sourceFile, source, clearedTimeoutKeys));

  // ── Pass 7: find uncleaned Renderer2.listen() callbacks ───────────────────
  const calledThisKeys = collectCalledThisPropertyKeys(ngOnDestroyBody, bodyMap);
  results.push(...findUncleanedRendererListeners(sourceFile, source, calledThisKeys));

  // ── Pass 8: find takeUntil Subjects never completed in ngOnDestroy ────────
  const completedSubjectKeys = collectCompletedSubjectKeys(ngOnDestroyBody, bodyMap);
  results.push(...findIncompleteDestroySubjects(sourceFile, source, completedSubjectKeys));

  // Sort by line for a clean presentation
  results.sort((a, b) => a.line - b.line);

  return results;
}

// ── Event listener leak detection ─────────────────────────────────────────────

/**
 * Serialises an addEventListener / removeEventListener argument pair
 * (event name + handler) into a stable key for matching.
 *
 * Recognised handler forms:
 *   this.onScroll          → "this.onScroll"
 *   someVar                → "someVar"
 *   inline arrow/function  → null  (always flagged, can never be matched)
 */
function listenerKey(eventArg: ts.Expression, handlerArg: ts.Expression): string | null {
  // Event name must be a string literal
  if (!ts.isStringLiteral(eventArg)) {
    return null;
  }
  const handlerKey = expressionToKey(handlerArg);
  if (handlerKey === null) {
    // Inline function — unfixable without restructuring, always flag
    return `${eventArg.text}:<<inline>>`;
  }
  return `${eventArg.text}:${handlerKey}`;
}

function findUnremovedEventListeners(
  sourceFile: ts.SourceFile,
  source: string,
  removedKeys: Set<string>,
): MemoryLeakLocation[] {
  const addedListeners: Array<{ node: ts.CallExpression; key: string }> = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.arguments.length >= 2
    ) {
      const methodName = node.expression.name.text;
      const eventArg = node.arguments[0] as ts.Expression;
      const handlerArg = node.arguments[1] as ts.Expression;

      if (methodName === 'addEventListener') {
        const key = listenerKey(eventArg, handlerArg);
        if (key) {
          addedListeners.push({ node, key });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const results: MemoryLeakLocation[] = [];
  for (const { node, key } of addedListeners) {
    // Inline handlers (key ends with <<inline>>) can never be removed — always flag.
    // Named handlers are flagged only when absent from removedKeys.
    if (!removedKeys.has(key)) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      results.push({
        file: sourceFile.fileName,
        line: pos.line + 1,
        character: pos.character + 1,
        snippet: snippetAt(source, node.getStart()),
        kind: 'unremoved-event-listener',
      });
    }
  }

  return results;
}

/**
 * Serialises an expression to a stable string key used to match
 * the storage target of a setInterval return value against clearInterval args.
 *   this.intervalId  →  "this.intervalId"
 *   localVar         →  "localVar"
 */
function expressionToKey(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return `this.${expr.name.text}`;
  }
  return null;
}

// ── DOM reference leak detection ───────────────────────────────────────────────

const DOM_QUERY_METHODS = new Set([
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'getElementsByClassName',
  'getElementsByTagName',
  'getElementsByName',
]);

/**
 * Collects `this.x` keys that are assigned `null` anywhere reachable from `ngOnDestroy`.
 * These are considered "cleaned up" DOM references.
 */
function collectNulledDomKeys(
  ngOnDestroyBody: ts.Block | null,
  bodyMap: Map<string, ts.Node>,
): Set<string> {
  const keys = new Set<string>();
  if (!ngOnDestroyBody) return keys;
  walkReachableNodes(
    ngOnDestroyBody,
    bodyMap,
    (n) => {
      // this.x = null
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        n.right.kind === ts.SyntaxKind.NullKeyword
      ) {
        const key = expressionToKey(n.left as ts.Expression);
        if (key) keys.add(key);
      }
    },
    MAX_TRAVERSE_DEPTH,
  );
  return keys;
}

/**
 * Finds `this.x = document.getElementById/querySelector/etc.(...)` assignments
 * that are not nulled out in `ngOnDestroy`.
 */
function findRetainedDomReferences(
  sourceFile: ts.SourceFile,
  source: string,
  nulledKeys: Set<string>,
): MemoryLeakLocation[] {
  const domRefs: Array<{ node: ts.CallExpression; storedAs: string }> = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'document' &&
      DOM_QUERY_METHODS.has(node.expression.name.text)
    ) {
      // The call might be wrapped in a non-null assertion: document.getElementById(...)!
      let parent = node.parent;
      if (ts.isNonNullExpression(parent)) {
        parent = parent.parent;
      }
      // Must be assigned to this.x
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const key = expressionToKey(parent.left as ts.Expression);
        if (key && key.startsWith('this.')) {
          domRefs.push({ node, storedAs: key });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const results: MemoryLeakLocation[] = [];
  for (const { node, storedAs } of domRefs) {
    if (!nulledKeys.has(storedAs)) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      results.push({
        file: sourceFile.fileName,
        line: pos.line + 1,
        character: pos.character + 1,
        snippet: snippetAt(source, node.getStart()),
        kind: 'retained-dom-reference',
      });
    }
  }

  return results;
}

function findUnclearedIntervals(
  sourceFile: ts.SourceFile,
  source: string,
  clearedKeys: Set<string>,
): MemoryLeakLocation[] {
  const intervalCalls: Array<{ node: ts.CallExpression; storedAs: string | null }> = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fnName = node.expression.text;

      if (fnName === 'setInterval') {
        let storedAs: string | null = null;
        const parent = node.parent;

        // this.x = setInterval(...) or x = setInterval(...)
        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.right === node
        ) {
          storedAs = expressionToKey(parent.left as ts.Expression);
        }
        // const/let/var x = setInterval(...)
        else if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
          if (ts.isIdentifier(parent.name)) {
            storedAs = parent.name.text;
          }
        }

        intervalCalls.push({ node, storedAs });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const results: MemoryLeakLocation[] = [];
  for (const { node, storedAs } of intervalCalls) {
    const isCleared = storedAs !== null && clearedKeys.has(storedAs);
    if (!isCleared) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      results.push({
        file: sourceFile.fileName,
        line: pos.line + 1,
        character: pos.character + 1,
        snippet: snippetAt(source, node.getStart()),
        kind: 'uncleared-interval',
      });
    }
  }

  return results;
}

// ── Timeout leak detection ─────────────────────────────────────────────────────

function findUnclearedTimeouts(
  sourceFile: ts.SourceFile,
  source: string,
  clearedKeys: Set<string>,
): MemoryLeakLocation[] {
  const timeoutCalls: Array<{ node: ts.CallExpression; storedAs: string | null }> = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'setTimeout') {
        let storedAs: string | null = null;
        const parent = node.parent;

        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.right === node
        ) {
          storedAs = expressionToKey(parent.left as ts.Expression);
        } else if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
          if (ts.isIdentifier(parent.name)) {
            storedAs = parent.name.text;
          }
        }

        // Only flag when the return value is stored — bare setTimeout(() => ...) is not trackable
        if (storedAs !== null) {
          timeoutCalls.push({ node, storedAs });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const results: MemoryLeakLocation[] = [];
  for (const { node, storedAs } of timeoutCalls) {
    if (storedAs !== null && !clearedKeys.has(storedAs)) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      results.push({
        file: sourceFile.fileName,
        line: pos.line + 1,
        character: pos.character + 1,
        snippet: snippetAt(source, node.getStart()),
        kind: 'uncleared-timeout',
      });
    }
  }

  return results;
}

// ── Renderer2.listen() leak detection ─────────────────────────────────────────

/**
 * Finds `this.x = expr.listen(target, event, handler)` assignments (3-arg `.listen()` calls,
 * typical of Renderer2) whose stored cleanup function is never called from `ngOnDestroy`.
 */
function findUncleanedRendererListeners(
  sourceFile: ts.SourceFile,
  source: string,
  calledThisPropertyKeys: Set<string>,
): MemoryLeakLocation[] {
  const listenCalls: Array<{ node: ts.CallExpression; storedAs: string }> = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'listen' &&
      node.arguments.length === 3
    ) {
      const parent = node.parent;
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === node
      ) {
        const key = expressionToKey(parent.left as ts.Expression);
        if (key && key.startsWith('this.')) {
          listenCalls.push({ node, storedAs: key });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return listenCalls
    .filter(({ storedAs }) => !calledThisPropertyKeys.has(storedAs))
    .map(({ node, storedAs: _ }) => {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      return {
        file: sourceFile.fileName,
        line: pos.line + 1,
        character: pos.character + 1,
        snippet: snippetAt(source, node.getStart()),
        kind: 'unremoved-renderer-listener' as MemoryLeakKind,
      };
    });
}

// ── takeUntil Subject completeness detection ───────────────────────────────────

const SUBJECT_CONSTRUCTORS = new Set([
  'Subject',
  'BehaviorSubject',
  'ReplaySubject',
  'AsyncSubject',
]);

/**
 * Returns the set of `this.x` keys that appear as the argument to `takeUntil(this.x)`
 * anywhere in the file.
 */
function findSubjectsUsedInTakeUntil(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  function visit(n: ts.Node): void {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'takeUntil' &&
      n.arguments.length === 1
    ) {
      const key = expressionToKey(n.arguments[0] as ts.Expression);
      if (key) keys.add(key);
    }
    ts.forEachChild(n, visit);
  }
  visit(sourceFile);
  return keys;
}

/**
 * Finds Subject/BehaviorSubject/etc. instances stored on `this` that are used as
 * `takeUntil` sources but whose `next()` / `complete()` is never called from `ngOnDestroy`.
 */
function findIncompleteDestroySubjects(
  sourceFile: ts.SourceFile,
  source: string,
  completedSubjectKeys: Set<string>,
): MemoryLeakLocation[] {
  const takeUntilKeys = findSubjectsUsedInTakeUntil(sourceFile);
  if (takeUntilKeys.size === 0) return [];

  const results: MemoryLeakLocation[] = [];

  function checkNewSubject(newExpr: ts.NewExpression, key: string, reportNode: ts.Node): void {
    if (
      ts.isIdentifier(newExpr.expression) &&
      SUBJECT_CONSTRUCTORS.has(newExpr.expression.text) &&
      takeUntilKeys.has(key) &&
      !completedSubjectKeys.has(key)
    ) {
      const pos = sourceFile.getLineAndCharacterOfPosition(reportNode.getStart());
      results.push({
        file: sourceFile.fileName,
        line: pos.line + 1,
        character: pos.character + 1,
        snippet: snippetAt(source, reportNode.getStart()),
        kind: 'incomplete-destroy-subject',
      });
    }
  }

  function visit(node: ts.Node): void {
    // Class property initializer: private destroy$ = new Subject<void>()
    if (
      ts.isPropertyDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isNewExpression(node.initializer)
    ) {
      checkNewSubject(node.initializer, `this.${node.name.text}`, node.initializer);
    }

    // Assignment in constructor / method: this.destroy$ = new Subject()
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isNewExpression(node.right)
    ) {
      const key = expressionToKey(node.left as ts.Expression);
      if (key) {
        checkNewSubject(node.right, key, node.right);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}
