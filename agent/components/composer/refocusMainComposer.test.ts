import { describe, expect, mock, test } from 'bun:test';
import { refocusMainComposer } from './refocusMainComposer';

describe('refocusMainComposer', () => {
  test('focuses immediately and across two animation frames', () => {
    const focus = mock(() => {});
    const callbacks: Array<() => void> = [];

    refocusMainComposer(
      { commands: { focus } },
      (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    );

    expect(focus).toHaveBeenCalledTimes(1);
    expect(callbacks).toHaveLength(1);

    callbacks.shift()?.();
    expect(focus).toHaveBeenCalledTimes(2);
    expect(callbacks).toHaveLength(1);

    callbacks.shift()?.();
    expect(focus).toHaveBeenCalledTimes(3);
    expect(callbacks).toHaveLength(0);
  });
});
