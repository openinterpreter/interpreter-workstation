import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WakeSources, WakeAdmissionFailure, WakeContentConflictError, WakeSourceCancelledError, WakeUnsavedError,
  wakeClientId, wakeInput, wakeTokenValid, type WakeEvent, type WakeNative } from './wakeSources';
import { nextCivilDaily } from './civilSchedule';
import { THREAD_INPUT_SOURCE, threadInputCustody, type WakeAdmission } from './wakeSources';
import { SubagentDirectInputError } from '../../src/lib/codex/subagent-input';

/** No background interval or follow-up timer: every pass is an explicit tick(). */
const MANUAL = { intervalMs: 0, followUpMs: 0 };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wake-test-'));
  const wakes: WakeSources[] = [];
  const messages: string[] = [];
  let activeTurnId: string | undefined;
  let starts = 0;
  let steers = 0;
  // Observes each native offer at the moment it is made, before it is recorded.
  let onOffer: ((threadId: string, message: string) => void) | undefined;
  const native: WakeNative = {
    inspect: async () => ({ activeTurnId, messages }),
    steer: async (thread, _turn, message) => { onOffer?.(thread, message); steers++; messages.push(message); return 'turn-1'; },
    start: async (thread, message) => { onOffer?.(thread, message); starts++; messages.push(message); return 'turn-2'; },
  };
  const make = async (timing?: { intervalMs: number; followUpMs: number }) => {
    const wake = new WakeSources(native, root, 30_000, timing);
    await wake.initialize();
    wakes.push(wake);
    return wake;
  };
  return { root, make, messages, setActive: (id?: string) => { activeTurnId = id; },
    setOnOffer: (fn?: (threadId: string, message: string) => void) => { onOffer = fn; },
    counts: () => ({ starts, steers }), cleanup: async () => { for (const wake of wakes) await wake.stop(); await rm(root, { recursive: true, force: true }); } };
}

/** A command output fixture read by /bin/cat: one line per entry plus a trailing newline. */
async function outputFile(root: string, name: string, lines: string[]): Promise<string> {
  const file = path.join(root, `${name}.out`);
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}
async function settle(done: () => boolean, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
}

