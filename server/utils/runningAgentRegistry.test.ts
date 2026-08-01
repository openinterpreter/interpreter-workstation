import { describe, test, expect, beforeEach } from 'bun:test';
import {
  registerRunningAgent,
  stopAgentAndDescendants,
  stopAllRunningAgents,
  clearAllRunningAgents,
  getRunningAgentCount,
  getRunningAgentIds,
} from './runningAgentRegistry';

beforeEach(() => {
  clearAllRunningAgents();
});

describe('registerRunningAgent', () => {
  test('registers agent and increases count', () => {
    registerRunningAgent('root', new AbortController());

    expect(getRunningAgentCount()).toBe(1);
    expect(getRunningAgentIds()).toContain('root');
  });

  test('re-registration unregisters previous', () => {
    const first = new AbortController();
    registerRunningAgent('root', first);

    const second = new AbortController();
    registerRunningAgent('root', second);

    expect(getRunningAgentCount()).toBe(1);
    expect(first.signal.aborted).toBe(false);
  });

  test('registers parent-child relationship', () => {
    registerRunningAgent('parent', new AbortController());
    registerRunningAgent('child', new AbortController(), 'parent');

    expect(getRunningAgentCount()).toBe(2);
    expect(getRunningAgentIds()).toContain('child');
  });
});

describe('stopAgentAndDescendants', () => {
  test('stops agent and aborts controller', async () => {
    const ac = new AbortController();
    registerRunningAgent('root', ac);

    await stopAgentAndDescendants('root');

    expect(ac.signal.aborted).toBe(true);
    expect(getRunningAgentCount()).toBe(0);
  });

  test('depth-first stops children before parent', async () => {
    const order: string[] = [];
    const parentAc = new AbortController();
    const childAc = new AbortController();

    registerRunningAgent('parent', parentAc, null, () => { order.push('parent'); });
    registerRunningAgent('child', childAc, 'parent', () => { order.push('child'); });

    await stopAgentAndDescendants('parent');

    expect(order).toEqual(['child', 'parent']);
  });

  test('calls onStop callback', async () => {
    let called = false;
    registerRunningAgent('root', new AbortController(), null, () => { called = true; });

    await stopAgentAndDescendants('root');

    expect(called).toBe(true);
  });

  test('no-op for unknown agent', async () => {
    await stopAgentAndDescendants('ghost');

    expect(getRunningAgentCount()).toBe(0);
  });

  test('idempotent abort', async () => {
    const ac = new AbortController();
    registerRunningAgent('root', ac);
    ac.abort();

    await stopAgentAndDescendants('root');

    expect(ac.signal.aborted).toBe(true);
    expect(getRunningAgentCount()).toBe(0);
  });
});

describe('stopAllRunningAgents', () => {
  test('stops all root agents and descendants', async () => {
    const order: string[] = [];
    const rootA = new AbortController();
    const childA = new AbortController();
    const rootB = new AbortController();

    registerRunningAgent('root-a', rootA, null, () => { order.push('root-a'); });
    registerRunningAgent('child-a', childA, 'root-a', () => { order.push('child-a'); });
    registerRunningAgent('root-b', rootB, null, () => { order.push('root-b'); });

    const stoppedAgentIds = await stopAllRunningAgents();

    expect(stoppedAgentIds).toEqual(['root-a', 'child-a', 'root-b']);
    expect(order).toEqual(['child-a', 'root-a', 'root-b']);
    expect(rootA.signal.aborted).toBe(true);
    expect(childA.signal.aborted).toBe(true);
    expect(rootB.signal.aborted).toBe(true);
    expect(getRunningAgentCount()).toBe(0);
  });
});

describe('clearAllRunningAgents', () => {
  test('aborts all controllers', () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    registerRunningAgent('a', ac1);
    registerRunningAgent('b', ac2);

    clearAllRunningAgents();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
  });

  test('count is zero after clear', () => {
    registerRunningAgent('a', new AbortController());
    registerRunningAgent('b', new AbortController());

    clearAllRunningAgents();

    expect(getRunningAgentCount()).toBe(0);
  });
});
