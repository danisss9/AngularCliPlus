import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  semverSatisfies,
  validateCustomCommand,
  toKebabCase,
  buildNgGenerateCommand,
  isValidSchematicName,
  SCHEMATIC_NAME_REGEX,
  parseNgUpdateOutput,
  parseNgVersionOutput,
  findMatchingProjects,
  findBestProjectForPath,
  parseComponentFilePath,
  getComponentSiblingPaths,
} from '../pure-utils';
import {
  getBuildConfigFlag,
  getProductionFlag,
  supportsStandalone,
  isStandaloneDefault,
  resolveOutputPathStrategy,
  supportsTestUiFlag,
} from '../version-adapter';
import type { AngularProject } from '../types';
import * as ts from 'typescript';
import {
  collectTemplateCandidates,
  extractSelectorTokens,
  extractSelectorTokenWeights,
  parseDtsModule,
} from '../auto-imports-scan';
import { buildEditsForSelection, cleanupSuggestions } from '../auto-imports';
import type { ImportOption } from '../auto-imports';
import {
  applySpans,
  countReferences,
  parseDecoratedOwners,
  planImportStatements,
  planImportsArray,
} from '../import-edits';
import { buildCleanupSpans, computeCleanupEdits, computeCleanupPlan } from '../clean-imports';
import * as vscode from 'vscode';
import type { AutoImportIndex, AutoImportSymbol } from '../auto-imports-index';

// ── semverSatisfies ───────────────────────────────────────────────────────────

suite('semverSatisfies', () => {
  // Wildcards / pass-through
  test('* range always passes', () => assert.strictEqual(semverSatisfies('1.2.3', '*'), true));
  test('empty range always passes', () => assert.strictEqual(semverSatisfies('1.2.3', ''), true));
  test('"latest" always passes', () =>
    assert.strictEqual(semverSatisfies('1.2.3', 'latest'), true));
  test('whitespace-only range treated as empty', () =>
    assert.strictEqual(semverSatisfies('1.2.3', '   '), true));

  // Non-semver specifiers
  test('git+https: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'git+https://github.com/foo/bar'), true));
  test('file: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'file:../local-pkg'), true));
  test('workspace: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'workspace:^'), true));
  test('https: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'https://example.com/pkg.tgz'), true));
  test('github: specifier passes', () =>
    assert.strictEqual(semverSatisfies('1.0.0', 'github:owner/repo'), true));

  // Caret (^)
  test('^ patch upgrade satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.5', '^1.2.3'), true));
  test('^ minor upgrade satisfies', () =>
    assert.strictEqual(semverSatisfies('1.3.0', '^1.2.3'), true));
  test('^ exact match satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.3', '^1.2.3'), true));
  test('^ major bump fails', () => assert.strictEqual(semverSatisfies('2.0.0', '^1.2.3'), false));
  test('^ older patch fails', () => assert.strictEqual(semverSatisfies('1.2.2', '^1.2.3'), false));
  test('^ zero major: same minor required', () =>
    assert.strictEqual(semverSatisfies('0.2.5', '^0.2.3'), true));
  test('^ zero major: different minor fails', () =>
    assert.strictEqual(semverSatisfies('0.3.0', '^0.2.3'), false));

  // Tilde (~)
  test('~ patch upgrade satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.5', '~1.2.3'), true));
  test('~ exact match satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.3', '~1.2.3'), true));
  test('~ minor bump fails', () => assert.strictEqual(semverSatisfies('1.3.0', '~1.2.3'), false));
  test('~ older patch fails', () => assert.strictEqual(semverSatisfies('1.2.2', '~1.2.3'), false));

  // >= and >
  test('>= equal satisfies', () => assert.strictEqual(semverSatisfies('1.2.3', '>=1.2.3'), true));
  test('>= greater satisfies', () => assert.strictEqual(semverSatisfies('2.0.0', '>=1.2.3'), true));
  test('>= lesser fails', () => assert.strictEqual(semverSatisfies('1.0.0', '>=1.2.3'), false));
  test('> strictly greater satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.4', '>1.2.3'), true));
  test('> equal fails', () => assert.strictEqual(semverSatisfies('1.2.3', '>1.2.3'), false));

  // <= and <
  test('<= equal satisfies', () => assert.strictEqual(semverSatisfies('1.2.3', '<=1.2.3'), true));
  test('<= lesser satisfies', () => assert.strictEqual(semverSatisfies('1.0.0', '<=1.2.3'), true));
  test('<= greater fails', () => assert.strictEqual(semverSatisfies('2.0.0', '<=1.2.3'), false));
  test('< strictly lesser satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.2', '<1.2.3'), true));
  test('< equal fails', () => assert.strictEqual(semverSatisfies('1.2.3', '<1.2.3'), false));

  // Exact
  test('exact match passes', () => assert.strictEqual(semverSatisfies('1.2.3', '1.2.3'), true));
  test('exact mismatch fails', () => assert.strictEqual(semverSatisfies('1.2.4', '1.2.3'), false));
  test('exact with = prefix passes', () =>
    assert.strictEqual(semverSatisfies('1.2.3', '=1.2.3'), true));

  // Hyphen range
  test('hyphen range — value inside satisfies', () =>
    assert.strictEqual(semverSatisfies('1.5.0', '1.0.0 - 2.0.0'), true));
  test('hyphen range — lower bound satisfies', () =>
    assert.strictEqual(semverSatisfies('1.0.0', '1.0.0 - 2.0.0'), true));
  test('hyphen range — upper bound satisfies', () =>
    assert.strictEqual(semverSatisfies('2.0.0', '1.0.0 - 2.0.0'), true));
  test('hyphen range — outside fails', () =>
    assert.strictEqual(semverSatisfies('3.0.0', '1.0.0 - 2.0.0'), false));

  // OR range (||)
  test('|| range — first alternative satisfies', () =>
    assert.strictEqual(semverSatisfies('1.2.3', '^1.0.0 || ^2.0.0'), true));
  test('|| range — second alternative satisfies', () =>
    assert.strictEqual(semverSatisfies('2.5.0', '^1.0.0 || ^2.0.0'), true));
  test('|| range — neither alternative fails', () =>
    assert.strictEqual(semverSatisfies('3.0.0', '^1.0.0 || ^2.0.0'), false));

  // Pre-release versions — metadata is preserved (matches npm resolution)
  test('pre-release installed against non-pre-release range fails', () =>
    assert.strictEqual(semverSatisfies('1.0.0-beta', '^1.0.0'), false));
  test('pre-release installed below range fails', () =>
    assert.strictEqual(semverSatisfies('0.9.0-rc1', '^1.0.0'), false));
  test('pre-release installed satisfying matching pre-release range passes', () =>
    assert.strictEqual(semverSatisfies('18.1.0-rc.0', '^18.1.0-rc.0'), true));
  test('pre-release installed satisfying same major pre-release range passes', () =>
    assert.strictEqual(semverSatisfies('18.1.0-rc.2', '^18.1.0-rc.0'), true));
  test('placeholder version against release range fails', () =>
    assert.strictEqual(semverSatisfies('0.0.0-replace-foo', '^1.0.0'), false));

  // v-prefix
  test('v-prefixed version satisfies range', () =>
    assert.strictEqual(semverSatisfies('v14.21.0', '>=14'), true));
  test('v-prefixed version fails range', () =>
    assert.strictEqual(semverSatisfies('v12.0.0', '>=14'), false));
  test('v-prefixed version satisfies caret', () =>
    assert.strictEqual(semverSatisfies('v18.19.0', '^18.0.0'), true));

  // Unparseable / garbage versions
  test('completely unparseable installed version returns true (safe default)', () =>
    assert.strictEqual(semverSatisfies('not-a-version', '^1.0.0'), true));
});

