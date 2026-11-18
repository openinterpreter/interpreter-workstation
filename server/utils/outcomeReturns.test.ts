import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OUTCOME_SUMMARY_LIMIT,
  OutcomeReturns,
  outcomeReturnId,
  outcomeRetryDelayMs,
  parseOutcomeReturnCommand,
  type OutcomeReturnsOptions,
} from './outcomeReturns';

const thread = '00000000-0000-4000-8000-000000000001';
const sender = { computer: 'peer-host', thread: 'origin_thread' };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outcome-returns-'));
  const output = path.join(root, 'received.jsonl');
  const script = path.join(root, 'receiver.js');
  // A tiny receiving command: append stdin as one line, exit with argv[3].
  await writeFile(script, `const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.argv[2], input + '\\n');
  process.exit(Number(process.argv[3] ?? 0));
});
`);
  let now = Date.parse('2026-11-16T00:00:00.000Z');
  const instances: OutcomeReturns[] = [];
  const make = async (exitCode: number | null, extra: Partial<OutcomeReturnsOptions> = {}) => {
    const store = new OutcomeReturns({ root, now: () => now,
      command: exitCode === null ? undefined : JSON.stringify([process.execPath, script, output, String(exitCode)]),
      ...extra });
    await store.initialize();
    instances.push(store);
    return store;
  };
  const received = async (): Promise<unknown[]> => {
    try { return (await readFile(output, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  return { root, make, received, advance: (ms: number) => { now += ms; }, now: () => now,
    cleanup: async () => { for (const store of instances) await store.stop(); await rm(root, { recursive: true, force: true }); } };
}

describe('outcome returns', () => {
  test('watch, turn end and delivery write the exact JSON to the command', async () => {
    const f = await fixture();
    try {
      const store = await f.make(0);
      expect(await store.watch(thread, 'turn_1', sender, 'handoff_1')).toBe(true);
      expect(store.list()[0]).toMatchObject({ status: 'watching', attempts: 0 });
      await store.turnEnded(thread, 'turn_1', 'completed', 'All done.');
      await store.deliverDue();
      const id = outcomeReturnId(thread, 'turn_1');
      expect(await f.received()).toEqual([{ version: 1, id, to: sender,
        from: { threadId: thread, turnId: 'turn_1' }, clientUserMessageId: 'handoff_1',
        outcome: 'completed', summary: 'All done.' }]);
      const [entry] = store.list();
      expect(entry).toMatchObject({ id, status: 'delivered', outcome: 'completed', attempts: 0, sender });
      expect(entry).not.toHaveProperty('summary');
      await store.deliverDue();
      expect(await f.received()).toHaveLength(1);
    } finally { await f.cleanup(); }
  }, 30_000);

  test('a turn started by the delivery of an outcome is never watched', async () => {
    const f = await fixture();
    try {
      const store = await f.make(0);
      expect(await store.watch(thread, 'turn_delivery', sender, `outcome-${outcomeReturnId(thread, 'turn_0')}`)).toBe(true);
      expect(store.list()).toEqual([]);
      await store.turnEnded(thread, 'turn_delivery', 'completed', 'Acknowledged.');
      await store.deliverDue();
      expect(await f.received()).toEqual([]);
      // Ordinary sender-attributed work joining that same turn is still returned.
      expect(await store.watch(thread, 'turn_delivery_2', sender, 'handoff_after_delivery')).toBe(true);
      expect(store.list()).toHaveLength(1);
    } finally { await f.cleanup(); }
  }, 30_000);

  test('a failing command is retried with backoff and gives up after the attempt limit', async () => {
    const f = await fixture();
    try {
      const store = await f.make(3);
      await store.watch(thread, 'turn_2', { computer: 'peer-host' }, 'handoff_2');
      await store.turnEnded(thread, 'turn_2', 'failed', '');
      await store.deliverDue();
      expect(store.list()[0]).toMatchObject({ status: 'pending', attempts: 1,
        nextAttemptAt: new Date(f.now() + 60_000).toISOString() });
      await store.deliverDue();
      expect(await f.received()).toHaveLength(1);
      f.advance(60_000);
      await store.deliverDue();
      expect(store.list()[0]).toMatchObject({ status: 'pending', attempts: 2,
        nextAttemptAt: new Date(f.now() + 120_000).toISOString() });
      expect(await f.received()).toEqual([expect.objectContaining({ outcome: 'failed', summary: '',
        to: { computer: 'peer-host' } }), expect.anything()]);
      expect([1, 2, 3, 4, 5, 6, 40].map(outcomeRetryDelayMs))
        .toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
      await store.stop();
      // The last allowed attempt marks the entry failed and keeps it visible.
      const file = path.join(f.root, 'outcome-returns.json');
      const state = JSON.parse(await readFile(file, 'utf8'));
      state.entries[0].attempts = 39;
      await writeFile(file, JSON.stringify(state));
      f.advance(900_000);
      const restarted = await f.make(3);
      await restarted.deliverDue();
      expect(restarted.list()[0]).toMatchObject({ status: 'failed', attempts: 40 });
      expect(restarted.list()[0].nextAttemptAt).toBeUndefined();
    } finally { await f.cleanup(); }
  }, 30_000);

  test('watching and pending entries survive a restart; pending is then delivered', async () => {
    const f = await fixture();
    try {
      const first = await f.make(null);
      await first.watch(thread, 'turn_w', sender, 'handoff_w');
      await first.watch(thread, 'turn_p', sender, 'handoff_p');
      await first.turnEnded(thread, 'turn_p', 'interrupted', 'Stopped early.');
      await first.stop();
      const second = await f.make(0);
      expect(second.list().map(entry => [entry.turnId, entry.status]))
        .toEqual([['turn_w', 'watching'], ['turn_p', 'pending']]);
      await second.deliverDue();
      expect(await f.received()).toEqual([expect.objectContaining({ from: { threadId: thread, turnId: 'turn_p' },
        outcome: 'interrupted', summary: 'Stopped early.' })]);
      await second.turnEnded(thread, 'turn_w', 'completed', 'Later.');
      await second.deliverDue();
      expect(second.list().map(entry => entry.status)).toEqual(['delivered', 'delivered']);
    } finally { await f.cleanup(); }
  }, 30_000);

  test('an unset or invalid command spawns nothing and leaves the outcome pending', async () => {
    const f = await fixture();
    try {
      for (const raw of [undefined, '', 'not json', '[]', '[""]', '["ok", 1]', '{"argv":["x"]}']) {
        expect(parseOutcomeReturnCommand(raw)).toBeNull();
      }
      expect(parseOutcomeReturnCommand('["/bin/true","--x"]')).toEqual(['/bin/true', '--x']);
      const store = await f.make(null);
      await store.watch(thread, 'turn_3', sender, 'handoff_3');
      await store.turnEnded(thread, 'turn_3', 'completed', 'Done.');
      f.advance(3_600_000);
      await store.deliverDue();
      expect(store.list()[0]).toMatchObject({ status: 'pending', attempts: 0 });
      expect(await f.received()).toEqual([]);
    } finally { await f.cleanup(); }
  });

  test('an unknown turn ending is a no-op and watch is idempotent', async () => {
    const f = await fixture();
    try {
      const store = await f.make(null);
      await store.turnEnded(thread, 'turn_unknown', 'completed', 'Nobody asked.');
      expect(store.list()).toEqual([]);
      await store.watch(thread, 'turn_4', sender, 'handoff_4');
      await store.watch(thread, 'turn_4', sender, 'handoff_4');
      expect(store.list()).toHaveLength(1);
      await store.turnEnded(thread, 'turn_4', 'completed', 'First.');
      await store.watch(thread, 'turn_4', sender, 'handoff_4');
      await store.turnEnded(thread, 'turn_4', 'failed', 'Second.');
      expect(store.list()).toEqual([expect.objectContaining({ status: 'pending', outcome: 'completed' })]);
      // A turn that ended just before its watch was recorded is still returned.
      await store.turnEnded(thread, 'turn_fast', 'completed', 'Quick.');
      await store.watch(thread, 'turn_fast', sender, 'handoff_fast');
      expect(store.list()[1]).toMatchObject({ turnId: 'turn_fast', status: 'pending', outcome: 'completed' });
    } finally { await f.cleanup(); }
  });

  test('the summary is truncated to the limit', async () => {
    const f = await fixture();
    try {
      const store = await f.make(0);
      await store.watch(thread, 'turn_5', sender, 'handoff_5');
      await store.turnEnded(thread, 'turn_5', 'completed', 'x'.repeat(OUTCOME_SUMMARY_LIMIT + 500));
      await store.deliverDue();
      const [payload] = await f.received() as Array<{ summary: string }>;
      expect(payload.summary).toBe('x'.repeat(OUTCOME_SUMMARY_LIMIT));
    } finally { await f.cleanup(); }
  }, 30_000);

  test('startup reconciles a watched turn that already ended', async () => {
    const f = await fixture();
    try {
      const first = await f.make(null);
      await first.watch(thread, 'turn_done', sender, 'handoff_6');
      await first.watch(thread, 'turn_live', sender, 'handoff_7');
      await first.stop();
      const reads: string[] = [];
      const second = await f.make(null, { readTurn: async (_thread, turnId) => {
        reads.push(turnId);
        return turnId === 'turn_done' ? { outcome: 'completed', summary: 'Finished offline.' } : null;
      } });
      expect(reads.sort()).toEqual(['turn_done', 'turn_live']);
      expect(second.list().map(entry => [entry.turnId, entry.status]))
        .toEqual([['turn_done', 'pending'], ['turn_live', 'watching']]);
    } finally { await f.cleanup(); }
  });
});
