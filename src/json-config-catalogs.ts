/**
 * Static catalogs of well-known config options used by the tsconfig and
 * angular.json editors. Each entry describes how to render and type a value;
 * editors still surface any extra keys present in the file that aren't listed
 * here, so nothing is hidden.
 */

export type OptionType = 'boolean' | 'string' | 'enum' | 'number' | 'array' | 'readonly';

export interface OptionDef {
  key: string;
  type: OptionType;
  /** Allowed values for `enum` options. */
  enum?: string[];
  /** Short, one-line description shown under the option name. */
  doc?: string;
  /** Hint shown when the option is absent (e.g. the compiler default). */
  placeholder?: string;
}

// ── tsconfig.json ──────────────────────────────────────────────────────────────

const TS_COMPILER_OPTIONS: OptionDef[] = [
  { key: 'target', type: 'enum', enum: ['ES5', 'ES2015', 'ES2016', 'ES2017', 'ES2018', 'ES2019', 'ES2020', 'ES2021', 'ES2022', 'ES2023', 'ESNext'], doc: 'JS language version for emitted code.' },
  { key: 'module', type: 'enum', enum: ['CommonJS', 'ES2015', 'ES2020', 'ES2022', 'ESNext', 'Node16', 'NodeNext', 'Preserve'], doc: 'Module code generation.' },
  { key: 'moduleResolution', type: 'enum', enum: ['node', 'node10', 'node16', 'nodenext', 'bundler', 'classic'], doc: 'How modules are resolved.' },
  { key: 'lib', type: 'array', doc: 'Library declaration files to include.' },
  { key: 'strict', type: 'boolean', doc: 'Enable all strict type-checking options.' },
  { key: 'noImplicitAny', type: 'boolean', doc: 'Error on expressions with an implied "any" type.' },
  { key: 'strictNullChecks', type: 'boolean', doc: 'Account for null and undefined in type checking.' },
  { key: 'strictFunctionTypes', type: 'boolean', doc: 'Check function parameter types contravariantly.' },
  { key: 'strictBindCallApply', type: 'boolean', doc: 'Check bind/call/apply argument types.' },
  { key: 'strictPropertyInitialization', type: 'boolean', doc: 'Ensure class properties are initialized.' },
  { key: 'noImplicitThis', type: 'boolean', doc: 'Error on "this" with an implied "any" type.' },
  { key: 'alwaysStrict', type: 'boolean', doc: 'Emit "use strict" and parse in strict mode.' },
  { key: 'noUnusedLocals', type: 'boolean', doc: 'Report unused local variables.' },
  { key: 'noUnusedParameters', type: 'boolean', doc: 'Report unused function parameters.' },
  { key: 'noImplicitReturns', type: 'boolean', doc: 'Ensure all code paths return a value.' },
  { key: 'noFallthroughCasesInSwitch', type: 'boolean', doc: 'Report fallthrough cases in switch statements.' },
  { key: 'noImplicitOverride', type: 'boolean', doc: 'Require the "override" modifier on overrides.' },
  { key: 'noPropertyAccessFromIndexSignature', type: 'boolean', doc: 'Require indexed access for index signatures.' },
  { key: 'exactOptionalPropertyTypes', type: 'boolean', doc: 'Differentiate undefined from absent properties.' },
  { key: 'esModuleInterop', type: 'boolean', doc: 'Emit interop helpers for CommonJS modules.' },
  { key: 'allowSyntheticDefaultImports', type: 'boolean', doc: 'Allow default imports without a default export.' },
  { key: 'forceConsistentCasingInFileNames', type: 'boolean', doc: 'Disallow inconsistently-cased imports.' },
  { key: 'skipLibCheck', type: 'boolean', doc: 'Skip type checking of declaration files.' },
  { key: 'declaration', type: 'boolean', doc: 'Generate .d.ts declaration files.' },
  { key: 'declarationMap', type: 'boolean', doc: 'Generate source maps for declarations.' },
  { key: 'sourceMap', type: 'boolean', doc: 'Generate .map source map files.' },
  { key: 'experimentalDecorators', type: 'boolean', doc: 'Enable legacy decorator support.' },
  { key: 'emitDecoratorMetadata', type: 'boolean', doc: 'Emit design-type metadata for decorators.' },
  { key: 'useDefineForClassFields', type: 'boolean', doc: 'Emit class fields with "define" semantics.' },
  { key: 'importHelpers', type: 'boolean', doc: 'Import emit helpers from tslib.' },
  { key: 'downlevelIteration', type: 'boolean', doc: 'Emit compliant iteration for ES5/ES3.' },
  { key: 'resolveJsonModule', type: 'boolean', doc: 'Allow importing .json files.' },
  { key: 'isolatedModules', type: 'boolean', doc: 'Ensure each file can be transpiled alone.' },
  { key: 'allowJs', type: 'boolean', doc: 'Allow JavaScript files to be compiled.' },
  { key: 'checkJs', type: 'boolean', doc: 'Type-check JavaScript files.' },
  { key: 'outDir', type: 'string', doc: 'Output directory for emitted files.' },
  { key: 'rootDir', type: 'string', doc: 'Root directory of input files.' },
  { key: 'baseUrl', type: 'string', doc: 'Base directory for non-relative imports.' },
  { key: 'composite', type: 'boolean', doc: 'Enable project references.' },
  { key: 'incremental', type: 'boolean', doc: 'Save .tsbuildinfo for incremental builds.' },
  { key: 'removeComments', type: 'boolean', doc: 'Strip comments from emitted output.' },
  { key: 'skipDefaultLibCheck', type: 'boolean', doc: 'Skip checking the default library files.' },
];

