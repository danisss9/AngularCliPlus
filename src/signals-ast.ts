import * as ts from 'typescript';
import * as fs from 'fs';

export type SignalKind = 'signal' | 'input' | 'computed' | 'effect' | 'output';

export interface SignalNode {
  name: string;
  kind: SignalKind;
  line: number;
  character: number;
  file: string;
}

export interface SignalEdge {
  from: string;
  to: string;
  label?: string;
}

export interface SignalGraphData {
  nodes: SignalNode[];
  edges: SignalEdge[];
  file: string;
  className?: string;
}

const MAX_DEPTH = 10;

// ── Helpers ────────────────────────────────────────────────────────────────────

function getCallFnName(node: ts.CallExpression): string | null {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  // e.g. input.required<T>()
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text;
  }
  return null;
}

/**
 * Walk a subtree and collect names of known signals that are called (read)
 * inside it.  Recognises both `this.name()` and bare `name()` patterns up to
 * MAX_DEPTH levels of nesting.
 */
function collectSignalReads(root: ts.Node, knownSignals: Set<string>, depth: number): string[] {
  if (depth <= 0) return [];
  const reads: string[] = [];

  function walk(node: ts.Node, d: number): void {
    if (d <= 0) return;
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      // this.signalName()
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const propName = expr.name.text;
        if (knownSignals.has(propName) && !reads.includes(propName)) {
          reads.push(propName);
        }
      }
      // bare signalName()
      if (ts.isIdentifier(expr) && knownSignals.has(expr.text) && !reads.includes(expr.text)) {
        reads.push(expr.text);
      }
    }
    ts.forEachChild(node, (child) => walk(child, d - 1));
  }

  walk(root, depth);
  return reads;
}

/**
 * Walk a class body and find every `this.outputName.emit(...)` call.
 * Returns a map: outputName → list of method names where emit is called.
 */
function collectOutputEmits(
  classDecl: ts.ClassDeclaration,
  outputNames: Set<string>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const name of outputNames) {
    result.set(name, []);
  }

  function walkForEmit(node: ts.Node, contextName: string): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'emit'
    ) {
      const target = node.expression.expression;
      if (
        ts.isPropertyAccessExpression(target) &&
        target.expression.kind === ts.SyntaxKind.ThisKeyword &&
        outputNames.has(target.name.text)
      ) {
        const list = result.get(target.name.text)!;
        if (!list.includes(contextName)) {
          list.push(contextName);
        }
      }
    }
    ts.forEachChild(node, (child) => walkForEmit(child, contextName));
  }

  for (const member of classDecl.members) {
    if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
      const methodName =
        ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)
          ? member.name.text
          : 'constructor';
      walkForEmit(member.body, methodName);
    }
  }

  return result;
}

// ── Main analyser ──────────────────────────────────────────────────────────────

export function analyzeSignalsInFile(filePath: string): SignalGraphData | null {
  if (!fs.existsSync(filePath)) return null;

  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

  const nodes: SignalNode[] = [];
  const edges: SignalEdge[] = [];
  let className: string | undefined;

  // Find the first class declaration
  let classDecl: ts.ClassDeclaration | undefined;
  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt)) {
      classDecl = stmt;
      if (stmt.name) className = stmt.name.text;
      break;
    }
  }

  if (!classDecl) return { nodes: [], edges: [], file: filePath };

  const signalNames = new Set<string>();
  const outputNames = new Set<string>();
  // Map of node name → callback node, for dep tracing after all names are known
  const callbackMap = new Map<string, ts.Node>();
  let effectCounter = 0;

  // ── Phase A: collect property declarations ─────────────────────────────────

  for (const member of classDecl.members) {
    if (
      !ts.isPropertyDeclaration(member) ||
      !member.name ||
      !ts.isIdentifier(member.name) ||
      !member.initializer ||
      !ts.isCallExpression(member.initializer)
    ) {
      continue;
    }

    const propName = member.name.text;
    const fnName = getCallFnName(member.initializer);
    if (!fnName) continue;

    let kind: SignalKind | null = null;
    if (fnName === 'signal') kind = 'signal';
    else if (fnName === 'input') kind = 'input';
    else if (fnName === 'computed') kind = 'computed';
    else if (fnName === 'effect') kind = 'effect';
    else if (fnName === 'output') kind = 'output';

    if (!kind) continue;

    const pos = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
    nodes.push({
      name: propName,
      kind,
      line: pos.line + 1,
      character: pos.character,
      file: filePath,
    });
    signalNames.add(propName);
    if (kind === 'output') outputNames.add(propName);

    // Store the callback for dep tracing (computed/effect need their factory args)
    if ((kind === 'computed' || kind === 'effect') && member.initializer.arguments.length > 0) {
      callbackMap.set(propName, member.initializer.arguments[0]);
    }
  }

  // ── Phase B1: trace deps for property-level computed / effect ──────────────
  //    Done after Phase A so all signal names are known.

  for (const [nodeName, callback] of callbackMap) {
    const reads = collectSignalReads(callback, signalNames, MAX_DEPTH);
    for (const read of reads) {
      edges.push({ from: read, to: nodeName });
    }
  }

  // ── Phase B2: find inline effect() calls inside constructor / methods ──────

  function visitForInlineEffects(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'effect' &&
      node.arguments.length > 0
    ) {
      effectCounter++;
      const effectName = `effect_${effectCounter}`;
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      nodes.push({
        name: effectName,
        kind: 'effect',
        line: pos.line + 1,
        character: pos.character,
        file: filePath,
      });
      signalNames.add(effectName);

      const reads = collectSignalReads(node.arguments[0], signalNames, MAX_DEPTH);
      for (const read of reads) {
        edges.push({ from: read, to: effectName });
      }
      // Don't recurse into the effect callback (avoid double-counting nested effects)
      return;
    }
    ts.forEachChild(node, visitForInlineEffects);
  }

  for (const member of classDecl.members) {
    if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
      visitForInlineEffects(member.body);
    }
  }

  // ── Phase C: output .emit() calls ─────────────────────────────────────────

  if (outputNames.size > 0) {
    const emitMap = collectOutputEmits(classDecl, outputNames);
    for (const [outputName, callers] of emitMap.entries()) {
      for (const caller of callers) {
        edges.push({ from: outputName, to: caller, label: 'emit' });
      }
    }
  }

  // ── Deduplicate edges ──────────────────────────────────────────────────────

  const seen = new Set<string>();
  const uniqueEdges: SignalEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}:${edge.label ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEdges.push(edge);
    }
  }

  return { nodes, edges: uniqueEdges, file: filePath, className };
}
