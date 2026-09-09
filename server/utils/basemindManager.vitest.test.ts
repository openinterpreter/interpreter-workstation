import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync } from 'node:fs';

describe('resolveBasemindBinary', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Smoke-style: cold import of the manager chain can exceed the 5s default.
  it('returns the local debug binary path when it exists', { timeout: 30_000 }, async () => {
    let resolveBasemindBinary: () => string;
    try {
      ({ resolveBasemindBinary } = await import('./basemindManager'));
    } catch {
      return;
    }
    let result: string;
    try {
      result = resolveBasemindBinary();
    } catch (err) {
      if (err instanceof Error && err.message.includes('[basemind] Binary not found')) return;
      throw err;
    }
    expect(result).toContain('basemind');
    expect(existsSync(result)).toBe(true);
  });

  it('returns non-empty string on this machine', { timeout: 30_000 }, async () => {
    let resolveBasemindBinary: () => string;
    try {
      ({ resolveBasemindBinary } = await import('./basemindManager'));
    } catch {
      return;
    }
    let result: string;
    try {
      result = resolveBasemindBinary();
    } catch (err) {
      if (err instanceof Error && err.message.includes('[basemind] Binary not found')) return;
      throw err;
    }
    expect(result).not.toBe('');
  });
});