// ── validateCustomCommand ─────────────────────────────────────────────────────

suite('validateCustomCommand', () => {
  // Valid commands
  test('npm install is valid', () =>
    assert.strictEqual(validateCustomCommand('npm install'), null));
  test('pnpm install is valid', () =>
    assert.strictEqual(validateCustomCommand('pnpm install'), null));
  test('yarn --frozen-lockfile is valid', () =>
    assert.strictEqual(validateCustomCommand('yarn install --frozen-lockfile'), null));
  test('bun install is valid', () =>
    assert.strictEqual(validateCustomCommand('bun install'), null));
  test('npm ci is valid', () => assert.strictEqual(validateCustomCommand('npm ci'), null));
  test('command with flags is valid', () =>
    assert.strictEqual(validateCustomCommand('npm install --prefer-offline'), null));

  // Empty / whitespace
  test('empty string is invalid', () => assert.notStrictEqual(validateCustomCommand(''), null));
  test('whitespace-only is invalid', () =>
    assert.notStrictEqual(validateCustomCommand('   '), null));

  // Dangerous injection patterns
  test('; rm injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install; rm -rf /'), null));
  test('; del injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install; del /F /S /Q C:\\'), null));
  test('; format injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install; format C:'), null));
  test('; mkfs injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install; mkfs.ext4 /dev/sda'), null));
  test('; dd injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install; dd if=/dev/zero of=/dev/sda'), null));
  test('uppercase RM is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install; RM -rf /'), null));
  test('$() shell substitution is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install $(echo malicious)'), null));
  test('backtick shell substitution is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install `echo malicious`'), null));
  test('&& rm injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install && rm -rf /'), null));
  test('| rm injection is blocked', () =>
    assert.notStrictEqual(validateCustomCommand('npm install | rm -rf /'), null));

  // Must NOT be over-blocked
  test('"remove" word (not rm) is allowed', () =>
    assert.strictEqual(validateCustomCommand('npm remove lodash'), null));
  test('"install" containing "dd" is allowed', () =>
    assert.strictEqual(validateCustomCommand('npm add lodash'), null));
  test('path containing "del" in name is allowed', () =>
    assert.strictEqual(validateCustomCommand('npm run delete-cache'), null));

  // Return type is a non-empty string when invalid
  test('error message is a non-empty string', () => {
    const result = validateCustomCommand('');
    assert.ok(typeof result === 'string' && result.length > 0);
  });
});

// ── toKebabCase ───────────────────────────────────────────────────────────────

suite('toKebabCase', () => {
  test('camelCase → kebab-case', () => assert.strictEqual(toKebabCase('skipTests'), 'skip-tests'));
  test('two words', () => assert.strictEqual(toKebabCase('inlineTemplate'), 'inline-template'));
  test('three words', () =>
    assert.strictEqual(toKebabCase('changeDetectionStrategy'), 'change-detection-strategy'));
  test('already kebab unchanged', () =>
    assert.strictEqual(toKebabCase('skip-tests'), 'skip-tests'));
  test('all lowercase unchanged', () =>
    assert.strictEqual(toKebabCase('standalone'), 'standalone'));
  test('single word unchanged', () => assert.strictEqual(toKebabCase('flat'), 'flat'));
  test('number before capital', () =>
    assert.strictEqual(toKebabCase('form2Builder'), 'form2-builder'));
  test('output is always lowercase', () => {
    const result = toKebabCase('changeDetection');
    assert.strictEqual(result, result.toLowerCase());
  });
});

// ── isValidSchematicName ──────────────────────────────────────────────────────

suite('isValidSchematicName', () => {
  // Valid
  test('simple hyphenated name', () =>
    assert.strictEqual(isValidSchematicName('my-component'), true));
  test('name ending in number', () => assert.strictEqual(isValidSchematicName('form2'), true));
  test('single letter', () => assert.strictEqual(isValidSchematicName('a'), true));
  test('all lowercase letters', () =>
    assert.strictEqual(isValidSchematicName('userprofile'), true));
  test('SCHEMATIC_NAME_REGEX test', () => assert.ok(SCHEMATIC_NAME_REGEX.test('user-profile')));

  // Invalid
  test('uppercase start', () => assert.strictEqual(isValidSchematicName('MyComponent'), false));
  test('digit start', () => assert.strictEqual(isValidSchematicName('1component'), false));
  test('empty string', () => assert.strictEqual(isValidSchematicName(''), false));
  test('underscore', () => assert.strictEqual(isValidSchematicName('my_component'), false));
  test('space', () => assert.strictEqual(isValidSchematicName('my component'), false));
  test('dot', () => assert.strictEqual(isValidSchematicName('my.component'), false));
  test('slash', () => assert.strictEqual(isValidSchematicName('my/component'), false));
});

// ── buildNgGenerateCommand ────────────────────────────────────────────────────

suite('buildNgGenerateCommand', () => {
  test('no options → minimal command', () =>
    assert.strictEqual(buildNgGenerateCommand('component', {}), 'ng generate component'));
  test('boolean true → bare flag', () => {
    const cmd = buildNgGenerateCommand('component', { standalone: true });
    assert.ok(cmd.includes('--standalone'));
    assert.ok(!cmd.includes('--standalone='));
  });
  test('boolean false → flag=false', () =>
    assert.ok(
      buildNgGenerateCommand('component', { skipTests: false }).includes('--skip-tests=false'),
    ));
  test('string value → flag=value', () =>
    assert.ok(buildNgGenerateCommand('component', { style: 'scss' }).includes('--style=scss')));
  test('camelCase key → kebab-case flag', () =>
    assert.ok(
      buildNgGenerateCommand('component', { changeDetection: 'OnPush' }).includes(
        '--change-detection=OnPush',
      ),
    ));
  test('project option included', () => {
    const cmd = buildNgGenerateCommand('service', { project: 'my-app', flat: true });
    assert.ok(cmd.includes('--project=my-app'));
    assert.ok(cmd.includes('--flat'));
  });
  test('multiple options all appear', () => {
    const cmd = buildNgGenerateCommand('component', {
      standalone: true,
      skipTests: false,
      style: 'scss',
    });
    assert.ok(cmd.includes('--standalone'));
    assert.ok(cmd.includes('--skip-tests=false'));
    assert.ok(cmd.includes('--style=scss'));
  });
  test('starts with ng generate <type> for all schematic types', () => {
    const types = [
      'component',
      'service',
      'module',
      'directive',
      'pipe',
      'guard',
      'interceptor',
      'class',
      'interface',
      'enum',
      'resolver',
    ] as const;
    for (const t of types) {
      assert.ok(buildNgGenerateCommand(t, {}).startsWith(`ng generate ${t}`), `Failed for: ${t}`);
    }
  });
  test('does not append the schematic name itself', () => {
    // The caller is responsible for appending the name
    const cmd = buildNgGenerateCommand('component', {});
    assert.strictEqual(cmd, 'ng generate component');
  });
  test('string value with spaces is quoted', () => {
    const cmd = buildNgGenerateCommand('component', { style: 'my value' });
    assert.ok(cmd.includes('--style="my value"'));
  });
  test('string value without special chars is unquoted', () => {
    const cmd = buildNgGenerateCommand('component', { style: 'scss' });
    assert.ok(cmd.includes('--style=scss'));
    assert.ok(!cmd.includes('"'));
  });
});

// ── parseNgUpdateOutput ───────────────────────────────────────────────────────