describe('durable thread wake sources', () => {
  test('retargets only a drained paused command with exact prior argv, preserving pending custody', async () => {
    const f = await fixture();
    try {
      const wake = await f.make();
      const argvHash = (argv: string[]) => createHash('sha256').update(JSON.stringify(argv)).digest('hex');
      const oldArgv = ['/usr/bin/env', 'PATH=/old/bin:/usr/bin:/bin', '/bin/echo', 'old'];
      const newArgv = ['/usr/bin/env', 'PATH=/opt/example-tools/bin:/usr/bin:/bin', '/bin/echo', 'old'];
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: oldArgv });
      await wake.ingest('thread-1', 'provider', 'original-event', 'unadmitted input');
      await expect(wake.retargetPausedCommand('thread-1', 'provider', argvHash(oldArgv), '/old/bin', '/opt/example-tools/bin'))
        .rejects.toThrow('Paused command precondition rejected');
      const receipt = await wake.pause('thread-1', 'provider');
      expect(receipt.drain.pendingEvents).toBe(1);
      expect(await wake.pausedCommandMetadata('thread-1', 'provider')).toEqual({
        sourceId: 'provider', threadId: 'thread-1', status: 'waiting', paused: true,
        sequence: 0, argvSha256: argvHash(oldArgv), pendingEvents: 1, offeredEvents: 0,
      });
      const before = wake.list('thread-1');
      await expect(wake.retargetPausedCommand('thread-1', 'provider', argvHash(newArgv), '/old/bin', '/opt/example-tools/bin'))
        .rejects.toThrow('Paused command precondition rejected');
      const changed = await wake.retargetPausedCommand('thread-1', 'provider', argvHash(oldArgv), '/old/bin', '/opt/example-tools/bin');
      expect(changed).toEqual({ ...before.sources[0], argv: newArgv });
      expect((await wake.pausedCommandMetadata('thread-1', 'provider')).argvSha256)
        .toBe(argvHash(newArgv));
      expect(wake.list('thread-1').events).toEqual(before.events);
      await expect(wake.retargetPausedCommand('thread-1', 'provider', argvHash(oldArgv), '/old/bin', '/another/bin'))
        .rejects.toThrow('Paused command precondition rejected');
      await expect(wake.retargetPausedCommand('thread-2', 'provider', argvHash(newArgv), '/opt/example-tools/bin', '/another/bin'))
        .rejects.toThrow('Paused command precondition rejected');
      await expect(wake.retargetPausedCommand('thread-1', 'provider', argvHash(newArgv), '/not-present', '/another/bin'))
        .rejects.toThrow('Paused command precondition rejected');
      await expect(wake.retargetPausedCommand('thread-1', 'provider', argvHash(newArgv),
        '/opt/example-tools/bin', '/usr/bin'))
        .rejects.toThrow('Paused command precondition rejected');
      await wake.tick(Date.now() + 60_000);
      expect(f.counts().starts).toBe(0);
      await wake.stop();
      const recovered = await f.make();
      expect(recovered.list('thread-1').sources[0]?.argv).toEqual(newArgv);
      expect(recovered.list('thread-1').events).toEqual(before.events);
    } finally { await f.cleanup(); }
  });
  test('a failed persistence phase fences retarget, read and resume without losing input', async () => {
    const f = await fixture();
    try {
      const wake = await f.make();
      const argv = ['/usr/bin/env', 'PATH=/old/bin:/usr/bin', '/bin/echo', 'old'];
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv });
      await wake.ingest('thread-1', 'provider', 'event-1', 'held input');
      await wake.pause('thread-1', 'provider');
      const before = wake.list('thread-1').events;
      const save = (wake as any).save;
      (wake as any).save = async () => { throw new Error('simulated uncertain fsync'); };
      await expect(wake.retargetPausedCommand('thread-1', 'provider',
        createHash('sha256').update(JSON.stringify(argv)).digest('hex'),
        '/old/bin', '/opt/example-tools/bin'))
        .rejects.toThrow('simulated uncertain fsync');
      (wake as any).save = save;
      await expect(wake.pausedCommandMetadata('thread-1', 'provider'))
        .rejects.toThrow('Paused command persistence uncertain');
      await expect(wake.resume('thread-1', 'provider'))
        .rejects.toThrow('Paused command persistence uncertain');
      expect(wake.list('thread-1').events).toEqual(before);
    } finally { await f.cleanup(); }
  });
  test('a stalled native history inspection preserves pending custody and does not pin other threads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-inspect-deadline-'));
    const messages: string[] = [];
    let stalledInspections = 0;
    const wake = new WakeSources({
      inspect: async (threadId) => threadId === 'thread-stalled'
        ? (stalledInspections++, await new Promise<never>(() => {})) : { messages },
      start: async (_thread, message) => { messages.push(message); return 'turn-other'; },
      steer: async () => { throw new Error('unexpected steer'); },
    }, root, 10);
    try {
      await wake.initialize();
      await wake.ingest('thread-stalled', 'provider', 'old-id', 'old input');
      await wake.ingest('thread-healthy', 'provider', 'other-id', 'other input');
      await wake.tick();
      expect(wake.list('thread-stalled').events[0]?.status).toBe('pending');
      expect(wake.list('thread-stalled').events[0]?.error).toBe('Runtime temporarily unavailable');
      expect(wake.list('thread-healthy').events[0]?.status).toBe('offered');
      expect(messages).toHaveLength(1);
      expect(wake.list('thread-stalled').events[0]?.nextAttemptAt).toBeTruthy();
      await wake.tick(Date.parse(wake.list('thread-stalled').events[0]!.nextAttemptAt!) + 1);
      expect(stalledInspections).toBe(1);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });
  test('historical unbound offer requires an exact negative receipt and terminal latest-turn snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-historical-hold-'));
    let clientIds: string[] = [];
    let queued = 0;
    let latest = 'later-turn';
    const wake = new WakeSources({
      inspect: async () => ({ messages: [], clientIds }),
      custody: async () => ({ queuedSubmissionCount: queued, lastTurnId: latest,
        turnStatus: 'completed', threadStatus: 'idle' }),
      start: async () => { throw new Error('server overloaded'); },
      steer: async () => { throw new Error('unexpected steer'); },
    }, root);
    try {
      await wake.initialize();
      await wake.put({ id: 'old-schedule', threadId: 'thread-1', kind: 'schedule',
        message: 'Original instruction', at: new Date(Date.now() - 120_000).toISOString(), everyMs: 1_200_000 });
      await wake.tick();
      const first = wake.list('thread-1').events[0]!;
      expect(first.status).toBe('offered');
      const clientId = wakeClientId(first);
      await wake.stop();
      const file = path.join(root, 'wake-sources.json');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      saved.events[0].offeredAt = new Date(Date.now() - 61_000).toISOString();
      await writeFile(file, JSON.stringify(saved));
      const resumed = new WakeSources({
        inspect: async () => ({ messages: [], clientIds }),
        custody: async () => ({ queuedSubmissionCount: queued, lastTurnId: latest,
          turnStatus: 'completed', threadStatus: 'idle' }),
        start: async () => { throw new Error('unexpected start'); },
        steer: async () => { throw new Error('unexpected steer'); },
      }, root);
      await resumed.initialize();
      await expect(resumed.holdHistoricalOffered('thread-1', 'old-schedule', first.eventId,
        'wrong-client', latest, 'decision-1')).rejects.toThrow('mismatch');
      clientIds = [clientId];
      await expect(resumed.holdHistoricalOffered('thread-1', 'old-schedule', first.eventId,
        clientId, latest, 'decision-1')).rejects.toThrow('receipt exists');
      clientIds = []; queued = 1;
      await expect(resumed.holdHistoricalOffered('thread-1', 'old-schedule', first.eventId,
        clientId, latest, 'decision-1')).rejects.toThrow('queue-empty');
      queued = 0; latest = 'changed-turn';
      await expect(resumed.holdHistoricalOffered('thread-1', 'old-schedule', first.eventId,
        clientId, 'later-turn', 'decision-1')).rejects.toThrow('queue-empty');
      const held = await resumed.holdHistoricalOffered('thread-1', 'old-schedule', first.eventId,
        clientId, latest, 'decision-1');
      expect(held.status).toBe('held');
      expect(held.error).toContain('decision-1');
      expect(held.turnId).toBeUndefined();
      expect(resumed.list('thread-1').sources[0]?.status).toBe('error');
      expect((await resumed.ingest('thread-1', 'provider', 'later-id', 'later input')).status).toBe('pending');
      await resumed.stop();
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform !== 'linux')('reclaims a legacy lock after PID reuse, without evicting a live owner', async () => {
    const f = await fixture();
    try {
      const lock = path.join(f.root, 'wake-sources.json.owner');
      await mkdir(lock);
      const ownerFile = path.join(lock, 'owner.json');
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, owner: 'prior-process' }));
      const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await utimes(ownerFile, old, old);
      const wake = await f.make();
      const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
      expect(owner.pid).toBe(process.pid);
      expect(owner.owner).not.toBe('prior-process');
      expect(owner.linuxIdentity.startTicks).toMatch(/^\d+$/);
      const competitor = new WakeSources({ inspect: async () => ({ messages: [] }),
        steer: async () => '', start: async () => '' }, f.root);
      await expect(competitor.initialize()).rejects.toThrow('Another Workstation owns wake dispatch');
      await wake.stop();
    } finally { await f.cleanup(); }
  });
  test.skipIf(process.platform !== 'linux')('retains a fresh legacy owner and recovers a mismatched process identity', async () => {
    const f = await fixture();
    const lock = path.join(f.root, 'wake-sources.json.owner');
    const ownerFile = path.join(lock, 'owner.json');
    const native: WakeNative = { inspect: async () => ({ messages: [] }),
      steer: async () => '', start: async () => '' };
    try {
      await mkdir(lock);
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, owner: 'live-legacy' }));
      await expect(new WakeSources(native, f.root).initialize()).rejects.toThrow('Another Workstation owns wake dispatch');
      expect(JSON.parse(await readFile(ownerFile, 'utf8')).owner).toBe('live-legacy');
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, owner: 'old-pid',
        linuxIdentity: { bootId: 'previous-boot', startTicks: '0' } }));
      const recovered = await f.make();
      expect(JSON.parse(await readFile(ownerFile, 'utf8')).owner).not.toBe('old-pid');
      await recovered.stop();
    } finally { await f.cleanup(); }
  });
  test.skipIf(process.platform !== 'linux')('new locks use exact identity without executing a PATH-provided getconf', async () => {
    const f = await fixture();
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = '';
      const wake = await f.make();
      const owner = JSON.parse(await readFile(path.join(f.root, 'wake-sources.json.owner', 'owner.json'), 'utf8'));
      expect(owner.linuxIdentity.startTicks).toMatch(/^\d+$/);
      expect(owner.linuxIdentity.bootId).toMatch(/^[0-9a-f-]{36}$/);
      await wake.stop();
    } finally {
      process.env.PATH = previousPath;
      await f.cleanup();
    }
  });
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

  test('exposes the sole private config path and rejects invalid civil edits without changing it', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      expect(w.configFilePath()).toBe(path.join(f.root, 'wake-sources.json'));
      const source = { id: 'daily', threadId: 'thread-1', kind: 'schedule' as const,
        message: 'Daily review', dailyAt: '22:00', timeZone: 'America/Los_Angeles' };
      await w.put(source);
      const before = await readFile(w.configFilePath(), 'utf8');
      await expect(w.put({ ...source, dailyAt: '25:00' })).rejects.toThrow();
      await expect(w.put({ ...source, timeZone: 'Invalid/Zone' })).rejects.toThrow();
      expect(await readFile(w.configFilePath(), 'utf8')).toBe(before);
      expect(w.list('thread-1').sources[0]?.dailyAt).toBe('22:00');
    } finally { await f.cleanup(); }
  });

  test('persists before dispatch, reconciles history after restart, deduplicates source IDs', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      const first = await w.ingest('thread-1', 'source', 'event-1', 'hello');
      expect(await w.ingest('thread-1', 'source', 'event-1', 'hello')).toEqual(first);
      // A source repeating an ID keeps its stored input, whatever it now sends.
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
      // An admitted ID is a permanent receipt: a repeat is never delivered again.
      expect((await again.ingest('thread-1', 'source', 'event-1', 'hello')).status).toBe('admitted');
      expect((await again.ingest('thread-1', 'source', 'event-1', 'replayed')).status).toBe('admitted');
      expect(again.list('thread-1').events).toHaveLength(1);
      expect(f.counts()).toEqual({ starts: 1, steers: 0 });
      expect(f.messages[0]).toContain('hello');
    } finally { await f.cleanup(); }
  });

  test('a failed save is never acknowledged; a retry with the same ID succeeds only once it is on disk', async () => {
    const f = await fixture();
    try {
      const wake = await f.make(MANUAL);
      const write = (wake as any).writeState.bind(wake);
      let failing = true;
      (wake as any).writeState = async () => { if (failing) throw new Error('disk full'); return write(); };
      await expect(wake.ingest('thread-1', 'peer', 'stable-1', 'first input')).rejects.toBeInstanceOf(WakeUnsavedError);
      // Kept in memory (the write may have reached disk), never dropped and never re-created.
      expect(wake.list('thread-1').events.map(e => e.eventId)).toEqual(['stable-1']);
      // While unsaved, even a repeat of a known ID must write before it is answered.
      await expect(wake.ingest('thread-1', 'peer', 'stable-1', 'first input')).rejects.toBeInstanceOf(WakeUnsavedError);
      await expect(wake.ingestBatch('thread-1', 'peer', [{ id: 'stable-1', message: 'first input' },
        { id: 'stable-2', message: 'second input' }])).rejects.toBeInstanceOf(WakeUnsavedError);
      // Nothing is offered while memory is not on disk.
      await wake.tick();
      expect(f.counts()).toEqual({ starts: 0, steers: 0 });
      expect(wake.list('thread-1').events.every(e => e.status === 'pending')).toBe(true);
      failing = false;
      const retried = await wake.ingestBatch('thread-1', 'peer', [{ id: 'stable-1', message: 'first input' },
        { id: 'stable-2', message: 'second input' }]);
      expect(retried.map(e => [e.eventId, e.status])).toEqual([['stable-1', 'pending'], ['stable-2', 'pending']]);
      expect(wake.list('thread-1').events).toHaveLength(2);
      await wake.stop();
      const reopened = await f.make(MANUAL);
      expect(reopened.list('thread-1').events.map(e => [e.eventId, e.message, e.status]))
        .toEqual([['stable-1', 'first input', 'pending'], ['stable-2', 'second input', 'pending']]);
      expect(f.counts()).toEqual({ starts: 0, steers: 0 });
    } finally { await f.cleanup(); }
  });

  test('a pass after a failed save writes first, then offers', async () => {
    const f = await fixture();
    try {
      const wake = await f.make(MANUAL);
      const write = (wake as any).writeState.bind(wake);
      let failing = true;
      (wake as any).writeState = async () => { if (failing) throw new Error('disk full'); return write(); };
      await expect(wake.ingest('thread-1', 'peer', 'kept-1', 'kept input')).rejects.toBeInstanceOf(WakeUnsavedError);
      await wake.tick();
      expect(f.counts().starts).toBe(0);
      failing = false;
      await wake.tick();
      expect(f.counts().starts).toBe(1);
      expect(JSON.parse(await readFile(wake.configFilePath(), 'utf8')).events.map((e: WakeEvent) => e.eventId))
        .toEqual(['kept-1']);
    } finally { await f.cleanup(); }
  });

  test('a repeat is not answered from memory while the write of its input is outstanding, nor after it failed', async () => {
    const f = await fixture();
    try {
      const wake = await f.make(MANUAL);
      const write = (wake as any).writeState.bind(wake);
      let failing = false;
      let release!: () => void;
      let hold: Promise<void> | undefined = new Promise<void>(resolve => { release = resolve; });
      (wake as any).writeState = async () => {
        const held = hold; hold = undefined;
        if (held) await held;
        if (failing) throw new Error('disk full');
        return write();
      };
      // Outcomes are captured at creation, so a rejection is never unhandled.
      const first = wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'r1', 'first input')
        .then(() => undefined, (error: unknown) => error);
      await settle(() => wake.list('thread-1').events.length === 1);
      // In memory, but its write is still running: not answered as stored.
      expect(wake.storedInput('thread-1', THREAD_INPUT_SOURCE, 'r1', 'first input')).toBeUndefined();
      let repeatDone = false;
      const repeat = wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'r1', 'first input')
        .then(() => undefined, (error: unknown) => error).finally(() => { repeatDone = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(repeatDone).toBe(false);
      // The first write fails: neither request is acknowledged, and the repeat wrote again first.
      failing = true;
      release();
      expect(await first).toBeInstanceOf(WakeUnsavedError);
      expect(await repeat).toBeInstanceOf(WakeUnsavedError);
      expect(wake.storedInput('thread-1', THREAD_INPUT_SOURCE, 'r1', 'first input')).toBeUndefined();
      failing = false;
      expect((await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'r1', 'first input')).status).toBe('pending');
      expect(wake.storedInput('thread-1', THREAD_INPUT_SOURCE, 'r1', 'first input')).toMatchObject({ status: 'pending' });
      expect(JSON.parse(await readFile(wake.configFilePath(), 'utf8')).events.map((e: WakeEvent) => e.eventId))
        .toEqual(['r1']);
    } finally { await f.cleanup(); }
  });

  test('an admission whose write failed is not reported settled until a write succeeds', async () => {
    const f = await fixture();
    try {
      const wake = await f.make(MANUAL);
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a1', 'input');
      await wake.tick(); // started; its receipt is in history at once
      const write = (wake as any).writeState.bind(wake);
      let failing = true;
      (wake as any).writeState = async () => { if (failing) throw new Error('disk full'); return write(); };
      await wake.tick(); // admitted in memory only
      expect(wake.list('thread-1').events[0]?.status).toBe('admitted');
      let settled: WakeEvent | undefined;
      const waiting = wake.whenSettled('thread-1', THREAD_INPUT_SOURCE, 'a1', 10_000).then(e => { settled = e; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(settled).toBeUndefined();
      failing = false;
      await wake.tick(); // writes first
      await waiting;
      expect(settled).toMatchObject({ status: 'admitted', turnId: 'turn-2' });
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
      // The accepted provider input does not hold back the schedule: both are
      // steered into the active turn in one pass, in order.
      expect(after.list('thread-1').events.map(e => [e.eventId, e.status]))
        .toEqual([['stable-provider-id', 'offered'], ['daily-1', 'offered']]);
      expect(f.counts()).toEqual({ starts: 0, steers: 2 });
      await after.tick(Date.now() + 90_000);
      expect(after.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'admitted']);
      expect(f.counts().steers).toBe(2);
      await after.tick();
      await after.tick();
      expect(after.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'admitted']);
      expect(f.counts()).toEqual({ starts: 0, steers: 2 });
      expect((await after.ingest('thread-1', 'provider', 'stable-provider-id', 'duplicate')).status)
        .toBe('admitted');
    } finally { await f.cleanup(); }
  });

  test('two sources steer one active turn before a supervised command finishes, without restarting it', async () => {
    const f = await fixture();
    let finishCommand!: (value: string) => void;
    const commandResult = new Promise<string>(resolve => { finishCommand = resolve; });
    let commandFinished = false;
    void commandResult.then(() => { commandFinished = true; });
    try {
      const wake = await f.make();
      f.setActive('long-command-turn');
      await wake.ingest('thread-1', 'timer', 'timer-1', 'scheduled input');
      await wake.ingest('thread-1', 'peer', 'peer-1', 'trusted peer input');
      for (let attempt = 0; attempt < 4 && f.counts().steers < 2; attempt++) await wake.tick();
      expect(f.counts()).toEqual({ starts: 0, steers: 2 });
      expect(commandFinished).toBe(false);
      for (let attempt = 0; attempt < 4 && wake.list('thread-1').events.some(e => e.status !== 'admitted'); attempt++) {
        await wake.tick();
      }
      expect(wake.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'admitted']);
      finishCommand('exit 0; retained output');
      expect(await commandResult).toContain('retained output');
      await wake.stop();
      const resumed = await f.make();
      expect((await resumed.ingest('thread-1', 'peer', 'peer-1', 'duplicate')).status).toBe('admitted');
      await resumed.tick();
      expect(f.counts()).toEqual({ starts: 0, steers: 2 });
    } finally { await f.cleanup(); }
  });

  test('a real supervised process survives two same-turn inputs and a wake-owner restart', async () => {
    const f = await fixture();
    // This is a real process, not a promise standing in for a command. Native
    // app-server turn/steer and tool policy still require installed acceptance.
    const child = spawn(process.execPath, ['-e',
      "process.stdout.write('ready\\n');setTimeout(()=>{process.stdout.write('late-result\\n');process.exit(0)},2200)"],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const pid = child.pid;
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk.toString(); });
    const exited = once(child, 'close');
    try {
      await once(child.stdout!, 'data');
      const before = await f.make();
      f.setActive('active-command-turn');
      await before.ingest('thread-1', 'user', 'message-1', 'A user follow-up');
      await before.ingest('thread-1', 'peer', 'message-2', 'A peer follow-up');
      for (let attempt = 0; attempt < 4 && f.counts().steers < 2; attempt++) await before.tick();
      expect(f.counts()).toEqual({ starts: 0, steers: 2 });
      expect(child.exitCode).toBeNull();
      expect(output).not.toContain('late-result');
      for (let attempt = 0; attempt < 4 && before.list('thread-1').events.some(e => e.status !== 'admitted'); attempt++) {
        await before.tick();
      }
      expect(before.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'admitted']);
      await before.stop();
      const after = await f.make();
      expect((await after.ingest('thread-1', 'peer', 'message-2', 'duplicate')).status).toBe('admitted');
      await after.tick();
      expect(f.counts()).toEqual({ starts: 0, steers: 2 });
      const [code] = await exited;
      expect(code).toBe(0);
      expect(output).toContain('late-result');
      expect(child.pid).toBe(pid);
    } finally {
      if (child.exitCode === null) child.kill();
      await f.cleanup();
    }
  }, 15_000);

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

  test('stable native client ID reconciles a steered receipt without replaying a missing text marker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-client-id-'));
    const receipts: string[] = [];
    let submissions = 0;
    const native: WakeNative = {
      inspect: async () => ({ messages: [], clientIds: receipts }),
      steer: async (_thread, turnId, _message, clientId) => {
        submissions++;
        expect(turnId).toBe('turn-1');
        expect(clientId).toMatch(/^wake_[0-9a-f]{64}$/);
        return turnId;
      },
      start: async (_thread, _message, clientId) => {
        submissions++;
        expect(clientId).toMatch(/^wake_[0-9a-f]{64}$/);
        return 'turn-1';
      },
    };
    const first = new WakeSources(native, root);
    try {
      await first.initialize();
      const event = await first.ingest('thread-1', 'source-1', 'event-1', 'approved input');
      const second = await first.ingest('thread-1', 'source-1', 'event-2', 'later input');
      expect(wakeClientId(event)).not.toBe(wakeClientId(second));
      await first.tick();
      // The second input steers the turn the first one started, although
      // history does not show that turn yet.
      expect(first.list('thread-1').events.map(e => [e.status, e.turnId])).toEqual([['offered', 'turn-1'], ['offered', 'turn-1']]);
      expect(submissions).toBe(2);
      await first.stop();
      const resumed = new WakeSources(native, root);
      try {
        await resumed.initialize();
        await resumed.tick(Date.now() + 300_000);
        expect(submissions).toBe(2);
        receipts.push(wakeClientId(event));
        await resumed.tick();
        expect(resumed.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'offered']);
        receipts.push(wakeClientId(second));
        await resumed.tick();
        expect(resumed.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'admitted']);
        expect(submissions).toBe(2);
      } finally { await resumed.stop(); }
    } finally { await first.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('only an exact terminal queue-empty ambiguous offer may be held without a duplicate turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-hold-'));
    let activeTurnId: string | undefined;
    let turnStatus = 'inProgress';
    let queueCount = 0;
    let starts = 0;
    const messages: string[] = [];
    const native: WakeNative = {
      inspect: async () => ({ activeTurnId, messages }),
      custody: async () => ({ turnStatus, queuedSubmissionCount: queueCount }),
      steer: async () => { throw new Error('unexpected steer'); },
      start: async (_thread, message) => { starts++; if (starts > 1) messages.push(message); return 'turn-offered'; },
    };
    const wake = new WakeSources(native, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.put({ id: 'old-schedule', threadId: 'thread-1', kind: 'schedule', message: 'old work',
        at: new Date(Date.now() - 1000).toISOString() });
      await wake.tick();
      const first = wake.list('thread-1').events[0]!;
      expect(first.status).toBe('offered');
      await wake.ingest('thread-1', 'provider', 'later', 'operator input');
      await expect(wake.holdOffered('thread-1', 'old-schedule', first.eventId, 'wrong-turn')).rejects.toThrow('mismatch');
      await expect(wake.holdOffered('thread-1', 'old-schedule', first.eventId, 'turn-offered')).rejects.toThrow('terminal');
      turnStatus = 'interrupted'; queueCount = 1;
      await expect(wake.holdOffered('thread-1', 'old-schedule', first.eventId, 'turn-offered')).rejects.toThrow('terminal');
      queueCount = 0; activeTurnId = 'still-active';
      await expect(wake.holdOffered('thread-1', 'old-schedule', first.eventId, 'turn-offered')).rejects.toThrow('terminal');
      activeTurnId = undefined;
      messages.push(wakeInput(first));
      await expect(wake.holdOffered('thread-1', 'old-schedule', first.eventId, 'turn-offered')).rejects.toThrow('receipt exists');
      messages.splice(0);
      const held = await wake.holdOffered('thread-1', 'old-schedule', first.eventId, 'turn-offered');
      expect(held.status).toBe('held');
      expect(held.message).toBe('old work');
      expect(wake.list('thread-1').sources[0]?.status).toBe('error');
      await wake.put({ id: 'old-schedule', threadId: 'thread-1', kind: 'schedule', message: 'reviewed future work',
        at: new Date(Date.now() + 1_000_000).toISOString() });
      expect((await wake.ingest('thread-1', 'old-schedule', first.eventId, 'duplicate')).status).toBe('held');
      await wake.tick();
      expect(starts).toBe(2);
      expect(wake.list('thread-1').events.map(e => e.status)).toEqual(['held', 'offered']);
      await wake.tick(Date.now() + 300_000);
      expect(starts).toBe(2);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('operator holds an unbound failed offer without replay and later input admits once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-unbound-hold-'));
    let starts = 0;
    let queue = 0;
    let threadStatus = 'systemError';
    let lastTurnId = 'failed-turn';
    let nativeTurnStatus = 'failed';
    const messages: string[] = [];
    const native: WakeNative = {
      inspect: async () => ({ messages }),
      custody: async () => ({ turnStatus: nativeTurnStatus, queuedSubmissionCount: queue,
        lastTurnId, threadStatus }),
      steer: async () => { throw new Error('unexpected steer'); },
      start: async (_thread, message) => { starts++; if (starts === 1) throw new Error('server overloaded');
        messages.push(message); return 'next-turn'; },
    };
    const wake = new WakeSources(native, root);
    try {
      await wake.initialize();
      await wake.put({ id: 'same-schedule', threadId: 'thread-1', kind: 'schedule',
        message: 'Original instruction', at: new Date(Date.now() - 1_000).toISOString(), everyMs: 1_200_000 });
      await wake.tick();
      const first = wake.list('thread-1').events[0]!;
      expect(first.status).toBe('offered');
      expect(first.turnId).toBeUndefined();
      await wake.ingest('thread-1', 'provider', 'later-message', 'later input');
      // A queued native submission withholds the proof that the offer did not
      // land, so it is neither offered again nor overtaken.
      queue = 1;
      await wake.tick(Date.now() + 61_000);
      queue = 0;
      expect(starts).toBe(1);
      await expect(wake.holdOffered('thread-1', 'same-schedule', first.eventId, 'failed-turn'))
        .rejects.toThrow('settled');
      // The saved timestamp is deliberately aged, not the offered event retried.
      first.offeredAt = new Date(Date.now() - 61_000).toISOString();
      // list() returns a clone; age the durable fixture through a safe stop/load.
      await wake.stop();
      const file = path.join(root, 'wake-sources.json');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      saved.events[0].offeredAt = first.offeredAt;
      await writeFile(file, JSON.stringify(saved));
      const resumed = new WakeSources(native, root);
      await resumed.initialize();
      try {
        await expect(resumed.holdOffered('thread-1', 'same-schedule', first.eventId, 'wrong-turn'))
          .rejects.toThrow('settled');
        queue = 1;
        await expect(resumed.holdOffered('thread-1', 'same-schedule', first.eventId, 'failed-turn'))
          .rejects.toThrow('terminal');
        queue = 0; threadStatus = 'active';
        await expect(resumed.holdOffered('thread-1', 'same-schedule', first.eventId, 'failed-turn'))
          .rejects.toThrow('settled');
        threadStatus = 'systemError'; lastTurnId = 'another-turn';
        await expect(resumed.holdOffered('thread-1', 'same-schedule', first.eventId, 'failed-turn'))
          .rejects.toThrow('settled');
        lastTurnId = 'failed-turn'; nativeTurnStatus = 'completed';
        await expect(resumed.holdOffered('thread-1', 'same-schedule', first.eventId, 'failed-turn'))
          .rejects.toThrow('settled');
        nativeTurnStatus = 'failed'; threadStatus = 'notLoaded'; // supervised host restart
        messages.push(wakeInput(first));
        await expect(resumed.holdOffered('thread-1', 'same-schedule', first.eventId, 'failed-turn'))
          .rejects.toThrow('receipt exists');
        messages.length = 0;
        expect((await resumed.holdOffered('thread-1', 'same-schedule', first.eventId, 'failed-turn')).status)
          .toBe('held');
        expect((await resumed.ingest('thread-1', 'same-schedule', first.eventId, 'duplicate')).status)
          .toBe('held');
        await resumed.put({ id: 'same-schedule', threadId: 'thread-1', kind: 'schedule',
          message: 'Future instruction', at: new Date(Date.now() + 600_000).toISOString(),
          everyMs: 1_200_000 });
        await resumed.tick();
        expect(starts).toBe(2);
        await resumed.tick();
        expect(resumed.list('thread-1').events.map(e => e.status)).toEqual(['held', 'admitted']);
        expect(starts).toBe(2); // the held offer is never started a second time
        await resumed.tick(Date.now() + 601_000);
        expect(resumed.list('thread-1').events.map(e => [e.eventId, e.status]))
          .toEqual([[first.eventId, 'held'], ['later-message', 'admitted'], ['same-schedule-2', 'offered']]);
        await resumed.tick();
        expect(resumed.list('thread-1').events[2]?.status).toBe('admitted');
        expect(starts).toBe(3);
      } finally { await resumed.stop(); }
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('held schedule occurrence stays held while an explicit same-ID rearm admits only the next sequence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-held-rearm-'));
    const messages: string[] = [];
    let starts = 0;
    const native: WakeNative = {
      inspect: async () => ({ messages }),
      custody: async () => ({ turnStatus: 'completed', queuedSubmissionCount: 0 }),
      steer: async () => { throw new Error('unexpected steer'); },
      start: async () => `turn-${++starts}`,
    };
    const wake = new WakeSources(native, root);
    try {
      await wake.initialize();
      const id = 'existing-monitor';
      const interval = 1_200_000;
      await wake.put({ id, threadId: 'thread-1', kind: 'schedule', message: 'existing instruction',
        at: new Date(Date.now() - 1000).toISOString(), everyMs: interval });
      await wake.tick();
      const first = wake.list('thread-1').events[0]!;
      expect(first.eventId).toBe(`${id}-1`);
      expect((await wake.holdOffered('thread-1', id, first.eventId, 'turn-1')).status).toBe('held');
      const dueAt = Date.now() + 120_000;
      const updated = await wake.put({ id, threadId: 'thread-1', kind: 'schedule', message: 'existing instruction',
        at: new Date(dueAt).toISOString(), everyMs: interval });
      expect(updated.sequence).toBe(1);
      await wake.tick(dueAt - 1);
      expect(starts).toBe(1);
      await wake.tick(dueAt);
      const [held, next] = wake.list('thread-1').events;
      expect(held?.status).toBe('held');
      expect(held?.message).toBe('existing instruction');
      expect(next?.eventId).toBe(`${id}-2`);
      expect(next?.status).toBe('offered');
      expect(starts).toBe(2);
      await wake.tick(dueAt + 1);
      expect(starts).toBe(2);
      messages.push(wakeInput(next!));
      await wake.tick(dueAt + 2);
      const state = wake.list('thread-1');
      expect(state.events.map(event => event.status)).toEqual(['held', 'admitted']);
      expect(state.sources[0]?.status).toBe('waiting');
      expect(Date.parse(state.sources[0]!.nextAt!)).toBe(dueAt + 2 + interval);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('later provider or scheduled input cannot overtake an offer of unknown outcome', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-unknown-fence-'));
    const messages: string[] = [];
    let starts = 0;
    const wake = new WakeSources({
      inspect: async () => ({ messages }),
      steer: async () => { throw new Error('unexpected steer'); },
      start: async (_thread, message) => {
        starts++;
        if (starts === 1) throw new Error('connection timed out'); // the outcome is unknown
        messages.push(message); return `turn-${starts}`;
      },
    }, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.ingest('thread-1', 'provider', 'provider-first', 'first');
      await wake.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule', message: 'second',
        at: new Date(Date.now() - 1000).toISOString() });
      const t0 = Date.now();
      await wake.tick(t0); // creates the due scheduled event, offers only the earliest provider input
      expect(starts).toBe(1);
      expect(wake.list('thread-1').events.map(e => [e.status, e.turnId])).toEqual([['offered', undefined], ['pending', undefined]]);
      await wake.tick(t0 + 120_000);
      expect(starts).toBe(1);
      messages.push(wakeInput(wake.list('thread-1').events[0]!));
      await wake.tick(t0 + 120_001);
      // Only the receipt releases the later input, in order, in the same pass.
      expect(wake.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'offered']);
      expect(starts).toBe(2);
      await wake.tick(t0 + 120_002);
      expect(starts).toBe(2);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a definitively rejected steer promptly wakes the SAME idle thread without backoff or source error', async () => {
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
    }, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'schedule', message: 'unused',
        at: new Date(Date.now() + 1_000_000).toISOString() });
      await wake.ingest('thread-1', 'provider', 'stable-id', 'approved message');
      const followUps = wake.followUpsRequested;
      await wake.tick();
      const reverted = wake.list('thread-1');
      expect(reverted.events[0]?.status).toBe('pending');
      expect(reverted.events[0]?.error).toBeUndefined();
      expect(reverted.events[0]?.nextAttemptAt).toBeUndefined();
      expect(reverted.sources[0]?.status).toBe('waiting');
      expect(reverted.sources[0]?.error).toBeUndefined();
      // The refusal asks for a prompt follow-up pass instead of waiting on the interval.
      expect(wake.followUpsRequested).toBe(followUps + 1);
      expect({ steers, starts }).toEqual({ steers: 1, starts: 0 });
      // That follow-up pass starts the now-idle thread.
      await wake.tick();
      expect({ steers, starts }).toEqual({ steers: 1, starts: 1 });
      await wake.tick();
      expect(wake.list('thread-1').events[0]?.status).toBe('admitted');
      expect(wake.list('thread-1').sources[0]?.error).toBeUndefined();
      expect({ steers, starts }).toEqual({ steers: 1, starts: 1 });
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a steer refused twice in a row is retried on the one-minute interval with a visible source error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-refused-twice-'));
    const history: Record<string, string[]> = {};
    // The inspected history keeps reporting a turn the runtime no longer has.
    let ghost = true;
    const steers: Record<string, number> = {};
    const starts: Record<string, number> = {};
    let offersInFlight = 0;
    const violations: string[] = [];
    // One thread sees the refusal as an Error, the other as a plain JSON-RPC error object.
    const refusal = (threadId: string): unknown => threadId === 'thread-error'
      ? new Error('no active turn to steer') : { message: 'no active turn to steer' };
    const observe = (threadId: string) => {
      if (++offersInFlight > 1) violations.push(`${threadId}: concurrent offers`);
      const offered = wake.list(threadId).events.filter(e => e.status === 'offered').length;
      if (offered !== 1) violations.push(`${threadId}: ${offered} offered at offer time`);
    };
    const wake = new WakeSources({
      inspect: async threadId => ({ activeTurnId: ghost ? 'ended-turn' : undefined, messages: history[threadId] ?? [] }),
      steer: async threadId => {
        observe(threadId);
        try { steers[threadId] = (steers[threadId] ?? 0) + 1; throw refusal(threadId); }
        finally { offersInFlight--; }
      },
      start: async (threadId, message) => {
        observe(threadId);
        try { starts[threadId] = (starts[threadId] ?? 0) + 1; (history[threadId] ??= []).push(message); return `turn-${threadId}`; }
        finally { offersInFlight--; }
      },
    }, root, 30_000, MANUAL);
    const threads = ['thread-error', 'thread-plain'];
    try {
      await wake.initialize();
      for (const threadId of threads) {
        await wake.put({ id: 'provider', threadId, kind: 'schedule', message: 'unused',
          at: new Date(Date.now() + 10_000_000).toISOString() });
        await wake.ingest(threadId, 'provider', 'stable-id', 'approved message');
      }
      const t0 = Date.now();
      const followUps = wake.followUpsRequested;
      await wake.tick(t0);
      for (const threadId of threads) {
        const { events, sources } = wake.list(threadId);
        expect([threadId, events[0]?.status, events[0]?.error, events[0]?.nextAttemptAt, sources[0]?.status, sources[0]?.error])
          .toEqual([threadId, 'pending', undefined, undefined, 'waiting', undefined]);
      }
      expect(wake.followUpsRequested).toBe(followUps + 2);
      // The second consecutive refusal is not the ordinary race: back off and say why.
      await wake.tick(t0 + 1);
      expect(wake.followUpsRequested).toBe(followUps + 2);
      for (const threadId of threads) {
        const { events, sources } = wake.list(threadId);
        expect([threadId, events[0]?.status, events[0]?.error, sources[0]?.status, sources[0]?.error])
          .toEqual([threadId, 'pending', 'Active turn refused the input; retrying', 'error',
            'Active turn refused the input; retrying']);
        expect(Date.parse(events[0]!.nextAttemptAt!)).toBe(t0 + 1 + 60_000);
      }
      expect(steers).toEqual({ 'thread-error': 2, 'thread-plain': 2 });
      // Not offered again before the retry time.
      await wake.tick(t0 + 30_000);
      await wake.tick(t0 + 60_000);
      expect(steers).toEqual({ 'thread-error': 2, 'thread-plain': 2 });
      expect(starts).toEqual({});
      // Once the thread is idle and the retry time has passed, the input is started and admitted.
      ghost = false;
      await wake.tick(t0 + 60_002);
      expect(starts).toEqual({ 'thread-error': 1, 'thread-plain': 1 });
      await wake.tick(t0 + 60_003);
      for (const threadId of threads) {
        const { events, sources } = wake.list(threadId);
        expect([threadId, events[0]?.status, events[0]?.error, events[0]?.nextAttemptAt, sources[0]?.error])
          .toEqual([threadId, 'admitted', undefined, undefined, undefined]);
        expect(sources[0]?.status).not.toBe('error');
      }
      expect(steers).toEqual({ 'thread-error': 2, 'thread-plain': 2 });
      expect(starts).toEqual({ 'thread-error': 1, 'thread-plain': 1 });
      expect(violations).toEqual([]);
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

  test('civil daily source coalesces missed dates and rearms by local wall clock', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      const beforePut = Date.now();
      const source = await w.put({ id: 'morning', threadId: 'thread-1', kind: 'schedule',
        message: 'check', dailyAt: '07:00', timeZone: 'America/Los_Angeles' });
      expect(source.nextAt).toBe(nextCivilDaily(beforePut, 'America/Los_Angeles', '07:00'));
      const simulatedRestartAfterMissedDays = Date.parse(source.nextAt!) + 4 * 86_400_000;
      await w.tick(simulatedRestartAfterMissedDays);
      expect(w.list('thread-1').events).toHaveLength(1);
      await w.tick(simulatedRestartAfterMissedDays + 1000);
      expect(w.list('thread-1').events[0]?.status).toBe('admitted');
      expect(w.list('thread-1').sources[0]?.nextAt).toBe(nextCivilDaily(simulatedRestartAfterMissedDays + 1000,
        'America/Los_Angeles', '07:00'));
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

  test('pause drains a running command, retains its event through restart and resumes exactly once', async () => {
    const f = await fixture();
    try {
      const wake = await f.make();
      const marker = path.join(f.root, 'command-started');
      const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started');
setTimeout(() => process.stdout.write(JSON.stringify({id:'receipt-1',message:'provider input'})), 200);`;
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      await wake.tick();
      for (let i = 0; i < 100; i++) {
        try { await readFile(marker); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      expect(wake.list('thread-1').sources[0]?.status).toBe('running');
      const before = wake.list('thread-1').sources[0]!;
      let pauseSettled = false;
      const pausing = wake.pause('thread-1', 'provider').then(result => {
        pauseSettled = true; return result;
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(pauseSettled).toBe(false);
      const pausedReceipt = await pausing;
      expect(pausedReceipt.source.paused).toBe(true);
      expect(pausedReceipt.drain).toEqual({
        drained: true, commandInFlight: false, nativeOfferInFlight: false,
        pendingEvents: 1, offeredEvents: 0,
      });
      // The command output and stable event are durable at response time, not
      // merely after a later polling loop or a killed child during restart.
      expect(wake.list('thread-1').events.map(e => [e.eventId, e.status]))
        .toEqual([['receipt-1', 'pending']]);
      await expect(wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: ['/bin/echo', 'new'] }))
        .rejects.toThrow('Resume the paused source');
      for (let i = 0; i < 100 && !wake.list('thread-1').events.length; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      await wake.tick(Date.now() + 60_000);
      const paused = wake.list('thread-1');
      expect(paused.sources[0]?.paused).toBe(true);
      expect(paused.sources[0]?.sequence).toBe(before.sequence);
      expect(paused.events.map(e => [e.eventId, e.status])).toEqual([['receipt-1', 'pending']]);
      expect(f.counts().starts).toBe(0);
      await wake.stop();
      const recovered = await f.make();
      await recovered.tick(Date.now() + 60_000);
      expect(recovered.list('thread-1').events[0]?.status).toBe('pending');
      expect(f.counts().starts).toBe(0);
      await recovered.resume('thread-1', 'provider');
      await recovered.tick();
      expect(f.counts().starts).toBe(1);
      expect(recovered.list('thread-1').events).toHaveLength(1);
      await recovered.tick();
      expect(recovered.list('thread-1').events[0]?.status).toBe('admitted');
      expect(recovered.list('thread-1').sources[0]?.nextAt).toBeDefined();
    } finally { await f.cleanup(); }
  });

  test('pause before a waiting poll preserves nextAt and does not launch or acknowledge input', async () => {
    const f = await fixture();
    try {
      const wake = await f.make();
      const original = await wake.put({ id: 'poll', threadId: 'thread-1', kind: 'command',
        argv: ['/bin/echo', '{"status":"waiting"}'] });
      const drained = await wake.pause('thread-1', 'poll');
      expect(drained.drain).toEqual({
        drained: true, commandInFlight: false, nativeOfferInFlight: false,
        pendingEvents: 0, offeredEvents: 0,
      });
      await wake.tick(Date.now() + 60_000);
      expect(wake.list('thread-1').sources[0]?.nextAt).toBe(original.nextAt);
      expect(wake.list('thread-1').events).toHaveLength(0);
      await wake.stop();
      const recovered = await f.make();
      expect(recovered.list('thread-1').sources[0]?.nextAt).toBe(original.nextAt);
      await recovered.tick(Date.now() + 60_000);
      expect(recovered.list('thread-1').sources[0]?.status).toBe('waiting');
      await recovered.resume('thread-1', 'poll');
      await recovered.tick();
      for (let i = 0; i < 100 && recovered.list('thread-1').sources[0]?.status !== 'waiting'; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      expect(recovered.list('thread-1').events).toHaveLength(0);
    } finally { await f.cleanup(); }
  });

  test('pause waits for an in-flight native offer and preserves its stable ID without replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-pause-offer-'));
    let release!: (turnId: string) => void;
    const offered = new Promise<string>(resolve => { release = resolve; });
    let started = 0;
    const wake = new WakeSources({
      inspect: async () => ({ messages: [] }),
      steer: async () => { throw new Error('unexpected steer'); },
      start: async () => { started++; return offered; },
    }, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command',
        argv: ['/bin/echo', '{"id":"stable-offer","message":"private input"}'] });
      await wake.tick();
      for (let i = 0; i < 100 && !wake.list('thread-1').events.length; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      // No background pass can offer first: this explicit pass is the one in flight.
      expect(started).toBe(0);
      const delivering = wake.tick();
      for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(started).toBe(1);
      let pauseSettled = false;
      const pausing = wake.pause('thread-1', 'provider').then(receipt => {
        pauseSettled = true; return receipt;
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(pauseSettled).toBe(false);
      release('turn-stable');
      await delivering;
      const receipt = await pausing;
      expect(receipt.drain.offeredEvents).toBe(1);
      expect(receipt.drain.nativeOfferInFlight).toBe(false);
      expect(wake.list('thread-1').events.map(event => [event.eventId, event.turnId, event.status]))
        .toEqual([['stable-offer', 'turn-stable', 'offered']]);
      await wake.tick(Date.now() + 60_000);
      expect(started).toBe(1);
    } finally { release?.('turn-stable'); await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('pause during an empty in-flight poll lets it finish without spawning another poll', async () => {
    const f = await fixture();
    try {
      const wake = await f.make();
      const marker = path.join(f.root, 'poll-started');
      const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started');
setTimeout(() => process.stdout.write(JSON.stringify({status:'waiting'})), 80);`;
      await wake.put({ id: 'poll', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      await wake.tick();
      for (let i = 0; i < 100; i++) {
        try { await readFile(marker); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      expect(wake.list('thread-1').sources[0]?.status).toBe('running');
      await wake.pause('thread-1', 'poll');
      for (let i = 0; i < 100 && wake.list('thread-1').sources[0]?.status === 'running'; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      expect(wake.list('thread-1').sources[0]?.status).toBe('waiting');
      const due = Date.parse(wake.list('thread-1').sources[0]!.nextAt!);
      await wake.tick(due + 1);
      expect(wake.list('thread-1').sources[0]?.paused).toBe(true);
      expect(wake.list('thread-1').events).toHaveLength(0);
      expect(f.counts().starts).toBe(0);
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

  test('newline-delimited output preserves a UTF-8 code point split across pipe chunks', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      const script = `const b=Buffer.from([JSON.stringify({id:'one',message:'first'}),
JSON.stringify({id:'two',message:'second 😀'}),'{"status":"more"}'].join('\\n')+'\\n');
const i=b.indexOf(Buffer.from([0xf0])); process.stdout.write(b.subarray(0,i+2));
setTimeout(()=>process.stdout.write(b.subarray(i+2)),30);`;
      await w.put({ id: 'utf8', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      await w.tick();
      await settle(() => w.list('thread-1').events.length === 2);
      expect(w.list('thread-1').events.map(e => [e.eventId, e.message])).toEqual([['one', 'first'], ['two', 'second 😀']]);
      expect(w.list('thread-1').sources[0]?.moreAvailable).toBe(true);
    } finally { await f.cleanup(); }
  });

  test('five command event lines become five ordered inputs, each steered once into the one active turn', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      f.setActive('turn-1');
      const ids = ['e1', 'e2', 'e3', 'e4', 'e5'];
      // Checked at the moment of each native offer: every earlier offer was
      // accepted (only this one's outcome is unknown), in ID order.
      const violations: string[] = [];
      f.setOnOffer((thread, message) => {
        const unknown = w.list(thread).events.filter(e => e.status === 'offered' && !e.turnId).length;
        if (unknown !== 1) violations.push(`${unknown} offers of unknown outcome`);
        const next = ids[f.messages.length];
        if (message !== `[Wake event poll/${next}]\ninput ${next}`) violations.push(`out of order before ${next}`);
      });
      const file = await outputFile(f.root, 'five', ids.map(id => JSON.stringify({ id, message: `input ${id}` })));
      await w.put({ id: 'poll', threadId: 'thread-1', kind: 'command', argv: ['/bin/cat', file] });
      await w.tick();
      await settle(() => w.list('thread-1').events.length === 5);
      expect(w.list('thread-1').events.map(e => [e.eventId, e.status])).toEqual(ids.map(id => [id, 'pending']));
      for (let i = 0; i < 20 && w.list('thread-1').events.some(e => e.status !== 'admitted'); i++) await w.tick();
      expect(w.list('thread-1').events.map(e => [e.eventId, e.status])).toEqual(ids.map(id => [id, 'admitted']));
      expect(f.messages).toEqual(ids.map(id => `[Wake event poll/${id}]\ninput ${id}`));
      expect(f.counts()).toEqual({ starts: 0, steers: 5 });
      expect(violations).toEqual([]);
    } finally { await f.cleanup(); }
  });

  test('a burst on an idle thread starts it once and steers the rest in order without waiting on the interval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-burst-'));
    const messages: string[] = [];
    let active: string | undefined;
    let starts = 0;
    let steers = 0;
    // Checked at the moment of each native offer: only this offer's outcome is unknown, in ID order.
    const violations: string[] = [];
    const observe = (message: string) => {
      const unknown = wake.list('thread-1').events.filter(e => e.status === 'offered' && !e.turnId).length;
      if (unknown !== 1) violations.push(`${unknown} offers of unknown outcome`);
      if (message !== `[Wake event peer/burst-${messages.length}]\nburst input ${messages.length}`)
        violations.push(`out of order before burst-${messages.length}`);
    };
    const wake = new WakeSources({
      inspect: async () => ({ activeTurnId: active, messages }),
      start: async (_thread, message) => { observe(message); starts++; active = 'started-turn'; messages.push(message); return 'started-turn'; },
      steer: async (_thread, turnId, message) => {
        if (turnId !== 'started-turn') throw new Error('unexpected turn');
        observe(message); steers++; messages.push(message); return turnId;
      },
    }, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      const batch = Array.from({ length: 5 }, (_, i) => ({ id: `burst-${i}`, message: `burst input ${i}` }));
      const events = await wake.ingestBatch('thread-1', 'peer', batch);
      expect(events.map(e => [e.eventId, e.status])).toEqual(batch.map(item => [item.id, 'pending']));
      const followUps = wake.followUpsRequested;
      // The first pass starts the thread and steers the other four into the
      // turn it returned, although its history read showed no active turn;
      // it asks for one prompt follow-up pass for their receipts. The next
      // pass admits all five and, with nothing left awaiting a receipt, asks
      // for none.
      let passes = 0;
      while (passes < 10 && !wake.list('thread-1').events.every(e => e.status === 'admitted')) {
        const before = wake.followUpsRequested;
        await wake.tick();
        passes++;
        if (wake.list('thread-1').events.some(e => e.status === 'offered')) expect(wake.followUpsRequested).toBe(before + 1);
      }
      expect(passes).toBe(2);
      expect(wake.followUpsRequested).toBe(followUps + 1);
      expect(wake.list('thread-1').events.map(e => e.status)).toEqual(batch.map(() => 'admitted'));
      expect(messages).toEqual(events.map(event => wakeInput(event)));
      expect({ starts, steers }).toEqual({ starts: 1, steers: 4 });
      expect(violations).toEqual([]);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('one invalid line rejects the whole command run and ingests nothing', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      const event = (id: string, message = `input ${id}`) => JSON.stringify({ id, message });
      const cases: Record<string, string[]> = {
        'bad-id': [event('ok'), event('bad/id')],
        'empty-message': [event('ok'), event('blank', '   ')],
        'long-message': [event('ok'), event('long', 'x'.repeat(32_001))],
        'duplicate-id': [event('same'), event('same')],
        'too-many': Array.from({ length: 17 }, (_, i) => event(`e${i}`)),
        'waiting-mixed': [event('ok'), '{"status":"waiting"}'],
        'more-not-last': [event('ok'), '{"status":"more"}', event('later')],
        'more-alone': ['{"status":"more"}'],
        'unknown-status': [event('ok'), '{"status":"done"}'],
        'malformed': [event('ok'), '{"id":'],
        'blank-line': [event('ok'), '', event('later')],
      };
      for (const [thread, lines] of Object.entries(cases)) {
        await w.put({ id: 'poll', threadId: thread, kind: 'command', argv: ['/bin/cat', await outputFile(f.root, thread, lines)] });
      }
      await w.tick();
      const threads = Object.keys(cases);
      await settle(() => threads.every(thread => w.list(thread).sources[0]?.status === 'error'), 1000);
      for (const thread of threads) {
        const { sources, events } = w.list(thread);
        expect([thread, sources[0]?.status, sources[0]?.error, events.length])
          .toEqual([thread, 'error', 'Wake source failed; check local service diagnostics', 0]);
      }
      // Sixteen events are the bound, not a violation.
      await w.put({ id: 'poll', threadId: 'sixteen', kind: 'command', argv: ['/bin/cat',
        await outputFile(f.root, 'sixteen', Array.from({ length: 16 }, (_, i) => event(`e${i}`)))] });
      await w.tick();
      await settle(() => w.list('sixteen').events.length === 16);
      expect(w.list('sixteen').events).toHaveLength(16);
      await expect(w.ingestBatch('direct', 'peer', [{ id: 'x', message: 'a' }, { id: 'x', message: 'b' }]))
        .rejects.toThrow('Invalid wake event');
      await expect(w.ingestBatch('direct', 'peer', [{ id: 'y', message: 'a' }, { id: 'bad/id', message: 'b' }]))
        .rejects.toThrow('Invalid wake event');
      expect(w.list('direct').events).toHaveLength(0);
    } finally { await f.cleanup(); }
  }, 20_000);

  test('command lines must be exact event or status objects; CRLF line endings are accepted', async () => {
    const f = await fixture();
    try {
      const w = await f.make(MANUAL);
      const event = (id: string, message = `input ${id}`) => JSON.stringify({ id, message });
      const lines = (...items: string[]) => `${items.join('\n')}\n`;
      // Raw stdout, so leading bytes and line endings are exactly as written.
      const rejected: Record<string, string> = {
        'string-line': lines(event('ok'), '"text"'),
        'number-line': lines(event('ok'), '42'),
        'null-line': lines(event('ok'), 'null'),
        'array-line': lines(`[${event('ok')}]`),
        'leading-bom': `﻿${lines(event('ok'))}`,
        'blank-middle': lines(event('ok'), '', event('later')),
        'two-trailing-newlines': `${lines(event('ok'))}\n`,
        'waiting-mixed': lines(event('ok'), '{"status":"waiting"}'),
        'more-not-last': lines(event('ok'), '{"status":"more"}', event('later')),
        'more-alone': lines('{"status":"more"}'),
        'event-extra-key': lines(JSON.stringify({ id: 'ok', message: 'input', extra: true })),
        'more-extra-key': lines(event('ok'), '{"status":"more","note":"x"}'),
        'waiting-extra-key': lines('{"status":"waiting","note":"x"}'),
        'whitespace-message': lines(event('ok'), event('blank', ' \t\n ')),
        'seventeen-events': lines(...Array.from({ length: 17 }, (_, i) => event(`e${i}`))),
        'eighteen-lines': lines(...Array.from({ length: 17 }, (_, i) => event(`e${i}`)), '{"status":"more"}'),
        'duplicate-ids': lines(event('same'), event('same', 'again')),
      };
      for (const [thread, output] of Object.entries(rejected)) {
        const file = path.join(f.root, `${thread}.out`);
        await writeFile(file, output);
        await w.put({ id: 'poll', threadId: thread, kind: 'command', argv: ['/bin/cat', file] });
      }
      const crlf = path.join(f.root, 'crlf.out');
      await writeFile(crlf, `${event('c1')}\r\n${event('c2')}\r\n{"status":"more"}\r\n`);
      await w.put({ id: 'poll', threadId: 'crlf', kind: 'command', argv: ['/bin/cat', crlf] });
      await w.tick();
      const threads = Object.keys(rejected);
      await settle(() => threads.every(thread => w.list(thread).sources[0]?.status === 'error') &&
        w.list('crlf').events.length === 2, 1000);
      for (const thread of threads) {
        const { sources, events } = w.list(thread);
        expect([thread, sources[0]?.status, sources[0]?.error, events.length])
          .toEqual([thread, 'error', 'Wake source failed; check local service diagnostics', 0]);
      }
      expect(w.list('crlf').events.map(e => [e.eventId, e.message])).toEqual([['c1', 'input c1'], ['c2', 'input c2']]);
      expect(w.list('crlf').sources[0]?.error).toBeUndefined();
      expect(w.list('crlf').sources[0]?.moreAvailable).toBe(true);
    } finally { await f.cleanup(); }
  }, 20_000);

  test('an event ID re-emitted by a later command run is ingested once', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      const counter = path.join(f.root, 'runs');
      const script = `const fs=require('fs');const p=${JSON.stringify(counter)};let n=0;
try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));
const ids=n===0?['a','b']:['b','c'];
process.stdout.write(ids.map(id=>JSON.stringify({id,message:'input '+id})).join('\\n')+'\\n');`;
      await w.put({ id: 'poll', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      await w.tick();
      await settle(() => w.list('thread-1').events.length === 2);
      const done = () => w.list('thread-1').events.length === 3 &&
        w.list('thread-1').events.every(e => e.status === 'admitted');
      for (let i = 0; i < 300 && !done(); i++) {
        await w.tick();
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(w.list('thread-1').events.map(e => [e.eventId, e.status]))
        .toEqual([['a', 'admitted'], ['b', 'admitted'], ['c', 'admitted']]);
      expect(f.messages).toEqual(['a', 'b', 'c'].map(id => `[Wake event poll/${id}]\ninput ${id}`));
      expect(Number(await readFile(counter, 'utf8'))).toBeGreaterThanOrEqual(2);
    } finally { await f.cleanup(); }
  }, 10_000);

  test('a command re-arms at once after its last input when its run produced events; "waiting" keeps 30 s', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-rearm-'));
    // Receipts appear only when the test adds them, so no background pass can advance admission.
    const receipts: string[] = [];
    // The second input of a run steers the turn the first one started.
    const native: WakeNative = {
      inspect: async () => ({ messages: [], clientIds: receipts }),
      start: async () => 'turn-1',
      steer: async (_thread, turnId) => turnId,
    };
    const wake = new WakeSources(native, root);
    const admit = (threadId: string, eventId: string) => receipts.push(wakeClientId({ threadId, sourceId: 'poll', eventId }));
    const source = (threadId: string) => wake.list(threadId).sources[0]!;
    try {
      await wake.initialize();
      const more = await outputFile(root, 'more', [JSON.stringify({ id: 'm1', message: 'first' }),
        JSON.stringify({ id: 'm2', message: 'second' }), '{"status":"more"}']);
      const plain = await outputFile(root, 'plain', [JSON.stringify({ id: 'p1', message: 'only' })]);
      const idle = await outputFile(root, 'idle', ['{"status":"waiting"}']);
      await wake.put({ id: 'poll', threadId: 'thread-more', kind: 'command', argv: ['/bin/cat', more] });
      await wake.put({ id: 'poll', threadId: 'thread-plain', kind: 'command', argv: ['/bin/cat', plain] });
      await wake.put({ id: 'poll', threadId: 'thread-idle', kind: 'command', argv: ['/bin/cat', idle] });
      await wake.tick();
      await settle(() => wake.list('thread-more').events.length === 2 && wake.list('thread-plain').events.length === 1 &&
        source('thread-idle').moreAvailable === false);
      expect(Date.parse(source('thread-idle').nextAt!) - Date.now()).toBeGreaterThan(25_000);
      expect(source('thread-more')).toMatchObject({ status: 'waiting', moreAvailable: true });
      expect(Date.parse(source('thread-more').nextAt!) - Date.now()).toBeGreaterThan(25_000);
      expect(source('thread-plain').moreAvailable).toBe(true);
      await wake.tick();
      admit('thread-more', 'm1');
      admit('thread-plain', 'p1');
      await wake.tick();
      // m2 still awaits admission: the pending fence holds, and the re-arm is not immediate yet.
      expect(wake.list('thread-more').events.map(e => e.status)).toEqual(['admitted', 'offered']);
      expect(Date.parse(source('thread-more').nextAt!) - Date.now()).toBeGreaterThan(25_000);
      // A run with events but no "more" also re-arms at once after its last admission.
      expect(Date.parse(source('thread-plain').nextAt!)).toBeLessThanOrEqual(Date.now());
      admit('thread-more', 'm2');
      await wake.tick();
      expect(wake.list('thread-more').events.map(e => e.status)).toEqual(['admitted', 'admitted']);
      expect(Date.parse(source('thread-more').nextAt!)).toBeLessThanOrEqual(Date.now());
      expect(source('thread-more').status).toBe('waiting');
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a configurable command re-arm polls later text behind an unadmitted event without replaying its ID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-command-rearm-'));
    const counter = path.join(root, 'runs');
    const clientIds: string[] = [];
    let starts = 0;
    const native: WakeNative = {
      inspect: async () => ({ messages: [], clientIds }),
      start: async () => { starts++; return 'turn-1'; },
      steer: async () => 'turn-1',
    };
    const script = `const fs=require('fs');const p=${JSON.stringify(counter)};let n=0;
try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));
const first=JSON.stringify({id:'first',message:'first text'});
const second=JSON.stringify({id:'second',message:'later text'});
process.stdout.write((n===0?first:n===1?first+'\\n'+second:'{"status":"waiting"}')+'\\n');`;
    let wake = new WakeSources(native, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      const put = { id: 'intake', threadId: 'thread-1', kind: 'command' as const,
        argv: [process.execPath, '-e', script], rearmMs: 2_000 };
      await wake.put(put);
      await wake.tick();
      await settle(() => wake.list('thread-1').events.length === 1 &&
        wake.list('thread-1').sources[0]?.status === 'waiting');
      expect(wake.list('thread-1').sources[0]?.rearmMs).toBe(2_000);
      await wake.tick(); // offer first, but native has not admitted it
      expect(wake.list('thread-1').events[0]?.status).toBe('offered');
      await wake.tick(Date.now() + 3_000); // collect later text despite the unresolved first offer
      await settle(() => wake.list('thread-1').events.length === 2 &&
        wake.list('thread-1').sources[0]?.status === 'waiting');
      expect(wake.list('thread-1').events.map(e => e.eventId)).toEqual(['first', 'second']);
      expect(starts).toBe(1);
      await wake.stop();
      wake = new WakeSources(native, root, 30_000, MANUAL);
      await wake.initialize();
      expect(wake.list('thread-1').sources[0]?.rearmMs).toBe(2_000);
      expect(wake.list('thread-1').events.map(e => e.eventId)).toEqual(['first', 'second']);
      clientIds.push(wakeClientId({ threadId: 'thread-1', sourceId: 'intake', eventId: 'first' }));
      await wake.tick();
      expect(wake.list('thread-1').events[0]?.status).toBe('admitted');
      clientIds.push(wakeClientId({ threadId: 'thread-1', sourceId: 'intake', eventId: 'second' }));
      await wake.tick();
      expect(wake.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'admitted']);
      expect(starts).toBe(1);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('admission during a command poll leaves its running state and re-arm to that poll', async () => {
    const f = await fixture();
    const release = path.join(f.root, 'release-command');
    const started = path.join(f.root, 'started-command');
    const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'1');
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){
clearInterval(timer);process.stdout.write('{"status":"waiting"}\\n')}},10);`;
    try {
      const wake = await f.make(MANUAL);
      await wake.put({ id: 'poll', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      const input = await wake.ingest('thread-1', 'poll', 'first', 'first input');
      await wake.tick();
      await settle(() => existsSync(started));
      expect(wake.list('thread-1').sources[0]?.status).toBe('running');
      expect(wake.list('thread-1').events[0]?.status).toBe('offered');
      f.messages.push(wakeInput(input));
      await wake.tick();
      expect(wake.list('thread-1').events[0]?.status).toBe('admitted');
      expect(wake.list('thread-1').sources[0]?.status).toBe('running');
      await writeFile(release, 'go');
      await settle(() => wake.list('thread-1').sources[0]?.status === 'waiting');
      expect(Date.parse(wake.list('thread-1').sources[0]!.nextAt!) - Date.now()).toBeGreaterThan(25_000);
    } finally { await writeFile(release, 'go'); await f.cleanup(); }
  });

  test('put refuses a command task even after its source is no longer marked running', async () => {
    const f = await fixture();
    try {
      const wake = await f.make(MANUAL);
      const source = { id: 'poll', threadId: 'thread-1', kind: 'command' as const,
        argv: ['/bin/echo', '{"status":"waiting"}'] };
      await wake.put(source);
      (wake as any).commandTasksBySource.set('thread-1:poll', Promise.resolve());
      await expect(wake.put(source)).rejects.toThrow('running command');
      (wake as any).commandTasksBySource.delete('thread-1:poll');
      expect((await wake.put(source)).status).toBe('waiting');
    } finally { await f.cleanup(); }
  });

  test('refusal during a command run stops it; duplicate refused ID and put cannot re-arm it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-command-refusal-'));
    const release = path.join(root, 'release');
    const started = path.join(root, 'started');
    const clientIds: string[] = [];
    const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'1');
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){
clearInterval(timer);process.stdout.write(JSON.stringify({id:'later',message:'later input'})+'\\n')}},10);`;
    const wake = new WakeSources({
      inspect: async () => ({ messages: [], clientIds }),
      start: async (thread) => { throw new WakeAdmissionFailure('start',
        new SubagentDirectInputError(thread, 'parent-thread')); },
      steer: async () => { throw new Error('unexpected steer'); },
    }, root, 30_000, MANUAL);
    const source = { id: 'poll', threadId: 'thread-1', kind: 'command' as const,
      argv: [process.execPath, '-e', script] };
    try {
      await wake.initialize();
      await wake.put(source);
      await wake.ingest('thread-1', 'poll', 'refused-id', 'first input');
      await wake.tick();
      await settle(() => existsSync(started));
      expect(wake.list('thread-1').events[0]?.status).toBe('refused');
      expect(wake.list('thread-1').sources[0]).toMatchObject({ status: 'error', stopped: 'refusal' });
      await expect(wake.put(source)).rejects.toThrow('running command');
      await writeFile(release, 'go');
      await settle(() => wake.list('thread-1').events.length === 2);
      expect(wake.list('thread-1').events.map(e => [e.eventId, e.status]))
        .toEqual([['refused-id', 'refused'], ['later', 'pending']]);
      expect(wake.list('thread-1').sources[0]).toMatchObject({ status: 'error', stopped: 'refusal' });
      expect(wake.list('thread-1').sources[0]?.nextAt).toBeUndefined();
      expect((await wake.ingest('thread-1', 'poll', 'refused-id', 'different')).status).toBe('refused');
      clientIds.push(wakeClientId(wake.list('thread-1').events[1]!));
      await wake.tick();
      expect(wake.list('thread-1').events[1]?.status).toBe('admitted');
      expect(wake.list('thread-1').sources[0]).toMatchObject({ status: 'error', stopped: 'refusal' });
      expect(wake.list('thread-1').sources[0]?.nextAt).toBeUndefined();
      await wake.tick(Date.now() + 600_000);
      expect(wake.list('thread-1').sources[0]?.status).toBe('error');
    } finally { await writeFile(release, 'go'); await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('operator hold or unconfirmed review during a poll cannot be undone by command exit', async () => {
    for (const decision of ['hold', 'unconfirmed'] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `wake-command-${decision}-`));
      const release = path.join(root, 'release');
      const started = path.join(root, 'started');
      const clientIds: string[] = [];
      const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'1');
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){
clearInterval(timer);process.stdout.write(JSON.stringify({id:'later',message:'later input'})+'\\n')}},10);`;
      const wake = new WakeSources({
        inspect: async () => ({ messages: [], clientIds }),
        custody: async () => ({ queuedSubmissionCount: 0, lastTurnId: 'turn-1',
          turnStatus: 'completed', threadStatus: 'idle' }),
        start: async () => 'turn-1',
        steer: async () => { throw new Error('unexpected steer'); },
      }, root, 30_000, MANUAL);
      try {
        await wake.initialize();
        await wake.put({ id: 'poll', threadId: 'thread-1', kind: 'command', rearmMs: 2_000,
          argv: [process.execPath, '-e', script] });
        await wake.ingest('thread-1', 'poll', 'first', 'first input');
        await wake.tick();
        await settle(() => existsSync(started));
        expect(wake.list('thread-1').sources[0]?.status).toBe('running');
        expect(wake.list('thread-1').events[0]?.status).toBe('offered');
        if (decision === 'hold') {
          expect((await wake.holdOffered('thread-1', 'poll', 'first', 'turn-1')).status).toBe('held');
        } else {
          const event = (wake as any).state.events[0] as WakeEvent;
          event.offerAttempts = 3;
          event.offeredAt = new Date(Date.now() - 70_000).toISOString();
          const now = Date.now();
          await wake.tick(now);
          await wake.tick(now + 16_000);
          expect(wake.list('thread-1').events[0]).toMatchObject({ status: 'offered',
            error: 'Input could not be confirmed; operator review required' });
        }
        expect(wake.list('thread-1').sources[0]?.status).toBe('error');
        expect(wake.list('thread-1').sources[0]?.nextAt).toBeUndefined();
        await writeFile(release, 'go');
        await settle(() => (wake as any).inFlight.size === 0 && wake.list('thread-1').events.length === 2);
        expect((wake as any).inFlight.size).toBe(0);
        expect(wake.list('thread-1').events.map(event => event.eventId)).toEqual(['first', 'later']);
        expect(wake.list('thread-1').sources[0]?.status).toBe('error');
        expect(wake.list('thread-1').sources[0]?.nextAt).toBeUndefined();
        if (decision === 'hold') {
          expect((await wake.ingest('thread-1', 'poll', 'first', 'different')).status).toBe('held');
        }
        // Native history later confirms the new output. A receipt may settle
        // its event, but must not silently resume the operator-stopped source.
        clientIds.push(wakeClientId(wake.list('thread-1').events[1]!));
        await wake.tick();
        expect(wake.list('thread-1').events[1]?.status).toBe('admitted');
        expect(wake.list('thread-1').sources[0]?.status).toBe('error');
        expect(wake.list('thread-1').sources[0]?.nextAt).toBeUndefined();
        await wake.tick(Date.now() + 600_000);
        expect(wake.list('thread-1').sources[0]?.status).toBe('error');
      } finally { await writeFile(release, 'go'); await wake.stop(); await rm(root, { recursive: true, force: true }); }
    }
  });

  test('pending schedule and errored command remain fenced even when due', async () => {
    const f = await fixture();
    try {
      const wake = await f.make(MANUAL);
      const command = path.join(f.root, 'ran');
      await wake.put({ id: 'scheduled', threadId: 'thread-schedule', kind: 'schedule',
        message: 'scheduled', at: new Date(Date.now() + 60_000).toISOString() });
      await wake.ingest('thread-schedule', 'scheduled', 'older', 'not admitted');
      await wake.put({ id: 'poll', threadId: 'thread-command', kind: 'command',
        argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(command)},'ran')`] });
      await wake.ingest('thread-command', 'poll', 'older', 'not admitted');
      const errored = (wake as any).state.sources.find((s: { id: string }) => s.id === 'poll');
      errored.status = 'error'; errored.nextAt = new Date(Date.now() - 1000).toISOString();
      await wake.tick(Date.now() + 120_000);
      expect(wake.list('thread-schedule').events.map(e => e.eventId)).toEqual(['older']);
      expect(wake.list('thread-command').sources[0]?.status).toBe('error');
      expect(existsSync(command)).toBe(false);
    } finally { await f.cleanup(); }
  });

  test('empty re-poll preserves immediate drain while an earlier ID awaits admission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-empty-repoll-'));
    const counter = path.join(root, 'runs');
    const clientIds: string[] = [];
    const wake = new WakeSources({
      inspect: async () => ({ messages: [], clientIds }),
      start: async () => 'turn-1',
      steer: async () => 'turn-1',
    }, root, 30_000, MANUAL);
    const script = `const fs=require('fs');const p=${JSON.stringify(counter)};let n=0;
try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));
process.stdout.write(n===0?JSON.stringify({id:'first',message:'input'})+'\\n':'{"status":"waiting"}\\n');`;
    try {
      await wake.initialize();
      await wake.put({ id: 'poll', threadId: 'thread-1', kind: 'command', rearmMs: 2_000,
        argv: [process.execPath, '-e', script] });
      await wake.tick();
      await settle(() => wake.list('thread-1').events.length === 1 &&
        wake.list('thread-1').sources[0]?.status === 'waiting');
      await wake.tick(); // offer, but no native receipt yet
      expect(wake.list('thread-1').events[0]?.status).toBe('offered');
      await wake.tick(Date.now() + 3_000);
      await settle(() => wake.list('thread-1').sources[0]?.status === 'waiting' &&
        (wake as any).inFlight.size === 0 && existsSync(counter));
      expect(await readFile(counter, 'utf8')).toBe('2');
      expect(wake.list('thread-1').sources[0]?.moreAvailable).toBe(true);
      clientIds.push(wakeClientId(wake.list('thread-1').events[0]!));
      await wake.tick();
      expect(wake.list('thread-1').events[0]?.status).toBe('admitted');
      expect(Date.parse(wake.list('thread-1').sources[0]!.nextAt!)).toBeLessThanOrEqual(Date.now());
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('command re-arm defaults to 30 s and rejects intervals below its 2 s floor', async () => {
    const f = await fixture();
    try {
      const wake = await f.make(MANUAL);
      const source = { id: 'poll', threadId: 'thread-1', kind: 'command' as const,
        argv: ['/bin/echo', '{"status":"waiting"}'] };
      await expect(wake.put({ ...source, rearmMs: 1_999 })).rejects.toThrow();
      await expect(wake.put({ ...source, rearmMs: Number.NaN })).rejects.toThrow();
      await expect(wake.put({ ...source, rearmMs: 2_000.5 })).rejects.toThrow();
      await expect(wake.put({ ...source, rearmMs: Number.MAX_SAFE_INTEGER })).rejects.toThrow();
      await expect(wake.put({ ...source, rearmMs: 2_147_483_648 })).rejects.toThrow();
      await wake.put(source);
      await wake.tick();
      await settle(() => wake.list('thread-1').sources[0]?.status === 'waiting' &&
        Date.parse(wake.list('thread-1').sources[0]?.nextAt ?? '') > Date.now());
      expect(Date.parse(wake.list('thread-1').sources[0]!.nextAt!) - Date.now()).toBeGreaterThan(25_000);
    } finally { await f.cleanup(); }
  });

  test('a command error and restart retain the error backoff and configured poll interval', async () => {
    const f = await fixture();
    try {
      const wake = await f.make(MANUAL);
      await wake.put({ id: 'poll', threadId: 'thread-1', kind: 'command', rearmMs: 2_000,
        argv: ['/bin/echo', 'not-json'] });
      await wake.tick();
      await settle(() => wake.list('thread-1').sources[0]?.status === 'error');
      const source = wake.list('thread-1').sources[0]!;
      expect(source.rearmMs).toBe(2_000);
      expect(Date.parse(source.nextAt!) - Date.now()).toBeGreaterThan(50_000);
      await wake.stop();
      const restored = await f.make(MANUAL);
      expect(restored.list('thread-1').sources[0]).toMatchObject({ status: 'error', rearmMs: 2_000 });
      expect(Date.parse(restored.list('thread-1').sources[0]!.nextAt!)).toBe(Date.parse(source.nextAt!));
      await restored.tick();
      expect(restored.list('thread-1').sources[0]?.status).toBe('error');
    } finally { await f.cleanup(); }
  });

  test('a persisted moreAvailable re-runs the command once its last input is admitted after restart', async () => {
    const f = await fixture();
    try {
      const first = await f.make(MANUAL);
      // Each run records itself; the first emits one input and "more", later runs are empty.
      const counter = path.join(f.root, 'runs');
      const script = `const fs=require('fs');const p=${JSON.stringify(counter)};let n=0;
try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));
process.stdout.write(n===0?JSON.stringify({id:'r1',message:'restart input'})+'\\n{"status":"more"}\\n':'{"status":"waiting"}\\n');`;
      await first.put({ id: 'poll', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      await first.tick();
      await settle(() => first.list('thread-1').events.length === 1 && first.list('thread-1').sources[0]?.status === 'waiting');
      await first.stop();
      expect(await readFile(counter, 'utf8')).toBe('1');
      const second = await f.make(MANUAL);
      expect(second.list('thread-1').sources[0]?.moreAvailable).toBe(true);
      await second.tick();
      const followUps = second.followUpsRequested;
      await second.tick();
      expect(second.list('thread-1').events[0]?.status).toBe('admitted');
      expect(Date.parse(second.list('thread-1').sources[0]!.nextAt!)).toBeLessThanOrEqual(Date.now());
      // Admission of the last input asks for a pass at once, and that pass runs the command again.
      expect(second.followUpsRequested).toBe(followUps + 1);
      await second.tick();
      await settle(() => second.list('thread-1').sources[0]?.moreAvailable === false &&
        second.list('thread-1').sources[0]?.status === 'waiting');
      expect(await readFile(counter, 'utf8')).toBe('2');
      expect(Date.parse(second.list('thread-1').sources[0]!.nextAt!) - Date.now()).toBeGreaterThan(25_000);
      expect(second.list('thread-1').events).toHaveLength(1);
      expect(f.counts()).toEqual({ starts: 1, steers: 0 });
    } finally { await f.cleanup(); }
  });

  test('a command that only re-emits an admitted ID does not earn an immediate re-run', async () => {
    const f = await fixture();
    try {
      const w = await f.make(MANUAL);
      const counter = path.join(f.root, 'runs');
      const script = `const fs=require('fs');const p=${JSON.stringify(counter)};let n=0;
try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));
process.stdout.write(JSON.stringify({id:'same',message:'repeated input'})+'\\n{"status":"more"}\\n');`;
      await w.put({ id: 'poll', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      const source = () => w.list('thread-1').sources[0]!;
      await w.tick();
      await settle(() => w.list('thread-1').events.length === 1 && source().status === 'waiting');
      expect(source().moreAvailable).toBe(true);
      await w.tick(); // offers
      await w.tick(); // admits; the run produced new input, so it re-arms at once
      expect(w.list('thread-1').events[0]?.status).toBe('admitted');
      expect(Date.parse(source().nextAt!)).toBeLessThanOrEqual(Date.now());
      await w.tick(); // second run: the same ID again, with "more"
      await settle(() => source().moreAvailable === false && source().status === 'waiting');
      expect(await readFile(counter, 'utf8')).toBe('2');
      expect(source().moreAvailable).toBe(false);
      expect(Date.parse(source().nextAt!) - Date.now()).toBeGreaterThanOrEqual(25_000);
      expect(w.list('thread-1').events.map(e => [e.eventId, e.status])).toEqual([['same', 'admitted']]);
      await w.tick();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readFile(counter, 'utf8')).toBe('2');
      expect(f.counts()).toEqual({ starts: 1, steers: 0 });
    } finally { await f.cleanup(); }
  });

  test('a command may poll later IDs while its earlier offer stays unadmitted without a second native start', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-command-fence-'));
    const releaseFirst = path.join(root, 'release-first');
    let starts = 0;
    // History never shows the marker, so the offered input stays unadmitted.
    const native: WakeNative = {
      inspect: async () => ({ messages: [] }),
      start: async () => { starts++; return 'turn-unconfirmed'; },
      steer: async () => 'turn-unconfirmed',
    };
    const counter = path.join(root, 'runs');
    // A new ID on every run; the native start for run-1 remains unconfirmed.
    const script = `const fs=require('fs');const p=${JSON.stringify(counter)};let n=0;
try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));
const output=JSON.stringify({id:'run-'+(n+1),message:'input '+(n+1)})+'\\n{"status":"more"}\\n';
if(n===0){const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFirst)})){
clearInterval(timer);process.stdout.write(output)}},10)}else process.stdout.write(output);`;
    const first = new WakeSources(native, root, 30_000, MANUAL);
    let second: WakeSources | undefined;
    const commandDrained = (wake: WakeSources, expectedEvents: number) =>
      wake.list('thread-1').events.length === expectedEvents &&
      wake.list('thread-1').sources[0]?.status === 'waiting' &&
      (wake as any).inFlight.size === 0;
    try {
      await first.initialize();
      await first.put({ id: 'poll', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      await first.tick();
      expect((first as any).inFlight.size).toBe(1);
      await settle(() => existsSync(counter));
      expect(await readFile(counter, 'utf8')).toBe('1');
      const inFlightAt = Date.now();
      // A synthetic re-arm tick during the gated child must not queue a
      // duplicate command or consume the future tick after the child exits.
      await first.tick(inFlightAt + 31_000);
      expect((first as any).inFlight.size).toBe(1);
      expect(await readFile(counter, 'utf8')).toBe('1');
      await writeFile(releaseFirst, 'continue');
      await settle(() => commandDrained(first, 1));
      expect(commandDrained(first, 1)).toBe(true);
      // The re-arm is scheduled by the completed child, not by its start.
      const t0 = Date.now();
      await first.tick(t0);
      // An accepted offer fences native admission, not future command polls.
      expect(first.list('thread-1').events.map(e => [e.eventId, e.status, e.turnId]))
        .toEqual([['run-1', 'offered', 'turn-unconfirmed']]);
      for (const [index, offset] of [31_000, 61_000].entries()) {
        await first.tick(t0 + offset);
        await settle(() => commandDrained(first, index + 2));
        expect(commandDrained(first, index + 2)).toBe(true);
      }
      expect(await readFile(counter, 'utf8')).toBe('3');
      await first.stop();
      // Restart retains the earlier native offer and polls for additional IDs.
      const file = path.join(root, 'wake-sources.json');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      saved.sources[0].nextAt = new Date(t0 - 1000).toISOString();
      await writeFile(file, JSON.stringify(saved));
      second = new WakeSources(native, root, 30_000, MANUAL);
      await second.initialize();
      await second.tick(t0 + 61_001);
      await settle(() => commandDrained(second!, 4));
      expect(commandDrained(second!, 4)).toBe(true);
      expect(await readFile(counter, 'utf8')).toBe('4');
      const events = second.list('thread-1').events;
      expect(events.map(e => e.eventId)).toEqual(['run-1', 'run-2', 'run-3', 'run-4']);
      expect(events[0]?.status).toBe('offered');
      expect(events.slice(1).every(e => e.status === 'offered' || e.status === 'pending')).toBe(true);
      expect(starts).toBe(1);
    } finally { await writeFile(releaseFirst, 'continue'); await second?.stop(); await first.stop();
      await rm(root, { recursive: true, force: true }); }
  });

  test('command output is bounded in aggregate: sixteen maximum events fit, an oversized batch is never partial', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      // U+0001 is escaped by JSON to six bytes (\u0001), the worst case per UTF-16
      // unit: sixteen such lines are about 3,072,406 bytes, under the 3,088,384 limit.
      // The oversized run adds a 200,000-byte line after them, so it is over the limit
      // in one run even though every one of its first sixteen lines would fit.
      const script = (padding: number) => `const m=String.fromCharCode(1).repeat(32000);
for(let i=0;i<16;i++)process.stdout.write(JSON.stringify({id:'e'+i,message:m})+'\\n');
if(${padding})process.stdout.write('x'.repeat(${padding})+'\\n');`;
      await w.put({ id: 'fits', threadId: 'thread-fits', kind: 'command', argv: [process.execPath, '-e', script(0)] });
      await w.put({ id: 'over', threadId: 'thread-over', kind: 'command', argv: [process.execPath, '-e', script(200_000)] });
      await w.tick();
      await settle(() => w.list('thread-fits').events.length === 16 &&
        w.list('thread-over').sources[0]?.status === 'error', 1000);
      expect(w.list('thread-fits').events.map(e => e.eventId)).toEqual(Array.from({ length: 16 }, (_, i) => `e${i}`));
      expect(w.list('thread-over').sources[0]?.error).toBe('Wake command exceeded bounded output before a provider receipt');
      expect(w.list('thread-over').events).toHaveLength(0);
    } finally { await f.cleanup(); }
  }, 20_000);

  test('a restart with part of a batch admitted delivers the remainder in order without duplicates', async () => {
    const f = await fixture();
    try {
      f.setActive('turn-1');
      const first = await f.make();
      const batch = ['r1', 'r2', 'r3', 'r4'].map(id => ({ id, message: `input ${id}` }));
      const events = await first.ingestBatch('thread-1', 'peer', batch);
      expect((await first.ingestBatch('thread-1', 'peer', batch)).map(e => e.eventId)).toEqual(['r1', 'r2', 'r3', 'r4']);
      await first.tick(); // all four are steered into the active turn, in order
      expect(f.counts()).toEqual({ starts: 0, steers: 4 });
      // The turn has consumed only the first two so far.
      const unconsumed = f.messages.splice(2);
      await first.tick();
      expect(first.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'admitted', 'offered', 'offered']);
      await first.stop();
      const second = await f.make();
      await second.tick();
      // Accepted inputs are never offered again after a restart; their bodies are kept until their receipts.
      expect(f.counts()).toEqual({ starts: 0, steers: 4 });
      expect(second.list('thread-1').events.slice(2).map(e => [e.status, e.message]))
        .toEqual([['offered', 'input r3'], ['offered', 'input r4']]);
      f.messages.push(...unconsumed);
      for (let i = 0; i < 10 && second.list('thread-1').events.some(e => e.status !== 'admitted'); i++) await second.tick();
      expect(second.list('thread-1').events.map(e => [e.eventId, e.status])).toEqual(batch.map(item => [item.id, 'admitted']));
      expect(f.messages).toEqual(events.map(event => wakeInput(event)));
      expect(f.counts()).toEqual({ starts: 0, steers: 4 });
    } finally { await f.cleanup(); }
  });

  test('the wake-sources listing advertises newline-delimited command output', async () => {
    const f = await fixture();
    try {
      const w = await f.make();
      await w.put({ id: 'poll', threadId: 'thread-1', kind: 'command', argv: ['/bin/echo', '{"status":"waiting"}'] });
      const view = w.view('thread-1');
      expect(view.commandOutput).toBe('ndjson');
      expect({ sources: view.sources, events: view.events }).toEqual(w.list('thread-1'));
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
      await writeFile(output, '{"id":"stable-provider-id","message":"approved envelope"}\n');
      const recovered = await f.make();
      await recovered.tick(retryAt + 1);
      for (let i = 0; i < 50 && recovered.list('thread-1').events.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(recovered.list('thread-1').events[0]?.eventId).toBe('stable-provider-id');
      for (let i = 0; i < 50 && recovered.list('thread-1').sources[0]?.status !== 'waiting'; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(recovered.list('thread-1').sources[0]?.status).toBe('waiting');
      expect(recovered.list('thread-1').sources[0]?.error).toBeUndefined();
      await recovered.tick();
      await recovered.tick();
      expect(recovered.list('thread-1').events[0]?.status).toBe('admitted');
      expect(f.counts()).toEqual({ starts: 1, steers: 0 });
    } finally { await f.cleanup(); }
  });

  test('oversized command output is not misreported as subscription usage', async () => {
    const f = await fixture();
    try {
      const wake = await f.make();
      await wake.put({ id: 'bounded', threadId: 'thread-1', kind: 'command',
        argv: [process.execPath, '-e', `process.stdout.write('x'.repeat(4_000_000));`] });
      await wake.tick();
      for (let i = 0; i < 100 && wake.list('thread-1').sources[0]?.status !== 'error'; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      expect(wake.list('thread-1').sources[0]?.error).toBe('Wake command exceeded bounded output before a provider receipt');
      expect(wake.list('thread-1').events).toHaveLength(0);
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

  test('resume rejection is durably diagnosed and may retry the same stable ID without another user turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-resume-reject-'));
    let attempts = 0;
    const ids: string[] = [];
    const messages: string[] = [];
    const native: WakeNative = {
      inspect: async () => ({ messages }), steer: async () => { throw new Error('unexpected'); },
      start: async (_thread, message, id) => {
        attempts++; ids.push(id!);
        if (attempts === 1) throw new WakeAdmissionFailure('resume', new Error('native sensitive diagnostic'));
        messages.push(message); return 'native-turn';
      },
    };
    const wake = new WakeSources(native, root);
    try {
      await wake.initialize();
      await wake.ingest('thread-1', 'daily', 'daily-21', 'private instruction');
      await wake.tick();
      const first = wake.list('thread-1').events[0]!;
      expect(first.status).toBe('pending');
      expect(first.failure?.phase).toBe('resume');
      expect(first.failure?.messageSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(first)).not.toContain('native sensitive diagnostic');
      await wake.tick(Date.now() + 70_000);
      expect(attempts).toBe(2);
      expect(ids[0]).toBe(ids[1]);
      await wake.tick(Date.now() + 70_001);
      expect(wake.list('thread-1').events[0]?.status).toBe('admitted');
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('native start timeout stays offered through restart, then reconciles a late client-ID receipt once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-start-timeout-'));
    let attempts = 0;
    const ids: string[] = [];
    const native: WakeNative = {
      inspect: async () => ({ messages: [], clientIds: ids }),
      steer: async () => { throw new Error('unexpected'); },
      start: async (_thread, _message, id) => {
        attempts++;
        if (attempts === 1) throw new WakeAdmissionFailure('start', new Error('timeout after submission'));
        ids.push(id!); return 'second';
      },
    };
    const first = new WakeSources(native, root);
    try {
      await first.initialize();
      const event = await first.ingest('thread-1', 'daily', 'daily-21', 'private instruction');
      await first.tick();
      expect(first.list('thread-1').events[0]?.status).toBe('offered');
      expect(first.list('thread-1').events[0]?.failure?.phase).toBe('start');
      await first.stop();
      const resumed = new WakeSources(native, root);
      try {
        await resumed.initialize();
        await resumed.tick(Date.now() + 70_000);
        expect(attempts).toBe(1);
        ids.push(wakeClientId(event));
        await resumed.tick(Date.now() + 70_001);
        expect(resumed.list('thread-1').events[0]?.status).toBe('admitted');
        expect(resumed.list('thread-1').events[0]?.failure).toBeUndefined();
        expect(attempts).toBe(1);
      } finally { await resumed.stop(); }
    } finally { await first.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('persisted errored daily offer fences later input across restart until its exact native receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-daily-offer-fence-'));
    const clientIds: string[] = [];
    const starts: string[] = [];
    const native: WakeNative = {
      inspect: async () => ({ messages: [], clientIds }),
      steer: async () => { throw Error('unexpected steer'); },
      start: async (_thread, _message, clientId) => {
        starts.push(clientId!);
        if (starts.length === 1) throw new WakeAdmissionFailure('start', Error('timed out'));
        clientIds.push(clientId!);
        return 'later-turn';
      },
    };
    const first = new WakeSources(native, root);
    try {
      await first.initialize();
      await first.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule',
        message: 'synthetic maintenance', at: new Date(Date.now() - 1_000).toISOString(),
        everyMs: 86_400_000 });
      await first.tick();
      const offered = first.list('thread-1').events[0]!;
      expect(offered.status).toBe('offered');
      expect(offered.failure?.phase).toBe('start');
      await first.ingest('thread-1', 'peer', 'later-input', 'synthetic peer input');
      await first.stop();
      const resumed = new WakeSources(native, root);
      try {
        await resumed.initialize();
        const later = Date.now() + 70_000;
        await resumed.tick(later);
        expect(resumed.list('thread-1').events.map(e => e.status)).toEqual(['offered', 'pending']);
        expect(starts).toHaveLength(1);
        clientIds.push(wakeClientId(offered));
        await resumed.tick(later + 1);
        // The exact receipt releases the later input in the same pass.
        expect(resumed.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'offered']);
        expect(starts).toHaveLength(2);
        await resumed.tick(later + 2);
        expect(resumed.list('thread-1').events.map(e => e.status)).toEqual(['admitted', 'admitted']);
        expect(starts).toHaveLength(2);
      } finally { await resumed.stop(); }
    } finally { await first.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('offered daily event remains fenced across a timed-out inspection and reconciles its late receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-offered-inspect-timeout-'));
    let resolveInspection!: (value: { messages: string[]; clientIds: string[] }) => void;
    let inspections = 0;
    let starts = 0;
    let nativeReceipt = false;
    let originalClientId = '';
    const native: WakeNative = {
      inspect: async () => {
        inspections++;
        if (inspections === 1) return { messages: [], clientIds: [] };
        if (inspections === 2) return new Promise(resolve => { resolveInspection = resolve; });
        return { messages: [], clientIds: nativeReceipt ? [originalClientId] : [] };
      },
      start: async (_thread, _message, clientId) => {
        starts++;
        originalClientId = clientId!;
        throw new WakeAdmissionFailure('start', Error('native outcome unknown'));
      },
      steer: async () => { throw Error('unexpected steer'); },
    };
    const first = new WakeSources(native, root, 5);
    try {
      await first.initialize();
      await first.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule',
        message: 'synthetic maintenance', at: new Date(Date.now() - 1_000).toISOString(),
        everyMs: 86_400_000 });
      await first.tick();
      const event = first.list('thread-1').events[0]!;
      expect(event.status).toBe('offered');
      expect(event.failure?.phase).toBe('start');
      // An offered input is never in backoff: only offering is delayed by one.
      expect(event.nextAttemptAt).toBeUndefined();
      expect(originalClientId).toBe(wakeClientId(event));
      await first.stop();
      const resumed = new WakeSources(native, root, 5);
      try {
        await resumed.initialize();
        const retry = Date.now() + 70_000;
        await resumed.tick(retry);
        // The timed-out read is not recorded on the offered input as a backoff.
        expect(resumed.list('thread-1').events[0]).toMatchObject({ status: 'offered',
          failure: { phase: 'start' } });
        expect(resumed.list('thread-1').events[0]?.nextAttemptAt).toBeUndefined();
        await resumed.tick(retry + 1);
        expect(inspections).toBe(2); // A timed-out native RPC is still in flight.
        expect(starts).toBe(1);
        nativeReceipt = true;
        resolveInspection({ messages: [], clientIds: [originalClientId] });
        await Promise.resolve();
        await resumed.tick(retry + 2);
        expect(resumed.list('thread-1').events[0]?.status).toBe('admitted');
        expect(resumed.list('thread-1').events[0]?.failure).toBeUndefined();
        expect(resumed.list('thread-1').sources[0]?.status).toBe('waiting');
        expect(starts).toBe(1);
      } finally { await resumed.stop(); }
    } finally { await first.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('due schedule survives a pre-start rejection and re-arms only after a native receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-schedule-rejection-'));
    const receipts: string[] = [];
    let attempts = 0;
    const wake = new WakeSources({
      inspect: async () => ({ messages: [], clientIds: receipts }),
      steer: async () => { throw new Error('unexpected'); },
      start: async (_thread, _message, clientId) => {
        attempts++;
        if (attempts === 1) throw new WakeAdmissionFailure('resume', new Error('native resume rejected'));
        receipts.push(clientId!); return 'native-turn';
      },
    }, root);
    try {
      await wake.initialize();
      await wake.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule',
        message: 'maintenance', at: new Date(Date.now() - 1_000).toISOString(), everyMs: 600_000 });
      await wake.tick();
      expect(wake.list('thread-1').events.map(e => [e.eventId, e.status])).toEqual([['daily-1', 'pending']]);
      expect(wake.list('thread-1').sources[0]?.nextAt).toBeUndefined();
      await wake.tick(Date.now() + 70_000);
      expect(wake.list('thread-1').events[0]?.status).toBe('offered');
      await wake.tick(Date.now() + 70_001);
      expect(wake.list('thread-1').events[0]?.status).toBe('admitted');
      expect(wake.list('thread-1').sources[0]?.status).toBe('waiting');
      expect(wake.list('thread-1').sources[0]?.nextAt).toBeTruthy();
      expect(attempts).toBe(2);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });
});

