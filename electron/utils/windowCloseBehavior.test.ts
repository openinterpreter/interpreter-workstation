import { describe, expect, mock, test } from 'bun:test';
import { destroyTraySafely, shouldKeepAppResident } from './windowCloseBehavior';

describe('shouldKeepAppResident', () => {
  test('always keeps the app resident even without overlay tray mode', () => {
    expect(shouldKeepAppResident()).toBe(true);
  });

  test('keeps the app resident when the overlay tray is enabled', () => {
    expect(shouldKeepAppResident()).toBe(true);
  });
});

describe('destroyTraySafely', () => {
  test('returns null for missing tray', () => {
    expect(destroyTraySafely(null)).toBeNull();
  });

  test('destroys a live tray instance', () => {
    const destroy = mock(() => {});
    const tray = { destroy };

    expect(destroyTraySafely(tray)).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('skips destroy when tray is already destroyed', () => {
    const destroy = mock(() => {});
    const tray = {
      destroy,
      isDestroyed: () => true,
    };

    expect(destroyTraySafely(tray)).toBeNull();
    expect(destroy).not.toHaveBeenCalled();
  });

  test('swallows destroyed tray TypeError during cleanup', () => {
    const warning = mock((_message: string) => {});
    const tray = {
      destroy: () => {
        throw new TypeError('Object has been destroyed');
      },
      isDestroyed: () => false,
    };

    expect(destroyTraySafely(tray, { warn: warning })).toBeNull();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('[Main] Tray already destroyed during cleanup');
  });

  test('rethrows non-destroy errors', () => {
    const tray = {
      destroy: () => {
        throw new Error('unexpected tray failure');
      },
      isDestroyed: () => false,
    };

    expect(() => destroyTraySafely(tray)).toThrow('unexpected tray failure');
  });
});
