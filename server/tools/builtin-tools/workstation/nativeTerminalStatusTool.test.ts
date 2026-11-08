import { describe, expect, test } from 'bun:test';
import type { BuiltinToolContext } from '../../builtinTools';
import { nativeTerminalStatusTool, readTerminalForCaller } from './nativeTerminalStatusTool';

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