/** A native thread fake that records client IDs with their turns. `start`
 * makes its new turn active, as the runtime does; `busyTurn` starts active. */
function threadInputNative(options: { busyTurn?: string; hook?: WakeNative['onAdmitted'];
  start?: WakeNative['start'] } = {}) {
  const state = { active: options.busyTurn, starts: 0, steers: 0 };
  const messages: string[] = [];
  const clientIds: string[] = [];
  const clientTurns: Array<{ clientId: string; turnId: string }> = [];
  /** First line (the wake marker) of each offer, in offer order. */
  const offered: string[] = [];
  /** Offered events on the thread at the moment of each offer, this one included. */
  const openAtOffer: number[] = [];
  /** Offers of unknown outcome (offered, no turn saved) at the moment of each offer, this one included. */
  const unknownAtOffer: number[] = [];
  let wake: WakeSources | undefined;
  const record = (threadId: string, message: string, clientId: string | undefined, turnId: string) => {
    openAtOffer.push(wake?.list(threadId).events.filter(e => e.status === 'offered').length ?? 0);
    unknownAtOffer.push(wake?.list(threadId).events.filter(e => e.status === 'offered' && !e.turnId).length ?? 0);
    offered.push(message.split('\n')[0]!);
    messages.push(message);
    if (clientId) { clientIds.push(clientId); clientTurns.push({ clientId, turnId }); }
  };
  const native: WakeNative = {
    inspect: async () => ({ activeTurnId: state.active, messages: [...messages], clientIds: [...clientIds],
      clientTurns: [...clientTurns] }),
    steer: async (threadId, turnId, message, clientId) => {
      state.steers++; record(threadId, message, clientId, turnId); return turnId;
    },
    start: options.start ?? (async (threadId, message, clientId) => {
      state.starts++;
      const turnId = `turn-${state.starts}`;
      state.active = turnId;
      record(threadId, message, clientId, turnId);
      return turnId;
    }),
    ...(options.hook ? { onAdmitted: options.hook } : {}),
  };
  return { native, state, offered, openAtOffer, unknownAtOffer, attach: (instance: WakeSources) => { wake = instance; } };
}