suite('parseNgUpdateOutput', () => {
  test('empty string returns empty array', () => {
    assert.deepStrictEqual(parseNgUpdateOutput(''), []);
  });
  test('whitespace-only string returns empty array', () => {
    assert.deepStrictEqual(parseNgUpdateOutput('   \n  \n'), []);
  });
  test('parses a single package line', () => {
    const output = '@angular/core                      17.0.0 -> 18.0.0';
    const result = parseNgUpdateOutput(output);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, '@angular/core');
    assert.strictEqual(result[0].versions, '17.0.0 -> 18.0.0');
  });
  test('parses multiple package lines', () => {
    const output = [
      '@angular/core         17.0.0 -> 18.0.0',
      '@angular/cli          17.0.0 -> 18.0.0',
      'rxjs                   7.5.0 ->  7.8.0',
    ].join('\n');
    const result = parseNgUpdateOutput(output);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].name, '@angular/core');
    assert.strictEqual(result[1].name, '@angular/cli');
    assert.strictEqual(result[2].name, 'rxjs');
  });
  test('strips ANSI escape codes', () => {
    const output = '\x1b[32m@angular/core\x1b[0m         17.0.0 -> 18.0.0';
    const result = parseNgUpdateOutput(output);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, '@angular/core');
  });
  test('ignores header/footer lines without version arrows', () => {
    const output = [
      '    We analyzed your package.json, there are some packages to update:',
      '',
      '@angular/core         17.0.0 -> 18.0.0',
      '',
      '    There might be additional packages...',
    ].join('\n');
    const result = parseNgUpdateOutput(output);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, '@angular/core');
  });
  test('normalises extra spaces in version string', () => {
    const output = '@angular/core    17.0.0  ->  18.0.0';
    const result = parseNgUpdateOutput(output);
    assert.strictEqual(result[0].versions, '17.0.0 -> 18.0.0');
  });
  test('handles scoped package names', () => {
    const output = '@angular/material   17.0.0 -> 18.0.0';
    const result = parseNgUpdateOutput(output);
    assert.strictEqual(result[0].name, '@angular/material');
  });
  test('handles unscoped package names', () => {
    const output = 'typescript   5.3.0 -> 5.4.0';
    const result = parseNgUpdateOutput(output);
    assert.strictEqual(result[0].name, 'typescript');
  });
  test('all-ANSI output with no packages returns empty array', () => {
    const output = '\x1b[1m\x1b[32mAll packages up to date.\x1b[0m';
    assert.deepStrictEqual(parseNgUpdateOutput(output), []);
  });
});

// ── findMatchingProjects ──────────────────────────────────────────────────────

// Use forward-slash paths and normalise to the OS separator for cross-platform tests
const SEP = path.sep;
const W = (p: string) => p.split('/').join(SEP); // workspace-root helper

suite('findMatchingProjects', () => {
  const workspaceRoot = W('/workspace');

  const projects: { [name: string]: AngularProject } = {
    app: { root: 'projects/app', sourceRoot: 'projects/app/src' },
    lib: { root: 'projects/lib', sourceRoot: 'projects/lib/src' },
    'root-app': { root: '', sourceRoot: 'src' },
  };

  test('folder inside app/src matches app', () => {
    const matches = findMatchingProjects(
      W('/workspace/projects/app/src/components'),
      workspaceRoot,
      projects,
    );
    assert.ok(matches.includes('app'));
  });
  test('folder inside lib/src matches lib', () => {
    const matches = findMatchingProjects(
      W('/workspace/projects/lib/src/utils'),
      workspaceRoot,
      projects,
    );
    assert.ok(matches.includes('lib'));
  });
  test('folder outside any project returns empty array', () => {
    const matches = findMatchingProjects(W('/workspace/e2e'), workspaceRoot, projects);
    assert.strictEqual(matches.length, 0);
  });
  test('workspace src folder matches root-app', () => {
    const matches = findMatchingProjects(W('/workspace/src/app'), workspaceRoot, projects);
    assert.ok(matches.includes('root-app'));
  });
  test('folder matching both root and sourceRoot returns project once', () => {
    const matches = findMatchingProjects(
      W('/workspace/projects/app/src/components'),
      workspaceRoot,
      projects,
    );
    const count = matches.filter((n) => n === 'app').length;
    assert.strictEqual(count, 1);
  });
  test('project root folder itself matches', () => {
    const matches = findMatchingProjects(W('/workspace/projects/app'), workspaceRoot, projects);
    assert.ok(matches.includes('app'));
  });
  test('empty projects map returns empty array', () => {
    const matches = findMatchingProjects(W('/workspace/projects/app/src'), workspaceRoot, {});
    assert.deepStrictEqual(matches, []);
  });
  test('project with absolute root path is handled', () => {
    const absProjects: { [name: string]: AngularProject } = {
      'abs-app': { root: W('/workspace/projects/abs-app') },
    };
    const matches = findMatchingProjects(
      W('/workspace/projects/abs-app/src'),
      workspaceRoot,
      absProjects,
    );
    assert.ok(matches.includes('abs-app'));
  });
});

// ── findBestProjectForPath ────────────────────────────────────────────────────

suite('findBestProjectForPath', () => {
  const workspaceRoot = W('/workspace');

  const projects: { [name: string]: AngularProject } = {
    app: { root: 'projects/app', sourceRoot: 'projects/app/src' },
    lib: { root: 'projects/lib', sourceRoot: 'projects/lib/src' },
    'root-app': { root: '', sourceRoot: 'src' },
  };

  test('file inside app/src → app', () => {
    const result = findBestProjectForPath(
      W('/workspace/projects/app/src/app/app.component.ts'),
      workspaceRoot,
      projects,
    );
    assert.strictEqual(result, 'app');
  });
  test('file inside lib/src → lib', () => {
    const result = findBestProjectForPath(
      W('/workspace/projects/lib/src/lib/lib.ts'),
      workspaceRoot,
      projects,
    );
    assert.strictEqual(result, 'lib');
  });
  test('file in workspace src → root-app', () => {
    const result = findBestProjectForPath(W('/workspace/src/main.ts'), workspaceRoot, projects);
    assert.strictEqual(result, 'root-app');
  });
  test('file outside any project → null', () => {
    const result = findBestProjectForPath(W('/workspace/e2e/app.e2e.ts'), workspaceRoot, projects);
    assert.strictEqual(result, null);
  });
  test('prefers longer (more specific) root over shorter root', () => {
    // sourceRoot 'projects/app/src' is longer than root 'projects/app'
    // Both match a file in projects/app/src — sourceRoot should win (longer = more specific)
    const result = findBestProjectForPath(
      W('/workspace/projects/app/src/app.ts'),
      workspaceRoot,
      projects,
    );
    assert.strictEqual(result, 'app');
  });
  test('empty projects map → null', () => {
    const result = findBestProjectForPath(W('/workspace/src/main.ts'), workspaceRoot, {});
    assert.strictEqual(result, null);
  });
  test('nested project wins over parent project', () => {
    const nested: { [name: string]: AngularProject } = {
      parent: { root: 'packages' },
      child: { root: 'packages/child' },
    };
    const result = findBestProjectForPath(
      W('/workspace/packages/child/src/main.ts'),
      workspaceRoot,
      nested,
    );
    assert.strictEqual(result, 'child');
  });
});

// ── parseComponentFilePath ────────────────────────────────────────────────────

