import { describe, expect, test } from 'bun:test';
import {
  isVersionBelow,
  isVersionGreaterThan,
  normalizeVersion,
  tryNormalizeVersion,
} from './version';

describe('normalizeVersion', () => {
  test('passes through a strict semver', () => {
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
  });

  test('coerces a loose version and strips a leading v', () => {
    expect(normalizeVersion('v0.13')).toBe('0.13.0');
  });

  test('throws on empty', () => {
    expect(() => normalizeVersion('   ')).toThrow();
  });

  test('throws on unparseable', () => {
    expect(() => normalizeVersion('beta')).toThrow();
  });
});

describe('tryNormalizeVersion', () => {
  test('returns null instead of throwing on bad input', () => {
    expect(tryNormalizeVersion('beta')).toBeNull();
    expect(tryNormalizeVersion('')).toBeNull();
    expect(tryNormalizeVersion(null)).toBeNull();
    expect(tryNormalizeVersion(undefined)).toBeNull();
  });

  test('coerces valid input', () => {
    expect(tryNormalizeVersion('v0.13.4-rc1')).toBe('0.13.4-rc1');
  });
});

describe('isVersionGreaterThan', () => {
  test('true when version exceeds baseline', () => {
    expect(isVersionGreaterThan('1.1.0', '1.0.1')).toBe(true);
  });

  test('false when equal or lower', () => {
    expect(isVersionGreaterThan('1.0.1', '1.0.1')).toBe(false);
    expect(isVersionGreaterThan('1.0.1', '1.0.2')).toBe(false);
  });

  test('throws on unparseable input (oo-editors contract)', () => {
    expect(() => isVersionGreaterThan('beta', '1.0.0')).toThrow();
  });
});

describe('isVersionBelow', () => {
  test('true when version is older than the minimum', () => {
    expect(isVersionBelow('0.11.2', '0.13.4')).toBe(true);
  });

  test('false at or above the minimum', () => {
    expect(isVersionBelow('0.13.4', '0.13.4')).toBe(false);
    expect(isVersionBelow('0.24.0', '0.13.4')).toBe(false);
  });

  test('false (safe default) on empty or unparseable input', () => {
    expect(isVersionBelow(null, '0.13.4')).toBe(false);
    expect(isVersionBelow('beta', '0.13.4')).toBe(false);
  });
});
