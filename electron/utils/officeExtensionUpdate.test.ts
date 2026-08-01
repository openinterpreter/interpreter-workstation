import { describe, expect, test } from 'bun:test';
import { extractLatestOoEditorsVersion, shouldUpdateOoEditors } from './officeExtensionUpdate';

describe('shouldUpdateOoEditors', () => {
  test('returns false when not installed', () => {
    expect(shouldUpdateOoEditors(null, '1.0.1')).toBe(false);
  });

  test('returns false when latest version is missing', () => {
    expect(shouldUpdateOoEditors('1.0.1', null)).toBe(false);
  });

  test('returns true when latest is newer', () => {
    expect(shouldUpdateOoEditors('1.0.1', '1.1.0')).toBe(true);
  });

  test('returns false when latest is equal', () => {
    expect(shouldUpdateOoEditors('1.0.1', '1.0.1')).toBe(false);
  });

  test('returns false when latest is older', () => {
    expect(shouldUpdateOoEditors('1.0.2', '1.0.1')).toBe(false);
  });

  test('accepts v-prefixed versions', () => {
    expect(shouldUpdateOoEditors('v1.0.0', 'v1.0.1')).toBe(true);
  });

  test('throws on invalid versions', () => {
    expect(() => shouldUpdateOoEditors('1.0.0', 'beta')).toThrow();
  });
});

describe('extractLatestOoEditorsVersion', () => {
  test('returns tag_name when present', () => {
    expect(extractLatestOoEditorsVersion({ tag_name: 'v1.2.3' })).toBe('v1.2.3');
  });

  test('falls back to name when tag_name missing', () => {
    expect(extractLatestOoEditorsVersion({ name: '1.2.4' })).toBe('1.2.4');
  });

  test('returns null for empty strings', () => {
    expect(extractLatestOoEditorsVersion({ tag_name: '  ' })).toBeNull();
  });

  test('returns null when no version fields present', () => {
    expect(extractLatestOoEditorsVersion({})).toBeNull();
  });

  test('returns null when payload is null', () => {
    expect(extractLatestOoEditorsVersion(null)).toBeNull();
  });
});
