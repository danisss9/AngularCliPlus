/**
 * Pure functions that adapt Angular CLI command flags based on the detected
 * major version. All functions accept `null` and fall back to modern defaults
 * (current behaviour of the extension).
 */

/**
 * Returns the appropriate production build flag.
 * CLI <12: `--prod`
 * CLI >=12 (or unknown): `--configuration=production`
 */
export function getProductionFlag(majorVersion: number | null): string {
  if (majorVersion !== null && majorVersion < 12) {
    return ' --prod';
  }
  return ' --configuration=production';
}

/**
 * Returns the appropriate build configuration flag string.
 * For the 'production' config on CLI <12 this returns `--prod`.
 * For 'default' this returns an empty string (omit flag entirely).
 * For all other configs (or CLI >=12) this returns `--configuration=<config>`.
 */
export function getBuildConfigFlag(config: string, majorVersion: number | null): string {
  if (config === 'default') {
    return '';
  }
  if (config === 'production' && majorVersion !== null && majorVersion < 12) {
    return ' --prod';
  }
  return ` --configuration=${config}`;
}

/**
 * Whether the `--standalone` flag is supported by `ng generate`.
 * Available from CLI 14+.
 */
export function supportsStandalone(majorVersion: number | null): boolean {
  if (majorVersion === null) {
    return true; // assume modern
  }
  return majorVersion >= 14;
}

/**
 * Whether standalone is the default for generated components.
 * True from CLI 17+ (standalone by default).
 */
export function isStandaloneDefault(majorVersion: number | null): boolean {
  if (majorVersion === null) {
    return true; // assume modern
  }
  return majorVersion >= 17;
}

/**
 * Returns 'browser-subdir' for CLI 17+ (dist/<project>/browser/),
 * or 'legacy' for older versions (dist/<project>/).
 */
export function resolveOutputPathStrategy(
  majorVersion: number | null,
): 'legacy' | 'browser-subdir' {
  if (majorVersion === null) {
    return 'browser-subdir'; // assume modern
  }
  return majorVersion >= 17 ? 'browser-subdir' : 'legacy';
}

/**
 * Whether the `--ui` test flag (Vitest UI) is supported.
 * Available from CLI 17+ (when using Vitest).
 */
export function supportsTestUiFlag(majorVersion: number | null): boolean {
  if (majorVersion === null) {
    return true;
  }
  return majorVersion >= 17;
}
