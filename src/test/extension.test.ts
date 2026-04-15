import * as assert from 'assert';
import * as path from 'path';
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

  // Pre-release versions (broken in the old custom parser)
  test('pre-release installed coerces to release for range check', () =>
    assert.strictEqual(semverSatisfies('1.0.0-beta', '^1.0.0'), true));
  test('pre-release installed fails lower range after coercion', () =>
    assert.strictEqual(semverSatisfies('0.9.0-rc1', '^1.0.0'), false));

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
      '   / △ \\ | \'_ \\ / _` | | | | |/ _` | \'__|   | |   | |    | |',
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