suite('parseComponentFilePath', () => {
  test('.component.ts is recognised', () => {
    const result = parseComponentFilePath('/app/src/hero/hero.component.ts');
    assert.ok(result);
    assert.strictEqual(result.basePath, '/app/src/hero/hero');
    assert.strictEqual(result.suffix, '.component.ts');
  });
  test('.component.html is recognised', () => {
    const result = parseComponentFilePath('/app/hero.component.html');
    assert.ok(result);
    assert.strictEqual(result.basePath, '/app/hero');
    assert.strictEqual(result.suffix, '.component.html');
  });
  test('.component.scss is recognised', () => {
    const result = parseComponentFilePath('/app/hero.component.scss');
    assert.ok(result);
    assert.strictEqual(result.suffix, '.component.scss');
  });
  test('.component.css is recognised', () => {
    const result = parseComponentFilePath('/app/hero.component.css');
    assert.ok(result);
    assert.strictEqual(result.suffix, '.component.css');
  });
  test('.component.sass is recognised', () => {
    const result = parseComponentFilePath('/app/hero.component.sass');
    assert.ok(result);
    assert.strictEqual(result.suffix, '.component.sass');
  });
  test('.component.less is recognised', () => {
    const result = parseComponentFilePath('/app/hero.component.less');
    assert.ok(result);
    assert.strictEqual(result.suffix, '.component.less');
  });
  test('.component.spec.ts is recognised (not confused with .component.ts)', () => {
    const result = parseComponentFilePath('/app/hero.component.spec.ts');
    assert.ok(result);
    assert.strictEqual(result.basePath, '/app/hero');
    assert.strictEqual(result.suffix, '.component.spec.ts');
  });
  test('non-component .ts file returns null', () => {
    assert.strictEqual(parseComponentFilePath('/app/hero.service.ts'), null);
  });
  test('plain .ts file returns null', () => {
    assert.strictEqual(parseComponentFilePath('/app/main.ts'), null);
  });
  test('empty string returns null', () => {
    assert.strictEqual(parseComponentFilePath(''), null);
  });
  test('case-insensitive matching (Windows paths)', () => {
    const result = parseComponentFilePath('C:\\App\\Hero.Component.TS');
    assert.ok(result);
    assert.strictEqual(result.suffix, '.component.ts');
    assert.strictEqual(result.basePath, 'C:\\App\\Hero');
  });
});

// ── getComponentSiblingPaths ──────────────────────────────────────────────────

suite('getComponentSiblingPaths', () => {
  test('returns all known suffixes', () => {
    const paths = getComponentSiblingPaths('/app/hero');
    assert.strictEqual(paths.length, 7);
    assert.ok(paths.includes('/app/hero.component.ts'));
    assert.ok(paths.includes('/app/hero.component.html'));
    assert.ok(paths.includes('/app/hero.component.css'));
    assert.ok(paths.includes('/app/hero.component.scss'));
    assert.ok(paths.includes('/app/hero.component.sass'));
    assert.ok(paths.includes('/app/hero.component.less'));
    assert.ok(paths.includes('/app/hero.component.spec.ts'));
  });
  test('preserves basePath exactly', () => {
    const paths = getComponentSiblingPaths('C:\\Users\\test\\hero');
    assert.ok(paths.every((p) => p.startsWith('C:\\Users\\test\\hero.component.')));
  });
});

// ── parseNgVersionOutput ──────────────────────────────────────────────────────

suite('parseNgVersionOutput', () => {
  test('parses standard ng version output (CLI 17)', () => {
    const output = [
      '',
      '     _                      _                 ____ _     ___',
      '    / \\   _ __   __ _ _   _| | __ _ _ __     / ___| |   |_ _|',
      "   / △ \\ | '_ \\ / _` | | | | |/ _` | '__|   | |   | |    | |",
      '  / ___ \\| | | | (_| | |_| | | (_| | |      | |___| |___ | |',
      ' /_/   \\_\\_| |_|\\__, |\\__,_|_|\\__,_|_|       \\____|_____|___|',
      '                |___/',
      '',
      'Angular CLI: 17.3.8',
      'Node: 20.11.1',
      'Package Manager: npm 10.2.4',
    ].join('\n');
    assert.strictEqual(parseNgVersionOutput(output), 17);
  });

  test('parses CLI 8 output', () => {
    const output = 'Angular CLI: 8.3.29\nNode: 12.22.12';
    assert.strictEqual(parseNgVersionOutput(output), 8);
  });

  test('parses CLI 12 output', () => {
    const output = 'Angular CLI: 12.2.18\nNode: 14.20.0';
    assert.strictEqual(parseNgVersionOutput(output), 12);
  });

  test('parses CLI 14 output', () => {
    const output = 'Angular CLI: 14.2.13\nNode: 16.20.2';
    assert.strictEqual(parseNgVersionOutput(output), 14);
  });

  test('parses CLI 19 output', () => {
    const output = 'Angular CLI: 19.0.0\nNode: 22.0.0';
    assert.strictEqual(parseNgVersionOutput(output), 19);
  });

  test('strips ANSI codes before parsing', () => {
    const output = '\x1b[32mAngular CLI: 17.1.0\x1b[0m\nNode: 20.0.0';
    assert.strictEqual(parseNgVersionOutput(output), 17);
  });

  test('returns null for empty string', () => {
    assert.strictEqual(parseNgVersionOutput(''), null);
  });

  test('returns null for unrelated output', () => {
    assert.strictEqual(parseNgVersionOutput('command not found: ng'), null);
  });

  test('returns null for output without version line', () => {
    const output = 'Node: 20.11.1\nPackage Manager: npm 10.2.4';
    assert.strictEqual(parseNgVersionOutput(output), null);
  });
});

// ── getProductionFlag ─────────────────────────────────────────────────────────

suite('getProductionFlag', () => {
  test('CLI 8 → --prod', () => assert.strictEqual(getProductionFlag(8), ' --prod'));
  test('CLI 11 → --prod', () => assert.strictEqual(getProductionFlag(11), ' --prod'));
  test('CLI 12 → --configuration=production', () =>
    assert.strictEqual(getProductionFlag(12), ' --configuration=production'));
  test('CLI 17 → --configuration=production', () =>
    assert.strictEqual(getProductionFlag(17), ' --configuration=production'));
  test('null (unknown) → --configuration=production', () =>
    assert.strictEqual(getProductionFlag(null), ' --configuration=production'));
});

// ── getBuildConfigFlag ────────────────────────────────────────────────────────

suite('getBuildConfigFlag', () => {
  test('default config → empty string regardless of version', () => {
    assert.strictEqual(getBuildConfigFlag('default', 8), '');
    assert.strictEqual(getBuildConfigFlag('default', 17), '');
    assert.strictEqual(getBuildConfigFlag('default', null), '');
  });

  test('production on CLI 8 → --prod', () =>
    assert.strictEqual(getBuildConfigFlag('production', 8), ' --prod'));
  test('production on CLI 11 → --prod', () =>
    assert.strictEqual(getBuildConfigFlag('production', 11), ' --prod'));
  test('production on CLI 12 → --configuration=production', () =>
    assert.strictEqual(getBuildConfigFlag('production', 12), ' --configuration=production'));
  test('production on CLI 17 → --configuration=production', () =>
    assert.strictEqual(getBuildConfigFlag('production', 17), ' --configuration=production'));
  test('production on null → --configuration=production', () =>
    assert.strictEqual(getBuildConfigFlag('production', null), ' --configuration=production'));

  test('development on CLI 8 → --configuration=development', () =>
    assert.strictEqual(getBuildConfigFlag('development', 8), ' --configuration=development'));
  test('development on CLI 17 → --configuration=development', () =>
    assert.strictEqual(getBuildConfigFlag('development', 17), ' --configuration=development'));

  test('custom config name on any version', () =>
    assert.strictEqual(getBuildConfigFlag('staging', 14), ' --configuration=staging'));
});

// ── supportsStandalone ────────────────────────────────────────────────────────

