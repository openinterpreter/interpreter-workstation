import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PublicThreadSnapshot } from '../../shared/types/publicThread';
import { readPublicThreadCache, writePublicThreadCache } from './publicThreadCache';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function snapshot(threadId = 'thread-1'): PublicThreadSnapshot {
  return {
    schemaVersion: 1,
    threadId,
    title: 'Public thread',
    status: 'working',
    goal: null,
    messages: [{ id: 'message-1', role: 'assistant', parts: [{ kind: 'text', content: 'Working' }] }],
    page: { nextCursor: null, hasMore: false },
    eventCursor: 'cursor-1',
    updatedAt: 1000,
  };
}

describe('public thread durable cache', () => {
  test('round trips a validated snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'public-thread-cache-'));
    directories.push(directory);
    const path = join(directory, 'snapshot.json');
    const state = { snapshot: snapshot(), refreshedAt: 2000 };
    await writePublicThreadCache(path, state);
    expect(await readPublicThreadCache(path, 'thread-1')).toEqual(state);
  });

  test('rejects a cache belonging to a different thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'public-thread-cache-'));
    directories.push(directory);
    const path = join(directory, 'snapshot.json');
    await writePublicThreadCache(path, { snapshot: snapshot(), refreshedAt: 2000 });
    expect(await readPublicThreadCache(path, 'thread-2')).toBeNull();
  });
});
