/**
 * Symbol index behind "Angular: Auto Import Missing Imports".
 *
 * Two indexes are maintained per workspace folder:
 *
 *   - **Workspace index** — every exported `@Component`/`@Directive`/`@Pipe`/
 *     `@NgModule` of the project's `.ts` files, keyed by the selector / pipe
 *     tokens a template would use them with. It is built once, kept in memory
 *     and refreshed *per file* by a `FileSystemWatcher`, so the second run of
 *     the command costs nothing.
 *
 *   - **Library index** — the same information for Angular packages inside
 *     `node_modules`, read straight from the metadata the Angular compiler
 *     embeds in `.d.ts` files (`ɵɵComponentDeclaration<…, "mat-card", …>`).
 *     Only packages that depend on `@angular/core` are scanned, so a plain
 *     project touches a handful of files.
 *
 * Speed notes: files are read in parallel batches, a regex pre-filter skips
 * the TypeScript parse for the ~90% of files that hold no decorator, and the
 * parse itself runs without parent pointers.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import { extractSelectorTokenWeights, parseDtsModule } from './auto-imports-scan';
import type { DtsModule, LibraryDeclaration } from './auto-imports-scan';
import { logDiagnostic } from './state';

// ── Types ────────────────────────────────────────────────────────────────────

export type SymbolKind = 'Component' | 'Directive' | 'Pipe' | 'NgModule';

export interface AutoImportSymbol {
  className: string;
  kind: SymbolKind;
  /** lowercased selector / pipe-name tokens; empty for modules */
  tokens: string[];
  origin: 'workspace' | 'library';
  /** absolute path of the declaring file (workspace symbols) */
  filePath?: string;
  /** bare module specifier (library symbols) */
  moduleSpecifier?: string;
  /** how much of its selector each token accounts for (1 when absent) */
  weights?: Record<string, number>;
  /** class names an NgModule re-exports */
  exports?: string[];
  /**
   * Whether the symbol is standalone. `undefined` when it cannot be told
   * (older libraries, or a decorator that relies on the version default).
   */
  standalone?: boolean;
}

export interface AutoImportIndex {
  root: string;
  /** token → symbols providing it (workspace first, then libraries) */
  byToken: Map<string, AutoImportSymbol[]>;
  /** class name → symbols with that name */
  byName: Map<string, AutoImportSymbol[]>;
  /** normalized templateUrl target → owning `.ts` files */
  templateUrlOwners: Map<string, string[]>;
  /** tsconfig `paths` mapping used to resolve aliased imports */
  pathMappings: PathMapping[];
  /** how many workspace files the index covers (for diagnostics) */
  fileCount: number;
  /** true when node_modules metadata could be read */
  libraryScanned: boolean;
}

export interface PathMapping {
  /** e.g. `@app/` for `"@app/*"` or `@env` for an exact mapping */
  prefix: string;
  wildcard: boolean;
  /** absolute target prefixes */
  targets: string[];
}

interface FileIndexEntry {
  filePath: string;
  symbols: AutoImportSymbol[];
  templateUrls: string[];
}

const DECORATOR_KINDS: ReadonlySet<string> = new Set([
  'Component',
  'Directive',
  'Pipe',
  'NgModule',
]);

const DECORATOR_HINT = /@(?:Component|Directive|Pipe|NgModule)\s*\(/;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  '.git',
  '.vscode',
  '.angular',
  'coverage',
]);

/** Directories inside a package that never hold public type declarations. */
const SKIP_PACKAGE_DIRS = /^(?:node_modules|fesm\d*|esm\d*|bundles|__ivy_ngcc__|src|schematics|\.bin)$/;

const MAX_LIBRARY_FILES = 4000;
const READ_BATCH_SIZE = 64;

// ── Small helpers ────────────────────────────────────────────────────────────

export function normalizeFs(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p;
}