suite('supportsStandalone', () => {
  test('CLI 8 → false', () => assert.strictEqual(supportsStandalone(8), false));
  test('CLI 13 → false', () => assert.strictEqual(supportsStandalone(13), false));
  test('CLI 14 → true', () => assert.strictEqual(supportsStandalone(14), true));
  test('CLI 17 → true', () => assert.strictEqual(supportsStandalone(17), true));
  test('null → true (assume modern)', () => assert.strictEqual(supportsStandalone(null), true));
});

// ── isStandaloneDefault ───────────────────────────────────────────────────────

suite('isStandaloneDefault', () => {
  test('CLI 14 → false', () => assert.strictEqual(isStandaloneDefault(14), false));
  test('CLI 16 → false', () => assert.strictEqual(isStandaloneDefault(16), false));
  test('CLI 17 → true', () => assert.strictEqual(isStandaloneDefault(17), true));
  test('CLI 19 → true', () => assert.strictEqual(isStandaloneDefault(19), true));
  test('null → true (assume modern)', () => assert.strictEqual(isStandaloneDefault(null), true));
});

// ── resolveOutputPathStrategy ─────────────────────────────────────────────────

suite('resolveOutputPathStrategy', () => {
  test('CLI 8 → legacy', () => assert.strictEqual(resolveOutputPathStrategy(8), 'legacy'));
  test('CLI 14 → legacy', () => assert.strictEqual(resolveOutputPathStrategy(14), 'legacy'));
  test('CLI 16 → legacy', () => assert.strictEqual(resolveOutputPathStrategy(16), 'legacy'));
  test('CLI 17 → browser-subdir', () =>
    assert.strictEqual(resolveOutputPathStrategy(17), 'browser-subdir'));
  test('CLI 19 → browser-subdir', () =>
    assert.strictEqual(resolveOutputPathStrategy(19), 'browser-subdir'));
  test('null → browser-subdir (assume modern)', () =>
    assert.strictEqual(resolveOutputPathStrategy(null), 'browser-subdir'));
});

// ── supportsTestUiFlag ────────────────────────────────────────────────────────

suite('supportsTestUiFlag', () => {
  test('CLI 8 → false', () => assert.strictEqual(supportsTestUiFlag(8), false));
  test('CLI 14 → false', () => assert.strictEqual(supportsTestUiFlag(14), false));
  test('CLI 16 → false', () => assert.strictEqual(supportsTestUiFlag(16), false));
  test('CLI 17 → true', () => assert.strictEqual(supportsTestUiFlag(17), true));
  test('CLI 19 → true', () => assert.strictEqual(supportsTestUiFlag(19), true));
  test('null → true (assume modern)', () => assert.strictEqual(supportsTestUiFlag(null), true));
});

// ── auto-import: template candidates ──────────────────────────────────────────

suite('collectTemplateCandidates', () => {
  function tokensOf(html: string): string[] {
    return [...collectTemplateCandidates(html).keys()].sort();
  }

  test('finds custom elements but not standard tags', () => {
    const tokens = tokensOf('<div><app-card></app-card><ng-container></ng-container></div>');
    assert.deepStrictEqual(tokens, ['app-card']);
  });

  test('finds plain attribute directives', () => {
    const tokens = tokensOf('<button mat-raised-button type="submit">go</button>');
    assert.ok(tokens.includes('mat-raised-button'));
    assert.ok(!tokens.includes('type'), 'standard attributes are not candidates');
  });

  test('finds structural directives and skips control flow blocks', () => {
    const tokens = tokensOf('<div *ngIf="a"><span *ngFor="let x of y"></span></div>@if (a) {<i></i>}');
    assert.ok(tokens.includes('ngif'));
    assert.ok(tokens.includes('ngfor'));
    assert.ok(!tokens.includes('if'));
  });

  test('finds two-way, input and non-native output bindings', () => {
    const tokens = tokensOf('<input [(ngModel)]="v" [matAutosize]="true" (valueChange)="f()" (click)="g()">');
    assert.ok(tokens.includes('ngmodel'));
    assert.ok(tokens.includes('matautosize'));
    assert.ok(tokens.includes('valuechange'));
    assert.ok(!tokens.includes('click'), 'native events are not candidates');
  });

  test('ignores DOM namespaces, standard attributes and template refs', () => {
    const tokens = tokensOf(
      '<img #ref [class.on]="a" [style.width.px]="w" [attr.data-id]="i" src="x" alt="y" width="1">',
    );
    assert.deepStrictEqual(tokens, []);
  });

  test('finds pipes but not the logical OR operator', () => {
    const tokens = tokensOf('{{ a | date:"short" }} {{ b || c }} {{ d | truncate }}');
    assert.ok(tokens.includes('date'));
    assert.ok(tokens.includes('truncate'));
    assert.strictEqual(tokens.includes('c'), false);
  });

  test('ignores commented-out markup', () => {
    assert.deepStrictEqual(tokensOf('<!-- <app-card></app-card> -->'), []);
  });

  test('records how a token was used', () => {
    const candidates = collectTemplateCandidates('<app-card *ngIf="a">{{ b | json }}</app-card>');
    assert.strictEqual(candidates.get('app-card')?.kind, 'element');
    assert.strictEqual(candidates.get('ngif')?.kind, 'structural');
    assert.strictEqual(candidates.get('json')?.kind, 'pipe');
  });
});

// ── auto-import: selector tokens ──────────────────────────────────────────────

suite('extractSelectorTokenWeights', () => {
  test('a whole-selector token weighs 1', () => {
    assert.strictEqual(extractSelectorTokenWeights('[ngModel]').get('ngmodel'), 1);
    assert.strictEqual(extractSelectorTokenWeights('app-card').get('app-card'), 1);
  });

  test('a token combined with others weighs less', () => {
    const weights = extractSelectorTokenWeights('mat-checkbox[required][ngModel]');
    assert.ok((weights.get('ngmodel') ?? 1) < 0.5);
  });

  test('pseudo selectors and attribute values are stripped', () => {
    const tokens = extractSelectorTokens('button[mat-button]:not([disabled]), a[mat-button]');
    assert.deepStrictEqual(tokens.sort(), ['a', 'button', 'mat-button']);
    assert.deepStrictEqual(extractSelectorTokens('input[type="text"]').sort(), ['input', 'type']);
  });

  test('the best weight of several selector parts wins', () => {
    const weights = extractSelectorTokenWeights('div[appHighlight], [appHighlight]');
    assert.strictEqual(weights.get('apphighlight'), 1);
  });
});

// ── auto-import: compiled library metadata ────────────────────────────────────

