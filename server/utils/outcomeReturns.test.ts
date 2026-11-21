import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GOAL_ASSIGNER_LIMIT,
  OUTCOME_RETURN_LIMIT,
  OUTCOME_SUMMARY_LIMIT,
  OutcomeReturns,
  goalNoticeId,
  goalNoticeSummary,
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
      const id = outcomeReturnId(thread, 'turn_1', 'handoff_1');
      expect(await f.received()).toEqual([{ version: 1, kind: 'turn', id, to: sender,
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
      expect(await store.watch(thread, 'turn_delivery', sender, `outcome-${outcomeReturnId(thread, 'turn_0', 'handoff_0')}`)).toBe(true);
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
      const file = path.join(f.root, 'outcome-returns-2.json');
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

  test('a Goal notice is delivered through the same command with its own kind and stable ID', async () => {
    const f = await fixture();
    try {
      const store = await f.make(0);
      await store.watch(thread, 'turn_g', sender, 'handoff_g');
      const goal = { status: 'blocked' as const, previousStatus: 'active' as const, reason: 'turn_error' as const,
        createdAt: 1_700_000_000, updatedAt: 1_700_000_500 };
      expect(await store.noticeGoal(thread, { sender }, goal)).toBe(true);
      expect(await store.noticeGoal(thread, { sender }, goal)).toBe(true);
      const id = goalNoticeId(thread, goal);
      expect(id).toBe(goalNoticeId(thread, { ...goal, reason: 'unknown' } as typeof goal));
      expect(id).not.toBe(goalNoticeId(thread, { ...goal, updatedAt: goal.updatedAt + 1 }));
      expect(id).not.toBe(outcomeReturnId(thread, 'turn_g', 'handoff_g'));
      expect(store.lastGoalNotice(thread)).toEqual(goal);
      await store.turnEnded(thread, 'turn_g', 'completed', 'Worker answer.');
      await store.deliverDue();
      const received = await f.received();
      expect(received).toContainEqual({ version: 1, kind: 'goal', id, to: sender, from: { threadId: thread },
        goal, summary: goalNoticeSummary(thread, goal) });
      expect(goalNoticeSummary(thread, goal))
        .toBe(`Goal on thread ${thread} is blocked (status blocked, previously active; reason turn_error).`);
      expect(store.list().find(entry => entry.id === id)).toMatchObject({ kind: 'goal', status: 'delivered', goal });
      // The delivery of the notice to the sender's thread is never watched there.
      expect(await store.watch(thread, 'turn_delivery', { computer: 'other-host', thread: 'other_thread' },
        `outcome-${id}`)).toBe(true);
      expect(await store.bindGoalAssigner(thread, goal.createdAt, null)).toEqual({ threadId: thread,
        goalCreatedAt: goal.createdAt, sender, source: 'sole_sender' });
      // Goal entries survive a restart and still validate.
      await store.stop();
      const restarted = await f.make(null);
      expect(restarted.lastGoalNotice(thread)).toEqual(goal);
      expect(restarted.recentSenderThreads(50)).toEqual([thread]);
    } finally { await f.cleanup(); }
  }, 30_000);

  test('only attributed turns count as senders; most recent thread first', async () => {
    const f = await fixture();
    try {
      const store = await f.make(null);
      const other = '00000000-0000-4000-8000-000000000002';
      await store.watch(thread, 'turn_only_delivery', sender, 'outcome-abc');
      expect(store.recentSenderThreads(50)).toEqual([]);
      // A delivery is not an input: the Goal is local and gets no record.
      expect(await store.bindGoalAssigner(thread, 1, 'turn_only_delivery')).toBeNull();
      await store.watch(thread, 'turn_a', { computer: 'first-host' }, 'handoff_a');
      await store.watch(other, 'turn_b', sender, 'handoff_b');
      await store.watch(thread, 'turn_c', { computer: 'second-host' }, 'handoff_c');
      expect(store.recentSenderThreads(50)).toEqual([thread, other]);
      expect(store.recentSenderThreads(1)).toEqual([thread]);
    } finally { await f.cleanup(); }
  });

  test('a Goal assigner is bound by its turn, then by a sole sender with a thread, else recorded unrouted', async () => {
    const f = await fixture();
    try {
      const store = await f.make(null);
      const first = { computer: 'first-host', thread: 'first_thread' };
      const second = { computer: 'second-host', thread: 'second_thread' };
      await store.watch(thread, 'turn_1', first, 'handoff_1');
      await store.watch(thread, 'turn_1', { computer: 'plain-host' }, 'handoff_plain');
      await store.watch(thread, 'turn_2', second, 'handoff_2');
      // The turn's one sender with a thread, although the thread has two.
      expect(await store.bindGoalAssigner(thread, 10, 'turn_1')).toEqual({ threadId: thread, goalCreatedAt: 10,
        sender: first, source: 'turn' });
      // Several senders with a thread and no deciding turn.
      expect(await store.bindGoalAssigner(thread, 20, 'turn_unknown')).toEqual({ threadId: thread, goalCreatedAt: 20,
        unrouted: 'ambiguous_assigner' });
      // Bound once: later calls and senders never change it.
      expect(await store.bindGoalAssigner(thread, 10, 'turn_2')).toMatchObject({ sender: first, source: 'turn' });
      const other = '00000000-0000-4000-8000-000000000002';
      await store.watch(other, 'turn_3', { computer: 'plain-host' }, 'handoff_3');
      expect(await store.bindGoalAssigner(other, 30, null)).toEqual({ threadId: other, goalCreatedAt: 30,
        unrouted: 'no_assigner' });
      await store.watch(other, 'turn_4', second, 'handoff_4');
      expect(await store.bindGoalAssigner(other, 30, 'turn_4')).toEqual({ threadId: other, goalCreatedAt: 30,
        unrouted: 'no_assigner' });
      // A new Goal on that thread has its own binding.
      expect(await store.bindGoalAssigner(other, 31, null)).toEqual({ threadId: other, goalCreatedAt: 31,
        sender: second, source: 'sole_sender' });
      await store.stop();
      // The bindings survive a restart and stay immutable.
      const restarted = await f.make(null);
      await restarted.watch(thread, 'turn_5', { computer: 'third-host', thread: 'third_thread' }, 'handoff_5');
      expect(await restarted.bindGoalAssigner(thread, 10, 'turn_5')).toEqual({ threadId: thread, goalCreatedAt: 10,
        sender: first, source: 'turn' });
      expect(await restarted.bindGoalAssigner(other, 30, null)).toMatchObject({ unrouted: 'no_assigner' });
      const state = JSON.parse(await readFile(path.join(f.root, 'outcome-returns-2.json'), 'utf8'));
      expect(state.goalAssigners).toHaveLength(4);
    } finally { await f.cleanup(); }
  });

  test('assigner records are bounded, oldest dropped first, and validated on load', async () => {
    const f = await fixture();
    try {
      const store = await f.make(null);
      await store.watch(thread, 'turn_1', sender, 'handoff_1');
      for (let index = 0; index <= GOAL_ASSIGNER_LIMIT; index++) await store.bindGoalAssigner(thread, index, null);
      await store.stop();
      const file = path.join(f.root, 'outcome-returns-2.json');
      const state = JSON.parse(await readFile(file, 'utf8'));
      expect(state.goalAssigners).toHaveLength(GOAL_ASSIGNER_LIMIT);
      expect(state.goalAssigners[0].goalCreatedAt).toBe(1);
      state.goalAssigners[0] = { threadId: thread, goalCreatedAt: 1, sender: { computer: 'peer-host' },
        source: 'sole_sender' };
      await writeFile(file, JSON.stringify(state));
      // A bound sender without a thread is not a valid record.
      await expect(f.make(null)).rejects.toThrow('Invalid outcome return state');
    } finally { await f.cleanup(); }
  }, 60_000);

  test('a state file without assigner records and with existing Goal notices loads', async () => {
    const f = await fixture();
    try {
      const goal = { status: 'blocked' as const, reason: 'turn_error' as const, createdAt: 1_700_000_000,
        updatedAt: 1_700_000_100 };
      const at = '2026-11-16T00:00:00.000Z';
      await writeFile(path.join(f.root, 'outcome-returns.json'), JSON.stringify({ version: 1, entries: [
        { id: outcomeReturnId(thread, 'turn_old', 'handoff_old'), threadId: thread, turnId: 'turn_old', sender,
          clientUserMessageId: 'handoff_old', status: 'delivered', outcome: 'completed', attempts: 0,
          createdAt: at, updatedAt: at },
        { kind: 'goal', id: goalNoticeId(thread, goal), threadId: thread, sender, goal, status: 'delivered',
          attempts: 0, createdAt: at, updatedAt: at },
      ] }));
      const store = await f.make(null);
      expect(store.lastGoalNotice(thread)).toEqual(goal);
      // The Goal that existed before is bound to the thread's sole sender with a thread.
      expect(await store.bindGoalAssigner(thread, goal.createdAt, null)).toEqual({ threadId: thread,
        goalCreatedAt: goal.createdAt, sender, source: 'sole_sender' });
      // The earlier file is carried over, not rewritten: the release that wrote it can still read it.
      const earlier = JSON.parse(await readFile(path.join(f.root, 'outcome-returns.json'), 'utf8'));
      expect(earlier).toEqual({ version: 1, entries: expect.any(Array) });
      expect(earlier.entries).toHaveLength(2);
      const current = JSON.parse(await readFile(path.join(f.root, 'outcome-returns-2.json'), 'utf8'));
      expect(current.version).toBe(2);
      expect(current.entries).toHaveLength(2);
      expect(current.goalAssigners).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  test('an unrouted Goal notice is stored typed, never delivered, and dropped first when the store is full', async () => {
    const f = await fixture();
    try {
      const store = await f.make(3);
      const goal = { status: 'paused' as const, reason: 'changed_outside_turn' as const, createdAt: 1, updatedAt: 2 };
      expect(await store.noticeGoal(thread, { unrouted: 'ambiguous_assigner' }, goal)).toBe(true);
      expect(await store.noticeGoal(thread, { unrouted: 'ambiguous_assigner' }, goal)).toBe(true);
      await store.deliverDue();
      expect(await f.received()).toEqual([]);
      expect(store.list()).toEqual([{ kind: 'goal', id: goalNoticeId(thread, goal), threadId: thread, goal,
        unrouted: 'ambiguous_assigner', status: 'unrouted', attempts: 0, nextAttemptAt: undefined,
        updatedAt: expect.any(String) }]);
      expect(store.lastGoalNotice(thread)).toEqual(goal);
      await store.stop();
      const restarted = await f.make(null);
      expect(restarted.list()).toHaveLength(1);
      for (let index = 1; index < OUTCOME_RETURN_LIMIT; index++) {
        await restarted.watch(thread, `turn_${index}`, sender, `handoff_${index}`);
      }
      // The unrouted entry makes room; undelivered watches do not.
      expect(await restarted.watch(thread, 'turn_last', sender, 'handoff_last')).toBe(true);
      expect(restarted.list().some(entry => 'kind' in entry)).toBe(false);
    } finally { await f.cleanup(); }
  }, 60_000);

  test('the transient notice of a pending resume and the block\'s final notice are both delivered', async () => {
    const f = await fixture();
    try {
      const store = await f.make(0);
      const transient = { status: 'blocked' as const, previousStatus: 'active' as const,
        reason: 'capacity_retry_pending' as const, createdAt: 1_700_000_000, updatedAt: 1_700_000_100,
        goalId: '11111111-2222-4333-8444-555555555555', missionRevision: 0, lifecycleRevision: 3 };
      const final = { ...transient, reason: 'model_capacity_exhausted' as const };
      expect(await store.noticeGoal(thread, { sender }, transient)).toBe(true);
      expect(await store.noticeGoal(thread, { sender }, final)).toBe(true);
      await store.deliverDue();
      const received = await f.received() as Array<{ id: string; goal: unknown; summary: string }>;
      expect(received.map(payload => payload.goal)).toEqual([transient, final]);
      expect(received[0]!.id).not.toBe(received[1]!.id);
      expect(received[0]!.summary).toBe(`Goal on thread ${thread} is blocked (status blocked, previously active; ` +
        'reason capacity_retry_pending; goal 11111111-2222-4333-8444-555555555555, mission revision 0, ' +
        'lifecycle revision 3).');
      await store.stop();
      // Both reload and validate.
      expect((await f.make(null)).list()).toHaveLength(2);
    } finally { await f.cleanup(); }
  }, 30_000);

  test('two senders whose inputs steered one turn each get their own return', async () => {
    const f = await fixture();
    try {
      const store = await f.make(0);
      const other = { computer: 'second-host' };
      expect(await store.watch(thread, 'turn_shared', sender, 'handoff_first')).toBe(true);
      expect(await store.watch(thread, 'turn_shared', other, 'handoff_second')).toBe(true);
      // A repeat of either input is idempotent.
      expect(await store.watch(thread, 'turn_shared', other, 'handoff_second')).toBe(true);
      expect(store.list()).toHaveLength(2);
      await store.turnEnded(thread, 'turn_shared', 'completed', 'Both handled.');
      await store.deliverDue();
      const received = await f.received() as Array<Record<string, unknown>>;
      expect(received.map(payload => [payload.id, payload.to, payload.clientUserMessageId])).toEqual([
        [outcomeReturnId(thread, 'turn_shared', 'handoff_first'), sender, 'handoff_first'],
        [outcomeReturnId(thread, 'turn_shared', 'handoff_second'), other, 'handoff_second'],
      ]);
      expect(received.every(payload => payload.summary === 'Both handled.')).toBe(true);
      // A sender joining after the turn ended still gets the outcome; a delivery never does.
      expect(await store.watch(thread, 'turn_shared', { computer: 'third-host' }, 'handoff_third')).toBe(true);
      expect(await store.watch(thread, 'turn_shared', other, 'outcome-abc')).toBe(true);
      expect(store.list().map(entry => entry.status)).toEqual(['delivered', 'delivered', 'pending']);
      await store.stop();
      // Both kinds of entry reload and validate after a restart.
      const restarted = await f.make(null);
      expect(restarted.list()).toHaveLength(3);
    } finally { await f.cleanup(); }
  }, 30_000);

  test('a watch recorded after startup for a turn that already ended resolves at once', async () => {
    const f = await fixture();
    try {
      const reads: string[] = [];
      const store = await f.make(null, { readTurn: async (_thread, turnId) => {
        reads.push(turnId);
        return turnId === 'turn_over' ? { outcome: 'interrupted', summary: 'Ended while unobserved.' } : null;
      } });
      expect(reads).toEqual([]);
      await store.watch(thread, 'turn_over', sender, 'handoff_late');
      await store.watch(thread, 'turn_running', sender, 'handoff_live');
      expect(reads).toEqual(['turn_over', 'turn_running']);
      expect(store.list().map(entry => [entry.turnId, entry.status, entry.outcome])).toEqual([
        ['turn_over', 'pending', 'interrupted'], ['turn_running', 'watching', undefined]]);
      // A repeated watch reads nothing again.
      await store.watch(thread, 'turn_running', sender, 'handoff_live');
      expect(reads).toHaveLength(2);
    } finally { await f.cleanup(); }
  });

  test('a watched turn whose end was missed is read again on the re-check interval, without a restart', async () => {
    const f = await fixture();
    try {
      const reads: string[] = [];
      let ended = false;
      let failing = true;
      const store = await f.make(null, { recheckMs: 20, readTurn: async (_thread, turnId) => {
        reads.push(turnId);
        if (failing) { failing = false; throw new Error('read failed'); }
        return ended ? { outcome: 'completed', summary: 'Ended while unobserved.' } : null;
      } });
      // The read when the watch is recorded fails, and no notification ever arrives.
      await store.watch(thread, 'turn_missed', sender, 'handoff_missed');
      expect(store.list()[0]).toMatchObject({ status: 'watching' });
      ended = true;
      for (let i = 0; i < 200 && store.list()[0]?.status === 'watching'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(store.list()[0]).toMatchObject({ status: 'pending', outcome: 'completed' });
      // A turn no longer watched is not read again.
      const count = reads.length;
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(reads.length).toBe(count);
    } finally { await f.cleanup(); }
  });

  test('a watch whose write failed is not reported recorded by a retry; once written it survives a restart', async () => {
    const f = await fixture();
    try {
      const store = await f.make(null);
      const save = (store as any).save.bind(store);
      let failing = true;
      (store as any).save = async () => { if (failing) throw new Error('disk full'); return save(); };
      await expect(store.watch(thread, 'turn_s', sender, 'handoff_s')).rejects.toThrow('disk full');
      expect(store.list()).toEqual([]);
      // The retry writes it again instead of finding it known.
      await expect(store.watch(thread, 'turn_s', sender, 'handoff_s')).rejects.toThrow('disk full');
      await store.stop();
      // Nothing reached disk, so nothing may have been reported recorded.
      expect((await f.make(null)).list()).toEqual([]);
      const again = await f.make(null);
      expect(await again.watch(thread, 'turn_s', sender, 'handoff_s')).toBe(true);
      await again.stop();
      const restarted = await f.make(null);
      expect(restarted.list().map(entry => [entry.turnId, entry.status])).toEqual([['turn_s', 'watching']]);
    } finally { await f.cleanup(); }
  });

  test('a turn whose read never settles is read once, however many re-checks pass', async () => {
    const f = await fixture();
    try {
      let reads = 0;
      const store = await f.make(null, { recheckMs: 20, readTimeoutMs: 20,
        readTurn: () => { reads++; return new Promise<null>(() => {}); } });
      const started = Date.now();
      expect(await store.watch(thread, 'turn_hung', sender, 'handoff_hung')).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(reads).toBe(1);
      expect(store.list()[0]).toMatchObject({ status: 'watching' });
    } finally { await f.cleanup(); }
  });

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