/** Explicit passes until nothing on the thread awaits admission. */
async function drain(wake: WakeSources, threadId: string, passes = 40): Promise<void> {
  for (let i = 0; i < passes && wake.list(threadId).events.some(e => e.status === 'pending' || e.status === 'offered'); i++) {
    await wake.tick();
  }
}

describe('thread input events', () => {
  const sender = { computer: 'peer-host', thread: 'origin_thread-1' };

  test('events without a source record keep FIFO order with a registered source on the same thread', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-fifo-'));
    const fake = threadInputNative();
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    fake.attach(wake);
    try {
      await wake.initialize();
      await expect(wake.put({ id: THREAD_INPUT_SOURCE, threadId: 'thread-1', kind: 'schedule',
        message: 'not allowed', at: new Date().toISOString() })).rejects.toThrow('Reserved wake source ID');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a', 'first input');
      await wake.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule', message: 'scheduled input',
        at: new Date(Date.now() - 1_000).toISOString() });
      await wake.tick(); // queues daily-1 behind `a` and offers `a`
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'b', 'second input');
      await drain(wake, 'thread-1');
      expect(fake.offered).toEqual(['[Wake event thread-input/a]', '[Wake event daily/daily-1]',
        '[Wake event thread-input/b]']);
      // `daily-1` follows the accepted `a` in the same pass; `b` comes after both receipts.
      expect(fake.openAtOffer).toEqual([1, 2, 1]);
      expect(fake.unknownAtOffer).toEqual([1, 1, 1]);
      expect(wake.list('thread-1').events.map(e => [e.sourceId, e.eventId, e.status])).toEqual([
        [THREAD_INPUT_SOURCE, 'a', 'admitted'], ['daily', 'daily-1', 'admitted'], [THREAD_INPUT_SOURCE, 'b', 'admitted']]);
      expect(wake.list('thread-1').sources.map(s => s.id)).toEqual(['daily']);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('five inputs to a busy thread are steered in order with at most one offer of unknown outcome', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-busy-'));
    const fake = threadInputNative({ busyTurn: 'turn-busy' });
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    fake.attach(wake);
    try {
      await wake.initialize();
      for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) await wake.ingest('thread-1', THREAD_INPUT_SOURCE, id, `input ${id}`);
      await drain(wake, 'thread-1');
      expect(fake.offered).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'].map(id => `[Wake event thread-input/${id}]`));
      // All five are steered in the first pass; each earlier offer was accepted when the next was made.
      expect(fake.openAtOffer).toEqual([1, 2, 3, 4, 5]);
      expect(fake.unknownAtOffer).toEqual([1, 1, 1, 1, 1]);
      expect(fake.state).toMatchObject({ starts: 0, steers: 5 });
      expect(wake.list('thread-1').events.map(e => [e.status, e.turnId])).toEqual(
        Array.from({ length: 5 }, () => ['admitted', 'turn-busy']));
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('to an idle thread the first input starts a turn and the rest follow in order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-idle-'));
    const fake = threadInputNative();
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    fake.attach(wake);
    try {
      await wake.initialize();
      for (const id of ['i1', 'i2', 'i3']) await wake.ingest('thread-1', THREAD_INPUT_SOURCE, id, `input ${id}`);
      await drain(wake, 'thread-1');
      expect(fake.offered).toEqual(['i1', 'i2', 'i3'].map(id => `[Wake event thread-input/${id}]`));
      // The later inputs steer the started turn in the same pass.
      expect(fake.state).toMatchObject({ starts: 1, steers: 2 });
      expect(fake.openAtOffer).toEqual([1, 2, 3]);
      expect(fake.unknownAtOffer).toEqual([1, 1, 1]);
      expect(wake.list('thread-1').events.every(e => e.status === 'admitted' && e.turnId === 'turn-1')).toBe(true);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a repeated ID returns the stored event and is never offered twice', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-repeat-'));
    const fake = threadInputNative();
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    fake.attach(wake);
    try {
      await wake.initialize();
      const first = await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'client_1', 'original input', sender);
      await wake.tick();
      const repeated = await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'client_1', 'original input', sender);
      expect(repeated).toMatchObject({ eventId: 'client_1', status: 'offered', message: 'original input', sender });
      expect(repeated.createdAt).toBe(first.createdAt);
      // Other text, or the same text from another sender, is a different input.
      await expect(wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'client_1', 'different input', sender))
        .rejects.toBeInstanceOf(WakeContentConflictError);
      await expect(wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'client_1', 'original input'))
        .rejects.toBeInstanceOf(WakeContentConflictError);
      await drain(wake, 'thread-1');
      const admitted = await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'client_1', 'original input', sender);
      expect(admitted).toMatchObject({ status: 'admitted', turnId: 'turn-1', message: '' });
      await expect(wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'client_1', 'again', sender))
        .rejects.toBeInstanceOf(WakeContentConflictError);
      await wake.tick();
      expect(fake.offered).toEqual(['[Wake event thread-input/client_1]']);
      expect(wake.list('thread-1').events).toHaveLength(1);
      await expect(wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'client_2', 'x', { computer: 'Bad_Host' } as any))
        .rejects.toThrow('Invalid wake event');
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('the sender persists and onAdmitted runs once per input, also across a restart before it ran', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-sender-'));
    const calls: WakeAdmission[] = [];
    let recorded = false;
    const hook = async (admission: WakeAdmission) => { calls.push(admission); return recorded; };
    const make = async (withHook: boolean) => {
      const fake = threadInputNative({ busyTurn: 'turn-9', ...(withHook ? { hook } : {}) });
      const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
      fake.attach(wake);
      await wake.initialize();
      return wake;
    };
    // The process stops after the admission save and before any hand-over.
    const first = await make(false);
    await first.ingest('thread-1', THREAD_INPUT_SOURCE, 'handoff_1', 'attributed input', sender);
    await first.ingest('thread-1', THREAD_INPUT_SOURCE, 'plain_1', 'input without a sender');
    await drain(first, 'thread-1');
    expect(first.list('thread-1').events.map(e => [e.eventId, e.status, e.message, e.sender, e.outcomeWatched]))
      .toEqual([['handoff_1', 'admitted', '', sender, undefined], ['plain_1', 'admitted', '', undefined, undefined]]);
    await first.stop();
    try {
      // A hook that cannot record yet leaves the input to be offered again.
      const unrecorded = await make(true);
      await settle(() => calls.length === 1);
      expect(calls).toEqual([{ threadId: 'thread-1', sourceId: THREAD_INPUT_SOURCE, eventId: 'handoff_1',
        turnId: 'turn-9', sender }]);
      await unrecorded.stop();
      expect(JSON.parse(await readFile(path.join(root, 'wake-sources.json'), 'utf8')).events[0].outcomeWatched)
        .toBeUndefined();

      recorded = true;
      const second = await make(true);
      await settle(() => calls.length === 2);
      await settle(() => second.list('thread-1').events[0]?.outcomeWatched === true);
      expect(second.list('thread-1').events[0]?.outcomeWatched).toBe(true);
      await second.ingest('thread-1', THREAD_INPUT_SOURCE, 'handoff_2', 'second attributed input', sender);
      await drain(second, 'thread-1');
      await settle(() => calls.length === 3);
      await second.tick();
      await second.tick();
      await second.stop();
      expect(calls.map(call => call.eventId)).toEqual(['handoff_1', 'handoff_1', 'handoff_2']);

      const third = await make(true);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(calls).toHaveLength(3);
      expect(third.list('thread-1').events.filter(e => e.outcomeWatched).map(e => e.eventId))
        .toEqual(['handoff_1', 'handoff_2']);
      await third.stop();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('at startup an admission from an earlier release is marked without a hand-over; one with an admission time is handed over at any age', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-old-'));
    const now = Date.now();
    const admitted = (eventId: string, ageMs?: number): WakeEvent => ({ threadId: 'thread-1',
      sourceId: THREAD_INPUT_SOURCE, eventId, message: '', status: 'admitted',
      createdAt: new Date(now - (ageMs ?? 86_400_000) - 1_000).toISOString(), turnId: `turn-${eventId}`, sender,
      ...(ageMs !== undefined && { admittedAt: new Date(now - ageMs).toISOString() }) });
    const file = path.join(root, 'wake-sources.json');
    await writeFile(file, JSON.stringify({ sources: [], events: [
      admitted('long_ago_1', 3 * 86_400_000), admitted('earlier_release_1'), admitted('recent_1', 60_000)] }));
    const calls: WakeAdmission[] = [];
    const wake = new WakeSources({ ...threadInputNative().native,
      onAdmitted: async admission => { calls.push(admission); return true; } }, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      // The earlier release's one is on disk as handled before any hand-over runs.
      const saved = JSON.parse(await readFile(file, 'utf8')) as { events: WakeEvent[] };
      expect(saved.events.find(e => e.eventId === 'earlier_release_1')?.outcomeWatched).toBe(true);
      await settle(() => wake.list('thread-1').events.every(e => e.outcomeWatched));
      // An accepted input waits for its watch for as long as it takes: three days is not too old.
      expect(calls.map(c => c.eventId).sort()).toEqual(['long_ago_1', 'recent_1']);
      expect(wake.list('thread-1').events.every(e => e.outcomeWatched)).toBe(true);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('an admission observed after a restart takes its turn from the native receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-turn-'));
    const calls: WakeAdmission[] = [];
    const first = new WakeSources(threadInputNative().native, root, 30_000, MANUAL);
    await first.initialize();
    const event = await first.ingest('thread-1', THREAD_INPUT_SOURCE, 'handoff_3', 'attributed input', sender);
    await first.stop();
    // The offer reached the runtime, but the process stopped before its turn was saved.
    const file = path.join(root, 'wake-sources.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    Object.assign(saved.events[0], { status: 'offered', offeredAt: new Date().toISOString() });
    await writeFile(file, JSON.stringify(saved));
    const clientId = wakeClientId(event);
    const resumed = new WakeSources({
      inspect: async () => ({ messages: [], clientIds: [clientId], clientTurns: [{ clientId, turnId: 'turn-77' }] }),
      steer: async () => { throw new Error('unexpected steer'); },
      start: async () => { throw new Error('unexpected start'); },
      onAdmitted: async admission => { calls.push(admission); return true; },
    }, root, 30_000, MANUAL);
    try {
      await resumed.initialize();
      await resumed.tick();
      expect(resumed.list('thread-1').events[0]).toMatchObject({ status: 'admitted', turnId: 'turn-77', sender });
      await settle(() => calls.length === 1);
      expect(calls).toEqual([{ threadId: 'thread-1', sourceId: THREAD_INPUT_SOURCE, eventId: 'handoff_3',
        turnId: 'turn-77', sender }]);
    } finally { await resumed.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('whenSettled resolves on admission, and at the timeout or abort with the current state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-settled-'));
    const fake = threadInputNative();
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    fake.attach(wake);
    try {
      await wake.initialize();
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'w1', 'observed input');
      const waiting = wake.whenSettled('thread-1', THREAD_INPUT_SOURCE, 'w1', 10_000);
      await wake.tick();
      await wake.tick();
      expect(await waiting).toMatchObject({ eventId: 'w1', status: 'admitted', turnId: 'turn-1' });
      // Already settled: at once.
      expect((await wake.whenSettled('thread-1', THREAD_INPUT_SOURCE, 'w1', 10_000))?.status).toBe('admitted');

      await wake.ingest('thread-2', THREAD_INPUT_SOURCE, 'w2', 'unobserved input');
      const started = Date.now();
      expect((await wake.whenSettled('thread-2', THREAD_INPUT_SOURCE, 'w2', 30))?.status).toBe('pending');
      expect(Date.now() - started).toBeLessThan(5_000);
      const controller = new AbortController();
      const aborted = wake.whenSettled('thread-2', THREAD_INPUT_SOURCE, 'w2', 60_000, controller.signal);
      controller.abort();
      expect((await aborted)?.status).toBe('pending');
      expect(await wake.whenSettled('thread-2', THREAD_INPUT_SOURCE, 'missing', 10)).toBeUndefined();
      expect(wake.list('thread-2').events[0]?.status).toBe('pending');
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a sub-agent refusal settles the input as refused without fencing later input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-refused-'));
    let refuse = true;
    const fallback = threadInputNative();
    const fake = threadInputNative({
      start: async (threadId, message, clientId) => {
        if (refuse) throw new WakeAdmissionFailure('start', new SubagentDirectInputError(threadId, 'parent-thread'));
        return fallback.native.start(threadId, message, clientId);
      },
    });
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'r1', 'input to a sub-agent', sender);
      const settled = wake.whenSettled('thread-1', THREAD_INPUT_SOURCE, 'r1', 10_000);
      await wake.tick();
      expect(await settled).toMatchObject({ status: 'refused', message: '',
        refusal: { code: 'subagent_direct_input_unsupported', parentThreadId: 'parent-thread' } });
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'r2', 'later input');
      refuse = false;
      await wake.tick();
      expect(wake.list('thread-1').events.map(e => [e.eventId, e.status])).toEqual([['r1', 'refused'], ['r2', 'offered']]);
      expect(fallback.offered).toEqual(['[Wake event thread-input/r2]']);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('stop() answers an open settle waiter with the current state and clears its timer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-stop-'));
    const wake = new WakeSources(threadInputNative().native, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 's1', 'waiting input');
      const started = Date.now();
      const waiting = wake.whenSettled('thread-1', THREAD_INPUT_SOURCE, 's1', 60_000);
      await wake.stop();
      expect(await waiting).toMatchObject({ eventId: 's1', status: 'pending' });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((wake as any).settleWaiters.size).toBe(0);
      // After stop a new waiter is answered at once.
      expect((await wake.whenSettled('thread-1', THREAD_INPUT_SOURCE, 's1', 60_000))?.status).toBe('pending');
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a caller ID equal to a running source ID does not share its in-flight key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-keys-'));
    const fake = threadInputNative();
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      const script = `setTimeout(() => process.stdout.write(JSON.stringify({status:'waiting'})), 400);`;
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: [process.execPath, '-e', script] });
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'provider', 'input whose ID matches the source');
      await wake.tick(); // launches the command and, in the same pass, offers the input
      expect(wake.list('thread-1').sources[0]?.status).toBe('running');
      expect(fake.offered).toEqual(['[Wake event thread-input/provider]']);
      await settle(() => wake.list('thread-1').sources[0]?.status !== 'running');
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a caller batch holding an ID with other content is rejected whole; a source re-emitting one keeps the stored input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-thread-input-conflict-'));
    const fake = threadInputNative();
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'c1', 'stored text');
      await expect(wake.ingestBatch('thread-1', THREAD_INPUT_SOURCE, [{ id: 'c2', message: 'new' },
        { id: 'c1', message: 'other text' }])).rejects.toBeInstanceOf(WakeContentConflictError);
      expect(wake.list('thread-1').events.map(e => e.eventId)).toEqual(['c1']);
      await drain(wake, 'thread-1');
      // A source's wording for an input it already delivered may change
      // between runs; that must never stop the source or replay the input.
      await wake.ingest('thread-1', 'provider', 'x1', 'stored text');
      await drain(wake, 'thread-1');
      const offeredBefore = fake.offered.length;
      const file = await outputFile(root, 'conflict', ['{"id":"x1","message":"changed"}', '{"id":"x3","message":"fresh"}']);
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: ['/bin/cat', file] });
      await wake.tick();
      await settle(() => wake.list('thread-1').events.some(e => e.eventId === 'x3'));
      expect(wake.list('thread-1').sources[0]?.error).toBeUndefined();
      await drain(wake, 'thread-1');
      expect(wake.list('thread-1').events.filter(e => e.sourceId === 'provider').map(e => [e.eventId, e.status]))
        .toEqual([['x1', 'admitted'], ['x3', 'admitted']]);
      expect(fake.offered.length).toBe(offeredBefore + 1);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });
});

