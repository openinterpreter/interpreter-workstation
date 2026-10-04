import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
      expect(again.list('thread-1').events[0]?.message).toBe('');
      expect((await again.ingest('thread-1', 'source', 'event-1', 'replayed')).status).toBe('admitted');
      expect(again.list('thread-1').events).toHaveLength(1);
      expect(f.counts()).toEqual({ starts: 1, steers: 0 });
      expect(f.messages[0]).toContain('hello');
    } finally { await f.cleanup(); }
  });

  test('maintenance restart retains provider and missed schedule inputs on one thread without another owner', async () => {
    const f = await fixture();
    try {
      const before = await f.make();
      await before.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule',
        message: 'Check the existing worker version and report availability; do not activate.',
        at: new Date(Date.now() + 30_000).toISOString(), everyMs: 86_400_000 });
      await before.ingest('thread-1', 'provider', 'stable-provider-id', 'approved request');
      await before.stop();
      await expect(before.ingest('thread-1', 'provider', 'lost', 'too late')).rejects.toThrow('draining');
      const after = await f.make();
      f.setActive('existing-turn');
      await after.tick(Date.now() + 31_000);
      expect(after.list('thread-1').events.map(e => [e.eventId, e.status]))
        .toEqual([['stable-provider-id', 'offered'], ['daily-1', 'pending']]);
      expect(f.counts()).toEqual({ starts: 0, steers: 1 });
      await after.tick(Date.now() + 90_000);
      expect(f.counts().steers).toBe(1); // ordered behind the offered receipt
      await after.tick();
      await after.tick();
      expect(after.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'admitted']);
      expect(f.counts()).toEqual({ starts: 0, steers: 2 });
      expect((await after.ingest('thread-1', 'provider', 'stable-provider-id', 'duplicate')).status)
        .toBe('admitted');
    } finally { await f.cleanup(); }
  });

  test('shutdown does not release custody until an in-flight native admission has settled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-maintenance-'));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const history: string[] = [];
    let starts = 0;
    const native: WakeNative = {
      inspect: async () => ({ messages: history }),
      steer: async () => { throw new Error('no active turn'); },
      start: async (thread, message) => {
        expect(thread).toBe('same-thread'); starts++;
        await gate;
        history.push(message);
        return 'turn-on-same-thread';
      },
    };
    const before = new WakeSources(native, root);
    try {
      await before.initialize();
      await before.ingest('same-thread', 'provider', 'stable-one', 'retained');
      const delivering = before.tick();
      for (let n = 0; n < 50 && !starts; n++) await new Promise(resolve => setTimeout(resolve, 2));
      expect(starts).toBe(1);
      const stopping = before.stop();
      const competitor = new WakeSources(native, root);
      await expect(competitor.initialize()).rejects.toThrow('Another Workstation owns wake dispatch');
      release();
      await delivering;
      await stopping;
      const after = new WakeSources(native, root);
      await after.initialize();
      await after.tick();
      expect(after.list('same-thread').events[0]?.status).toBe('admitted');
      expect(starts).toBe(1);
      await after.stop();
    } finally { release(); await before.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('more than ten thousand compact admitted IDs do not block future events or schedules', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      await w.stop();
      const file = path.join(f.root, 'wake-sources.json');
      const state = JSON.parse(await readFile(file, 'utf8'));
      state.events = Array.from({ length: 10_001 }, (_, i) => ({ threadId: 'thread-1',
        sourceId: 'external', eventId: `stable-${i}`, message: 'old full body',
        status: 'admitted', createdAt: '2026-01-01T00:00:00.000Z' }));
      await writeFile(file, JSON.stringify(state));
      const recovered = await f.make();
      expect(recovered.list('thread-1').events[0]?.message).toBe('');
      expect((await recovered.ingest('thread-1', 'external', 'stable-0', 'duplicate')).status).toBe('admitted');
      await recovered.ingest('thread-1', 'external', 'new', 'request');
      await recovered.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule', message: 'check',
        at: new Date(Date.now() - 1000).toISOString() });
      await recovered.tick();
      expect(recovered.list('thread-1').events.at(-1)?.eventId).toBe('daily-1');
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

  test('later provider or scheduled input cannot overtake an ambiguous native receipt', async () => {
    const f = await fixture();
    try {
      const wake = await f.make();
      await wake.ingest('thread-1', 'provider', 'provider-first', 'first');
      await wake.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule', message: 'second',
        at: new Date(Date.now() - 1000).toISOString() });
      await wake.tick(); // creates due scheduled event, offers only earliest provider input
      expect(f.counts().starts).toBe(1);
      expect(wake.list('thread-1').events.map(e => e.status)).toEqual(['offered', 'pending']);
      f.messages.splice(0); // ambiguous offer has no history receipt yet
      await wake.tick(Date.now() + 120_000);
      expect(f.counts().starts).toBe(1);
      f.messages.push(wakeInput(wake.list('thread-1').events[0]!));
      await wake.tick();
      expect(wake.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'pending']);
      await wake.tick();
      expect(f.counts().starts).toBe(2);
    } finally { await f.cleanup(); }
  });

  test('a definitively rejected steer can wake the SAME idle thread after the turn ends', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-race-'));
    let active = true;
    let steers = 0;
    let starts = 0;
    const history: string[] = [];
    const wake = new WakeSources({
      inspect: async () => ({ activeTurnId: active ? 'finished-turn' : undefined, messages: history }),
      steer: async () => { steers++; active = false; throw new Error('no active turn to steer'); },
      start: async (threadId, message) => {
        expect(threadId).toBe('thread-1'); starts++; history.push(message); return 'new-turn';
      },
    }, root);
    try {
      await wake.initialize();
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'schedule', message: 'unused',
        at: new Date(Date.now() + 1_000_000).toISOString() });
      await wake.ingest('thread-1', 'provider', 'stable-id', 'approved message');
      await wake.tick();
      expect(wake.list('thread-1').events[0]?.status).toBe('pending');
      expect(wake.list('thread-1').events[0]?.error).toBeDefined();
      expect(wake.list('thread-1').sources[0]?.status).toBe('error');
      await wake.tick(Date.now() + 61_000);
      expect({ steers, starts }).toEqual({ steers: 1, starts: 1 });
      await wake.tick(Date.now() + 62_000);
      expect(wake.list('thread-1').events[0]?.status).toBe('admitted');
      expect(wake.list('thread-1').sources[0]?.error).toBeUndefined();
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
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

  test('schedule custody and sequence persist together, including legacy crash recovery', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      await w.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule', message: 'check',
        at: new Date(Date.now() - 90_000).toISOString(), everyMs: 60_000 });
      await w.tick();
      const persisted = JSON.parse(await readFile(path.join(f.root, 'wake-sources.json'), 'utf8'));
      expect(persisted.events[0].eventId).toBe('daily-1');
      expect(persisted.sources[0].sequence).toBe(1);
      await w.stop();

      // An old two-write dispatcher could persist the admitted event but not
      // the source transition. Recovery must not replay daily-1 or stop forever.
      persisted.sources[0].sequence = 0;
      persisted.sources[0].nextAt = new Date(Date.now() - 90_000).toISOString();
      persisted.events[0].status = 'admitted';
      await writeFile(path.join(f.root, 'wake-sources.json'), JSON.stringify(persisted));
      const recovered = await f.make();
      expect(recovered.list('thread-1').sources[0]?.sequence).toBe(1);
      expect(Date.parse(recovered.list('thread-1').sources[0]!.nextAt!)).toBeGreaterThan(Date.now());
      await recovered.tick();
      expect(recovered.list('thread-1').events.map(e => e.eventId)).toEqual(['daily-1']);
      await recovered.tick(Date.now() + 120_000);
      expect(recovered.list('thread-1').events.map(e => e.eventId)).toEqual(['daily-1', 'daily-2']);
    } finally { await f.cleanup(); }
  });

  test('schedule IDs reserve space for generated event sequence', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      const at = new Date(Date.now() - 1000).toISOString();
      await expect(w.put({ id: 's'.repeat(160), threadId: 'thread-1', kind: 'schedule', message: 'check', at }))
        .rejects.toThrow('Schedule ID is too long');
      await w.put({ id: 's'.repeat(143), threadId: 'thread-1', kind: 'schedule', message: 'check', at });
      await w.tick();
      expect(w.list('thread-1').events[0]?.eventId.length).toBeLessThanOrEqual(160);
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

  test('command output preserves a UTF-8 code point split across pipe chunks', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      const script = `const b=Buffer.from(JSON.stringify({id:'split',message:'hello 😀'}));
const i=b.indexOf(Buffer.from([0xf0])); process.stdout.write(b.subarray(0,i+2));
setTimeout(()=>process.stdout.write(b.subarray(i+2)),30);`;
      await w.put({ id: 'utf8', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      await w.tick();
      for (let i = 0; i < 100 && !w.list('thread-1').events.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(w.list('thread-1').events[0]?.message).toBe('hello 😀');
    } finally { await f.cleanup(); }
  });

  test('command transport errors stay visible, retry on a bounded timer and recover after restart', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      const output = path.join(f.root, 'result');
      await w.put({ id: 'poll', threadId: 'thread-1', kind: 'command',
        argv: ['/bin/cat', output] });
      await w.tick();
      for (let i = 0; i < 50 && w.list('thread-1').sources[0]?.status !== 'error'; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(w.list('thread-1').sources[0]?.status).toBe('error');
      const retryAt = Date.parse(w.list('thread-1').sources[0]!.nextAt!);
      expect(retryAt).toBeGreaterThan(Date.now());
      await w.tick(retryAt - 1);
      expect(w.list('thread-1').sources[0]?.status).toBe('error');
      await w.stop();
      await writeFile(output, '{"id":"stable-world-id","message":"approved envelope"}\n');
      const recovered = await f.make();
      await recovered.tick(retryAt + 1);
      for (let i = 0; i < 50 && recovered.list('thread-1').events.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(recovered.list('thread-1').events[0]?.eventId).toBe('stable-world-id');
      for (let i = 0; i < 50 && recovered.list('thread-1').sources[0]?.status !== 'waiting'; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(recovered.list('thread-1').sources[0]?.status).toBe('waiting');
      expect(recovered.list('thread-1').sources[0]?.error).toBeUndefined();
      await recovered.tick();
      await recovered.tick();
      expect(recovered.list('thread-1').events[0]?.status).toBe('admitted');
      expect(f.counts()).toEqual({ starts: 1, steers: 0 });
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
