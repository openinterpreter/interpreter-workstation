import { describe, test, expect, beforeEach } from 'bun:test';
import type { SubagentToolCallEvent } from '../../electron/ipc/registry';
import {
  addSubagentToolCall,
  getDirectChildren,
  getSubtree,
  clearSubagentToolCalls,
  clearAllSubagentToolCalls,
} from './subagentToolStore';

function makeEvent(
  toolCallId: string,
  toolCallPath: string[],
  parentToolCallId: string,
  result?: { output: any; isError: boolean },
): SubagentToolCallEvent {
  return {
    toolCallPath,
    depth: toolCallPath.length,
    parentToolCallId,
    subagentName: 'test',
    toolCall: { toolCallId, toolName: 'test_tool', args: {} },
    ...(result ? { result } : {}),
  } as SubagentToolCallEvent;
}

beforeEach(() => {
  clearAllSubagentToolCalls();
});

describe('addSubagentToolCall', () => {
  test('stores new tool call', () => {
    const event = makeEvent('tc1', ['explore-root'], 'root');

    addSubagentToolCall(event);

    const children = getDirectChildren([]);
    expect(children).toHaveLength(1);
    expect(children[0].toolCall.toolCallId).toBe('tc1');
  });

  test('merges result into existing call', () => {
    const call = makeEvent('tc1', ['explore-root'], 'root');
    const result = makeEvent('tc1', ['explore-root'], 'root', { output: 'done', isError: false });

    addSubagentToolCall(call);
    addSubagentToolCall(result);

    const children = getDirectChildren([]);
    expect(children[0].result).toEqual({ output: 'done', isError: false });
  });

  test('handles orphaned result (result before call)', () => {
    const orphan = makeEvent('tc1', ['explore-root'], 'root', { output: 'early', isError: false });

    addSubagentToolCall(orphan);

    const children = getDirectChildren([]);
    expect(children).toHaveLength(1);
    expect(children[0].result).toEqual({ output: 'early', isError: false });
  });

  test('ignores duplicate call (no result)', () => {
    const call = makeEvent('tc1', ['explore-root'], 'root');

    addSubagentToolCall(call);
    addSubagentToolCall(call);

    const children = getDirectChildren([]);
    expect(children).toHaveLength(1);
  });
});

describe('getDirectChildren', () => {
  test('returns only direct children of path', () => {
    addSubagentToolCall(makeEvent('tc1', ['explore-root'], 'root'));
    addSubagentToolCall(makeEvent('tc2', ['explore-root', 'task-tc2'], 'root'));
    addSubagentToolCall(makeEvent('tc3', ['explore-root', 'task-tc2', 'read-tc3'], 'root'));

    const direct = getDirectChildren(['explore-root']);

    expect(direct).toHaveLength(1);
    expect(direct[0].toolCall.toolCallId).toBe('tc2');
  });

  test('returns empty for leaf nodes', () => {
    addSubagentToolCall(makeEvent('tc1', ['explore-root'], 'root'));

    const children = getDirectChildren(['explore-root']);

    expect(children).toHaveLength(0);
  });
});

describe('getSubtree', () => {
  test('returns all descendants', () => {
    addSubagentToolCall(makeEvent('tc1', ['explore-root'], 'root'));
    addSubagentToolCall(makeEvent('tc2', ['explore-root', 'task-tc2'], 'root'));
    addSubagentToolCall(makeEvent('tc3', ['explore-root', 'task-tc2', 'read-tc3'], 'root'));

    const subtree = getSubtree(['explore-root']);

    expect(subtree).toHaveLength(3);
    const ids = subtree.map(e => e.toolCall.toolCallId).sort();
    expect(ids).toEqual(['tc1', 'tc2', 'tc3']);
  });
});

describe('clearSubagentToolCalls', () => {
  test('clears specific parent', () => {
    addSubagentToolCall(makeEvent('tc1', ['explore-root'], 'root'));
    addSubagentToolCall(makeEvent('tc2', ['explore-other'], 'other'));

    clearSubagentToolCalls('root');

    const rootChildren = getDirectChildren([]);
    // NOTE(victor): clearSubagentToolCalls uses the root parent index, not path-based lookup
    expect(rootChildren.some(e => e.toolCall.toolCallId === 'tc1')).toBe(false);
    expect(rootChildren.some(e => e.toolCall.toolCallId === 'tc2')).toBe(true);
  });
});

describe('clearAllSubagentToolCalls', () => {
  test('clears everything', () => {
    addSubagentToolCall(makeEvent('tc1', ['explore-root'], 'root'));
    addSubagentToolCall(makeEvent('tc2', ['explore-other'], 'other'));

    clearAllSubagentToolCalls();

    expect(getDirectChildren([])).toHaveLength(0);
    expect(getSubtree([])).toHaveLength(0);
  });
});
