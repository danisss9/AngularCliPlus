/**
 * Read/write helpers for JSONC config files (tsconfig.json, eslint config,
 * angular.json) built on `jsonc-parser`. Writes are surgical: a single key is
 * modified or removed while comments, key order, and formatting are preserved.
 */
import * as fs from 'fs';
import * as jsonc from 'jsonc-parser';
import { logDiagnostic } from './state';

/** Formatting applied to inserted/modified properties. */
const FORMATTING_OPTIONS: jsonc.FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: '\n',
};

/** A path into the JSON tree, e.g. `['compilerOptions', 'strict']`. */
export type JsonPath = jsonc.JSONPath;

/**
 * Reads and parses a JSONC file. Tolerates comments and trailing commas.
 * Returns `null` when the file is missing or cannot be parsed.
 */
export function readJsonc<T = unknown>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const errors: jsonc.ParseError[] = [];
  const result = jsonc.parse(raw, errors, { allowTrailingComma: true }) as T;
  if (errors.length > 0) {
    logDiagnostic(`jsonc parse issues in ${filePath}: ${errors.length} error(s)`);
  }
  return result ?? null;
}

/** Reads the raw text of a file, or `null` when it cannot be read. */
export function readRaw(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Sets a value at the given JSON path, creating intermediate objects as needed,
 * and writes the file back with comments/formatting preserved.
 * Returns `true` on success.
 */
export function setKey(filePath: string, jsonPath: JsonPath, value: unknown): boolean {
  return applyModification(filePath, jsonPath, value);
}

/**
 * Removes the key at the given JSON path and writes the file back. Removing a
 * missing key is a no-op that still reports success.
 */
export function removeKey(filePath: string, jsonPath: JsonPath): boolean {
  return applyModification(filePath, jsonPath, undefined);
}

function applyModification(filePath: string, jsonPath: JsonPath, value: unknown): boolean {
  const raw = readRaw(filePath);
  if (raw === null) {
    logDiagnostic(`Cannot read ${filePath} for modification`);
    return false;
  }
  try {
    const edits = jsonc.modify(raw, jsonPath, value, {
      formattingOptions: FORMATTING_OPTIONS,
    });
    const updated = jsonc.applyEdits(raw, edits);
    fs.writeFileSync(filePath, updated, 'utf-8');
    return true;
  } catch (err) {
    logDiagnostic(`Failed to modify ${filePath} at ${jsonPath.join('.')}: ${err}`);
    return false;
  }
}