/** A native thread fake for lost offers. `lose` start RPCs fail after
 * reaching nothing; others record their client ID in a completed turn. */
function lossyNative(options: { custody?: boolean } = {}) {
  const state = { active: undefined as string | undefined, queued: 0, lose: 0, starts: 0,
    turnStatus: 'completed' as string | undefined, lastTurnId: 'turn-0' as string | null,
    threadStatus: 'idle', onCustody: undefined as (() => void) | undefined };
  const clientIds: string[] = [];
  const clientTurns: Array<{ clientId: string; turnId: string }> = [];
  /** The client ID of every start RPC, in order. */
  const offers: string[] = [];
  const native: WakeNative = {
    inspect: async () => ({ activeTurnId: state.active, messages: [], clientIds: [...clientIds],
      clientTurns: [...clientTurns] }),
    steer: async () => { throw new Error('unexpected steer'); },
    start: async (_thread, _message, clientId) => {
      state.starts++;
      offers.push(clientId!);
      if (state.lose > 0) { state.lose--; throw new Error('connection timed out'); }
      const turnId = `turn-${state.starts}`;
      clientIds.push(clientId!); clientTurns.push({ clientId: clientId!, turnId });
      state.lastTurnId = turnId; state.turnStatus = 'completed';
      return turnId;
    },
    ...(options.custody === false ? {} : { custody: async () => {
      state.onCustody?.();
      return { turnStatus: state.turnStatus, queuedSubmissionCount: state.queued,
        lastTurnId: state.lastTurnId, threadStatus: state.threadStatus };
    } }),
  };
  const receipt = (clientId: string, turnId = 'turn-late') => {
    clientIds.push(clientId); clientTurns.push({ clientId, turnId });
  };
  return { native, state, offers, clientIds, receipt };
}

