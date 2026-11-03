import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { nativeCommandSessionSnapshot, nativeTurnReceipt } from './native-turn-receipt';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('current native command observation', () => {
  const turn = { id: 'turn_1', status: 'inProgress', items: [
    { type: 'commandExecution', id: 'item_1', processId: 'process_1', status: 'inProgress',
      aggregatedOutput: 'private incremental output', exitCode: null, command: 'private shell' },
  ] };
  test('reports native in-progress session and output digest without disclosing private text or claiming OS liveness', () => {
    const observation = nativeCommandSessionSnapshot(turn, true);
    expect(observation).toEqual({ scope: 'native-thread-read-not-os-process-custody', sessions: [
      { itemId: 'item_1', processId: 'process_1', status: 'inProgress', nativeTurnActiveAtRead: true,
        exitCode: null, outputBytes: 26, outputSha256: sha('private incremental output') },
    ] });
    expect(JSON.stringify(observation)).not.toMatch(/private|shell/);
  });
  test('never upgrades a saved or racy completed native turn to live process custody', () => {
    expect(nativeCommandSessionSnapshot(turn, false).sessions[0].nativeTurnActiveAtRead).toBe(false);
    expect(nativeCommandSessionSnapshot({ ...turn, status: 'completed', items: [
      { ...turn.items[0], status: 'completed', exitCode: 0 },
    ] }, true).sessions[0]).toMatchObject({ nativeTurnActiveAtRead: false, exitCode: 0 });
    expect(nativeCommandSessionSnapshot(null, true).sessions).toEqual([]);
  });
  test('fails closed on malformed identifiers, excessive output and unbounded items', () => {
    expect(() => nativeCommandSessionSnapshot({ ...turn, items: [{ ...turn.items[0], processId: 'private process' }] }, true)).toThrow();
    expect(() => nativeCommandSessionSnapshot({ ...turn, items: [{ ...turn.items[0], aggregatedOutput: 'x'.repeat(16_777_217) }] }, true)).toThrow();
    expect(() => nativeCommandSessionSnapshot({ ...turn, items: Array(201).fill(turn.items[0]) }, true)).toThrow();
  });
});

describe('exact native turn receipt', () => {
  test('returns bounded user and supervised-command hashes, never message, output or error prose', () => {
    const input = { id: 'turn_1', status: 'failed', items: [
      { type: 'userMessage', id: 'item_1', content: [{ type: 'text', text: 'private task' }] },
      { type: 'commandExecution', id: 'item_2', processId: 'process_1',
        status: 'completed', aggregatedOutput: 'private stdout', exitCode: 7, command: 'secret command' },
      { type: 'agentMessage', id: 'agent_1', text: 'private helpful response' },
      { type: 'mcpToolCall', id: 'tool_1', status: 'completed', server: 'private-server',
        tool: 'private-outbound', arguments: { body: 'private payload' } },
      { type: 'functionCallOutput', id: 'output_1', output: 'private provider receipt' },
    ], error: { message: 'private error', codexErrorInfo: 'serverOverloaded' } };
    const result = nativeTurnReceipt(input);
    expect(result.userItems).toEqual([{ itemId: 'item_1',
      contentSha256: sha(JSON.stringify(input.items[0].content)),
      contentBytes: Buffer.byteLength(JSON.stringify(input.items[0].content)), clientUserMessageId: null }]);
    expect(result.commandSessions).toEqual([{ itemId: 'item_2', processId: 'process_1',
      status: 'completed', exitCode: 7, outputSha256: sha('private stdout'), outputBytes: 14 }]);
    expect(result.agentMessages).toEqual([{ itemId: 'agent_1', contentSha256: sha('private helpful response'), contentBytes: 24 }]);
    expect(result.toolObservations).toEqual([
      { itemId: 'tool_1', kind: 'mcpToolCall', status: 'completed' },
      { itemId: 'output_1', kind: 'functionCallOutput', status: 'recorded' },
    ]);
    expect(result.externalDeliveryScope).toBe('not-established-by-native-turn');
    expect(result.error).toEqual({ category: 'serverOverloaded', sha256: sha('private error'), bytes: 13 });
    expect(result.clientIdLinkage).toBe('unavailable-from-native-turn');
    expect(result.commandSessionScope).toBe('saved-native-turn-only-not-live-process-custody');
    expect(JSON.stringify(result)).not.toMatch(/private|secret/);
  });

  test('does not infer admission from a failed turn without user item or from a processId', () => {
    const result = nativeTurnReceipt({ id: 'turn_2', status: 'failed', items: [
      { type: 'commandExecution', id: 'item_9', processId: null, status: 'inProgress', aggregatedOutput: null },
    ], error: { message: 'unknown', codexErrorInfo: { newUnknownCategory: {} } } });
    expect(result.userItems).toEqual([]);
    expect(result.commandSessions[0]?.processId).toBeNull();
    expect(result.commandSessions[0]?.exitCode).toBeNull();
    expect(result.error?.category).toBe('unclassified');
  });

  test('rejects malformed or unbounded native items instead of claiming complete custody', () => {
    expect(() => nativeTurnReceipt({ id: 'turn_3', status: 'completed', items: [{}] })).toThrow();
    expect(() => nativeTurnReceipt({ id: 'turn_3', status: 'completed', items: Array(2001).fill({ type: 'userMessage', id: 'x' }) })).toThrow();
    expect(() => nativeTurnReceipt({ id: 'turn_3', status: 'completed', items: [
      { type: 'commandExecution', id: 'cmd', aggregatedOutput: 'x'.repeat(16_777_217) },
    ] })).toThrow();
  });
  test('rejects excessive model output and malformed tool item rather than disclosing it', () => {
    expect(() => nativeTurnReceipt({ id: 'turn_3', status: 'completed', items: [
      { type: 'agentMessage', id: 'item_1', text: 'x'.repeat(1_048_577) },
    ] })).toThrow();
    expect(() => nativeTurnReceipt({ id: 'turn_3', status: 'completed', items: [
      { type: 'mcpToolCall', id: 'invalid tool id', status: 'completed' },
    ] })).toThrow();
  });
});
