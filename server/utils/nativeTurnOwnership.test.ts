import { describe, expect, it } from 'bun:test';
import { nativeTerminalOwnerObserved } from './nativeTurnOwnership';
import type { v2 } from '../handlers/codex-generated-types/index';

const threadId = '00000000-0000-4000-8000-000000000001';
const shell = (status: 'idle' | 'active' = 'idle') => ({ thread: {
  id: threadId, status: { type: status }, turns: [], preview: 'private old instruction',
} as unknown as v2.Thread });
const turn = (id: string, status: v2.TurnStatus = 'completed') => ({
  id, status, itemsView: 'notLoaded' as const, items: [],
}) as v2.Turn;
const page = (data: v2.Turn[], nextCursor: string | null = null) => ({
  data, nextCursor, backwardsCursor: null,
});

describe('bounded exact native terminal-owner reconciliation', () => {
  it('proves a terminal older owner without hydrating rollout items', async () => {
    const calls: unknown[] = [];
    const result = await nativeTerminalOwnerObserved(threadId, 'owned',
      async () => { calls.push('metadata'); return shell(); },
      async params => { calls.push(params); return page(params.limit === 1 ?
        [turn('newer')] : [turn('newer'), turn('owned')]); });
    expect(result).toBe(true);
    expect(calls).toEqual(['metadata', { threadId, limit: 32,
      sortDirection: 'desc', itemsView: 'notLoaded', cursor: null }, 'metadata',
      { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }]);
    expect(JSON.stringify(calls)).not.toContain('private old instruction');
  });

  it('retains the guard for missing, active, mismatched and changing owners', async () => {
    const metadata = async () => shell();
    expect(await nativeTerminalOwnerObserved(threadId, 'owned', metadata,
      async () => page([turn('newer')]))).toBe(false);
    expect(await nativeTerminalOwnerObserved(threadId, 'owned', metadata,
      async () => page([turn('newer', 'inProgress'), turn('owned')]))).toBe(false);
    expect(await nativeTerminalOwnerObserved(threadId, 'owned', metadata,
      async () => page([turn('newer'), turn('owned', 'inProgress')]))).toBe(false);
    let reads = 0;
    expect(await nativeTerminalOwnerObserved(threadId, 'owned',
      async () => ++reads === 1 ? shell() : shell('active'),
      async params => page(params.limit === 1 ? [turn('newer')] :
        [turn('newer'), turn('owned')]))).toBe(false);
    let pages = 0;
    expect(await nativeTerminalOwnerObserved(threadId, 'owned', metadata,
      async () => ++pages === 1 ? page([turn('newer'), turn('owned')]) : page([turn('changed')]))).toBe(false);
  });

  it('bounds pagination and preserves uncertainty when native pages repeat or fail', async () => {
    let calls = 0;
    expect(await nativeTerminalOwnerObserved(threadId, 'owned', async () => shell(),
      async () => { calls++; return page([turn('other')], 'same'); })).toBe(false);
    expect(calls).toBe(2);
    expect(await nativeTerminalOwnerObserved(threadId, 'owned', async () => shell(),
      async params => params.cursor === null ? page([turn('other')], 'next') :
        page([turn('other'), turn('owned')]))).toBe(false);
    await expect(nativeTerminalOwnerObserved(threadId, 'owned', async () => shell(),
      async () => { throw Error('private native error'); })).rejects.toThrow();
  });
});
