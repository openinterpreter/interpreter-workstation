// Behavior tests for liveItemsStore.
//   * setLiveToolCall notifies listeners on real content changes.
//   * setLiveToolCall is silent when the new snapshot is render-equal.
//   * clearLiveToolCallsForIds wakes listeners with null.

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ToolCallInfo } from '../hooks/use-chat';
import {
  __resetLiveToolCallsForTests,
  clearLiveToolCallsForIds,
  getLiveToolCall,
  setLiveToolCall,
  subscribeLiveToolCall,
} from './liveItemsStore';

function toolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    id: 'tc-1',
    type: 'commandExecution',
    label: 'sleep 5',
    state: 'loading',
    output: '',
    ...overrides,
  } as ToolCallInfo;
}

afterEach(() => {
  __resetLiveToolCallsForTests();
});

describe('liveItemsStore', () => {
  test('setLiveToolCall stores the snapshot and notifies subscribers', () => {
    const listener = vi.fn();
    const unsub = subscribeLiveToolCall('tc-1', listener);

    setLiveToolCall('tc-1', toolCall({ output: 'hello' }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLiveToolCall('tc-1')?.output).toBe('hello');

    unsub();
  });

  test('subsequent setLiveToolCall with no render-relevant change is silent', () => {
    const listener = vi.fn();
    subscribeLiveToolCall('tc-1', listener);

    setLiveToolCall('tc-1', toolCall({ output: 'hello' }));
    expect(listener).toHaveBeenCalledTimes(1);

    // Same state, same output — different object identity. Should NOT notify.
    setLiveToolCall('tc-1', toolCall({ output: 'hello' }));
    expect(listener).toHaveBeenCalledTimes(1);

    // Output changes — should notify.
    setLiveToolCall('tc-1', toolCall({ output: 'hello world' }));
    expect(listener).toHaveBeenCalledTimes(2);

    // State changes — should notify.
    setLiveToolCall('tc-1', toolCall({ output: 'hello world', state: 'complete' }));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  test('listeners for one item id are not woken by other ids', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeLiveToolCall('tc-1', a);
    subscribeLiveToolCall('tc-2', b);

    setLiveToolCall('tc-1', toolCall({ id: 'tc-1', output: 'x' }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(0);

    setLiveToolCall('tc-2', toolCall({ id: 'tc-2', output: 'y' }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test('unsubscribe stops further notifications', () => {
    const listener = vi.fn();
    const unsub = subscribeLiveToolCall('tc-1', listener);

    setLiveToolCall('tc-1', toolCall({ output: 'first' }));
    unsub();
    setLiveToolCall('tc-1', toolCall({ output: 'second' }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('clearLiveToolCallsForIds removes snapshots and notifies listeners', () => {
    const listener = vi.fn();
    subscribeLiveToolCall('tc-1', listener);
    setLiveToolCall('tc-1', toolCall({ output: 'hello' }));
    expect(listener).toHaveBeenCalledTimes(1);

    clearLiveToolCallsForIds(['tc-1']);
    expect(getLiveToolCall('tc-1')).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
