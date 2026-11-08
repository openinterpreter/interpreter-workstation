import { describe, expect, test } from 'bun:test';
import type { BuiltinToolContext } from '../../builtinTools';
import { listTerminalsForCaller, nativeTerminalListTool, nativeTerminalStatusTool,
  readTerminalForCaller } from './nativeTerminalStatusTool';

const threadId = '00000000-0000-4000-8000-000000000077';
const args = { turnId: 'turn_1', itemId: 'item_1', nativeProcessId: 'process_1',
  terminalGeneration: 7, maxWaitMs: 500 };
const exited = { phase: 'exited' as const, outputBytes: 32, outputSha256: 'a'.repeat(64),
  outputCapReached: false, exitCode: 0, terminalGeneration: 7, observationTimedOut: false };
const caller: BuiltinToolContext = { threadId, verifiedCallerThreadId: threadId };

describe('same-thread live native terminal tool', () => {
  test('passes only exact owner identifiers to the version-gated native reader', async () => {
    const requests: unknown[] = [];
    const result = await readTerminalForCaller(caller, args, async request => {
      requests.push(request); return exited;
    });
    expect(requests).toEqual([{ threadId, ...args }]);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ available: true, ...exited });
    expect(nativeTerminalStatusTool.mainAgentOnly).toBe(true);
    expect(nativeTerminalStatusTool.mode).toBe('read');
  });

  test('missing binding, delegate, wrong thread and malformed native owner never reach native', async () => {
    let calls = 0;
    const read = async () => { calls++; return exited; };
    for (const context of [undefined, { threadId },
      { threadId, verifiedCallerThreadId: '00000000-0000-4000-8000-000000000078' },
      { ...caller, isSubagent: true }, { ...caller, toolCallPath: ['delegate'] }]) {
      const result = await readTerminalForCaller(context, args, read);
      expect(JSON.parse(result.content[0]!.text).category).toBe('caller_unavailable');
    }
    for (const request of [{ ...args, maxWaitMs: 1001 }, { ...args, terminalGeneration: 0 },
      { ...args, nativeProcessId: 'PRIVATE COMMAND' }]) {
      const result = await readTerminalForCaller(caller, request, read);
      expect(JSON.parse(result.content[0]!.text).category).toBe('invalid_owner');
    }
    expect(calls).toBe(0);
  });

  test('unsupported runtime and unknown underlying result do not leak errors or claim a live process', async () => {
    const result = await readTerminalForCaller(caller, args,
      async () => { throw new Error('PRIVATE native output, not a process result'); });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ available: false,
      category: 'observation_unavailable' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const malicious = await readTerminalForCaller(caller, args,
      async () => ({ ...exited, command: 'PRIVATE COMMAND' }));
    expect(JSON.stringify(malicious)).not.toContain('PRIVATE');
    const reused = await readTerminalForCaller(caller, args,
      async () => ({ ...exited, terminalGeneration: 8 }));
    expect(JSON.parse(reused.content[0]!.text).phase).toBe('unknown');
  });
});

describe('same-thread native terminal owner listing', () => {
  test('uses bound thread and projects only owner IDs with a bounded cursor', async () => {
    const calls: unknown[] = [];
    const result = await listTerminalsForCaller(caller, 'next_1', async (thread, cursor) => {
      calls.push([thread, cursor]);
      return { data: [{ threadId, ...args, command: 'PRIVATE COMMAND', osPid: 100 }],
        nextCursor: 'next_2' };
    });
    expect(calls).toEqual([[threadId, 'next_1']]);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ available: true,
      data: [{ turnId: args.turnId, itemId: args.itemId,
        nativeProcessId: args.nativeProcessId, terminalGeneration: args.terminalGeneration }],
      nextCursor: 'next_2' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(nativeTerminalListTool.mainAgentOnly).toBe(true);
  });

  test('rejects cross-owner, forged cursor and delegated callers without exposing native errors', async () => {
    let calls = 0;
    const read = async () => { calls++; return { data: [], nextCursor: null }; };
    const unbound = await listTerminalsForCaller({ ...caller, isSubagent: true }, undefined, read);
    expect(JSON.parse(unbound.content[0]!.text).category).toBe('caller_unavailable');
    const invalid = await listTerminalsForCaller(caller, '../private', read);
    expect(JSON.parse(invalid.content[0]!.text).category).toBe('invalid_cursor');
    expect(calls).toBe(0);
    const other = await listTerminalsForCaller(caller, undefined,
      async () => ({ data: [{ ...args, threadId: '00000000-0000-4000-8000-000000000078' }],
        nextCursor: null }));
    expect(JSON.parse(other.content[0]!.text).category).toBe('observation_unavailable');
    const failure = await listTerminalsForCaller(caller, undefined,
      async () => { throw new Error('PRIVATE native command'); });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE');
  });
});
