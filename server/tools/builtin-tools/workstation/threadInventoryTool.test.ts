import { describe, expect, test } from 'bun:test';
import type { BuiltinToolContext } from '../../builtinTools';
import type { v2 } from '../../../handlers/codex-generated-types/index';
import { readThreadInventoryForCaller, threadInventoryTool } from './threadInventoryTool';

const threadId = '00000000-0000-4000-8000-000000000077';
const other = '00000000-0000-4000-8000-000000000078';
const owner = { threadId, verifiedCallerThreadId: threadId };
const page = (ids: string[], nextCursor: string | null): v2.ThreadListResponse => ({
  data: ids.map(id => ({ id, status: { type: 'idle' }, preview: 'PRIVATE',
    path: '/private/path', name: 'PRIVATE NAME' })) as unknown as v2.Thread[],
  nextCursor, backwardsCursor: null,
});
const parse = (result: Awaited<ReturnType<typeof readThreadInventoryForCaller>>) =>
  JSON.parse(result.content[0]!.text);

describe('verified main-agent local thread inventory', () => {
  test('pages only bounded native IDs/status, preserving opaque cursor and privacy', async () => {
    const calls: v2.ThreadListParams[] = [];
    const first = await readThreadInventoryForCaller(owner, undefined, async params => {
      calls.push(params); return page([threadId], 'opaque|cursor');
    });
    expect(first.isError).toBeUndefined();
    expect(parse(first)).toEqual({ available: true, scope: 'local-computer',
      observation: 'saved-native-thread-page-not-queue-or-process-custody',
      threads: [{ threadId, status: 'idle' }],
      nextCursor: 'opaque|cursor', pageExhausted: false });
    expect(calls[0]).toMatchObject({ sourceKinds: ['cli', 'vscode', 'exec', 'appServer',
        'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn',
        'subAgentOther', 'unknown'],
      modelProviders: [], limit: 100, useStateDbOnly: true });
    expect(JSON.stringify(first)).not.toContain('PRIVATE');
    const second = await readThreadInventoryForCaller(owner, 'opaque|cursor', async params => {
      expect(params.cursor).toBe('opaque|cursor'); return page([other], null);
    });
    expect(parse(second).pageExhausted).toBe(true);
    expect(threadInventoryTool.mainAgentOnly).toBe(true);
    expect(threadInventoryTool.mode).toBe('read');
  });

  test('unbound, cross-thread, delegated and invalid-cursor callers do not read native state', async () => {
    let reads = 0;
    const read = async () => { reads++; return page([], null); };
    for (const context of [undefined, { threadId },
      { threadId, verifiedCallerThreadId: other },
      { threadId: other, verifiedCallerThreadId: threadId },
      { ...owner, isSubagent: true }, { ...owner, toolCallPath: ['delegated'] },
    ] as Array<BuiltinToolContext | undefined>) {
      expect(parse(await readThreadInventoryForCaller(context, undefined, read)))
        .toEqual({ available: false, category: 'caller_unavailable' });
    }
    for (const cursor of ['', 'x\nPRIVATE', 'x'.repeat(1025), 42]) {
      expect(parse(await readThreadInventoryForCaller(owner, cursor, read)).category)
        .toBe('invalid_cursor');
    }
    expect(reads).toBe(0);
  });

  test('empty DB page requires same-cursor scan; unavailable scan cannot claim empty', async () => {
    const calls: v2.ThreadListParams[] = [];
    const result = await readThreadInventoryForCaller(owner, 'cursor', async params => {
      calls.push(params); return params.useStateDbOnly ? page([], null) : page([other], null);
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ cursor: 'cursor', useStateDbOnly: false });
    expect(parse(result).threads).toEqual([{ threadId: other, status: 'idle' }]);
    const privateError = await readThreadInventoryForCaller(owner, undefined, async params => {
      if (params.useStateDbOnly) return page([], null);
      throw new Error('PRIVATE native failure');
    });
    expect(parse(privateError)).toEqual({ available: false, category: 'inventory_unavailable' });
    expect(JSON.stringify(privateError)).not.toContain('PRIVATE');
  });

  test('deadline, malformed page and late completion never fabricate an inventory', async () => {
    let finish!: (value: v2.ThreadListResponse) => void;
    const timeout = await readThreadInventoryForCaller(owner, undefined,
      () => new Promise(resolve => { finish = resolve; }), 5);
    expect(parse(timeout)).toEqual({ available: false, category: 'inventory_unavailable' });
    finish(page([threadId], null));
    await Promise.resolve();
    expect(parse(timeout).available).toBe(false);
    for (const invalid of [page([threadId, threadId], null), page([threadId], '\nPRIVATE'),
      page(Array(101).fill(threadId), null)]) {
      expect(parse(await readThreadInventoryForCaller(owner, undefined, async () => invalid)).available)
        .toBe(false);
    }
    expect(parse(await readThreadInventoryForCaller(owner, 'same', async () =>
      page([threadId], 'same'))).category).toBe('inventory_unavailable');
  });
});
