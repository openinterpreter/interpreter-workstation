import semver from 'semver';

/**
 * Shared semver helpers. Used by the oo-editors update check (electron main)
 * and the Ollama runtime-version warning (renderer + server), so version
 * comparison lives in one place. `semver` is a runtime dependency and pure JS,
 * so this module is safe to import from the renderer bundle.
 */

/**
 * Coerce a loose version string ("v1.2", "1.2.3-rc0", "1.2.3") to a strict
 * semver string. Throws when empty or unparseable.
 */
export function normalizeVersion(version: string): string {
  const trimmed = version.trim();
  if (!trimmed) {
    throw new Error('Version is empty');
  }

  const valid = semver.valid(trimmed);
  if (valid) return valid;

  const coerced = semver.coerce(trimmed);
  if (!coerced) {
    throw new Error(`Invalid version: ${version}`);
  }

  return coerced.version;
}

/** Like {@link normalizeVersion} but returns null instead of throwing. */
export function tryNormalizeVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  try {
    return normalizeVersion(version);
  } catch {
    return null;
  }
}

/**
 * True when `version` is strictly greater than `baseline` (e.g. an update is
 * available). Throws when either version is unparseable.
 */
export function isVersionGreaterThan(version: string, baseline: string): boolean {
  return semver.gt(normalizeVersion(version), normalizeVersion(baseline));
}

/**
 * True when `version` is strictly less than `minimum`. Returns false when
 * either side is empty or unparseable, so callers never warn on unknown input.
 */
export function isVersionBelow(version: string | null | undefined, minimum: string): boolean {
  const normalized = tryNormalizeVersion(version);
  const min = tryNormalizeVersion(minimum);
  if (!normalized || !min) return false;
  return semver.lt(normalized, min);
}
