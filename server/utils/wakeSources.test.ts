import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WakeSources, wakeInput, wakeTokenValid, type WakeNative } from './wakeSources';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wake-test-'));
  const wakes: WakeSources[] = [];
  const messages: string[] = [];
  let activeTurnId: string | undefined;
  let starts = 0;
  let steers = 0;
  const native: WakeNative = {
    inspect: async () => ({ activeTurnId, messages }),
    steer: async (_thread, _turn, message) => { steers++; messages.push(message); return 'turn-1'; },
    start: async (_thread, message) => { starts++; messages.push(message); return 'turn-2'; },
  };
  const make = async () => {
    const wake = new WakeSources(native, root);
    await wake.initialize();
    wakes.push(wake);
    return wake;
  };
  return { root, make, messages, setActive: (id?: string) => { activeTurnId = id; }, counts: () => ({ starts, steers }), cleanup: async () => { for (const wake of wakes) await wake.stop(); await rm(root, { recursive: true, force: true }); } };
}

describe('durable thread wake sources', () => {
  test('a second dispatcher cannot own the same home; a dead owner is recovered', async () => {
    const f = await fixture();
    try {
      const first = await f.make();
      await expect(f.make()).rejects.toThrow('Another Workstation owns wake dispatch');
      await first.stop();
      const lock = path.join(f.root, 'wake-sources.json.owner');
      await mkdir(lock);
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, owner: 'dead' }));
      const recovered = await f.make();
      expect(recovered.list('thread-1').events).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  test('rejects missing/wrong ingress secret and malformed events', async () => {
    expect(wakeTokenValid('private', 'private')).toBe(true);
    expect(wakeTokenValid('private', 'other')).toBe(false);
    expect(wakeTokenValid(undefined, 'private')).toBe(false);
    const f = await fixture();
    try { const w = await f.make(); await expect(w.ingest('bad/id', 'source', 'id', 'hello')).rejects.toThrow(); }
    finally { await f.cleanup(); }
  });

  test('persists before dispatch, reconciles history after restart, deduplicates source IDs', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      const first = await w.ingest('thread-1', 'source', 'event-1', 'hello');
      expect(await w.ingest('thread-1', 'source', 'event-1', 'different')).toEqual(first);
      await w.stop();
      const restarted = await f.make();
      expect(restarted.list('thread-1').events).toHaveLength(1);
      await restarted.tick();
      expect(f.counts()).toEqual({ starts: 1, steers: 0 });
      await restarted.stop();
      const again = await f.make();
      await again.tick();
      expect(again.list('thread-1').events[0]?.status).toBe('admitted');
      expect(f.counts()).toEqual({ starts: 1, steers: 0 });
      expect(f.messages[0]).toContain('hello');
    } finally { await f.cleanup(); }
  });

  test('active input steers and ambiguous offer does not duplicate during an active turn', async () => {
    const f = await fixture();
    try {
      f.setActive('turn-1');
      const w = await f.make();
      const event = await w.ingest('thread-1', 'source', 'event-2', 'busy');
      await w.tick();
      expect(f.counts()).toEqual({ starts: 0, steers: 1 });
      f.messages.splice(0); // accepted by RPC, not yet reflected in history
      await w.tick(Date.now() + 100_000);
      expect(f.counts().steers).toBe(1);
      f.messages.push(wakeInput(event));
      await w.tick();
      expect(w.list('thread-1').events[0]?.status).toBe('admitted');
    } finally { await f.cleanup(); }
  });

  test('coalesces missed recurring schedules and cancellation stops future inputs', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      await w.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule', message: 'check', at: new Date(Date.now() - 90_000).toISOString(), everyMs: 60_000 });
      await w.tick();
      expect(w.list('thread-1').events).toHaveLength(1);
      await w.tick();
      expect(w.list('thread-1').events[0]?.status).toBe('admitted');
      expect(Date.parse(w.list('thread-1').sources[0]!.nextAt!)).toBeGreaterThan(Date.now());
      await w.cancel('thread-1', 'daily');
      await w.tick(Date.now() + 10_000_000);
      expect(w.list('thread-1').events).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  test('trusted command stdout creates one event and rearms only after admission', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      await w.put({ id: 'poll', threadId: 'thread-1', kind: 'command', argv: ['/bin/echo', '{"id":"stable-1","message":"from command"}'] });
      await w.tick();
      for (let i = 0; i < 50 && w.list('thread-1').events.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(w.list('thread-1').events).toHaveLength(1);
      await w.tick();
      expect(f.counts().starts).toBe(1);
      await w.tick();
      expect(w.list('thread-1').sources[0]?.status).toBe('waiting');
      await w.tick();
      expect(w.list('thread-1').events).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  test('command errors surface without a retry loop', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      await w.put({ id: 'bad', threadId: 'thread-1', kind: 'command', argv: ['/bin/false'] });
      await w.tick();
      for (let i = 0; i < 50 && w.list('thread-1').sources[0]?.status !== 'error'; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(w.list('thread-1').sources[0]?.status).toBe('error');
      await w.tick(Date.now() + 1_000_000);
      expect(w.list('thread-1').sources[0]?.status).toBe('error');
    } finally { await f.cleanup(); }
  });

  test('native usage and authentication faults remain retained and do not retry rapidly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-errors-'));
    let attempts = 0;
    const wake = new WakeSources({
      inspect: async () => { attempts++; throw new Error('usageLimited: secret-token-value'); },
      steer: async () => { throw new Error('not reached'); },
      start: async () => { throw new Error('not reached'); },
    }, root);
    try {
      await wake.initialize();
      await wake.ingest('thread-1', 'external', 'event-1', 'request');
      await wake.tick();
      expect(wake.list('thread-1').events[0]?.status).toBe('pending');
      expect(wake.list('thread-1').events[0]?.error).toBe('Usage limit reached; operator action required');
      expect(wake.list('thread-1').sources).toHaveLength(0);
      await wake.tick();
      expect(attempts).toBe(1); // no retry storm, no fallback; retained for recovery
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