const TS_ANGULAR_COMPILER_OPTIONS: OptionDef[] = [
  { key: 'strictTemplates', type: 'boolean', doc: 'Enable strict template type checking.' },
  { key: 'strictInjectionParameters', type: 'boolean', doc: 'Error on unresolvable injection parameters.' },
  { key: 'strictInputAccessModifiers', type: 'boolean', doc: 'Honor input access modifiers in templates.' },
  { key: 'strictStandalone', type: 'boolean', doc: 'Require components/directives to be standalone.' },
  { key: 'fullTemplateTypeCheck', type: 'boolean', doc: 'Legacy full template type checking.' },
  { key: 'preserveWhitespaces', type: 'boolean', doc: 'Preserve template whitespace.' },
  { key: 'enableI18nLegacyMessageIdFormat', type: 'boolean', doc: 'Use the legacy i18n message id format.' },
  { key: 'disableTypeScriptVersionCheck', type: 'boolean', doc: 'Skip the supported TS version check.' },
  { key: 'enableResourceInlining', type: 'boolean', doc: 'Inline templates and styles into the output.' },
  { key: 'compilationMode', type: 'enum', enum: ['full', 'partial'], doc: 'Library partial-Ivy vs full compilation.' },
];

export function getTsconfigCatalog(): {
  compilerOptions: OptionDef[];
  angularCompilerOptions: OptionDef[];
} {
  return {
    compilerOptions: TS_COMPILER_OPTIONS,
    angularCompilerOptions: TS_ANGULAR_COMPILER_OPTIONS,
  };
}

// ── angular.json ─────────────────────────────────────────────────────────────

const OUTPUT_HASHING: string[] = ['none', 'all', 'media', 'bundles'];

const BUILD_APPLICATION: OptionDef[] = [
  { key: 'outputPath', type: 'string', doc: 'Output directory for the build.' },
  { key: 'index', type: 'string', doc: 'HTML index entry point.' },
  { key: 'browser', type: 'string', doc: 'Main browser entry point (.ts).' },
  { key: 'server', type: 'string', doc: 'Server (SSR) entry point.' },
  { key: 'tsConfig', type: 'string', doc: 'tsconfig used for the build.' },
  { key: 'polyfills', type: 'array', doc: 'Polyfills to include.' },
  { key: 'assets', type: 'array', doc: 'Static assets to copy.' },
  { key: 'styles', type: 'array', doc: 'Global stylesheets.' },
  { key: 'scripts', type: 'array', doc: 'Global scripts.' },
  { key: 'optimization', type: 'boolean', doc: 'Enable build optimizations.' },
  { key: 'sourceMap', type: 'boolean', doc: 'Emit source maps.' },
  { key: 'aot', type: 'boolean', doc: 'Ahead-of-time compilation.' },
  { key: 'extractLicenses', type: 'boolean', doc: 'Extract licenses into a file.' },
  { key: 'namedChunks', type: 'boolean', doc: 'Use readable chunk names.' },
  { key: 'prerender', type: 'boolean', doc: 'Prerender routes at build time.' },
  { key: 'ssr', type: 'boolean', doc: 'Enable server-side rendering output.' },
  { key: 'outputHashing', type: 'enum', enum: OUTPUT_HASHING, doc: 'Add hashes to output file names.' },
  { key: 'baseHref', type: 'string', doc: 'Base href for the app.' },
];

