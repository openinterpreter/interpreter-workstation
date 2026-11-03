import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { nativeTurnReceipt } from './native-turn-receipt';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('exact native turn receipt', () => {
  test('returns bounded user and supervised-command hashes, never message, output or error prose', () => {
    const input = { id: 'turn_1', status: 'failed', items: [
      { type: 'userMessage', id: 'item_1', content: [{ type: 'text', text: 'private task' }] },
      { type: 'commandExecution', id: 'item_2', processId: 'process_1',
        status: 'completed', aggregatedOutput: 'private stdout', exitCode: 7, command: 'secret command' },
    ], error: { message: 'private error', codexErrorInfo: 'serverOverloaded' } };
    const result = nativeTurnReceipt(input);
    expect(result.userItems).toEqual([{ itemId: 'item_1',
      contentSha256: sha(JSON.stringify(input.items[0].content)),
      contentBytes: Buffer.byteLength(JSON.stringify(input.items[0].content)), clientUserMessageId: null }]);
    expect(result.commandSessions).toEqual([{ itemId: 'item_2', processId: 'process_1',
      status: 'completed', exitCode: 7, outputSha256: sha('private stdout'), outputBytes: 14 }]);
    expect(result.error).toEqual({ category: 'serverOverloaded', sha256: sha('private error'), bytes: 13 });
    expect(result.clientIdLinkage).toBe('unavailable-from-native-turn');
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
});
