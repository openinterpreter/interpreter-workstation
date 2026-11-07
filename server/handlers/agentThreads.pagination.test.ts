import { describe, expect, test } from 'bun:test';
import type { v2 } from './codex-generated-types/index';
import { listAllThreadIds } from './agentThreads';

const params = { limit: 100 } as v2.ThreadListParams;
const page = (ids: string[], nextCursor: string | null): v2.ThreadListResponse => ({
  data: ids.map((id) => ({ id }) as v2.Thread),
  nextCursor,
});

describe('complete thread inventory', () => {
  test('includes every page beyond a single native page without silently truncating', async () => {
    const ids = Array.from({ length: 525 }, (_, index) => `thread_${index}`);
    let calls = 0;
    const result = await listAllThreadIds({ listThreads: async ({ cursor }) => {
      expect(cursor ?? null).toBe(calls ? `${calls}|thread_${calls * 100 - 1}` : null);
      const start = calls++ * 100;
      return page(ids.slice(start, start + 100), start + 100 < ids.length
        ? `${calls}|thread_${start + 99}` : null);
    } }, params);
    expect(result).toEqual(ids);
    expect(calls).toBe(6);
  });

  test('fails closed on a repeated cursor or duplicate thread ID', async () => {
    let cursorCalls = 0;
    await expect(listAllThreadIds({ listThreads: async () => page([`thread_${++cursorCalls}`], 'cursor') }, params))
      .rejects.toThrow(/repeated thread inventory cursor/);
    let calls = 0;
    await expect(listAllThreadIds({ listThreads: async () =>
      calls++ ? page(['thread_1'], null) : page(['thread_1'], 'cursor') }, params))
      .rejects.toThrow(/repeated thread inventory ID/);
  });

  test('rejects malformed and oversized pages without claiming a complete inventory', async () => {
    await expect(listAllThreadIds({ listThreads: async () => page(['invalid id'], null) }, params))
      .rejects.toThrow(/invalid or repeated thread inventory ID/i);
    await expect(listAllThreadIds({ listThreads: async () => page(Array.from({ length: 101 }, (_, i) => `t${i}`), null) }, params))
      .rejects.toThrow(/invalid thread inventory page/i);
    await expect(listAllThreadIds({ listThreads: async () => page(['thread_1'], 'cursor\nprivate') }, params))
      .rejects.toThrow(/invalid or repeated thread inventory cursor/i);
  });
});
