import { describe, expect, test } from 'bun:test';
import {
  isInterpreterOverlaySupportedPlatform,
  isOfficeExtensionSupportedPlatform,
} from './interpreter-overlay-platform';

describe('isInterpreterOverlaySupportedPlatform', () => {
  test('returns true for desktop overlay platforms', () => {
    expect(isInterpreterOverlaySupportedPlatform('darwin')).toBe(true);
    expect(isInterpreterOverlaySupportedPlatform('win32')).toBe(true);
    expect(isInterpreterOverlaySupportedPlatform('linux')).toBe(true);
  });

  test('returns false for unsupported and missing platform values', () => {
    expect(isInterpreterOverlaySupportedPlatform('freebsd')).toBe(false);
    expect(isInterpreterOverlaySupportedPlatform('')).toBe(false);
    expect(isInterpreterOverlaySupportedPlatform(null)).toBe(false);
    expect(isInterpreterOverlaySupportedPlatform(undefined)).toBe(false);
  });
});

describe('isOfficeExtensionSupportedPlatform', () => {
  test('returns true for supported platforms', () => {
    expect(isOfficeExtensionSupportedPlatform('darwin')).toBe(true);
    expect(isOfficeExtensionSupportedPlatform('win32')).toBe(true);
  });

  test('returns false for unsupported and missing platform values', () => {
    expect(isOfficeExtensionSupportedPlatform('linux')).toBe(false);
    expect(isOfficeExtensionSupportedPlatform('freebsd')).toBe(false);
    expect(isOfficeExtensionSupportedPlatform('')).toBe(false);
    expect(isOfficeExtensionSupportedPlatform(null)).toBe(false);
    expect(isOfficeExtensionSupportedPlatform(undefined)).toBe(false);
  });
});