describe('offers whose result was lost', () => {
  const withWake = async (native: WakeNative, run: (wake: WakeSources) => Promise<void>) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-lost-offer-'));
    const wake = new WakeSources(native, root, 30_000, MANUAL);
    try { await wake.initialize(); await run(wake); }
    finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  };
  const event = (wake: WakeSources, id: string) => wake.list('thread-1').events.find(e => e.eventId === id)!;

  test('with native proof it did not land, an offer is made again once with the same client ID and admitted', async () => {
    const fake = lossyNative();
    await withWake(fake.native, async (wake) => {
      fake.state.lose = 1;
      const stored = await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a1', 'lost input');
      const t0 = Date.now();
      await wake.tick(t0);
      expect(event(wake, 'a1').status).toBe('offered');
      // Elapsed time alone is never proof.
      await wake.tick(t0 + 30_000);
      expect(fake.state.starts).toBe(1);
      await wake.tick(t0 + 61_000); // proof: no receipt, idle, latest turn ended, empty queue; only noted
      expect(event(wake, 'a1').status).toBe('offered');
      await wake.tick(t0 + 70_000); // observed again, but less than 15 s later
      expect(event(wake, 'a1').status).toBe('offered');
      await wake.tick(t0 + 76_000); // observed again 15 s after the first: back to pending
      expect(event(wake, 'a1')).toMatchObject({ status: 'pending', offerAttempts: 1 });
      expect(event(wake, 'a1').offeredAt).toBeUndefined();
      expect(fake.state.starts).toBe(1);
      await wake.tick(t0 + 76_001);
      await wake.tick(t0 + 76_002);
      expect(event(wake, 'a1')).toMatchObject({ status: 'admitted', turnId: 'turn-2', offerAttempts: 1 });
      expect(fake.offers).toEqual([wakeClientId(stored), wakeClientId(stored)]);
      expect(fake.clientIds).toEqual([wakeClientId(stored)]); // exactly one input in history
      await wake.tick(t0 + 500_000);
      expect(fake.state.starts).toBe(2);
    });
  });

  test('no re-offer while a turn is active, the native queue holds input, or the offered turn is still running', async () => {
    const fake = lossyNative();
    await withWake(fake.native, async (wake) => {
      fake.state.lose = 1;
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a2', 'ambiguous input');
      const t0 = Date.now();
      await wake.tick(t0);
      // Each condition holds for two passes 16 s apart, which would otherwise complete the proof.
      fake.state.active = 'turn-other';
      await wake.tick(t0 + 61_000);
      await wake.tick(t0 + 77_000);
      fake.state.active = undefined; fake.state.queued = 1;
      await wake.tick(t0 + 200_000);
      await wake.tick(t0 + 216_000);
      fake.state.queued = 0; fake.state.turnStatus = 'inProgress';
      await wake.tick(t0 + 300_000);
      await wake.tick(t0 + 316_000);
      fake.state.turnStatus = 'completed'; fake.state.threadStatus = 'active';
      await wake.tick(t0 + 400_000);
      await wake.tick(t0 + 416_000);
      expect(fake.state.starts).toBe(1);
      expect(event(wake, 'a2')).toMatchObject({ status: 'offered' });
      expect(event(wake, 'a2').offerAttempts).toBeUndefined();
    });
  });

  test('without a native custody reader an unconfirmed offer is never made again', async () => {
    const fake = lossyNative({ custody: false });
    await withWake(fake.native, async (wake) => {
      fake.state.lose = 1;
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a3', 'ambiguous input');
      const t0 = Date.now();
      await wake.tick(t0);
      await wake.tick(t0 + 61_000);
      await wake.tick(t0 + 10_000_000);
      expect(fake.state.starts).toBe(1);
      expect(event(wake, 'a3').status).toBe('offered');
    });
  });

  test('a receipt that appears late admits the input without a second offer', async () => {
    const fake = lossyNative();
    await withWake(fake.native, async (wake) => {
      fake.state.lose = 2;
      const late = await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a4', 'late input');
      const early = await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a5', 'racing input');
      const t0 = Date.now();
      await wake.tick(t0);
      fake.receipt(wakeClientId(late));
      await wake.tick(t0 + 61_000);
      expect(event(wake, 'a4')).toMatchObject({ status: 'admitted', turnId: 'turn-late' });
      // a5 is offered (and lost) in that same pass; its receipt lands while
      // custody is being read, and the second history read sees it.
      expect(event(wake, 'a5').status).toBe('offered');
      fake.state.onCustody = () => fake.receipt(wakeClientId(early), 'turn-racing');
      await wake.tick(t0 + 200_000);
      await wake.tick(t0 + 200_001);
      expect(event(wake, 'a5')).toMatchObject({ status: 'admitted', turnId: 'turn-racing' });
      expect(fake.state.starts).toBe(2);
      expect(event(wake, 'a4').offerAttempts).toBeUndefined();
      expect(event(wake, 'a5').offerAttempts).toBeUndefined();
    });
  });

  test('after three re-offers an unconfirmed thread input is held and later inputs proceed', async () => {
    const fake = lossyNative();
    await withWake(fake.native, async (wake) => {
      fake.state.lose = 4;
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'c1', 'never confirmed');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'c2', 'later input');
      const settled = wake.whenSettled('thread-1', THREAD_INPUT_SOURCE, 'c1', 60_000);
      let t = Date.now();
      await wake.tick(t); // first offer, lost
      for (let attempt = 1; attempt <= 3; attempt++) {
        t += 61_000;
        await wake.tick(t); // proof noted
        expect(event(wake, 'c1').status).toBe('offered');
        t += 15_000;
        await wake.tick(t); // proof observed again: back to pending
        expect(event(wake, 'c1')).toMatchObject({ status: 'pending', offerAttempts: attempt });
        t += 1;
        await wake.tick(t); // offered again, lost again
        expect(event(wake, 'c1').status).toBe('offered');
      }
      expect(fake.state.starts).toBe(4);
      t += 61_000;
      await wake.tick(t); // proof noted once more
      expect(event(wake, 'c1').status).toBe('offered');
      t += 15_000;
      await wake.tick(t); // and observed again: held, and c2 follows in the same pass
      // Held with its text and ID retained for review; never admitted.
      expect(await settled).toMatchObject({ eventId: 'c1', status: 'held', message: 'never confirmed',
        error: 'Input could not be confirmed; operator review required' });
      expect(event(wake, 'c2').status).toBe('offered');
      await wake.tick(t + 1);
      expect(event(wake, 'c2').status).toBe('admitted');
      expect(fake.state.starts).toBe(5);
      expect(new Set(fake.offers.slice(0, 4)).size).toBe(1);
    });
  });

  test('a configured source at the cap stays offered with a visible error for review', async () => {
    const fake = lossyNative();
    await withWake(fake.native, async (wake) => {
      fake.state.lose = 4;
      await wake.ingest('thread-1', 'provider', 'p1', 'never confirmed');
      let t = Date.now();
      await wake.tick(t);
      for (let attempt = 1; attempt <= 3; attempt++) {
        t += 61_000; await wake.tick(t); t += 15_000; await wake.tick(t); t += 1; await wake.tick(t);
      }
      t += 61_000;
      await wake.tick(t);
      expect(event(wake, 'p1').error).not.toBe('Input could not be confirmed; operator review required'); // only noted
      t += 15_000;
      await wake.tick(t);
      expect(event(wake, 'p1')).toMatchObject({ status: 'offered', offerAttempts: 3,
        error: 'Input could not be confirmed; operator review required' });
      await wake.tick(t + 1_000_000);
      expect(fake.state.starts).toBe(4);
    });
  });
});

describe('queue fences', () => {
  test('a save that fails before the offer leaves the input pending and makes no native call', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-offer-save-'));
    const fake = threadInputNative();
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'f1', 'input');
      const write = (wake as any).writeState.bind(wake);
      let failing = true;
      (wake as any).writeState = async () => { if (failing) throw new Error('disk full'); return write(); };
      const t0 = Date.now();
      await wake.tick(t0);
      expect(fake.offered).toEqual([]);
      expect(wake.list('thread-1').events[0]).toMatchObject({ status: 'pending' });
      expect(wake.list('thread-1').events[0]?.offeredAt).toBeUndefined();
      failing = false;
      await wake.tick(t0 + 61_000);
      await wake.tick(t0 + 61_001);
      expect(fake.offered).toEqual(['[Wake event thread-input/f1]']);
      expect(wake.list('thread-1').events[0]?.status).toBe('admitted');
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test("a paused source's input waits while other inputs on the thread proceed in order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-paused-fence-'));
    const fake = threadInputNative();
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: ['/bin/echo', '{"status":"waiting"}'] });
      await wake.ingest('thread-1', 'provider', 'e1', 'paused input');
      await wake.pause('thread-1', 'provider');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 't1', 'first other input');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 't2', 'second other input');
      for (let i = 0; i < 6; i++) await wake.tick();
      expect(fake.offered).toEqual(['[Wake event thread-input/t1]', '[Wake event thread-input/t2]']);
      expect(wake.list('thread-1').events.map(e => [e.eventId, e.status]))
        .toEqual([['e1', 'pending'], ['t1', 'admitted'], ['t2', 'admitted']]);
      await wake.resume('thread-1', 'provider');
      await wake.tick();
      await wake.tick();
      expect(fake.offered).toEqual(['[Wake event thread-input/t1]', '[Wake event thread-input/t2]',
        '[Wake event provider/e1]']);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a command source stopped by a refusal stays stopped across a restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-refused-restart-'));
    const make = (refuse: boolean) => new WakeSources(threadInputNative({ start: async (threadId) => {
      if (refuse) throw new WakeAdmissionFailure('start', new SubagentDirectInputError(threadId, null));
      throw new Error('unexpected start');
    } }).native, root, 30_000, MANUAL);
    const first = make(true);
    try {
      await first.initialize();
      const file = await outputFile(root, 'refused', ['{"id":"r1","message":"input"}']);
      await first.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: ['/bin/cat', file] });
      await first.tick();
      await settle(() => first.list('thread-1').events.length === 1 &&
        first.list('thread-1').sources[0]?.status !== 'running');
      await first.tick();
      expect(first.list('thread-1').sources[0]).toMatchObject({ status: 'error', stopped: 'refusal' });
      expect(first.list('thread-1').sources[0]?.nextAt).toBeUndefined();
    } finally { await first.stop(); }
    const second = make(false);
    try {
      await second.initialize();
      expect(second.list('thread-1').sources[0]).toMatchObject({ status: 'error', stopped: 'refusal' });
      expect(second.list('thread-1').sources[0]?.nextAt).toBeUndefined();
      await second.tick(Date.now() + 10_000_000);
      expect(second.list('thread-1').events.map(e => e.status)).toEqual(['refused']);
    } finally { await second.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('history is inspected only back to the oldest input awaiting admission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-inspect-window-'));
    const fake = threadInputNative({ busyTurn: 'turn-busy' });
    const windows: Array<string | undefined> = [];
    const inspect = fake.native.inspect;
    fake.native.inspect = async (threadId, since) => { windows.push(since); return inspect(threadId, since); };
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    fake.attach(wake);
    try {
      await wake.initialize();
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'w1', 'first');
      await drain(wake, 'thread-1');
      const admittedAt = Date.now();
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'w2', 'second');
      const created = Date.parse(wake.list('thread-1').events[1]!.createdAt);
      windows.length = 0;
      await drain(wake, 'thread-1');
      // Every read is bounded by the unadmitted input, never the admitted one.
      expect(windows.length).toBeGreaterThan(0);
      for (const since of windows) {
        expect(since).toBeDefined();
        expect(Date.parse(since!)).toBe(created - 60_000);
        expect(Date.parse(since!)).toBeGreaterThan(admittedAt - 120_000);
      }
      // An admitted input is never inspected again.
      windows.length = 0;
      await wake.tick();
      expect(windows).toEqual([]);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });
});

/** A native thread fake for accepted offers. A steered or started input lands
 * in history only when the test calls `land`, as a running turn consumes it.
 * Each RPC yields before it completes, and records a violation when RPCs of
 * the thread overlap, when another offer's outcome is unknown, or when a turn
 * is started while one is running; and, for an RPC the runtime takes, when
 * any earlier unadmitted input of the thread (pending, or offered without a
 * turn or bound to a turn that has ended, so it may still be offered again)
 * would be overtaken. A paused source's pending input is skipped by rule. */