export function readFileOrNull(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

async function readFileAsync(absPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/** Reads many files with bounded concurrency. */
async function readAll(
  paths: string[],
  onFile: (filePath: string, contents: string) => void,
  token?: vscode.CancellationToken,
): Promise<void> {
  for (let i = 0; i < paths.length; i += READ_BATCH_SIZE) {
    if (token?.isCancellationRequested) {
      return;
    }
    const batch = paths.slice(i, i + READ_BATCH_SIZE);
    const contents = await Promise.all(batch.map((p) => readFileAsync(p)));
    for (let j = 0; j < batch.length; j += 1) {
      const text = contents[j];
      if (text !== null) {
        onFile(batch[j], text);
      }
    }
  }
}

function isInsideSkippedDir(filePath: string): boolean {
  return filePath.split(/[\\/]/).some((segment) => SKIP_DIRS.has(segment));
}

function pushSymbol(map: Map<string, AutoImportSymbol[]>, key: string, symbol: AutoImportSymbol) {
  const list = map.get(key);
  if (list) {
    list.push(symbol);
  } else {
    map.set(key, [symbol]);
  }
}

// ── TypeScript source parsing ────────────────────────────────────────────────

function isExported(node: ts.ClassDeclaration): boolean {
  return Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function stringOf(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

/** Identifier elements of an array literal property (`exports: [A, B]`). */
function identifiersOf(node: ts.Expression): string[] {
  if (!ts.isArrayLiteralExpression(node)) {
    return [];
  }
  return node.elements.filter(ts.isIdentifier).map((element) => element.text);
}

/**
 * Extracts the indexable symbols and `templateUrl` targets of one source file.
 * Runs on a parse without parent pointers — it only reads node texts.
 */
export function indexSourceFile(filePath: string, sourceFile: ts.SourceFile): FileIndexEntry {
  const symbols: AutoImportSymbol[] = [];
  const templateUrls: string[] = [];

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
        const kind = callee.text as SymbolKind;
        const metadata = modifier.expression.arguments[0];

        let weights = new Map<string, number>();
        let exports: string[] = [];
        let standalone: boolean | undefined;

        for (const prop of metadata.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
            continue;
          }
          const propertyName = prop.name.text;
          if (propertyName === 'templateUrl') {
            const value = stringOf(prop.initializer);
            if (value) {
              templateUrls.push(path.resolve(path.dirname(filePath), value));
            }
          } else if (propertyName === 'selector' && kind !== 'Pipe') {
            const value = stringOf(prop.initializer);
            if (value) {
              weights = extractSelectorTokenWeights(value);
            }
          } else if (propertyName === 'name' && kind === 'Pipe') {
            const value = stringOf(prop.initializer);
            if (value) {
              weights = new Map([[value.toLowerCase(), 1]]);
            }
          } else if (propertyName === 'exports' && kind === 'NgModule') {
            exports = identifiersOf(prop.initializer);
          } else if (propertyName === 'standalone') {
            if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
              standalone = true;
            } else if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) {
              standalone = false;
            }
          }
        }

        if (isExported(node) && (weights.size > 0 || exports.length > 0)) {
          symbols.push({
            className: node.name.text,
            kind,
            tokens: [...weights.keys()],
            weights: Object.fromEntries(weights),
            origin: 'workspace',
            filePath,
            exports: kind === 'NgModule' ? exports : undefined,
            standalone,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { filePath, symbols, templateUrls };
}

function parseForIndex(filePath: string, contents: string): ts.SourceFile {
  return ts.createSourceFile(filePath, contents, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
}

// ── tsconfig path mappings ───────────────────────────────────────────────────

interface RawTsConfig {
  extends?: string;
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

/** Reads `compilerOptions.paths` from tsconfig.json, following `extends`. */
export function loadPathMappings(workspaceRoot: string): PathMapping[] {
  const mappings: PathMapping[] = [];
  const visited = new Set<string>();

  const load = (configPath: string): void => {
    const normalized = normalizeFs(configPath);
    if (visited.has(normalized) || visited.size > 8) {
      return;
    }
    visited.add(normalized);

    const text = readFileOrNull(configPath);
    if (text === null) {
      return;
    }
    let config: RawTsConfig;
    try {
      config = jsonc.parse(text) as RawTsConfig;
    } catch {
      return;
    }
    if (!config) {
      return;
    }

    const configDir = path.dirname(configPath);
    if (config.extends) {
      const parent = config.extends.startsWith('.')
        ? path.resolve(configDir, config.extends)
        : path.join(workspaceRoot, 'node_modules', config.extends);
      load(parent.endsWith('.json') ? parent : `${parent}.json`);
    }

    const baseUrl = path.resolve(configDir, config.compilerOptions?.baseUrl ?? '.');
    for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
      const wildcard = pattern.endsWith('*');
      mappings.push({
        prefix: wildcard ? pattern.slice(0, -1) : pattern,
        wildcard,
        targets: targets.map((target) =>
          path.resolve(baseUrl, target.endsWith('*') ? target.slice(0, -1) : target),
        ),
      });
    }
  };

  load(path.join(workspaceRoot, 'tsconfig.json'));
  // Longest prefix first so `@app/shared/` beats `@app/`
  return mappings.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Attempts the usual file variants for a module target. */
function resolveTsFile(candidate: string): string | null {
  const variants = candidate.endsWith('.ts')
    ? [candidate]
    : [`${candidate}.ts`, path.join(candidate, 'index.ts'), candidate];
  for (const variant of variants) {
    if (variant.endsWith('.ts') && fs.existsSync(variant)) {
      return variant;
    }
  }
  return null;
}

/**
 * Resolves a module specifier used by `ownerFilePath` to a workspace `.ts`
 * file, understanding relative paths and tsconfig `paths` aliases.
 */
export function resolveModuleToWorkspaceFile(
  ownerFilePath: string,
  specifier: string,
  mappings: readonly PathMapping[],
): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return resolveTsFile(path.resolve(path.dirname(ownerFilePath), specifier));
  }
  for (const mapping of mappings) {
    if (mapping.wildcard ? specifier.startsWith(mapping.prefix) : specifier === mapping.prefix) {
      const rest = mapping.wildcard ? specifier.slice(mapping.prefix.length) : '';
      for (const target of mapping.targets) {
        const resolved = resolveTsFile(rest === '' ? target : path.join(target, rest));
        if (resolved) {
          return resolved;
        }
      }
    }
  }
  return null;
}

// ── Library (node_modules) scanning ──────────────────────────────────────────

interface PackageEntryPoints {
  /** package root directory */
  root: string;
  name: string;
  /** subpaths declared in `exports`, or null when the field is absent */
  exportSubpaths: Set<string> | null;
  /** absolute path of the `types`/`typings` entry, when declared */
  typesEntry: string | null;
}

function readJson(filePath: string): Record<string, unknown> | null {
  const text = readFileOrNull(filePath);
  if (text === null) {
    return null;
  }
  try {
    return jsonc.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Package names declared by the workspace (dependencies + devDependencies). */
function declaredDependencies(workspaceRoot: string): string[] {
  const pkg = readJson(path.join(workspaceRoot, 'package.json'));
  if (!pkg) {
    return [];
  }
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const section = pkg[field];
    if (section && typeof section === 'object') {
      for (const name of Object.keys(section as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/** True for packages that ship Angular declarations worth indexing. */
function isAngularPackage(name: string, manifest: Record<string, unknown> | null): boolean {
  if (name.startsWith('@angular/')) {
    return name !== '@angular/cli' && name !== '@angular/compiler-cli';
  }
  if (!manifest) {
    return false;
  }
  for (const field of ['peerDependencies', 'dependencies']) {
    const section = manifest[field];
    if (section && typeof section === 'object' && '@angular/core' in section) {
      return true;
    }
  }
  return false;
}

function collectDtsFiles(dir: string, out: string[], depth: number): void {
  if (out.length >= MAX_LIBRARY_FILES || depth > 4) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_LIBRARY_FILES) {
      return;
    }
    if (entry.isDirectory()) {
      if (!SKIP_PACKAGE_DIRS.test(entry.name) && !entry.name.startsWith('.')) {
        collectDtsFiles(path.join(dir, entry.name), out, depth + 1);
      }
    } else if (entry.name.endsWith('.d.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
}

/** Matches a subpath against an `exports` key, honouring `*` wildcards. */
function matchesExportKey(key: string, subpath: string): boolean {
  if (key === subpath) {
    return true;
  }
  const star = key.indexOf('*');
  if (star < 0) {
    return false;
  }
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return (
    subpath.length >= prefix.length + suffix.length &&
    subpath.startsWith(prefix) &&
    subpath.endsWith(suffix)
  );
}

function isExportedSubpath(pkg: PackageEntryPoints, subpath: string): boolean {
  if (!pkg.exportSubpaths) {
    return false;
  }
  for (const key of pkg.exportSubpaths) {
    if (matchesExportKey(key, subpath)) {
      return true;
    }
  }
  return false;
}

/**
 * Maps a `.d.ts` path to the module specifier that exposes it: the package
 * name plus its entry-point subpath (`@angular/material/button`).
 *
 * Returns null when no published entry point covers the file, so a symbol is
 * never suggested behind an import path that does not resolve.
 */
export function moduleSpecifierForDts(dtsPath: string, pkg: PackageEntryPoints): string | null {
  const relativeDir = path.relative(pkg.root, path.dirname(dtsPath)).replace(/\\/g, '/');
  if (relativeDir === '' || relativeDir === '.') {
    return !pkg.exportSubpaths || isExportedSubpath(pkg, '.') ? pkg.name : null;
  }

  // Try the longest subpath first, then its parents ("button/index.d.ts" may
  // be published as "pkg/button" even when it lives deeper).
  const segments = relativeDir.split('/');
  for (let end = segments.length; end > 0; end -= 1) {
    const subpath = segments.slice(0, end).join('/');
    if (pkg.exportSubpaths) {
      if (isExportedSubpath(pkg, `./${subpath}`)) {
        return `${pkg.name}/${subpath}`;
      }
    } else if (fs.existsSync(path.join(pkg.root, ...segments.slice(0, end), 'package.json'))) {
      return `${pkg.name}/${subpath}`;
    }
  }

  // No declared entry point: only the package root can be imported from.
  if (pkg.exportSubpaths && !isExportedSubpath(pkg, '.')) {
    return null;
  }
  return pkg.name;
}

function entryPointsOf(workspaceRoot: string, name: string): PackageEntryPoints | null {
  const root = path.join(workspaceRoot, 'node_modules', ...name.split('/'));
  const manifest = readJson(path.join(root, 'package.json'));
  if (!manifest || !isAngularPackage(name, manifest)) {
    return null;
  }
  const exportsField = manifest.exports;
  const exportSubpaths =
    exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)
      ? new Set(Object.keys(exportsField as Record<string, unknown>))
      : null;
  const types = manifest.types ?? manifest.typings;
  const typesEntry = typeof types === 'string' ? path.resolve(root, types) : null;
  return { root, name, exportSubpaths, typesEntry };
}


/** Public name of a library symbol together with where it is declared. */
interface PublicExport {
  file: string;
  localName: string;
}

/** Resolves `./chunk.js` / `../x` style specifiers to a `.d.ts` file. */
function resolveDtsSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, '.d.ts'),
    `${base}.d.ts`,
    path.join(base, 'index.d.ts'),
    base,
  ];
  for (const candidate of candidates) {
    if (candidate.endsWith('.d.ts') && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves the public names one `.d.ts` exposes, following its re-export
 * chain (`export { f as MatIcon } from '../chunk.js'`) down to the file that
 * actually declares each symbol.
 */
function resolvePublicExports(
  file: string,
  modules: Map<string, DtsModule>,
  depth = 0,
  visiting = new Set<string>(),
): Map<string, PublicExport> {
  const result = new Map<string, PublicExport>();
  const key = normalizeFs(file);
  const info = modules.get(key);
  if (!info || depth > 4 || visiting.has(key)) {
    return result;
  }
  visiting.add(key);

  for (const [alias, localName] of info.aliasToLocal) {
    result.set(alias, { file: key, localName });
  }

  for (const reExport of info.reExports) {
    const target = resolveDtsSpecifier(file, reExport.from);
    if (target === null) {
      continue;
    }
    const targetExports = resolvePublicExports(target, modules, depth + 1, visiting);
    if (reExport.star) {
      for (const [name, entry] of targetExports) {
        result.set(name, entry);
      }
    } else {
      for (const { source, exported } of reExport.names) {
        const entry = targetExports.get(source);
        if (entry) {
          result.set(exported, entry);
        }
      }
    }
  }

  visiting.delete(key);
  return result;
}

/**
 * How well an entry point matches a symbol: `MatFormField` belongs to
 * `@angular/material/form-field` even though `/select` re-exports it too.
 * Lower is better.
 */
function entryPointScore(publicName: string, specifier: string): number {
  const kebab = publicName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const lastSegment = specifier.split('/').pop() ?? '';
  const matches = lastSegment !== '' && kebab.includes(lastSegment);
  return (matches ? 0 : 1000) + specifier.length;
}

/** Files that may act as a package entry point. */
function isEntryPointFile(filePath: string, pkg: PackageEntryPoints): boolean {
  const base = path.basename(filePath);
  if (base === 'index.d.ts' || base === `${pkg.name.split('/').pop()}.d.ts`) {
    return true;
  }
  return pkg.typesEntry !== null && normalizeFs(filePath) === normalizeFs(pkg.typesEntry);
}

/**
 * Builds the symbol list for one Angular package: every declaration reachable
 * from a public entry point, named as that entry point exports it, with each
 * NgModule expanded to the tokens of everything it re-exports.
 */
async function symbolsForPackage(
  pkg: PackageEntryPoints,
  token?: vscode.CancellationToken,
): Promise<AutoImportSymbol[]> {
  const files: string[] = [];
  collectDtsFiles(pkg.root, files, 0);
  if (files.length === 0) {
    return [];
  }

  const modules = new Map<string, DtsModule>();
  await readAll(
    files,
    (filePath, contents) => {
      if (contents.includes('ɵɵ') || contents.includes('export')) {
        modules.set(normalizeFs(filePath), parseDtsModule(contents));
      }
    },
    token,
  );

  /** local name → declaration, package wide (used to expand NgModules) */
  const declarations = new Map<string, LibraryDeclaration>();
  for (const info of modules.values()) {
    for (const [name, declaration] of info.declarations) {
      if (!declarations.has(name)) {
        declarations.set(name, declaration);
      }
    }
  }

  /** A module provides everything its exported declarations provide. */
  const weightsOf = (localName: string, seen: Set<string>): Map<string, number> => {
    const collected = new Map<string, number>();
    if (seen.has(localName)) {
      return collected;
    }
    seen.add(localName);
    const declaration = declarations.get(localName);
    if (!declaration) {
      return collected;
    }
    for (const [token, weight] of Object.entries(declaration.weights)) {
      collected.set(token, Math.max(collected.get(token) ?? 0, weight));
    }
    if (declaration.kind === 'NgModule') {
      for (const exported of declaration.exports) {
        for (const [token, weight] of weightsOf(exported, seen)) {
          collected.set(token, Math.max(collected.get(token) ?? 0, weight));
        }
      }
    }
    return collected;
  };

  const entryPoints: Array<{ file: string; specifier: string }> = [];
  for (const file of files) {
    if (!isEntryPointFile(file, pkg)) {
      continue;
    }
    const specifier = moduleSpecifierForDts(file, pkg);
    // `@angular/router/testing` and friends only belong in specs
    if (specifier !== null && !/(?:^|\/)testing$/.test(specifier)) {
      entryPoints.push({ file, specifier });
    }
  }
  entryPoints.sort((a, b) => a.specifier.length - b.specifier.length);

  const symbols: AutoImportSymbol[] = [];
  const claimed = new Map<string, { symbol: AutoImportSymbol; score: number }>();

  for (const entryPoint of entryPoints) {
    for (const [publicName, origin] of resolvePublicExports(entryPoint.file, modules)) {
      if (!/^[A-Z]/.test(publicName)) {
        continue;
      }
      const declaration = modules.get(origin.file)?.declarations.get(origin.localName);
      if (!declaration) {
        continue;
      }
      // Several entry points may re-export the same symbol (MatFormField is
      // reachable from both `/select` and `/form-field`); keep the one whose
      // name the symbol echoes, then the shortest.
      const score = entryPointScore(publicName, entryPoint.specifier);
      const previous = claimed.get(publicName);
      if (previous) {
        if (score < previous.score) {
          previous.symbol.moduleSpecifier = entryPoint.specifier;
          previous.score = score;
        }
        continue;
      }
      const weights =
        declaration.kind === 'NgModule'
          ? weightsOf(origin.localName, new Set())
          : new Map(Object.entries(declaration.weights));
      const symbol: AutoImportSymbol = {
        className: publicName,
        kind: declaration.kind,
        tokens: [...weights.keys()],
        weights: Object.fromEntries(weights),
        origin: 'library',
        moduleSpecifier: entryPoint.specifier,
        exports: declaration.kind === 'NgModule' ? declaration.exports : undefined,
        standalone: declaration.standalone,
      };
      claimed.set(publicName, { symbol, score });
      symbols.push(symbol);
    }
  }

  return symbols;
}

/** Scans every Angular package declared by the workspace's package.json. */
async function buildLibrarySymbols(
  workspaceRoot: string,
  token?: vscode.CancellationToken,
): Promise<AutoImportSymbol[]> {
  const symbols: AutoImportSymbol[] = [];
  const claimed = new Set<string>();

  for (const name of declaredDependencies(workspaceRoot)) {
    if (token?.isCancellationRequested) {
      return [];
    }
    const pkg = entryPointsOf(workspaceRoot, name);
    if (!pkg) {
      continue;
    }
    for (const symbol of await symbolsForPackage(pkg, token)) {
      if (!claimed.has(symbol.className)) {
        claimed.add(symbol.className);
        symbols.push(symbol);
      }
    }
  }

  return symbols;
}

// ── Workspace index state (cached + incrementally refreshed) ─────────────────

interface WorkspaceIndexState {
  root: string;
  files: Map<string, FileIndexEntry>;
  /** files whose contents changed since the last build */
  dirty: Set<string>;
  librarySymbols: AutoImportSymbol[] | null;
  libraryStale: boolean;
  /** set when package.json / tsconfig changed: forces a rebuild */
  stale: boolean;
  /** number of deletions seen since the last derive */
  dirtyDeletes: number;
  pathMappings: PathMapping[] | null;
  built: boolean;
  building: Promise<AutoImportIndex> | null;
  derived: AutoImportIndex | null;
  disposables: vscode.Disposable[];
}

const states = new Map<string, WorkspaceIndexState>();

function stateFor(workspaceRoot: string): WorkspaceIndexState {
  const key = normalizeFs(workspaceRoot);
  const existing = states.get(key);
  if (existing) {
    return existing;
  }

  const state: WorkspaceIndexState = {
    root: workspaceRoot,
    files: new Map(),
    dirty: new Set(),
    librarySymbols: null,
    libraryStale: true,
    stale: false,
    dirtyDeletes: 0,
    pathMappings: null,
    built: false,
    building: null,
    derived: null,
    disposables: [],
  };

  const folder = vscode.Uri.file(workspaceRoot);
  const tsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '**/*.ts'),
  );
  const markDirty = (uri: vscode.Uri): void => {
    if (isInsideSkippedDir(uri.fsPath) || uri.fsPath.endsWith('.d.ts')) {
      return;
    }
    state.dirty.add(uri.fsPath);
  };
  const markDeleted = (uri: vscode.Uri): void => {
    state.files.delete(normalizeFs(uri.fsPath));
    state.dirty.delete(uri.fsPath);
    state.dirtyDeletes += 1;
  };
  tsWatcher.onDidCreate(markDirty);
  tsWatcher.onDidChange(markDirty);
  tsWatcher.onDidDelete(markDeleted);

  const configWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '{package.json,package-lock.json,tsconfig*.json}'),
  );
  const invalidateConfig = (): void => {
    state.libraryStale = true;
    state.pathMappings = null;
    state.stale = true;
  };
  configWatcher.onDidCreate(invalidateConfig);
  configWatcher.onDidChange(invalidateConfig);
  configWatcher.onDidDelete(invalidateConfig);

  state.disposables.push(tsWatcher, configWatcher);
  states.set(key, state);
  return state;
}

/** Re-reads the files marked dirty by the watcher (or all of them initially). */
async function refreshWorkspaceFiles(
  state: WorkspaceIndexState,
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<void> {
  let targets: string[];

  if (!state.built) {
    const folder = vscode.Uri.file(state.root);
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*.ts'),
      new vscode.RelativePattern(folder, '**/{node_modules,dist,out,.git,.angular,coverage}/**'),
    );
    targets = uris
      .map((uri) => uri.fsPath)
      .filter((filePath) => !filePath.endsWith('.d.ts') && !isInsideSkippedDir(filePath));
    progress?.report({ message: `indexing ${targets.length} files…` });
  } else {
    targets = [...state.dirty];
  }

  state.dirty.clear();
  if (targets.length === 0) {
    return;
  }

  await readAll(
    targets,
    (filePath, contents) => {
      if (!DECORATOR_HINT.test(contents)) {
        state.files.delete(normalizeFs(filePath));
        return;
      }
      const entry = indexSourceFile(filePath, parseForIndex(filePath, contents));
      if (entry.symbols.length === 0 && entry.templateUrls.length === 0) {
        state.files.delete(normalizeFs(filePath));
      } else {
        state.files.set(normalizeFs(filePath), entry);
      }
    },
    token,
  );

  if (!token?.isCancellationRequested) {
    state.built = true;
  }
}

/** Rebuilds the lookup maps from the per-file cache (cheap, pure in-memory). */
function deriveIndex(state: WorkspaceIndexState): AutoImportIndex {
  const byToken = new Map<string, AutoImportSymbol[]>();
  const byName = new Map<string, AutoImportSymbol[]>();
  const templateUrlOwners = new Map<string, string[]>();

  for (const entry of state.files.values()) {
    for (const symbol of entry.symbols) {
      pushSymbol(byName, symbol.className, symbol);
      for (const tokenKey of symbol.tokens) {
        pushSymbol(byToken, tokenKey, symbol);
      }
    }
    for (const templateUrl of entry.templateUrls) {
      const key = normalizeFs(templateUrl);
      const owners = templateUrlOwners.get(key) ?? [];
      if (!owners.includes(entry.filePath)) {
        owners.push(entry.filePath);
      }
      templateUrlOwners.set(key, owners);
    }
  }

  for (const symbol of state.librarySymbols ?? []) {
    pushSymbol(byName, symbol.className, symbol);
    for (const tokenKey of symbol.tokens) {
      pushSymbol(byToken, tokenKey, symbol);
    }
  }

  // A workspace NgModule provides whatever it exports. Its `exports` entries
  // are plain identifiers, so they are matched by name — ambiguous names are
  // skipped rather than guessed. This is what lets a standalone component
  // import the module of a declaration that is not standalone itself.
  const workspaceModules: AutoImportSymbol[] = [];
  for (const entry of state.files.values()) {
    for (const symbol of entry.symbols) {
      if (symbol.kind === 'NgModule') {
        workspaceModules.push(symbol);
      }
    }
  }

  const weightsOfName = (name: string, seen: Set<string>): Map<string, number> => {
    const collected = new Map<string, number>();
    if (seen.has(name) || seen.size > 16) {
      return collected;
    }
    seen.add(name);
    const matches = byName.get(name) ?? [];
    if (matches.length !== 1) {
      return collected; // unknown or ambiguous
    }
    const [symbol] = matches;
    const merge = (token: string, weight: number): void => {
      collected.set(token, Math.max(collected.get(token) ?? 0, weight));
    };
    if (symbol.kind === 'NgModule') {
      for (const exported of symbol.exports ?? []) {
        for (const [token, weight] of weightsOfName(exported, seen)) {
          merge(token, weight);
        }
      }
    }
    for (const token of symbol.tokens) {
      merge(token, symbol.weights?.[token] ?? 1);
    }
    return collected;
  };

  for (const symbol of workspaceModules) {
    const weights = weightsOfName(symbol.className, new Set());
    if (weights.size === 0) {
      continue;
    }
    symbol.tokens = [...weights.keys()];
    symbol.weights = Object.fromEntries(weights);
    for (const token of symbol.tokens) {
      const list = byToken.get(token);
      if (!list) {
        byToken.set(token, [symbol]);
      } else if (!list.includes(symbol)) {
        list.push(symbol);
      }
    }
  }

  return {
    root: state.root,
    byToken,
    byName,
    templateUrlOwners,
    pathMappings: state.pathMappings ?? [],
    fileCount: state.files.size,
    libraryScanned: (state.librarySymbols?.length ?? 0) > 0,
  };
}

/**
 * Returns the (cached) index for a workspace folder, refreshing only what
 * changed since the previous call.
 */
export async function getAutoImportIndex(
  workspaceRoot: string,
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<AutoImportIndex> {
  const state = stateFor(workspaceRoot);

  if (state.building) {
    return state.building;
  }
  if (state.derived && state.dirty.size === 0 && state.dirtyDeletes === 0 && !state.stale) {
    return state.derived;
  }

  const build = (async (): Promise<AutoImportIndex> => {
    const started = Date.now();
    const wasBuilt = state.built;

    if (state.pathMappings === null) {
      state.pathMappings = loadPathMappings(state.root);
    }

    await refreshWorkspaceFiles(state, progress, token);
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    if (state.libraryStale || state.librarySymbols === null) {
      progress?.report({ message: 'reading Angular packages…' });
      try {
        state.librarySymbols = await buildLibrarySymbols(state.root, token);
      } catch (error) {
        state.librarySymbols = [];
        logDiagnostic(
          `Auto-import: could not scan node_modules (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      state.libraryStale = false;
    }
    if (token?.isCancellationRequested) {
      state.libraryStale = true;
      throw new vscode.CancellationError();
    }

    state.derived = deriveIndex(state);
    state.stale = false;
    state.dirtyDeletes = 0;
    if (!wasBuilt) {
      logDiagnostic(
        `Auto-import: indexed ${state.derived.fileCount} decorated file(s) and ` +
          `${state.librarySymbols?.length ?? 0} library symbol(s) in ${Date.now() - started}ms`,
      );
    }
    return state.derived;
  })();

  state.building = build;
  try {
    return await build;
  } finally {
    state.building = null;
  }
}

/**
 * Returns the last index built for a workspace folder without ever waiting for
 * one. Callers that must not block — the on-save participant, which has a
 * strict time budget — use this and skip the work that needs an index.
 *
 * The answer may be a step behind: saving a file marks it dirty, so insisting
 * on a perfectly fresh index would mean never having one on save. A refresh is
 * kicked off in the background instead, which the next call picks up.
 */
export function peekAutoImportIndex(workspaceRoot: string): AutoImportIndex | null {
  const state = states.get(normalizeFs(workspaceRoot));
  if (!state || !state.built || !state.derived) {
    return null;
  }
  if (state.dirty.size > 0 || state.dirtyDeletes > 0 || state.stale) {
    warmAutoImportIndex(workspaceRoot);
  }
  return state.derived;
}

/**
 * Builds the index ahead of time so the first invocation of the command is
 * instant. Failures are swallowed — this is a pure optimisation.
 */
export function warmAutoImportIndex(workspaceRoot: string): void {
  void getAutoImportIndex(workspaceRoot).catch((error: unknown) => {
    logDiagnostic(
      `Auto-import: warm-up failed (${error instanceof Error ? error.message : String(error)})`,
    );
  });
}

/** Drops every cached index and disposes the watchers. */
export function disposeAutoImportIndexes(): void {
  for (const state of states.values()) {
    for (const disposable of state.disposables) {
      disposable.dispose();
    }
  }
  states.clear();
}

// ── Coverage: what does an existing `imports: [...]` entry provide? ──────────

/** What an entry of an `imports: [...]` array provides. */
export interface EntryInfo {
  /** lowercased tokens the entry makes available to the template */
  tokens: string[];
  /** null when the tokens are known but the declaration kind is not */
  kind: SymbolKind | null;
}

/**
 * Resolves the template tokens an entry of an `imports: [...]` array provides.
 * Returns null when the entry cannot be resolved confidently.
 */
export function resolveEntryTokens(
  ownerFilePath: string,
  localName: string,
  moduleSpecifier: string | undefined,
  index: AutoImportIndex,
  depth = 0,
): string[] | null {
  return resolveEntryInfo(ownerFilePath, localName, moduleSpecifier, index, depth)?.tokens ?? null;
}

/**
 * Same as `resolveEntryTokens`, but also reports what kind of symbol the entry
 * is — the auto-clean feature treats NgModules more carefully than plain
 * declarations because a module may exist only for the providers it carries.
 */
export function resolveEntryInfo(
  ownerFilePath: string,
  localName: string,
  moduleSpecifier: string | undefined,
  index: AutoImportIndex,
  depth = 0,
): EntryInfo | null {
  if (depth > 4) {
    return null;
  }

  if (moduleSpecifier !== undefined) {
    const workspaceFile = resolveModuleToWorkspaceFile(
      ownerFilePath,
      moduleSpecifier,
      index.pathMappings,
    );
    if (workspaceFile !== null) {
      // Fast path: the index already knows every decorated class of that file
      const indexed = (index.byName.get(localName) ?? []).find(
        (symbol) =>
          symbol.origin === 'workspace' &&
          symbol.filePath &&
          normalizeFs(symbol.filePath) === normalizeFs(workspaceFile),
      );
      if (indexed) {
        const tokens = expandModuleTokens(indexed, index, depth);
        return tokens === null ? null : { tokens, kind: indexed.kind };
      }
      const tokens = resolveWorkspaceSymbolTokens(workspaceFile, localName, index, depth);
      return tokens === null ? null : { tokens, kind: null };
    }
  }

  // Bare specifier → library symbol
  const candidates = index.byName.get(localName) ?? [];
  const library = candidates.filter((symbol) => symbol.origin === 'library');
  if (library.length > 0) {
    const exact = moduleSpecifier
      ? library.find((symbol) => symbol.moduleSpecifier === moduleSpecifier)
      : undefined;
    const symbol = exact ?? library[0];
    return { tokens: symbol.tokens, kind: symbol.kind };
  }

  // Same-file declaration (self-referencing component, module in the same file)
  const local = candidates.find(
    (symbol) => symbol.filePath && normalizeFs(symbol.filePath) === normalizeFs(ownerFilePath),
  );
  if (local) {
    const tokens = expandModuleTokens(local, index, depth);
    return tokens === null ? null : { tokens, kind: local.kind };
  }

  return null;
}

/** Tokens of `exportedName` as declared in `filePath` (following NgModules). */
function resolveWorkspaceSymbolTokens(
  filePath: string,
  exportedName: string,
  index: AutoImportIndex,
  depth: number,
): string[] | null {
  const contents = readFileOrNull(filePath);
  if (contents === null) {
    return null;
  }
  const sourceFile = parseForIndex(filePath, contents);
  const entry = indexSourceFile(filePath, sourceFile);
  const symbol = entry.symbols.find((candidate) => candidate.className === exportedName);
  if (symbol) {
    return expandModuleTokens(symbol, index, depth, filePath, sourceFile);
  }

  // Barrel file: follow the re-export that provides the name
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) {
      continue;
    }
    const specifier = stringOf(statement.moduleSpecifier);
    if (specifier === null) {
      continue;
    }
    const named = statement.exportClause;
    let originalName: string | null = null;
    if (named && ts.isNamedExports(named)) {
      const element = named.elements.find((item) => item.name.text === exportedName);
      if (!element) {
        continue;
      }
      originalName = element.propertyName ? element.propertyName.text : element.name.text;
    } else if (!named) {
      originalName = exportedName; // export * from '...'
    }
    if (originalName === null) {
      continue;
    }
    const target = resolveModuleToWorkspaceFile(filePath, specifier, index.pathMappings);
    if (target !== null) {
      const tokens = resolveWorkspaceSymbolTokens(target, originalName, index, depth + 1);
      if (tokens !== null) {
        return tokens;
      }
    } else {
      const tokens = resolveEntryTokens(filePath, originalName, specifier, index, depth + 1);
      if (tokens !== null) {
        return tokens;
      }
    }
  }

  return null;
}

/** For an NgModule, unions the tokens of everything it exports. */
function expandModuleTokens(
  symbol: AutoImportSymbol,
  index: AutoImportIndex,
  depth: number,
  filePath?: string,
  sourceFile?: ts.SourceFile,
): string[] | null {
  if (symbol.kind !== 'NgModule') {
    return symbol.tokens;
  }
  const owner = filePath ?? symbol.filePath;
  if (!owner) {
    return symbol.tokens;
  }

  let bindings: Map<string, string>;
  if (sourceFile) {
    bindings = collectImportBindings(sourceFile);
  } else {
    const contents = readFileOrNull(owner);
    bindings = contents === null ? new Map() : collectImportBindings(parseForIndex(owner, contents));
  }

  const tokens = new Set<string>(symbol.tokens);
  for (const exported of symbol.exports ?? []) {
    const resolved = resolveEntryTokens(owner, exported, bindings.get(exported), index, depth + 1);
    if (resolved === null) {
      return null; // an unknown re-export makes the whole module unknown
    }
    for (const item of resolved) {
      tokens.add(item);
    }
  }
  return [...tokens];
}

/** local name → module specifier for every named value import in a file. */
export function collectImportBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
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
      bindings.set(element.name.text, statement.moduleSpecifier.text);
    }
  }
  return bindings;
}
