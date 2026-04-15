import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { spawnCapture } from './dependencies';
import { cliVersionCache, logDiagnostic } from './state';
import { parseNgVersionOutput } from './pure-utils';

/**
 * Detects the major version of the Angular CLI used in the given workspace.
 *
 * Strategy:
 *  1. Return cached value if available.
 *  2. Run `ng version` and parse the output.
 *  3. Fall back to reading `@angular/cli` version from node_modules.
 *  4. Returns null if detection fails entirely (callers should use modern defaults).
 */
export async function detectCliVersion(workspaceRoot: string): Promise<number | null> {
  const cached = cliVersionCache.get(workspaceRoot);
  if (cached !== undefined) {
    return cached;
  }

  let majorVersion = await detectFromNgVersion(workspaceRoot);

  if (majorVersion === null) {
    majorVersion = detectFromNodeModules(workspaceRoot);
  }

  cliVersionCache.set(workspaceRoot, majorVersion);

  if (majorVersion !== null) {
    logDiagnostic(`Detected Angular CLI major version: ${majorVersion} in ${workspaceRoot}`);
  } else {
    logDiagnostic(
      `Could not detect Angular CLI version in ${workspaceRoot}, using modern defaults`,
    );
  }

  return majorVersion;
}

async function detectFromNgVersion(workspaceRoot: string): Promise<number | null> {
  try {
    const result = await spawnCapture('ng', ['version'], workspaceRoot);
    if (result.exitCode === 0) {
      return parseNgVersionOutput(result.stdout);
    }
  } catch (err) {
    logDiagnostic(`ng version failed: ${err}`);
  }
  return null;
}

function detectFromNodeModules(workspaceRoot: string): number | null {
  try {
    const cliPkgPath = path.join(workspaceRoot, 'node_modules', '@angular', 'cli', 'package.json');
    const raw = fs.readFileSync(cliPkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version) {
      const parsed = semver.coerce(pkg.version);
      if (parsed) {
        return parsed.major;
      }
    }
  } catch {
    // node_modules not available or package not installed
  }
  return null;
}
