import { describe, expect, it } from 'bun:test';
import { boundedSupervisorThread } from './boundedSupervisorThread';
import { projectSupervisorTurn } from './supervisorTurnObservation';
import type { v2 } from '../handlers/codex-generated-types/index';

const id = '00000000-0000-4000-8000-000000000001';
const metadata = { id, turns: [], preview: 'private historical preview' } as unknown as v2.Thread;
const savedTurn = { id: 'turn-current', status: 'inProgress', startedAt: 1,
  completedAt: null, itemsView: 'notLoaded', items: [] } as unknown as v2.Turn;
const page = { data: [savedTurn], nextCursor: 'opaque', backwardsCursor: 'opaque' };

describe('bounded supervisor native reader', () => {
  it('requests metadata only and exactly one unloaded newest turn, never historical payloads', async () => {
    const requests: unknown[] = [];
    const result = await boundedSupervisorThread(id,
      async request => { requests.push(request); return { thread: metadata }; },
      async request => { requests.push(request); return page; });
    expect(requests).toEqual([{ threadId: id, includeTurns: false },
      { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }]);
    expect(projectSupervisorTurn(result, id)).toMatchObject({
      turn: { id: 'turn-current', status: 'inProgress' },
      preview: { relation: 'initial-thread-historical-non-authoritative' },
      latestMessage: { relation: 'unavailable' },
      command: { observation: 'saved-items-unavailable' },
    });
    expect(JSON.stringify(projectSupervisorTurn(result, id))).not.toContain('private historical preview');
  });

  it('fails closed on a wrong owner, hydrated history, or a non-bounded item page', async () => {
    const read = async () => ({ thread: metadata });
    const turns = async () => page;
    await expect(boundedSupervisorThread('00000000-0000-4000-8000-000000000002', read, turns)).rejects.toThrow();
    await expect(boundedSupervisorThread(id,
      async () => ({ thread: { ...metadata, turns: [savedTurn] } }), turns)).rejects.toThrow();
    await expect(boundedSupervisorThread(id, read,
      async () => ({ ...page, data: [{ ...savedTurn, itemsView: 'full' as const,
        items: [{ type: 'agentMessage', text: 'private' }] as never }] }))).rejects.toThrow();
    await expect(boundedSupervisorThread(id, read,
      async () => ({ ...page, data: [savedTurn, savedTurn] }))).rejects.toThrow();
  });

  it('does not turn a late native read into an empty or successful observation', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<v2.ThreadReadResponse>((_, fail) => { reject = fail; });
    const read = boundedSupervisorThread(id, () => pending,
      async () => { throw Error('turn read must not start'); });
    reject(Error('native unavailable'));
    await expect(read).rejects.toThrow('native unavailable');
  });
  it('never starts the second RPC after disconnect and rejects late results from the old generation', async () => {
    let current = true;
    let resolve!: (value: v2.ThreadReadResponse) => void;
    let turnCalls = 0;
    const first = new Promise<v2.ThreadReadResponse>(done => { resolve = done; });
    const read = boundedSupervisorThread(id, () => first,
      async () => { turnCalls++; return page; }, () => current);
    current = false;
    resolve({ thread: metadata });
    await expect(read).rejects.toThrow('generation changed');
    expect(turnCalls).toBe(0);

    current = true;
    const later = boundedSupervisorThread(id, async () => ({ thread: metadata }),
      async () => { current = false; return page; }, () => current);
    await expect(later).rejects.toThrow('generation changed');
  });
});
