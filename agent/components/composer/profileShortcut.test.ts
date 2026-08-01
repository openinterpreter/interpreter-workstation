import { describe, expect, test } from 'bun:test';
import { resolveProfileShortcutSlot } from './profileShortcut';

function makeEvent(overrides: Partial<Parameters<typeof resolveProfileShortcutSlot>[0]> = {}) {
  return {
    altKey: true,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    key: '2',
    code: 'Digit2',
    ...overrides,
  };
}

describe('resolveProfileShortcutSlot', () => {
  test('uses number-row code when available', () => {
    expect(resolveProfileShortcutSlot(makeEvent({ code: 'Digit3', key: '#' }))).toBe(3);
  });

  test('supports numpad number keys', () => {
    expect(resolveProfileShortcutSlot(makeEvent({
      metaKey: false,
      ctrlKey: true,
      code: 'Numpad9',
      key: '9',
    }))).toBe(9);
  });

  test('supports digit key fallback when code is unavailable', () => {
    expect(resolveProfileShortcutSlot(makeEvent({ code: 'Unidentified', key: '4' }))).toBe(4);
  });

  test('supports mac option-number symbols when code is unavailable', () => {
    expect(resolveProfileShortcutSlot(makeEvent({ code: 'Unidentified', key: '™' }))).toBe(2);
  });

  test('rejects non-shortcut modifier combinations', () => {
    expect(resolveProfileShortcutSlot(makeEvent({ altKey: false }))).toBeNull();
    expect(resolveProfileShortcutSlot(makeEvent({ shiftKey: true }))).toBeNull();
    expect(resolveProfileShortcutSlot(makeEvent({ metaKey: false, ctrlKey: false }))).toBeNull();
  });
});
