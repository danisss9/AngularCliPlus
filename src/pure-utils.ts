/**
 * Pure utility functions with zero VS Code dependencies.
 * These are extracted here so they can be unit-tested without a VS Code host process.
 */

import * as path from 'path';
import * as semver from 'semver';
import type { AngularProject, GenerateOptions, SchematicType } from './types';

// ── Name validation ───────────────────────────────────────────────────────────

/** Regex for valid Angular schematic names: lowercase start, alphanumeric + hyphens. */
export const SCHEMATIC_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

export function isValidSchematicName(name: string): boolean {
  return SCHEMATIC_NAME_REGEX.test(name);
}

// ── String helpers ─────────────────────────────────────────────────────────────

export function toKebabCase(str: string): string {
  return str.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// ── Command building ──────────────────────────────────────────────────────────

export function buildNgGenerateCommand(
  schematic: SchematicType,
  options: GenerateOptions,
): string {
  let command = `ng generate ${schematic}`;

  for (const key of Object.keys(options)) {
    const value = options[key];
    const kebabKey = toKebabCase(key);

    if (typeof value === 'boolean') {
      command += value ? ` --${kebabKey}` : ` --${kebabKey}=false`;
    } else if (typeof value === 'string') {
      command += ` --${kebabKey}=${value}`;
    }
  }

  return command;
}

// ── Semver ────────────────────────────────────────────────────────────────────

/**
 * Returns true if `installed` satisfies the `required` semver range.
 * Non-semver specifiers (git, file, workspace, URLs) always return true.
 */
export function semverSatisfies(installed: string, required: string): boolean {
  const req = required.trim();
  if (!req || req === '*' || req === 'latest') {
    return true;
  }
  if (/^(git|file:|workspace:|https?:|github:)/.test(req)) {
    return true;
  }

  try {
    const coerced = semver.coerce(installed);
    if (!coerced) { return false; }
    return semver.satisfies(coerced, req);
  } catch {
    return true;
  }
}

// ── Command validation ────────────────────────────────────────────────────────

/**
 * Validates a user-provided shell command before passing it to spawn.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateCustomCommand(command: string): string | null {
  if (!command || command.trim() === '') {
    return 'Command cannot be empty';
  }
  if (/;\s*(rm|del|format|mkfs|dd)\b/i.test(command)) {
    return 'Command contains potentially dangerous operations';
  }
  return null;
}

// ── ng update output parsing ──────────────────────────────────────────────────

/**
 * Parses the output of `ng update` (after stripping ANSI codes) into a list of
 * packages with their current → target version strings.
 */
export function parseNgUpdateOutput(output: string): Array<{ name: string; versions: string }> {
  const clean = output.replace(/\x1b\[[\d;]*[A-Za-z]/g, '');
  const results: Array<{ name: string; versions: string }> = [];
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    const match = trimmed.match(/^(@?[\w/.-]+)\s+(\S+\s*->\s*\S+)/);
    if (match) {
      results.push({ name: match[1], versions: match[2].replace(/\s+/g, ' ') });
    }
  }
  return results;
}

// ── Angular project matching ──────────────────────────────────────────────────

/**
 * Returns the names of all Angular projects whose root or sourceRoot contains
 * `folderPath`. Used when generating schematics from a right-click context.
 */
export function findMatchingProjects(
  folderPath: string,
  workspaceRoot: string,
  projects: { [name: string]: AngularProject },
): string[] {
  const normalised = folderPath.endsWith(path.sep) ? folderPath : folderPath + path.sep;

  return Object.keys(projects).filter((name) => {
    const project = projects[name];
    const roots = [project.root, project.sourceRoot].filter(Boolean) as string[];

    return roots.some((r) => {
      const absRoot = path.isAbsolute(r) ? r : path.join(workspaceRoot, r);
      const absRootNorm = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
      return normalised.startsWith(absRootNorm) || normalised === absRootNorm;
    });
  });
}

/**
 * Returns the name of the Angular project whose root most specifically contains
 * `filePath` (longest matching root wins). Used to infer the current project
 * from the active editor file.
 */
export function findBestProjectForPath(
  filePath: string,
  workspaceRoot: string,
  projects: { [name: string]: AngularProject },
): string | null {
  const fileDir = path.dirname(filePath);
  const fileDirNorm = fileDir.endsWith(path.sep) ? fileDir : fileDir + path.sep;

  let bestMatch: { name: string; rootLen: number } | null = null;

  for (const [name, project] of Object.entries(projects)) {
    const roots = [project.root, project.sourceRoot].filter(Boolean) as string[];
    for (const r of roots) {
      const absRoot = path.isAbsolute(r) ? r : path.join(workspaceRoot, r);
      const absRootNorm = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
      if (fileDirNorm.startsWith(absRootNorm)) {
        if (!bestMatch || absRootNorm.length > bestMatch.rootLen) {
          bestMatch = { name, rootLen: absRootNorm.length };
        }
      }
    }
  }

  return bestMatch?.name ?? null;
}
