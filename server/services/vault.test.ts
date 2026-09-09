import { describe, expect, test } from 'bun:test';

import { extractRehydrationMap, resolveVaultBlobPath, sanitizeVaultDocId } from './vault';

describe('sanitizeVaultDocId', () => {
  test('accepts safe document ids', () => {
    expect(sanitizeVaultDocId('doc-123_ABC')).toBe('doc-123_ABC');
  });

  test('rejects traversal and empty ids', () => {
    expect(() => sanitizeVaultDocId('../vaults/other')).toThrow();
    expect(() => sanitizeVaultDocId('')).toThrow();
  });
});

describe('resolveVaultBlobPath', () => {
  test('keeps blobs inside the vaults directory', () => {
    expect(resolveVaultBlobPath('doc-1', '/data/user')).toBe('/data/user/vaults/doc-1.enc');
  });
});

describe('extractRehydrationMap', () => {
  test('reads the decrypted map from structured results', () => {
    expect(
      extractRehydrationMap({ structuredContent: { result: { map: { '[EMAIL_0]': 'a@b.c' } } } }),
    ).toEqual({ '[EMAIL_0]': 'a@b.c' });
  });

  test('returns empty map when nothing decrypted', () => {
    expect(extractRehydrationMap(null)).toEqual({});
  });
});
