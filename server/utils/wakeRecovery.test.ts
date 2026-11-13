import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WakeSources, wakeClientId, type WakeNative } from './wakeSources';

const threadId = '00000000-0000-4000-8000-000000000001';
const sourceId = 'daily';
const createdAt = '2026-11-01T00:00:00.000Z';
const source = (sequence: number) => ({ id: sourceId, threadId, kind: 'schedule',
  message: 'Fixture daily input', dailyAt: '07:00', timeZone: 'America/Los_Angeles',
  status: 'error', sequence, error: 'Held for review' });
async function fixture(sequence: number, status: 'held' | 'offered', native: WakeNative) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wake-recovery-'));
  const eventId = `${sourceId}-${sequence}`;
  await writeFile(path.join(root, 'wake-sources.json'), JSON.stringify({
    sources: [source(sequence)], events: [{ threadId, sourceId, eventId,
      message: 'Fixture daily input', status, createdAt,
      ...(status === 'offered' ? { offeredAt: createdAt } : {}) }],
  }));
  const make = async () => { const wake = new WakeSources(native, root); await wake.initialize(); return wake; };
  return { root, eventId, make };
}

describe('own-thread source recovery CAS', () => {
  test('held daily sequence remains retained; only future sequence runs after restart', async () => {
    let starts = 0;
    const f = await fixture(17, 'held', { inspect: async () => ({ messages: [] }),
      start: async () => { starts++; return 'new-turn'; },
      steer: async () => { throw Error('unexpected steer'); } });
    let wake: WakeSources | undefined;
    try {
      wake = await f.make();
      const before = wake.recoverySnapshot(threadId, sourceId);
      await expect(wake.recoverDailyFuture('other-thread', sourceId, before.revision,
        f.eventId)).rejects.toMatchObject({ category: 'invalid_request' });
      await expect(wake.recoverDailyFuture(threadId, sourceId, '0'.repeat(64),
        f.eventId)).rejects.toMatchObject({ category: 'stale_revision' });
      const recovered = await wake.recoverDailyFuture(threadId, sourceId, before.revision, f.eventId);
      expect(recovered.source.status).toBe('waiting');
      expect(Date.parse(recovered.source.nextAt!)).toBeGreaterThan(Date.now());
      expect(recovered.events).toEqual(before.events);
      await expect(wake.recoverDailyFuture(threadId, sourceId, before.revision,
        f.eventId)).rejects.toMatchObject({ category: 'stale_revision' });
      await wake.stop();
      wake = await f.make();
      expect(wake.list(threadId).events.map(e => [e.eventId, e.status]))
        .toEqual([[f.eventId, 'held']]);
      const due = Date.parse(wake.list(threadId).sources[0]!.nextAt!);
      await wake.tick(due + 1);
      expect(wake.list(threadId).events.map(e => [e.eventId, e.status]))
        .toEqual([[f.eventId, 'held'], ['daily-18', 'offered']]);
      // The synthetic native start has no observed receipt. Never assume an
      // offered occurrence is safe to retry or count it as admitted.
      await wake.tick(due + 2);
      expect(starts).toBe(1);
      expect(wake.list(threadId).events[0]?.status).toBe('held');
    } finally { await wake?.stop(); await rm(f.root, { recursive: true, force: true }); }
  });

  test('unknown offered admission refuses without replay; positive native marker reconciles once', async () => {
    let clientIds: string[] = [];
    let starts = 0;
    const native: WakeNative = { inspect: async () => ({ messages: [], clientIds }),
      start: async () => { starts++; throw Error('unexpected replay'); },
      steer: async () => { throw Error('unexpected steer'); } };
    const f = await fixture(21, 'offered', native);
    let wake: WakeSources | undefined;
    try {
      wake = await f.make();
      const before = wake.recoverySnapshot(threadId, sourceId);
      await expect(wake.recoverDailyFuture(threadId, sourceId, before.revision,
        f.eventId)).rejects.toMatchObject({ category: 'refused_ambiguous' });
      await expect(wake.reconcileOffered(threadId, sourceId, f.eventId,
        before.revision)).rejects.toMatchObject({ category: 'refused_ambiguous' });
      await expect(wake.reconcileOffered('other-thread', sourceId, f.eventId,
        before.revision)).rejects.toMatchObject({ category: 'invalid_request' });
      expect(wake.recoverySnapshot(threadId, sourceId)).toEqual(before);
      await wake.stop();
      wake = await f.make();
      await expect(wake.reconcileOffered(threadId, sourceId, f.eventId,
        '0'.repeat(64))).rejects.toMatchObject({ category: 'stale_revision' });
      clientIds = [wakeClientId(before.events[0]!)];
      const admitted = await wake.reconcileOffered(threadId, sourceId, f.eventId, before.revision);
      expect(admitted.events[0]?.status).toBe('admitted');
      expect(admitted.events[0]?.message).toBe('');
      expect(starts).toBe(0);
      await expect(wake.reconcileOffered(threadId, sourceId, f.eventId,
        before.revision)).rejects.toMatchObject({ category: 'stale_revision' });
      await wake.stop();
      wake = await f.make();
      expect(wake.list(threadId).events[0]?.status).toBe('admitted');
      expect(starts).toBe(0);
      const persisted = JSON.parse(await readFile(path.join(f.root, 'wake-sources.json'), 'utf8'));
      expect(persisted.events[0].status).toBe('admitted');
    } finally { await wake?.stop(); await rm(f.root, { recursive: true, force: true }); }
  });

  test('native inspection failure retains an offered event and reports typed unavailability', async () => {
    const f = await fixture(21, 'offered', {
      inspect: async () => { throw Error('fixture native unavailable'); },
      start: async () => { throw Error('unexpected replay'); },
      steer: async () => { throw Error('unexpected steer'); },
    });
    let wake: WakeSources | undefined;
    try {
      wake = await f.make();
      const before = wake.recoverySnapshot(threadId, sourceId);
      await expect(wake.reconcileOffered(threadId, sourceId, f.eventId,
        before.revision)).rejects.toMatchObject({ category: 'native_unavailable' });
      expect(wake.recoverySnapshot(threadId, sourceId)).toEqual(before);
    } finally { await wake?.stop(); await rm(f.root, { recursive: true, force: true }); }
  });
});
