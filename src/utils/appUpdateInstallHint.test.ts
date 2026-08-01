import { describe, expect, it } from 'bun:test';
import { getAppUpdateInstallHintKey, getAppUpdateSubtitleKey } from './appUpdateInstallHint';

describe('getAppUpdateInstallHintKey', () => {
  it('returns null when install is not running', () => {
    expect(
      getAppUpdateInstallHintKey({
        isInstalling: false,
        didDelayExpire: true,
      }),
    ).toBeNull();
  });

  it('returns null before the delayed hint threshold', () => {
    expect(
      getAppUpdateInstallHintKey({
        isInstalling: true,
        didDelayExpire: false,
      }),
    ).toBeNull();
  });

  it('returns the delayed hint on macOS', () => {
    expect(
      getAppUpdateInstallHintKey({
        isInstalling: true,
        didDelayExpire: true,
      }),
    ).toBe('appUpdate.installHintDelayed');
  });

  it('returns the delayed hint on Linux', () => {
    expect(
      getAppUpdateInstallHintKey({
        isInstalling: true,
        didDelayExpire: true,
      }),
    ).toBe('appUpdate.installHintDelayed');
  });
});

describe('getAppUpdateSubtitleKey', () => {
  it('returns the default subtitle before the install delay expires', () => {
    expect(
      getAppUpdateSubtitleKey({
        isInstalling: true,
        didDelayExpire: false,
      }),
    ).toBe('appUpdate.subtitle');
  });

  it('returns the delayed subtitle after the install delay expires', () => {
    expect(
      getAppUpdateSubtitleKey({
        isInstalling: true,
        didDelayExpire: true,
      }),
    ).toBe('appUpdate.restartingDelayed');
  });
});