function burstNative(options: { busyTurn?: string; custody?: boolean } = {}) {
  const state = { active: options.busyTurn as string | undefined, lastTurnId: (options.busyTurn ?? null) as string | null,
    starts: 0, steers: 0, queued: 0, fail: 0, inspections: 0,
    /** History lags: it does not show the active turn. */
    hideActive: false,
    /** Start RPCs that start the turn and then lose their response. */
    failAfterStart: 0,
    /** History reads that fail. */
    failInspect: false };
  const ended = new Set<string>();
  const clientIds: string[] = [];
  const clientTurns: Array<{ clientId: string; turnId: string }> = [];
  const unlanded: Array<{ clientId: string; turnId: string }> = [];
  /** First line (the wake marker) of each accepted RPC, in order. */
  const offered: string[] = [];
  const violations: string[] = [];
  let inFlight = 0;
  let wake: WakeSources | undefined;
  const rpc = async (threadId: string, clientId: string, run: () => string): Promise<string> => {
    if (++inFlight > 1) violations.push('concurrent RPCs on one thread');
    const { events, sources } = wake?.list(threadId) ?? { events: [], sources: [] };
    const paused = new Set(sources.filter(s => s.paused).map(s => s.id));
    const index = events.findIndex(e => wakeClientId(e) === clientId);
    const overtaken = events.slice(0, index).filter(e => e.status === 'pending' ? !paused.has(e.sourceId)
      : e.status === 'offered' && (!e.turnId || ended.has(e.turnId)));
    const unknown = events.filter(e => e.status === 'offered' && !e.turnId).length;
    if (unknown !== 1) violations.push(`${unknown} offers of unknown outcome`);
    try {
      for (let i = 0; i < 3; i++) await Promise.resolve();
      const turnId = run();
      if (overtaken.length) violations.push(`offered out of queue order: ${overtaken.map(e => e.eventId).join(',')}`);
      return turnId;
    } finally { inFlight--; }
  };
  const native: WakeNative = {
    inspect: async () => {
      state.inspections++;
      if (state.failInspect) throw new Error('connection refused');
      return { activeTurnId: state.hideActive ? undefined : state.active, messages: [],
        clientIds: [...clientIds], clientTurns: [...clientTurns] };
    },
    steer: (threadId, turnId, message, clientId) => rpc(threadId, clientId!, () => {
      if (state.fail > 0) { state.fail--; throw new Error('connection timed out'); }
      if (ended.has(turnId) || turnId !== state.active) throw new Error('no active turn to steer');
      state.steers++; offered.push(message.split('\n')[0]!); unlanded.push({ clientId: clientId!, turnId });
      return turnId;
    }),
    start: (threadId, message, clientId) => rpc(threadId, clientId!, () => {
      if (state.fail > 0) { state.fail--; throw new Error('connection timed out'); }
      if (state.active) violations.push('turn started while another is running');
      state.starts++;
      const turnId = `turn-${state.starts}`;
      state.active = turnId; state.lastTurnId = turnId;
      offered.push(message.split('\n')[0]!); unlanded.push({ clientId: clientId!, turnId });
      if (state.failAfterStart > 0) { state.failAfterStart--; throw new WakeAdmissionFailure('start', new Error('connection timed out')); }
      return turnId;
    }),
    ...(options.custody ? { custody: async (_threadId: string, turnId?: string) => {
      const id = turnId ?? state.lastTurnId;
      return { turnStatus: id && ended.has(id) ? 'completed' : id && id === state.active ? 'inProgress' : undefined,
        queuedSubmissionCount: state.queued, lastTurnId: state.lastTurnId,
        threadStatus: state.active ? 'active' : 'idle' };
    } } : {}),
  };
  return { native, state, offered, violations,
    attach: (instance: WakeSources) => { wake = instance; },
    /** The running turn consumes the next `count` accepted inputs: their receipts appear. */
    land: (count = unlanded.length) => {
      for (const item of unlanded.splice(0, count)) { clientIds.push(item.clientId); clientTurns.push(item); }
    },
    /** A receipt for an input whose RPC outcome was lost. */
    receipt: (clientId: string, turnId: string) => { clientIds.push(clientId); clientTurns.push({ clientId, turnId }); },
    /** The running turn ends; with `drop`, inputs it accepted but did not consume are lost. */
    end: (drop = false) => {
      if (state.active) ended.add(state.active);
      state.active = undefined;
      if (drop) unlanded.length = 0;
    },
    /** A turn is (again) the running turn. */
    restart: (turnId: string) => { ended.delete(turnId); state.active = turnId; state.lastTurnId = turnId; } };
}

describe('accepted offers', () => {
  const sender = { computer: 'peer-host', thread: 'origin_thread-1' };
  const withWake = async (native: WakeNative, run: (wake: WakeSources, root: string) => Promise<void>) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-accepted-'));
    const wake = new WakeSources(native, root, 30_000, MANUAL);
    try { await wake.initialize(); await run(wake, root); }
    finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  };
  const marker = (id: string) => `[Wake event ${THREAD_INPUT_SOURCE}/${id}]`;
  const statuses = (wake: WakeSources) => wake.list('thread-1').events.map(e => [e.eventId, e.status, e.turnId]);

  test('a burst to a busy thread is steered in one pass and admitted in one pass, in order', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy' });
    const admitted: string[] = [];
    fake.native.onAdmitted = async admission => { admitted.push(admission.eventId); return true; };
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
      for (const id of ids) await wake.ingest('thread-1', THREAD_INPUT_SOURCE, id, `input ${id}`, sender);
      await wake.tick();
      // One history read for the thread, five steers in queue order, one RPC each.
      expect(fake.state.inspections).toBe(1);
      expect(fake.offered).toEqual(ids.map(marker));
      expect(fake.state).toMatchObject({ starts: 0, steers: 5 });
      expect(statuses(wake)).toEqual(ids.map(id => [id, 'offered', 'turn-busy']));
      // Nothing consumed yet: nothing changes and nothing is offered again.
      await wake.tick();
      expect(fake.state.steers).toBe(5);
      expect(statuses(wake)).toEqual(ids.map(id => [id, 'offered', 'turn-busy']));
      fake.land();
      await wake.tick();
      expect(statuses(wake)).toEqual(ids.map(id => [id, 'admitted', 'turn-busy']));
      await settle(() => admitted.length === 5);
      expect(admitted).toEqual(ids);
      expect(fake.violations).toEqual([]);
    });
  });

  test('an idle thread is started once; the rest steer the returned turn while history lags', async () => {
    const fake = burstNative();
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      const ids = ['i1', 'i2', 'i3', 'i4', 'i5'];
      for (const id of ids) await wake.ingest('thread-1', THREAD_INPUT_SOURCE, id, `input ${id}`);
      await wake.tick();
      expect(fake.offered).toEqual(ids.map(marker));
      expect(fake.state).toMatchObject({ starts: 1, steers: 4 });
      expect(statuses(wake)).toEqual(ids.map(id => [id, 'offered', 'turn-1']));
      // In a later pass history still does not show the turn: the open turn is steered, not a second one started.
      fake.state.hideActive = true;
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'i6', 'input i6');
      await wake.tick();
      expect(fake.state).toMatchObject({ starts: 1, steers: 5 });
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'i6')).toMatchObject({ status: 'offered', turnId: 'turn-1' });
      fake.land();
      await wake.tick();
      expect(wake.list('thread-1').events.every(e => e.status === 'admitted' && e.turnId === 'turn-1')).toBe(true);
      expect(fake.violations).toEqual([]);
    });
  });

  test('an offer of unknown outcome fences later inputs until its receipt appears', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy', custody: true });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      fake.state.fail = 1;
      const first = await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'u1', 'input u1');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'u2', 'input u2');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'u3', 'input u3');
      const t0 = Date.now();
      await wake.tick(t0);
      expect(statuses(wake)).toEqual([['u1', 'offered', undefined], ['u2', 'pending', undefined], ['u3', 'pending', undefined]]);
      // The turn is still running, so there is no proof that it did not land.
      await wake.tick(t0 + 61_000);
      expect(fake.state.steers).toBe(0);
      expect(statuses(wake).map(([, status]) => status)).toEqual(['offered', 'pending', 'pending']);
      fake.receipt(wakeClientId(first), 'turn-busy');
      await wake.tick(t0 + 61_001);
      expect(statuses(wake)).toEqual([['u1', 'admitted', 'turn-busy'], ['u2', 'offered', 'turn-busy'], ['u3', 'offered', 'turn-busy']]);
      expect(fake.offered).toEqual([marker('u2'), marker('u3')]);
      expect(fake.violations).toEqual([]);
    });
  });

  test('an offer of unknown outcome fences later inputs until native proof returns it, first, for a re-offer', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy', custody: true });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      fake.state.fail = 1;
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'v1', 'input v1');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'v2', 'input v2');
      const t0 = Date.now();
      await wake.tick(t0);
      fake.end(); // the turn ends; the lost offer never reached it
      await wake.tick(t0 + 30_000);
      expect(statuses(wake).map(([, status]) => status)).toEqual(['offered', 'pending']);
      await wake.tick(t0 + 61_000); // proof noted; v2 still waits
      expect(statuses(wake).map(([, status]) => status)).toEqual(['offered', 'pending']);
      await wake.tick(t0 + 76_000); // proof observed again: back to pending; nothing after it is offered in this pass
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'v1')).toMatchObject({ status: 'pending', offerAttempts: 1 });
      expect(fake.state).toMatchObject({ starts: 0, steers: 0 });
      await wake.tick(t0 + 76_001);
      expect(fake.offered).toEqual([marker('v1'), marker('v2')]);
      expect(fake.state).toMatchObject({ starts: 1, steers: 1 });
      fake.land();
      await wake.tick(t0 + 76_002);
      expect(statuses(wake)).toEqual([['v1', 'admitted', 'turn-1'], ['v2', 'admitted', 'turn-1']]);
      expect(fake.violations).toEqual([]);
    });
  });

  test('after a restart accepted inputs are reconciled, never offered again, and keep their bodies until admitted', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy' });
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-accepted-restart-'));
    const ids = ['r1', 'r2', 'r3'];
    try {
      const first = new WakeSources(fake.native, root, 30_000, MANUAL);
      fake.attach(first);
      await first.initialize();
      for (const id of ids) await first.ingest('thread-1', THREAD_INPUT_SOURCE, id, `input ${id}`);
      await first.tick();
      expect(statuses(first)).toEqual(ids.map(id => [id, 'offered', 'turn-busy']));
      await first.stop();
      const saved = JSON.parse(await readFile(path.join(root, 'wake-sources.json'), 'utf8')) as { events: WakeEvent[] };
      expect(saved.events.map(e => [e.status, e.turnId, e.message])).toEqual(ids.map(id => ['offered', 'turn-busy', `input ${id}`]));
      const second = new WakeSources(fake.native, root, 30_000, MANUAL);
      fake.attach(second);
      try {
        await second.initialize();
        await second.tick();
        await second.tick(Date.now() + 120_000);
        expect(fake.state.steers).toBe(3);
        expect(second.list('thread-1').events.map(e => [e.status, e.message])).toEqual(ids.map(id => ['offered', `input ${id}`]));
        fake.land();
        await second.tick();
        expect(second.list('thread-1').events.map(e => [e.status, e.message])).toEqual(ids.map(() => ['admitted', '']));
        expect(fake.state.steers).toBe(3);
        expect(fake.violations).toEqual([]);
      } finally { await second.stop(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('an accepted steer its turn ended without consuming is re-offered once, on proof, before later input', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy', custody: true });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a1', 'input a1');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a2', 'input a2');
      const t0 = Date.now();
      await wake.tick(t0);
      fake.land(1); // the turn consumes a1 ...
      fake.end(true); // ... and ends without consuming a2
      await wake.tick(t0 + 1);
      expect(statuses(wake)).toEqual([['a1', 'admitted', 'turn-busy'], ['a2', 'offered', 'turn-busy']]);
      // A later input steers the ended turn, is refused, and then waits behind a2.
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'a3', 'input a3');
      await wake.tick(t0 + 2);
      await wake.tick(t0 + 3);
      expect(statuses(wake).map(([, status]) => status)).toEqual(['admitted', 'offered', 'pending']);
      expect(fake.state).toMatchObject({ starts: 0, steers: 2 });
      await wake.tick(t0 + 61_000); // proof noted
      await wake.tick(t0 + 76_000); // proof observed again: a2 back to pending, a3 still waits
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'a2')).toMatchObject({ status: 'pending', offerAttempts: 1 });
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'a3')?.status).toBe('pending');
      await wake.tick(t0 + 76_001); // a2 starts the idle thread, a3 steers that turn
      expect(fake.offered).toEqual([marker('a1'), marker('a2'), marker('a2'), marker('a3')]);
      expect(fake.state).toMatchObject({ starts: 1, steers: 3 });
      fake.land();
      await wake.tick(t0 + 76_002);
      expect(statuses(wake)).toEqual([['a1', 'admitted', 'turn-busy'], ['a2', 'admitted', 'turn-1'], ['a3', 'admitted', 'turn-1']]);
      expect(fake.violations).toEqual([]);
    });
  });

  test('an accepted steer is not re-offered while its turn runs, the native queue holds input, or within a minute', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy', custody: true });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'b1', 'input b1');
      const t0 = Date.now();
      await wake.tick(t0);
      fake.end(true);
      // Ended, but offered less than a minute before these passes: no proof, however long apart.
      await wake.tick(t0 + 30_000);
      await wake.tick(t0 + 59_999);
      fake.restart('turn-busy'); // (for the next condition, the turn runs again)
      await wake.tick(t0 + 61_000); // the turn is running
      await wake.tick(t0 + 77_000);
      fake.end(true);
      fake.state.queued = 1;
      await wake.tick(t0 + 122_000); // the native queue holds input
      await wake.tick(t0 + 138_000);
      expect(fake.state).toMatchObject({ starts: 0, steers: 1 });
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'b1')).toMatchObject({ status: 'offered', turnId: 'turn-busy' });
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'b1')?.offerAttempts).toBeUndefined();
      fake.state.queued = 0;
      await wake.tick(t0 + 183_000); // proof noted
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'b1')?.status).toBe('offered');
      await wake.tick(t0 + 198_000); // and observed again 15 s later
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'b1')).toMatchObject({ status: 'pending', offerAttempts: 1 });
      expect(fake.violations).toEqual([]);
    });
  });

  test('only a pass that changed state asks for a follow-up pass while accepted inputs await receipts', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy' });
    let sideSave: (() => Promise<unknown>) | undefined;
    const inspect = fake.native.inspect;
    // An unrelated caller saves while the pass waits on the history read.
    fake.native.inspect = async (threadId, since) => {
      const save = sideSave; sideSave = undefined;
      if (save) await save();
      return inspect(threadId, since);
    };
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      for (const id of ['f1', 'f2', 'f3']) await wake.ingest('thread-1', THREAD_INPUT_SOURCE, id, `input ${id}`);
      const before = wake.followUpsRequested;
      await wake.tick(); // three offers: one follow-up
      expect(wake.followUpsRequested).toBe(before + 1);
      for (let i = 0; i < 10; i++) await wake.tick(); // unchanged history: none
      expect(wake.followUpsRequested).toBe(before + 1);
      // A save by another caller during a pass is not a change made by that pass.
      sideSave = () => wake.put({ id: 'later', threadId: 'thread-1', kind: 'schedule', message: 'unrelated',
        at: new Date(Date.now() + 10_000_000).toISOString() });
      await wake.tick();
      expect(sideSave).toBeUndefined();
      expect(wake.followUpsRequested).toBe(before + 1);
      fake.land(1);
      await wake.tick(); // one admission, two still awaited: one follow-up
      expect(wake.followUpsRequested).toBe(before + 2);
      fake.land();
      await wake.tick(); // the rest admitted, none awaited: none
      expect(wake.followUpsRequested).toBe(before + 2);
      expect(wake.list('thread-1').events.every(e => e.status === 'admitted')).toBe(true);
    });
  });

  test('an earlier paused input, resumed while history lags, steers the accepted turn instead of starting a second', async () => {
    const fake = burstNative();
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: ['/bin/echo', '{"status":"waiting"}'] });
      await wake.ingest('thread-1', 'provider', 'p1', 'paused input');
      await wake.pause('thread-1', 'provider');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'x1', 'input x1');
      await wake.tick(); // p1 waits; x1 starts turn-1 and is accepted
      expect(fake.state).toMatchObject({ starts: 1, steers: 0 });
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'x1')).toMatchObject({ status: 'offered', turnId: 'turn-1' });
      await wake.resume('thread-1', 'provider');
      fake.state.hideActive = true; // history does not show turn-1 yet
      await wake.tick();
      // p1 comes first in the queue, yet x1's accepted turn is steered: never a second start.
      expect(fake.state).toMatchObject({ starts: 1, steers: 1 });
      expect(wake.find('thread-1', 'provider', 'p1')).toMatchObject({ status: 'offered', turnId: 'turn-1' });
      fake.state.hideActive = false;
      fake.land();
      await wake.tick();
      expect(wake.list('thread-1').events.map(e => [e.eventId, e.status])).toEqual([['p1', 'admitted'], ['x1', 'admitted']]);
      expect(fake.violations).toEqual([]);
    });
  });

  test('an accepted steer carried into the next turn between two proofs is admitted, never offered again', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy', custody: true });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      const stored = await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'c1', 'input c1');
      const t0 = Date.now();
      await wake.tick(t0);
      fake.end(); // the turn ends without consuming c1; the runtime keeps it for its next turn
      // Between turns: no receipt, the turn ended, the queue is empty and the thread idle. Only noted.
      await wake.tick(t0 + 61_000);
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'c1')).toMatchObject({ status: 'offered', turnId: 'turn-busy' });
      // Five seconds later the next turn consumes it.
      fake.receipt(wakeClientId(stored), 'turn-next');
      await wake.tick(t0 + 66_000);
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'c1')).toMatchObject({ status: 'admitted', turnId: 'turn-next' });
      await wake.tick(t0 + 90_000);
      expect(fake.offered).toEqual([marker('c1')]);
      expect(fake.state).toMatchObject({ starts: 0, steers: 1 });
      expect(fake.violations).toEqual([]);
    });
  });

  test('a proof observed with fresh reads in two passes 15 s apart offers a lost steer again exactly once', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy', custody: true });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'd1', 'input d1');
      const find = () => wake.find('thread-1', THREAD_INPUT_SOURCE, 'd1');
      const t0 = Date.now();
      await wake.tick(t0);
      fake.end(true); // the turn ends and drops d1
      const reads = fake.state.inspections;
      await wake.tick(t0 + 61_000); // complete proof: noted
      // The pass's shared read, then two fresh reads made by the proof itself.
      expect(fake.state.inspections - reads).toBe(3);
      expect(find()?.status).toBe('offered');
      fake.state.queued = 1; // a contrary observation discards the note
      await wake.tick(t0 + 70_000);
      fake.state.queued = 0;
      await wake.tick(t0 + 76_000); // complete again, 15 s after the discarded note: noted anew
      expect(find()?.status).toBe('offered');
      await wake.tick(t0 + 91_000); // observed again 15 s later: back to pending
      expect(find()).toMatchObject({ status: 'pending', offerAttempts: 1 });
      await wake.tick(t0 + 91_001); // started on the idle thread
      fake.land();
      await wake.tick(t0 + 91_002);
      expect(find()).toMatchObject({ status: 'admitted', turnId: 'turn-1' });
      await wake.tick(t0 + 200_000);
      expect(fake.offered).toEqual([marker('d1'), marker('d1')]);
      expect(fake.state).toMatchObject({ starts: 1, steers: 1 });
      expect(fake.violations).toEqual([]);
    });
  });

  test('a failed write of the turn after the RPC leaves, after a restart, an offer of unknown outcome that fences until its receipt', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy', custody: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-accepted-unsaved-'));
    try {
      const first = new WakeSources(fake.native, root, 30_000, MANUAL);
      fake.attach(first);
      await first.initialize();
      await first.ingest('thread-1', THREAD_INPUT_SOURCE, 'k1', 'input k1');
      await first.ingest('thread-1', THREAD_INPUT_SOURCE, 'k2', 'input k2');
      // Every write after the first steer RPC returns fails, so its turn never reaches disk.
      const write = (first as any).writeState.bind(first);
      (first as any).writeState = async () => { if (fake.state.steers > 0) throw new Error('disk full'); return write(); };
      const t0 = Date.now();
      await first.tick(t0);
      expect(fake.state.steers).toBe(1);
      // The turn is in memory only: it is not reported accepted, by custody or by a waiter.
      expect(first.list('thread-1').events[0]?.turnId).toBe('turn-busy');
      expect(first.find('thread-1', THREAD_INPUT_SOURCE, 'k1')).toMatchObject({ status: 'offered' });
      expect(first.find('thread-1', THREAD_INPUT_SOURCE, 'k1')?.turnId).toBeUndefined();
      expect(threadInputCustody(first.find('thread-1', THREAD_INPUT_SOURCE, 'k1')!)).toEqual({ status: 'offered' });
      expect((await first.whenAccepted('thread-1', THREAD_INPUT_SOURCE, 'k1', 0))?.turnId).toBeUndefined();
      await first.stop();
      const saved = JSON.parse(await readFile(path.join(root, 'wake-sources.json'), 'utf8')) as { events: WakeEvent[] };
      expect(saved.events.map(e => [e.eventId, e.status, e.turnId]))
        .toEqual([['k1', 'offered', undefined], ['k2', 'pending', undefined]]);
      const second = new WakeSources(fake.native, root, 30_000, MANUAL);
      fake.attach(second);
      try {
        await second.initialize();
        await second.tick(t0 + 1);
        await second.tick(t0 + 61_000); // the turn still runs: no proof
        await second.tick(t0 + 77_000);
        expect(statuses(second)).toEqual([['k1', 'offered', undefined], ['k2', 'pending', undefined]]);
        expect(fake.state.steers).toBe(1);
        fake.land(); // k1's receipt appears
        await second.tick(t0 + 77_001);
        expect(statuses(second)).toEqual([['k1', 'admitted', 'turn-busy'], ['k2', 'offered', 'turn-busy']]);
        fake.land();
        await second.tick(t0 + 77_002);
        expect(statuses(second).map(([, status]) => status)).toEqual(['admitted', 'admitted']);
        expect(fake.offered).toEqual([marker('k1'), marker('k2')]);
        expect(fake.violations).toEqual([]);
      } finally { await second.stop(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('a failed history read leaves accepted inputs non-fencing and unpenalised; they are admitted when it returns', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy' });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      for (const id of ['h1', 'h2']) await wake.ingest('thread-1', THREAD_INPUT_SOURCE, id, `input ${id}`);
      const t0 = Date.now();
      await wake.tick(t0);
      expect(statuses(wake)).toEqual([['h1', 'offered', 'turn-busy'], ['h2', 'offered', 'turn-busy']]);
      fake.state.failInspect = true;
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'h3', 'input h3');
      await wake.tick(t0 + 1);
      // Nothing is recorded on the accepted inputs, and nothing is put in backoff.
      for (const id of ['h1', 'h2', 'h3']) {
        const event = wake.find('thread-1', THREAD_INPUT_SOURCE, id)!;
        expect([id, event.error, event.nextAttemptAt, event.failure]).toEqual([id, undefined, undefined, undefined]);
      }
      fake.state.failInspect = false;
      fake.land();
      await wake.tick(t0 + 2);
      // Admitted as soon as history can be read, and h3 is steered in that same pass.
      expect(statuses(wake)).toEqual([['h1', 'admitted', 'turn-busy'], ['h2', 'admitted', 'turn-busy'],
        ['h3', 'offered', 'turn-busy']]);
      expect(fake.violations).toEqual([]);
    });
  });

  test('backoff never delays the admission of an offered input, nor fences what follows it', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy' });
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-accepted-backoff-'));
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    const event = (eventId: string, extra: Partial<WakeEvent>): WakeEvent => ({ threadId: 'thread-1',
      sourceId: THREAD_INPUT_SOURCE, eventId, message: `input ${eventId}`, status: 'pending', createdAt: at(-5_000), ...extra });
    // An accepted input carrying a backoff, as written by an earlier version.
    await writeFile(path.join(root, 'wake-sources.json'), JSON.stringify({ sources: [], events: [
      event('q1', { status: 'offered', offeredAt: at(-1_000), turnId: 'turn-busy', nextAttemptAt: at(300_000) }),
      event('q2', {}),
    ] }));
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    fake.attach(wake);
    try {
      await wake.initialize();
      await wake.tick(now);
      expect(statuses(wake)).toEqual([['q1', 'offered', 'turn-busy'], ['q2', 'offered', 'turn-busy']]);
      fake.receipt(wakeClientId(event('q1', {})), 'turn-busy');
      await wake.tick(now + 1);
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'q1')).toMatchObject({ status: 'admitted', turnId: 'turn-busy' });
      expect(fake.violations).toEqual([]);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a start whose response is lost after the turn began, with history lagging, never starts a second turn', async () => {
    const fake = burstNative({ custody: true });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 's1', 'input s1');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 's2', 'input s2');
      fake.state.failAfterStart = 1;
      fake.state.hideActive = true;
      const t0 = Date.now();
      await wake.tick(t0); // s1 starts turn-1, and the response is lost
      expect(statuses(wake)).toEqual([['s1', 'offered', undefined], ['s2', 'pending', undefined]]);
      await wake.tick(t0 + 1);
      await wake.tick(t0 + 2); // two more passes while history does not show turn-1
      expect(fake.state).toMatchObject({ starts: 1, steers: 0 });
      expect(statuses(wake)).toEqual([['s1', 'offered', undefined], ['s2', 'pending', undefined]]);
      fake.state.hideActive = false;
      fake.land();
      await wake.tick(t0 + 3); // the receipt admits s1, and s2 steers turn-1
      expect(statuses(wake)).toEqual([['s1', 'admitted', 'turn-1'], ['s2', 'offered', 'turn-1']]);
      expect(fake.state).toMatchObject({ starts: 1, steers: 1 });
      expect(fake.violations).toEqual([]);
    });
  });

  test("a paused source's offered input of unknown outcome holds back later input until its receipt", async () => {
    const fake = burstNative({ busyTurn: 'turn-busy' });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: ['/bin/echo', '{"status":"waiting"}'] });
      const e1 = await wake.ingest('thread-1', 'provider', 'e1', 'provider input');
      fake.state.fail = 1;
      const t0 = Date.now();
      await wake.tick(t0); // e1's steer response is lost
      expect(wake.find('thread-1', 'provider', 'e1')).toMatchObject({ status: 'offered' });
      await wake.pause('thread-1', 'provider');
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 't1', 'input t1');
      await wake.tick(t0 + 1);
      await wake.tick(t0 + 2);
      // The paused source's offer still fences: t1 never overtakes it.
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 't1')?.status).toBe('pending');
      expect(fake.state.steers).toBe(0);
      fake.receipt(wakeClientId(e1), 'turn-busy');
      await wake.tick(t0 + 3); // admitted while paused (an observation), and t1 follows in the same pass
      expect(wake.find('thread-1', 'provider', 'e1')?.status).toBe('admitted');
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 't1')).toMatchObject({ status: 'offered', turnId: 'turn-busy' });
      expect(fake.violations).toEqual([]);
    });
  });

  test("a paused source's input returned to pending by the proof waits while the thread's other input proceeds", async () => {
    const fake = burstNative({ busyTurn: 'turn-busy', custody: true });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'command', argv: ['/bin/echo', '{"status":"waiting"}'] });
      await wake.ingest('thread-1', 'provider', 'e2', 'provider input');
      const t0 = Date.now();
      await wake.tick(t0); // e2 is accepted into the running turn
      await wake.pause('thread-1', 'provider');
      fake.end(true); // the turn ends and drops e2
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 't2', 'input t2');
      await wake.tick(t0 + 61_000); // proof noted; e2 still fences t2
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 't2')?.status).toBe('pending');
      await wake.tick(t0 + 76_000); // e2 back to pending under its paused source; t2 starts the idle thread
      expect(wake.find('thread-1', 'provider', 'e2')).toMatchObject({ status: 'pending', offerAttempts: 1 });
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 't2')).toMatchObject({ status: 'offered', turnId: 'turn-1' });
      await wake.tick(t0 + 76_001);
      expect(wake.find('thread-1', 'provider', 'e2')?.status).toBe('pending');
      await wake.resume('thread-1', 'provider');
      await wake.tick(t0 + 76_002); // offered once resumed, into the running turn
      expect(wake.find('thread-1', 'provider', 'e2')).toMatchObject({ status: 'offered', turnId: 'turn-1' });
      expect(fake.offered).toEqual(['[Wake event provider/e2]', marker('t2'), '[Wake event provider/e2]']);
      expect(fake.violations).toEqual([]);
    });
  });

  test('an input cancelled or paused while its history read is pending is never offered', async () => {
    for (const action of ['cancel', 'pause'] as const) {
      let offers = 0;
      let reached!: () => void;
      let release!: () => void;
      let gate: Promise<void> | undefined;
      const native: WakeNative = {
        inspect: async () => { if (gate) { reached(); await gate; } return { messages: [] }; },
        steer: async () => { offers++; return 'turn-1'; },
        start: async () => { offers++; return 'turn-1'; },
      };
      await withWake(native, async (wake) => {
        await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'schedule', message: 'unused',
          at: new Date(Date.now() + 10_000_000).toISOString() });
        await wake.ingest('thread-1', 'provider', 'e1', 'provider input');
        const reading = new Promise<void>(resolve => { reached = resolve; });
        gate = new Promise<void>(resolve => { release = resolve; });
        const pass = wake.tick();
        await reading;
        let pausing: Promise<unknown> | undefined;
        if (action === 'cancel') await wake.cancel('thread-1', 'provider');
        else {
          pausing = wake.pause('thread-1', 'provider');
          await settle(() => wake.list('thread-1').sources[0]?.paused === true);
        }
        release();
        await pass;
        await pausing;
        expect([action, offers]).toEqual([action, 0]);
        expect(wake.list('thread-1').events.map(e => e.status)).toEqual(action === 'cancel' ? [] : ['pending']);
      });
    }
  });

  test('a re-offered input in backoff whose earlier offer landed late is admitted at the next pass, never offered again', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy' });
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-reoffer-backoff-'));
    const now = Date.now();
    // Returned to pending by the proof, then its new offer failed before the runtime took it.
    const event: WakeEvent = { threadId: 'thread-1', sourceId: THREAD_INPUT_SOURCE, eventId: 'n1', message: 'input n1',
      status: 'pending', createdAt: new Date(now - 120_000).toISOString(), offerAttempts: 1,
      nextAttemptAt: new Date(now + 300_000).toISOString(), error: 'Runtime temporarily unavailable' };
    await writeFile(path.join(root, 'wake-sources.json'), JSON.stringify({ sources: [], events: [event] }));
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    fake.attach(wake);
    try {
      await wake.initialize();
      await wake.tick(now); // in backoff: not offered
      expect(statuses(wake)).toEqual([['n1', 'pending', undefined]]);
      fake.receipt(wakeClientId(event), 'turn-busy'); // the earlier offer lands late
      await wake.tick(now + 1);
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'n1')).toMatchObject({ status: 'admitted', turnId: 'turn-busy' });
      await wake.tick(now + 400_000);
      expect(fake.state).toMatchObject({ starts: 0, steers: 0 });
      expect(fake.violations).toEqual([]);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a proof noted before an operator hold is observed again from the start when the hold fails', async () => {
    const fake = burstNative({ busyTurn: 'turn-busy', custody: true });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'o1', 'input o1');
      const find = () => wake.find('thread-1', THREAD_INPUT_SOURCE, 'o1');
      const t0 = Date.now();
      await wake.tick(t0);
      fake.end(true); // the turn ends and drops o1
      await wake.tick(t0 + 61_000); // complete proof: noted
      // A hold that fails: the native queue holds input when it looks.
      fake.state.queued = 1;
      await expect(wake.holdOffered('thread-1', THREAD_INPUT_SOURCE, 'o1', 'turn-busy')).rejects.toThrow('queue-empty');
      fake.state.queued = 0;
      await wake.tick(t0 + 77_000); // not acted on: noted anew
      expect(find()).toMatchObject({ status: 'offered', turnId: 'turn-busy' });
      // A pass while a hold is in progress skips the input; the hold then fails.
      const custody = fake.native.custody!;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      fake.native.custody = async (threadId, turnId) => { await gate; return custody(threadId, turnId); };
      const holding = wake.holdOffered('thread-1', THREAD_INPUT_SOURCE, 'o1', 'turn-busy');
      await wake.tick(t0 + 93_000);
      fake.state.queued = 1;
      release();
      await expect(holding).rejects.toThrow('queue-empty');
      fake.native.custody = custody;
      fake.state.queued = 0;
      await wake.tick(t0 + 94_000); // noted anew, not acted on
      expect(find()).toMatchObject({ status: 'offered', turnId: 'turn-busy' });
      expect(find()?.offerAttempts).toBeUndefined();
      await wake.tick(t0 + 109_000); // observed again 15 s later: back to pending
      expect(find()).toMatchObject({ status: 'pending', offerAttempts: 1 });
      expect(fake.violations).toEqual([]);
    });
  });

  test('a sender-attributed input admitted by its marker with no turn known says so in its custody', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-turn-unknown-'));
    const now = Date.now();
    const event: WakeEvent = { threadId: 'thread-1', sourceId: THREAD_INPUT_SOURCE, eventId: 'm1', message: 'input m1',
      status: 'offered', createdAt: new Date(now - 5_000).toISOString(), offeredAt: new Date(now - 5_000).toISOString(),
      sender };
    await writeFile(path.join(root, 'wake-sources.json'), JSON.stringify({ sources: [], events: [event] }));
    const calls: WakeAdmission[] = [];
    const wake = new WakeSources({
      inspect: async () => ({ messages: [wakeInput(event)] }),
      steer: async () => { throw new Error('unexpected steer'); },
      start: async () => { throw new Error('unexpected start'); },
      onAdmitted: async admission => { calls.push(admission); return true; },
    }, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.tick(now);
      const stored = wake.find('thread-1', THREAD_INPUT_SOURCE, 'm1')!;
      expect(stored).toMatchObject({ status: 'admitted', outcomeReturn: 'turn_unknown' });
      expect(threadInputCustody(stored)).toEqual({ status: 'admitted', outcomeReturn: 'turn_unknown' });
      expect(calls).toEqual([]);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });
});