suite('parseDtsModule', () => {
  const dts = `
import * as i0 from '@angular/core';
declare class NgIf<T = unknown> {
    static ɵdir: i0.ɵɵDirectiveDeclaration<NgIf<any>, "[ngIf]", never, {}, {}, never, never, true, never>;
}
declare class AsyncPipe {
    static ɵpipe: i0.ɵɵPipeDeclaration<AsyncPipe, "async", true>;
}
declare class MatButton {
    static ɵcmp: i0.ɵɵComponentDeclaration<MatButton, "button[mat-button]", never, {}, {}, never, ["*"], false, never>;
}
declare class MatButtonModule {
    static ɵmod: i0.ɵɵNgModuleDeclaration<MatButtonModule, [typeof i1.MatButton], never, [typeof i1.MatButton]>;
}
export { MatButtonModule as M, NgIf, AsyncPipe, MatButton as f };
export type { SomeOptions as a } from './options.js';
export { b as MatIcon } from '../icon.d-XYZ.js';
export * from './extra.js';
`;

  test('reads selectors, pipe names and the standalone flag', () => {
    const parsed = parseDtsModule(dts);
    assert.deepStrictEqual(parsed.declarations.get('NgIf')?.tokens, ['ngif']);
    assert.strictEqual(parsed.declarations.get('NgIf')?.standalone, true);
    assert.deepStrictEqual(parsed.declarations.get('AsyncPipe')?.tokens, ['async']);
    assert.strictEqual(parsed.declarations.get('AsyncPipe')?.kind, 'Pipe');
    assert.strictEqual(parsed.declarations.get('MatButton')?.standalone, false);
    assert.deepStrictEqual(parsed.declarations.get('MatButtonModule')?.exports, ['MatButton']);
  });

  test('maps mangled export aliases back to their declaration', () => {
    const parsed = parseDtsModule(dts);
    assert.strictEqual(parsed.aliasToLocal.get('M'), 'MatButtonModule');
    assert.strictEqual(parsed.aliasToLocal.get('f'), 'MatButton');
    assert.strictEqual(parsed.aliasToLocal.get('NgIf'), 'NgIf');
  });

  test('collects re-exports and ignores type-only ones', () => {
    const parsed = parseDtsModule(dts);
    const named = parsed.reExports.find((entry) => entry.from === '../icon.d-XYZ.js');
    assert.deepStrictEqual(named?.names, [{ source: 'b', exported: 'MatIcon' }]);
    assert.ok(parsed.reExports.some((entry) => entry.star && entry.from === './extra.js'));
    assert.ok(!parsed.reExports.some((entry) => entry.from === './options.js'));
  });

  test('files without Angular metadata yield no declarations', () => {
    assert.strictEqual(parseDtsModule('export declare class Plain {}').declarations.size, 0);
  });
});

// ── auto-import: edit construction ────────────────────────────────────────────

suite('buildEditsForSelection', () => {
  function applyTo(source: string, selection: ImportOption[]): string {
    const filePath = path.join('/repo', 'src', 'app', 'page.component.ts');
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    const owners = parseDecoratedOwners(sourceFile);
    const built = buildEditsForSelection(filePath, sourceFile, owners, selection);
    let result = source;
    for (const span of [...built.spans].sort((a, b) => b.start - a.start)) {
      result = result.slice(0, span.start) + span.text + result.slice(span.end);
    }
    return result;
  }

  function option(
    className: string,
    moduleSpecifier: string | null,
    ownerClassName?: string,
  ): ImportOption {
    return {
      action: 'add',
      className,
      moduleSpecifier,
      ownerClassName,
      label: className,
      description: moduleSpecifier ?? 'this file',
      detail: 'test',
      preselected: true,
      rank: 0,
    };
  }

  const withArray = [
    "import { Component } from '@angular/core';",
    '',
    '@Component({',
    "  selector: 'app-page',",
    "  template: '<div></div>',",
    '  imports: [NgIf],',
    '})',
    'export class PageComponent {}',
    '',
  ].join('\n');

  test('adds an import statement and an imports array entry', () => {
    const result = applyTo(withArray, [option('DatePipe', '@angular/common', 'PageComponent')]);
    assert.ok(result.includes("import { DatePipe } from '@angular/common';"));
    assert.ok(result.includes('imports: [NgIf, DatePipe],'));
  });

  test('merges into an existing import of the same module', () => {
    const source = withArray.replace(
      "import { Component } from '@angular/core';",
      "import { Component } from '@angular/core';\nimport { NgIf } from '@angular/common';",
    );
    const result = applyTo(source, [option('DatePipe', '@angular/common', 'PageComponent')]);
    assert.ok(result.includes("import { NgIf, DatePipe } from '@angular/common';"));
    assert.strictEqual(result.match(/@angular\/common/g)?.length, 1);
  });

  test('creates the imports array when the decorator has none', () => {
    const source = withArray.replace('  imports: [NgIf],\n', '');
    const result = applyTo(source, [option('NgFor', '@angular/common', 'PageComponent')]);
    assert.ok(result.includes('imports: [NgFor]'));
  });

  test('keeps a multi-line array multi-line', () => {
    const source = withArray.replace('  imports: [NgIf],', '  imports: [\n    NgIf,\n  ],');
    const result = applyTo(source, [option('NgFor', '@angular/common', 'PageComponent')]);
    assert.ok(result.includes('    NgIf,\n    NgFor,\n  ],'), result);
  });

  test('adds no import statement for a symbol declared in the same file', () => {
    const result = applyTo(withArray, [option('PageComponent', null, 'PageComponent')]);
    assert.ok(!result.includes('import { PageComponent }'));
    assert.ok(result.includes('imports: [NgIf, PageComponent],'));
  });

  test('reports a clash instead of shadowing an existing binding', () => {
    const source = withArray.replace(
      "import { Component } from '@angular/core';",
      "import { Component } from '@angular/core';\nimport { DatePipe } from './my-date.pipe';",
    );
    const filePath = path.join('/repo', 'src', 'app', 'page.component.ts');
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    const built = buildEditsForSelection(
      filePath,
      sourceFile,
      parseDecoratedOwners(sourceFile),
      [option('DatePipe', '@angular/common', 'PageComponent')],
    );
    assert.deepStrictEqual(built.conflicts, ['DatePipe']);
    assert.strictEqual(built.addedImports, 0);
  });

  test('does not duplicate an entry that is already in the array', () => {
    const result = applyTo(withArray, [option('NgIf', '@angular/common', 'PageComponent')]);
    assert.ok(result.includes('imports: [NgIf],'), result);
    assert.ok(result.includes("import { NgIf } from '@angular/common';"), result);
  });
});

// ── auto-clean: reference counting ────────────────────────────────────────────

suite('countReferences', () => {
  function counts(source: string): Map<string, number> {
    return countReferences(
      ts.createSourceFile('/proj/a.ts', source, ts.ScriptTarget.Latest, true),
    );
  }

  test('import bindings themselves are not references', () => {
    const map = counts("import { A } from './a';\n");
    assert.strictEqual(map.get('A') ?? 0, 0);
  });

  test('values, types and decorator metadata count as references', () => {
    const map = counts(
      [
        "import { A, B, C } from './a';",
        'const x = A;',
        'let y: B;',
        'class K { constructor(private c: C) {} }',
      ].join('\n'),
    );
    assert.strictEqual(map.get('A'), 1);
    assert.strictEqual(map.get('B'), 1);
    assert.strictEqual(map.get('C'), 1);
  });

  test('property names and dotted access are not references', () => {
    const map = counts("import { A } from './a';\nconst o = { A: 1 };\nconst v = o.A;\n");
    assert.strictEqual(map.get('A') ?? 0, 0);
  });

  test('a local re-export counts, a re-export from a module does not', () => {
    assert.strictEqual(counts("import { A } from './a';\nexport { A };\n").get('A'), 1);
    assert.strictEqual(counts("export { A } from './a';\n").get('A') ?? 0, 0);
  });

  test('ignored spans are not counted', () => {
    const source = "import { A } from './a';\nconst list = [A];\n";
    const sourceFile = ts.createSourceFile('/proj/a.ts', source, ts.ScriptTarget.Latest, true);
    const position = source.lastIndexOf('A');
    const map = countReferences(sourceFile, [{ start: position, end: position + 1 }]);
    assert.strictEqual(map.get('A') ?? 0, 0);
  });
});

// ── auto-clean: import statement planning ─────────────────────────────────────