const BUILD_BROWSER: OptionDef[] = [
  { key: 'outputPath', type: 'string', doc: 'Output directory for the build.' },
  { key: 'index', type: 'string', doc: 'HTML index entry point.' },
  { key: 'main', type: 'string', doc: 'Main entry point (.ts).' },
  { key: 'polyfills', type: 'string', doc: 'Polyfills entry point.' },
  { key: 'tsConfig', type: 'string', doc: 'tsconfig used for the build.' },
  { key: 'assets', type: 'array', doc: 'Static assets to copy.' },
  { key: 'styles', type: 'array', doc: 'Global stylesheets.' },
  { key: 'scripts', type: 'array', doc: 'Global scripts.' },
  { key: 'optimization', type: 'boolean', doc: 'Enable build optimizations.' },
  { key: 'sourceMap', type: 'boolean', doc: 'Emit source maps.' },
  { key: 'aot', type: 'boolean', doc: 'Ahead-of-time compilation.' },
  { key: 'extractLicenses', type: 'boolean', doc: 'Extract licenses into a file.' },
  { key: 'namedChunks', type: 'boolean', doc: 'Use readable chunk names.' },
  { key: 'vendorChunk', type: 'boolean', doc: 'Emit a separate vendor chunk.' },
  { key: 'buildOptimizer', type: 'boolean', doc: 'Enable the Angular build optimizer.' },
  { key: 'outputHashing', type: 'enum', enum: OUTPUT_HASHING, doc: 'Add hashes to output file names.' },
  { key: 'baseHref', type: 'string', doc: 'Base href for the app.' },
];

const TEST_OPTIONS: OptionDef[] = [
  { key: 'tsConfig', type: 'string', doc: 'tsconfig used for tests.' },
  { key: 'polyfills', type: 'array', doc: 'Polyfills to include.' },
  { key: 'karmaConfig', type: 'string', doc: 'Karma configuration file.' },
  { key: 'codeCoverage', type: 'boolean', doc: 'Collect code coverage.' },
  { key: 'watch', type: 'boolean', doc: 'Run tests in watch mode.' },
  { key: 'browsers', type: 'string', doc: 'Browsers to run tests in.' },
  { key: 'assets', type: 'array', doc: 'Static assets to copy.' },
  { key: 'styles', type: 'array', doc: 'Global stylesheets.' },
  { key: 'scripts', type: 'array', doc: 'Global scripts.' },
];

const LINT_OPTIONS: OptionDef[] = [
  { key: 'lintFilePatterns', type: 'array', doc: 'Glob patterns of files to lint.' },
  { key: 'eslintConfig', type: 'string', doc: 'Path to the ESLint config.' },
];

/**
 * Returns the curated option catalog for an architect target, choosing the
 * build variant from the builder string (preferred) or the Angular major
 * version. The `serve` target's build-link key name also changed across
 * versions (`browserTarget` → `buildTarget`).
 */
export function getAngularTargetCatalog(
  target: string,
  builder: string | undefined,
  majorVersion: number | null,
): OptionDef[] {
  switch (target) {
    case 'build':
      return usesApplicationBuilder(builder, majorVersion) ? BUILD_APPLICATION : BUILD_BROWSER;
    case 'serve':
      return [
        { key: 'port', type: 'number', doc: 'Dev server port.' },
        { key: 'host', type: 'string', doc: 'Dev server host.' },
        { key: 'proxyConfig', type: 'string', doc: 'Proxy configuration file.' },
        { key: 'ssl', type: 'boolean', doc: 'Serve over HTTPS.' },
        { key: 'open', type: 'boolean', doc: 'Open the browser on serve.' },
        usesBuildTargetKey(majorVersion)
          ? { key: 'buildTarget', type: 'string', doc: 'Build target to serve.' }
          : { key: 'browserTarget', type: 'string', doc: 'Browser target to serve.' },
      ];
    case 'test':
      return TEST_OPTIONS;
    case 'lint':
      return LINT_OPTIONS;
    default:
      return [];
  }
}

/** v17+ defaults to the esbuild `application` builder. */
function usesApplicationBuilder(builder: string | undefined, majorVersion: number | null): boolean {
  if (builder) {
    if (builder.includes(':application')) {
      return true;
    }
    if (builder.includes(':browser')) {
      return false;
    }
  }
  return majorVersion === null || majorVersion >= 17;
}

/** `browserTarget` was renamed to `buildTarget` in CLI 16. */
function usesBuildTargetKey(majorVersion: number | null): boolean {
  return majorVersion === null || majorVersion >= 16;
}