describe('in-memory and in-flight bounds', () => {
  const withWake = async (native: WakeNative, run: (wake: WakeSources, root: string) => Promise<void>,
    inspectTimeoutMs = 30_000, timing: { intervalMs: number; followUpMs: number; retryMs?: number } = MANUAL) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-bounds-'));
    const wake = new WakeSources(native, root, inspectTimeoutMs, timing);
    try { await wake.initialize(); await run(wake, root); }
    finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  };

  test('a hung history read is shared per thread, whatever window a later pass asks for', async () => {
    let inspections = 0;
    const native: WakeNative = {
      inspect: async () => { inspections++; return new Promise<never>(() => {}); },
      steer: async () => { throw new Error('unexpected steer'); },
      start: async () => { throw new Error('unexpected start'); },
    };
    await withWake(native, async (wake) => {
      await wake.put({ id: 'old', threadId: 'thread-1', kind: 'schedule', message: 'unused',
        at: new Date(Date.now() + 10_000_000).toISOString() });
      await wake.ingest('thread-1', 'old', 'old-1', 'oldest input');
      await new Promise(resolve => setTimeout(resolve, 5));
      await wake.ingest('thread-1', 'provider', 'new-1', 'newer input');
      const t0 = Date.now();
      await wake.tick(t0); // the read times out and stays outstanding
      await wake.cancel('thread-1', 'old'); // the oldest input goes: the window moves
      await wake.tick(t0 + 61_000);
      await wake.tick(t0 + 122_000);
      expect(inspections).toBe(1);
      expect((wake as any).nativeInspections.size).toBe(1);
    }, 10);
  });

  test('a remembered steer refusal is forgotten when its input leaves custody', async () => {
    const native: WakeNative = {
      inspect: async () => ({ activeTurnId: 'ended-turn', messages: [] }),
      steer: async () => { throw new Error('no active turn to steer'); },
      start: async () => { throw new Error('unexpected start'); },
    };
    await withWake(native, async (wake) => {
      await wake.put({ id: 'provider', threadId: 'thread-1', kind: 'schedule', message: 'unused',
        at: new Date(Date.now() + 10_000_000).toISOString() });
      await wake.ingest('thread-1', 'provider', 'r1', 'refused input');
      await wake.tick();
      expect((wake as any).steerRefusals.size).toBe(1);
      await wake.cancel('thread-1', 'provider');
      expect(wake.list('thread-1').events).toEqual([]);
      expect((wake as any).steerRefusals.size).toBe(0);
    });
  });

  test('an operator hold waiting on a hung runtime never blocks saves or acknowledgements', async () => {
    const native: WakeNative = {
      inspect: async () => ({ messages: [] }),
      custody: () => new Promise<never>(() => {}),
      steer: async () => { throw new Error('unexpected steer'); },
      start: async () => 'turn-1',
    };
    await withWake(native, async (wake) => {
      await wake.ingest('thread-1', 'provider', 'o1', 'offered input');
      await wake.tick();
      expect(wake.list('thread-1').events[0]).toMatchObject({ status: 'offered', turnId: 'turn-1' });
      const holding = wake.holdOffered('thread-1', 'provider', 'o1', 'turn-1').then(() => 'held', () => 'refused');
      const first = await Promise.race([
        wake.ingest('thread-1', 'provider', 'o2', 'later input').then(() => 'acknowledged'), holding]);
      expect(first).toBe('acknowledged');
      // The hold fails on its own deadline and changes nothing.
      expect(await holding).toBe('refused');
      expect(wake.list('thread-1').events.map(e => [e.eventId, e.status])).toEqual([['o1', 'offered'], ['o2', 'pending']]);
    }, 200);
  });

  test('stop() waits for an operator reconciliation in flight, which saves before the owner is released', async () => {
    type View = { messages: string[]; clientIds: string[] };
    let release: ((value: View) => void) | undefined;
    let gate = false;
    const native: WakeNative = {
      // Once gated, a history read waits until the test releases it.
      inspect: async () => gate ? new Promise<View>(resolve => { release = resolve; }) : { messages: [], clientIds: [] },
      steer: async () => { throw new Error('unexpected steer'); },
      start: async () => 'turn-1',
    };
    await withWake(native, async (wake, root) => {
      const source = await wake.put({ id: 'daily', threadId: 'thread-1', kind: 'schedule', message: 'daily input',
        dailyAt: '06:00', timeZone: 'UTC' });
      await wake.tick(Date.parse(source.nextAt!) + 1);
      const event = wake.list('thread-1').events[0]!;
      expect(event).toMatchObject({ status: 'offered', turnId: 'turn-1' });
      gate = true;
      const reconciling = wake.reconcileOffered('thread-1', 'daily', event.eventId,
        wake.recoverySnapshot('thread-1', 'daily').revision);
      await settle(() => release !== undefined);
      let stopped = false;
      const stopping = wake.stop().then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(stopped).toBe(false);
      release!({ messages: [], clientIds: [wakeClientId(event)] });
      expect((await reconciling).events[0]?.status).toBe('admitted');
      await stopping;
      const saved = JSON.parse(await readFile(path.join(root, 'wake-sources.json'), 'utf8')) as { events: WakeEvent[] };
      expect(saved.events[0]?.status).toBe('admitted');
      await expect(readFile(path.join(root, 'wake-sources.json.owner', 'owner.json'), 'utf8')).rejects.toThrow();
    });
  });

  test('an admission whose outcome watch was not recorded is handed over again on the retry interval', async () => {
    const calls: WakeAdmission[] = [];
    let recorded = false;
    const fake = threadInputNative({ busyTurn: 'turn-1', hook: async admission => { calls.push(admission); return recorded; } });
    await withWake(fake.native, async (wake) => {
      fake.attach(wake);
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'retry_1', 'attributed input',
        { computer: 'peer-host', thread: 'origin_thread-1' });
      await drain(wake, 'thread-1');
      await settle(() => calls.length >= 1);
      expect(wake.list('thread-1').events[0]?.outcomeWatched).toBeUndefined();
      recorded = true;
      // No restart: the retry interval hands it over again.
      await settle(() => wake.list('thread-1').events[0]?.outcomeWatched === true);
      expect(wake.list('thread-1').events[0]?.outcomeWatched).toBe(true);
      const count = calls.length;
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(calls.length).toBe(count); // once recorded, never handed over again
    }, 30_000, { intervalMs: 0, followUpMs: 0, retryMs: 20 });
  });

  test('an admission whose watch cannot be recorded keeps being handed over, however old it gets', async () => {
    const calls: WakeAdmission[] = [];
    const fake = threadInputNative({ busyTurn: 'turn-1', hook: async admission => { calls.push(admission); return false; } });
    await withWake(fake.native, async (wake, root) => {
      fake.attach(wake);
      await wake.ingest('thread-1', THREAD_INPUT_SOURCE, 'aging_1', 'attributed input',
        { computer: 'peer-host', thread: 'origin_thread-1' });
      await drain(wake, 'thread-1');
      await settle(() => calls.length >= 1);
      expect(wake.list('thread-1').events[0]?.admittedAt).toBeTruthy();
      expect(wake.list('thread-1').events[0]?.outcomeWatched).toBeUndefined();
      // Days pass while the watch is still unrecorded: it is neither dropped nor marked.
      (wake as any).state.events[0].admittedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const count = calls.length;
      await settle(() => calls.length >= count + 2);
      expect(wake.list('thread-1').events[0]?.outcomeWatched).toBeUndefined();
      const saved = JSON.parse(await readFile(path.join(root, 'wake-sources.json'), 'utf8')) as { events: WakeEvent[] };
      expect(saved.events[0]?.outcomeWatched).toBeUndefined();
    }, 30_000, { intervalMs: 0, followUpMs: 0, retryMs: 20 });
  });
});

describe('cancelled sources', () => {
  test("a cancelled source's pending input never wedges the thread, and its source takes no new input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-cancelled-'));
    const createdAt = new Date().toISOString();
    await writeFile(path.join(root, 'wake-sources.json'), JSON.stringify({
      sources: [{ id: 'gone', threadId: 'thread-1', kind: 'schedule', message: 'old', at: createdAt,
        status: 'cancelled', sequence: 1 }],
      events: [
        { threadId: 'thread-1', sourceId: 'gone', eventId: 'gone-1', message: 'never offered', status: 'pending', createdAt },
        { threadId: 'thread-1', sourceId: THREAD_INPUT_SOURCE, eventId: 't1', message: 'later input', status: 'pending', createdAt },
      ] }));
    const fake = threadInputNative({ busyTurn: 'turn-1' });
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    fake.attach(wake);
    try {
      await wake.initialize();
      await wake.tick();
      expect(fake.offered).toEqual(['[Wake event thread-input/t1]']);
      await wake.tick();
      expect(wake.list('thread-1').events.map(e => [e.eventId, e.status])).toEqual([['gone-1', 'pending'], ['t1', 'admitted']]);
      await expect(wake.ingest('thread-1', 'gone', 'gone-2', 'new input')).rejects.toBeInstanceOf(WakeSourceCancelledError);
      expect(wake.list('thread-1').events).toHaveLength(2);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test("a cancelled source's offer proved not delivered is removed, so the source can be saved again", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-cancelled-offer-'));
    const t0 = Date.now();
    const offeredAt = new Date(t0).toISOString();
    await writeFile(path.join(root, 'wake-sources.json'), JSON.stringify({
      sources: [{ id: 'gone', threadId: 'thread-1', kind: 'schedule', message: 'old', at: offeredAt,
        status: 'cancelled', sequence: 1 }],
      events: [{ threadId: 'thread-1', sourceId: 'gone', eventId: 'gone-1', message: 'lost offer', status: 'offered',
        createdAt: offeredAt, offeredAt }] }));
    const fake = lossyNative();
    const wake = new WakeSources(fake.native, root, 30_000, MANUAL);
    try {
      await wake.initialize();
      await wake.tick(t0 + 61_000); // proof noted
      expect(wake.list('thread-1').events.map(e => e.status)).toEqual(['offered']);
      await wake.tick(t0 + 76_000); // observed again: removed, never offered again
      expect(wake.list('thread-1').events).toEqual([]);
      expect(fake.state.starts).toBe(0);
      await wake.put({ id: 'gone', threadId: 'thread-1', kind: 'schedule', message: 'saved again',
        at: new Date(t0 + 10_000_000).toISOString() });
      expect(wake.list('thread-1').sources[0]).toMatchObject({ id: 'gone', status: 'waiting' });
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