suite('planImportStatements', () => {
  function plan(
    source: string,
    add: Record<string, string[]> = {},
    remove: string[] = [],
  ): string {
    const sourceFile = ts.createSourceFile('/proj/a.ts', source, ts.ScriptTarget.Latest, true);
    return applySpans(
      source,
      planImportStatements(sourceFile, {
        add: new Map(Object.entries(add)),
        remove: new Set(remove),
      }),
    );
  }

  test('removes a single named binding and keeps the rest', () => {
    const result = plan("import { A, B, C } from './a';\n", {}, ['B']);
    assert.strictEqual(result, "import { A, C } from './a';\n");
  });

  test('deletes the whole statement when every binding goes', () => {
    const source = "import { A } from './a';\nimport { B } from './b';\nconst x = B;\n";
    assert.strictEqual(plan(source, {}, ['A']), "import { B } from './b';\nconst x = B;\n");
  });

  test('keeps a default import when the named ones are removed', () => {
    const result = plan("import D, { A } from './a';\n", {}, ['A']);
    assert.ok(result.includes("import D from './a';"), result);
  });

  test('never touches a side-effect import', () => {
    const source = "import './polyfills';\n";
    assert.strictEqual(plan(source, {}, ['polyfills']), source);
  });

  test('adds into an existing statement and creates one for a new module', () => {
    const result = plan("import { A } from './a';\n", { './a': ['Z'], './b': ['Y'] });
    assert.ok(result.includes("import { A, Z } from './a';"), result);
    assert.ok(result.includes("import { Y } from './b';"), result);
  });

  test('adds and removes in the same statement without overlapping', () => {
    const result = plan("import { A, B } from './a';\n", { './a': ['C'] }, ['A']);
    assert.strictEqual(result, "import { B, C } from './a';\n");
  });

  test('preserves a multi-line import layout', () => {
    const source = "import {\n  A,\n  B,\n} from './a';\n";
    const result = plan(source, {}, ['A']);
    assert.strictEqual(result, "import {\n  B,\n} from './a';\n");
  });

  test('a namespace import receives a separate statement', () => {
    const result = plan("import * as ns from './a';\n", { './a': ['Z'] });
    assert.ok(result.includes("import * as ns from './a';"), result);
    assert.ok(result.includes("import { Z } from './a';"), result);
  });
});

// ── auto-clean: imports array planning ────────────────────────────────────────

suite('planImportsArray', () => {
  const component = [
    '@Component({',
    "  selector: 'app-root',",
    '  imports: [A, B, C],',
    "  template: '',",
    '})',
    'export class AppComponent {}',
    '',
  ].join('\n');

  function plan(source: string, add: string[], remove: string[]): string {
    const sourceFile = ts.createSourceFile('/proj/a.ts', source, ts.ScriptTarget.Latest, true);
    const [owner] = parseDecoratedOwners(sourceFile);
    return applySpans(
      source,
      planImportsArray(sourceFile, owner, { add, remove: new Set(remove) }),
    );
  }

  test('removes one entry', () => {
    assert.ok(plan(component, [], ['B']).includes('imports: [A, C],'));
  });

  test('empties the array when everything goes', () => {
    assert.ok(plan(component, [], ['A', 'B', 'C']).includes('imports: [],'));
  });

  test('adds and removes in one span', () => {
    assert.ok(plan(component, ['D'], ['A']).includes('imports: [B, C, D],'));
  });

  test('leaves an unchanged array alone', () => {
    assert.strictEqual(plan(component, [], ['Missing']), component);
  });

  test('keeps non-identifier entries', () => {
    const source = component.replace('imports: [A, B, C],', 'imports: [A, ...EXTRA],');
    assert.ok(plan(source, [], ['A']).includes('imports: [...EXTRA],'));
  });
});

// ── auto-clean: analysis ──────────────────────────────────────────────────────

suite('computeCleanupPlan', () => {
  const workspace = path.join(os.tmpdir(), 'acp-clean-tests');
  const ownerPath = path.join(workspace, 'app.component.ts');

  function symbol(partial: Partial<AutoImportSymbol> & { className: string }): AutoImportSymbol {
    return {
      kind: 'Component',
      tokens: [],
      origin: 'workspace',
      ...partial,
    } as AutoImportSymbol;
  }

  function makeIndex(symbols: AutoImportSymbol[]): AutoImportIndex {
    const byName = new Map<string, AutoImportSymbol[]>();
    const byToken = new Map<string, AutoImportSymbol[]>();
    for (const entry of symbols) {
      byName.set(entry.className, [...(byName.get(entry.className) ?? []), entry]);
      for (const token of entry.tokens) {
        byToken.set(token, [...(byToken.get(token) ?? []), entry]);
      }
    }
    return {
      root: workspace,
      byToken,
      byName,
      templateUrlOwners: new Map(),
      pathMappings: [],
      fileCount: symbols.length,
      libraryScanned: true,
    };
  }

  function analyse(source: string, symbols: AutoImportSymbol[]) {
    const sourceFile = ts.createSourceFile(ownerPath, source, ts.ScriptTarget.Latest, true);
    const owners = parseDecoratedOwners(sourceFile);
    const plan = computeCleanupPlan({
      filePath: ownerPath,
      sourceFile,
      owners,
      index: makeIndex(symbols),
      includeModules: true,
      cleanArrays: true,
      cleanBindings: true,
    });
    return { plan, cleaned: applySpans(source, buildCleanupSpans(sourceFile, owners, plan)) };
  }

  const childPath = path.join(workspace, 'child.component.ts');

  suiteSetup(() => {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      childPath,
      "import { Component } from '@angular/core';\n" +
        "@Component({ selector: 'app-child', template: '' })\n" +
        'export class ChildComponent {}\n',
      'utf-8',
    );
  });

  suiteTeardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const childSymbol = symbol({
    className: 'ChildComponent',
    tokens: ['app-child'],
    filePath: childPath,
    standalone: true,
  });

  function componentSource(template: string, extra = ''): string {
    return [
      "import { Component } from '@angular/core';",
      "import { ChildComponent } from './child.component';",
      '',
      '@Component({',
      "  selector: 'app-root',",
      '  imports: [ChildComponent],',
      `  template: '${template}',`,
      '})',
      `export class AppComponent {${extra}}`,
      '',
    ].join('\n');
  }

  test('removes an entry the template does not use, and its import', () => {
    const { plan, cleaned } = analyse(componentSource('<p>hi</p>'), [childSymbol]);
    assert.strictEqual(plan.arrayEntries.length, 1);
    assert.strictEqual(plan.arrayEntries[0].name, 'ChildComponent');
    assert.strictEqual(plan.arrayEntries[0].bindingBecomesUnused, true);
    assert.ok(cleaned.includes('imports: [],'), cleaned);
    assert.ok(!cleaned.includes('child.component'), cleaned);
  });

  test('keeps an entry the template uses', () => {
    const { plan } = analyse(componentSource('<app-child></app-child>'), [childSymbol]);
    assert.strictEqual(plan.arrayEntries.length, 0);
    assert.strictEqual(plan.bindings.length, 0);
  });

  test('keeps the import when the class is still referenced in code', () => {
    const { plan, cleaned } = analyse(
      componentSource('<p>hi</p>', '\n  readonly token = ChildComponent;\n'),
      [childSymbol],
    );
    assert.strictEqual(plan.arrayEntries.length, 1);
    assert.strictEqual(plan.arrayEntries[0].bindingBecomesUnused, false);
    assert.ok(cleaned.includes("import { ChildComponent } from './child.component';"), cleaned);
    assert.ok(cleaned.includes('imports: [],'), cleaned);
  });

  test('reports what the entries provide as coverage', () => {
    const { plan } = analyse(componentSource('<app-child></app-child>'), [childSymbol]);
    assert.deepStrictEqual([...(plan.coverage.get('AppComponent') ?? [])], ['app-child']);
  });

  test('keeps entries whose provider cannot be resolved', () => {
    const source = componentSource('<p>hi</p>').replace(
      "import { ChildComponent } from './child.component';",
      "import { ChildComponent } from 'some-unknown-lib';",
    );
    const { plan } = analyse(source, []);
    assert.strictEqual(plan.arrayEntries.length, 0);
    assert.deepStrictEqual(plan.unresolved.get('AppComponent'), ['ChildComponent']);
  });

  test('keeps a module that provides no template tokens (it may carry providers)', () => {
    const source = [
      "import { Component } from '@angular/core';",
      "import { HttpClientModule } from '@angular/common/http';",
      '',
      '@Component({',
      "  selector: 'app-root',",
      '  imports: [HttpClientModule],',
      "  template: '<p>hi</p>',",
      '})',
      'export class AppComponent {}',
      '',
    ].join('\n');
    const { plan } = analyse(source, [
      symbol({
        className: 'HttpClientModule',
        kind: 'NgModule',
        tokens: [],
        origin: 'library',
        moduleSpecifier: '@angular/common/http',
      }),
    ]);
    assert.strictEqual(plan.arrayEntries.length, 0);
  });

  test('flags an unused module only when modules are included', () => {
    const source = [
      "import { Component } from '@angular/core';",
      "import { CommonModule } from '@angular/common';",
      '',
      '@Component({',
      "  selector: 'app-root',",
      '  imports: [CommonModule],',
      "  template: '<p>hi</p>',",
      '})',
      'export class AppComponent {}',
      '',
    ].join('\n');
    const symbols = [
      symbol({
        className: 'CommonModule',
        kind: 'NgModule',
        tokens: ['ngif', 'ngfor'],
        origin: 'library',
        moduleSpecifier: '@angular/common',
      }),
    ];
    const sourceFile = ts.createSourceFile(ownerPath, source, ts.ScriptTarget.Latest, true);
    const owners = parseDecoratedOwners(sourceFile);
    const base = {
      filePath: ownerPath,
      sourceFile,
      owners,
      index: makeIndex(symbols),
      cleanArrays: true,
      cleanBindings: true,
    };
    assert.strictEqual(
      computeCleanupPlan({ ...base, includeModules: false }).arrayEntries.length,
      0,
    );
    const included = computeCleanupPlan({ ...base, includeModules: true });
    assert.strictEqual(included.arrayEntries.length, 1);
    assert.strictEqual(included.arrayEntries[0].kind, 'NgModule');
  });

  test('removes unused import statements of any kind', () => {
    const source = [
      "import { Component } from '@angular/core';",
      "import { Observable, Subject } from 'rxjs';",
      "import './side-effect';",
      '',
      '@Component({',
      "  selector: 'app-root',",
      "  template: '',",
      '})',
      'export class AppComponent {',
      '  value = new Subject<void>();',
      '}',
      '',
    ].join('\n');
    const { plan, cleaned } = analyse(source, []);
    assert.deepStrictEqual(
      plan.bindings.map((binding) => binding.name),
      ['Observable'],
    );
    assert.ok(cleaned.includes("import { Subject } from 'rxjs';"), cleaned);
    assert.ok(cleaned.includes("import './side-effect';"), cleaned);
  });

  test('does not analyse the array when a templateUrl cannot be read', () => {
    const source = componentSource('x').replace(
      "  template: 'x',",
      "  templateUrl: './missing.html',",
    );
    const { plan } = analyse(source, [childSymbol]);
    assert.strictEqual(plan.arrayEntries.length, 0);
    assert.ok(plan.skipped.some((entry) => entry.includes('AppComponent')));
  });

  test('turns findings into quick pick entries, modules unticked', () => {
    const { plan } = analyse(componentSource('<p>hi</p>'), [childSymbol]);
    const suggestions = cleanupSuggestions(plan);
    assert.strictEqual(suggestions.length, 1);
    const [option] = suggestions[0].options;
    assert.strictEqual(option.action, 'remove');
    assert.strictEqual(option.preselected, true);
    assert.strictEqual(option.dropBinding, true);
    assert.strictEqual(option.ownerClassName, 'AppComponent');
  });
});

// ── auto-import + auto-clean in one edit ──────────────────────────────────────

suite('buildEditsForSelection (add and remove together)', () => {
  test('adding and removing in the same array produces one consistent result', () => {
    const source = [
      "import { Component } from '@angular/core';",
      "import { NgIf } from '@angular/common';",
      '',
      '@Component({',
      "  selector: 'app-root',",
      '  imports: [NgIf],',
      "  template: '',",
      '})',
      'export class AppComponent {}',
      '',
    ].join('\n');
    const filePath = '/proj/app.component.ts';
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    const owners = parseDecoratedOwners(sourceFile);

    const built = buildEditsForSelection(filePath, sourceFile, owners, [
      {
        action: 'add',
        className: 'DatePipe',
        moduleSpecifier: '@angular/common',
        ownerClassName: 'AppComponent',
        label: 'DatePipe',
        description: '@angular/common',
        detail: 'pipe',
        preselected: true,
        rank: 0,
      },
      {
        action: 'remove',
        className: 'NgIf',
        moduleSpecifier: '@angular/common',
        ownerClassName: 'AppComponent',
        dropBinding: true,
        label: 'Remove NgIf',
        description: '@angular/common',
        detail: 'directive',
        preselected: true,
        rank: 0,
      },
    ]);

    const result = applySpans(source, built.spans);
    assert.ok(result.includes("import { DatePipe } from '@angular/common';"), result);
    assert.ok(!result.includes('NgIf'), result);
    assert.ok(result.includes('imports: [DatePipe],'), result);
    assert.strictEqual(built.addedEntries, 1);
    assert.strictEqual(built.removedEntries, 1);
    assert.strictEqual(built.removedImports, 1);
  });
});

// ── auto-clean: the edits handed to VS Code on save ───────────────────────────

suite('computeCleanupEdits', () => {
  const directory = path.join(os.tmpdir(), 'acp-save-tests');

  suiteSetup(() => fs.mkdirSync(directory, { recursive: true }));
  suiteTeardown(() => fs.rmSync(directory, { recursive: true, force: true }));

  async function editsFor(source: string): Promise<{ edits: vscode.TextEdit[]; result: string }> {
    const file = path.join(directory, `thing-${Math.random().toString(36).slice(2)}.ts`);
    fs.writeFileSync(file, source, 'utf-8');
    const document = await vscode.workspace.openTextDocument(file);
    const edits = computeCleanupEdits(
      document,
      { enabled: true, cleanBindings: true, cleanArrays: false, includeModules: false },
      null,
    );
    let result = source;
    const spans = edits
      .map((edit) => ({
        start: document.offsetAt(edit.range.start),
        end: document.offsetAt(edit.range.end),
        text: edit.newText,
      }))
      .sort((a, b) => b.start - a.start);
    for (const span of spans) {
      result = result.slice(0, span.start) + span.text + result.slice(span.end);
    }
    return { edits, result };
  }

  const BODY = "\nexport const subject = new Subject<void>();\n";

  test('returns text edits that drop an unused import', async () => {
    const { edits, result } = await editsFor(
      "import { Observable, Subject } from 'rxjs';\n" + BODY,
    );
    assert.ok(edits.length > 0);
    assert.strictEqual(result, "import { Subject } from 'rxjs';\n" + BODY);
  });

  test('returns nothing when every import is used', async () => {
    const { edits } = await editsFor("import { Subject } from 'rxjs';\n" + BODY);
    assert.strictEqual(edits.length, 0);
  });
});
