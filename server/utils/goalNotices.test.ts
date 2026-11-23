import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GoalAutoResumeState } from '../../src/lib/codex/goal-auto-resume';
import type { ThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import type { AppServerNotification } from '../../src/lib/codex/protocol';
import {
  GOAL_NOTICE_RECONCILE_LIMIT,
  GOAL_NOTICE_SETTLE_MS,
  GoalNotices,
  goalNoticeDue,
  type ObservedGoal,
} from './goalNotices';
import type { SubmissionSender } from './nativeSubmissionJournal';
import {
  OutcomeReturns,
  goalNoticeId,
  goalNoticeSummary,
  type GoalAssigner,
  type GoalNotice,
  type GoalUnroutedReason,
} from './outcomeReturns';

const thread = '00000000-0000-4000-8000-000000000001';
const sender: SubmissionSender = { computer: 'peer-host', thread: 'origin_thread' };
const OBJECTIVE = 'Process every item in the confidential manifest';
const CREATED = 1_700_000_000;
const GOAL_ID = '11111111-2222-4333-8444-555555555555';

type Timer = { at: number; callback: () => void; cleared: boolean };
type Recorded = { threadId: string; sender?: SubmissionSender; unrouted?: GoalUnroutedReason; notice: GoalNotice };

function harness(options: { sender?: SubmissionSender | null; settleMs?: number; store?: OutcomeReturns } = {}) {
  let now = Date.parse('2026-11-16T00:00:00.000Z');
  let updatedAt = CREATED;
  const timers: Timer[] = [];
  const recorded: Recorded[] = [];
  const autoResume = new Map<string, GoalAutoResumeState>();
  const goals = new Map<string, ObservedGoal>();
  const reads: string[] = [];
  const unreadable = new Set<string>();
  const logs: string[] = [];
  const senders = new Map<string, SubmissionSender>();
  /** Assigner overrides; otherwise a thread's sender is its bound assigner. */
  const assigners = new Map<string, GoalAssigner>();
  const binds: Array<{ threadId: string; goalCreatedAt: number; turnId: string | null }> = [];
  let revision: ThreadGoalRevision | null = null;
  if (options.sender !== null) senders.set(thread, options.sender ?? sender);
  const store = options.store;
  const notices = new GoalNotices({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = { at: now + delayMs, callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: handle => { (handle as Timer).cleared = true; },
    bindAssigner: async (threadId, goalCreatedAt, turnId) => {
      binds.push({ threadId, goalCreatedAt, turnId });
      if (store) return store.bindGoalAssigner(threadId, goalCreatedAt, turnId);
      const known = assigners.get(threadId);
      if (known) return known;
      const to = senders.get(threadId);
      return to ? { threadId, goalCreatedAt, sender: to, source: 'sole_sender' } : null;
    },
    lastNotice: async threadId => store ? store.lastGoalNotice(threadId)
      : [...recorded].reverse().find(item => item.threadId === threadId)?.notice ?? null,
    record: async (threadId, assigner, notice) => {
      if (store) { await store.noticeGoal(threadId, assigner, notice); return; }
      recorded.push('sender' in assigner ? { threadId, sender: assigner.sender, notice }
        : { threadId, unrouted: assigner.unrouted, notice });
    },
    readRevision: async () => revision && { createdAt: CREATED, revision },
    autoResumeState: threadId => autoResume.get(threadId) ?? null,
    recentSenderThreads: async limit => store ? store.recentSenderThreads(limit) : [...senders.keys()].slice(0, limit),
    readGoal: async threadId => {
      reads.push(threadId);
      if (unreadable.has(threadId)) throw Error(`thread not loaded: ${OBJECTIVE}`);
      return goals.get(threadId) ?? null;
    },
    log: line => { logs.push(line); },
    settleMs: options.settleMs,
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const send = (method: string, params: Record<string, unknown>) =>
    notices.handleNotification({ method, params } as unknown as AppServerNotification);
  return {
    notices, recorded, autoResume, goals, reads, unreadable, logs, senders, timers, assigners, binds,
    setRevision: (value: ThreadGoalRevision | null) => { revision = value; },
    advance: async (ms: number) => {
      now += ms;
      for (const timer of [...timers]) {
        if (!timer.cleared && timer.at <= now) { timer.cleared = true; timer.callback(); }
      }
      await flush();
    },
    /** A native Goal update; objective text is present, as on the wire. */
    goal: (status: string, turnId: string | null = null, threadId = thread) => {
      updatedAt += 1;
      send('thread/goal/updated', { threadId, turnId,
        goal: { threadId, objective: OBJECTIVE, status, tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 5,
          createdAt: CREATED, updatedAt } });
    },
    failedTurn: (turnId: string, threadId = thread) =>
      send('turn/completed', { threadId, turn: { id: turnId, status: 'failed', items: [],
        error: { message: 'boom', codexErrorInfo: null } } }),
    cleared: () => send('thread/goal/cleared', { threadId: thread }),
    updatedAt: () => updatedAt,
    flush,
  };
}

const statuses = (h: ReturnType<typeof harness>) => h.recorded.map(item => item.notice.status);

describe('goal notices', () => {
  test('each stopped status and complete is reported once after the settle delay', async () => {
    for (const [status, turnId, failed, reason] of [
      ['blocked', 'turn_1', true, 'turn_error'],
      ['blocked', 'turn_1', false, 'changed_during_turn'],
      ['blocked', null, false, 'changed_outside_turn'],
      ['paused', null, false, 'changed_outside_turn'],
      ['usageLimited', 'turn_1', true, 'usage_limit'],
      ['budgetLimited', 'turn_1', false, 'budget_limit'],
      ['complete', 'turn_1', false, 'changed_during_turn'],
    ] as const) {
      const h = harness();
      h.goal('active');
      if (failed) h.failedTurn('turn_1');
      h.goal(status, turnId);
      await h.advance(GOAL_NOTICE_SETTLE_MS - 1);
      expect(h.recorded).toEqual([]);
      await h.advance(1);
      expect(h.recorded).toEqual([{ threadId: thread, sender, notice: { status, previousStatus: 'active', reason,
        createdAt: CREATED, updatedAt: h.updatedAt() } }]);
      // The same settled state is never reported twice.
      h.goal(status, turnId);
      await h.advance(GOAL_NOTICE_SETTLE_MS);
      expect(h.recorded).toHaveLength(1);
    }
  });

  test('active again is reported only after an earlier stopped notice', async () => {
    const h = harness();
    h.goal('active');
    h.goal('paused');
    h.goal('active');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded).toEqual([]);
    h.goal('blocked');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    h.goal('active');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded.map(item => [item.notice.status, item.notice.previousStatus, item.notice.reason])).toEqual([
      ['blocked', 'active', 'changed_outside_turn'], ['active', 'blocked', 'changed_outside_turn']]);
    // Usage accounting on an active Goal reports nothing further.
    h.goal('active', 'turn_9');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded).toHaveLength(2);
    // Complete is final: a later active Goal is not "active again".
    h.goal('complete', 'turn_9');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    h.goal('active');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(statuses(h)).toEqual(['blocked', 'active', 'complete']);
  });

  test('flapping coalesces into at most one notice per settled state', async () => {
    const h = harness();
    h.goal('active');
    h.goal('blocked');
    await h.advance(10_000);
    h.goal('active');
    await h.advance(10_000);
    h.goal('blocked');
    await h.advance(10_000);
    h.goal('active');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded).toEqual([]);
    h.goal('blocked');
    await h.advance(10_000);
    h.goal('active');
    await h.advance(10_000);
    h.goal('blocked');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(statuses(h)).toEqual(['blocked']);
    // blocked -> active -> blocked inside one window after a blocked notice: nothing new.
    h.goal('active');
    await h.advance(5_000);
    h.goal('blocked');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(statuses(h)).toEqual(['blocked']);
  });

  test('a thread with no known sender sends and stores nothing', async () => {
    const h = harness({ sender: null });
    h.goal('active');
    h.goal('blocked');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded).toEqual([]);
    h.goals.set(thread, { status: 'blocked', createdAt: CREATED, updatedAt: 5 });
    await h.notices.reconcile();
    expect(h.reads).toEqual([]);
    expect(h.recorded).toEqual([]);
  });

  test('a capacity block that will be resumed automatically is reported once as pending, then as active again', async () => {
    const h = harness();
    h.goal('active');
    h.failedTurn('turn_1');
    h.goal('blocked', 'turn_1');
    const blockedAt = h.updatedAt();
    h.autoResume.set(thread, { state: 'scheduled', attempt: 1, retryAt: Date.parse('2026-11-16T00:00:30.000Z') });
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded).toEqual([{ threadId: thread, sender, notice: { status: 'blocked', previousStatus: 'active',
      reason: 'capacity_retry_pending', createdAt: CREATED, updatedAt: blockedAt } }]);
    // The resume works.
    h.autoResume.set(thread, { state: 'waiting', attempt: 1 });
    await h.advance(10_000);
    h.goal('active');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded.map(item => [item.notice.status, item.notice.reason])).toEqual([
      ['blocked', 'capacity_retry_pending'], ['active', 'changed_outside_turn']]);
  });

  test('a pending capacity resume is reported once per block, and again with its final reason when it gives up', async () => {
    const h = harness();
    h.goal('active');
    h.failedTurn('turn_1');
    h.goal('blocked', 'turn_1');
    const blockedAt = h.updatedAt();
    h.autoResume.set(thread, { state: 'scheduled', attempt: 1, retryAt: Date.parse('2026-11-16T00:00:30.000Z') });
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    // The next attempt is scheduled without the Goal ever settling active: no second transient notice.
    h.autoResume.set(thread, { state: 'scheduled', attempt: 2, retryAt: Date.parse('2026-11-16T00:03:00.000Z') });
    await h.advance(30_000);
    expect(h.recorded).toHaveLength(1);
    // The resume gives up; the Goal's status and times are unchanged.
    h.autoResume.set(thread, { state: 'exhausted', reason: 'model at capacity since …' });
    await h.advance(150_000);
    expect(h.recorded.map(item => item.notice)).toEqual([
      { status: 'blocked', previousStatus: 'active', reason: 'capacity_retry_pending', createdAt: CREATED,
        updatedAt: blockedAt },
      { status: 'blocked', previousStatus: 'active', reason: 'model_capacity_exhausted', createdAt: CREATED,
        updatedAt: blockedAt },
    ]);
    const [transient, final] = h.recorded.map(item => goalNoticeId(thread, item.notice));
    expect(transient).not.toBe(final);
    // The final outcome is never reported twice.
    await h.advance(GOAL_NOTICE_SETTLE_MS * 4);
    expect(h.recorded).toHaveLength(2);
  });

  test('a scheduled resume that never reverses the block is reported after it settles', async () => {
    const h = harness();
    h.goal('active');
    h.failedTurn('turn_1');
    h.goal('blocked', 'turn_1');
    h.autoResume.set(thread, { state: 'scheduled', attempt: 1, retryAt: Date.parse('2026-11-16T00:00:30.000Z') });
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    // The attempt ran but its result never showed the Goal active again.
    h.autoResume.set(thread, { state: 'waiting', attempt: 1 });
    await h.advance(30_000);
    expect(h.recorded.map(item => item.notice.reason)).toEqual(['capacity_retry_pending']);
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded.map(item => item.notice.reason)).toEqual(['capacity_retry_pending', 'turn_error']);
  });

  test('a cleared Goal cancels a pending notice and reports nothing', async () => {
    const h = harness();
    h.goal('active');
    h.goal('blocked');
    h.cleared();
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded).toEqual([]);
  });

  test('notices never carry objective or message text', async () => {
    const h = harness();
    h.goal('active');
    h.failedTurn('turn_1');
    h.goal('blocked', 'turn_1');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    const serialized = JSON.stringify(h.recorded);
    expect(serialized).not.toContain('confidential');
    expect(serialized).not.toContain('boom');
    expect(Object.keys(h.recorded[0]!.notice).sort())
      .toEqual(['createdAt', 'previousStatus', 'reason', 'status', 'updatedAt']);
  });

  test('restart reconciliation reports unreported stopped Goals once and corrects a stale stopped notice', async () => {
    const h = harness();
    const second = '00000000-0000-4000-8000-000000000002';
    const third = '00000000-0000-4000-8000-000000000003';
    h.senders.set(second, sender);
    h.senders.set(third, { computer: 'third-host' });
    h.goals.set(thread, { status: 'blocked', createdAt: CREATED, updatedAt: CREATED + 9 });
    h.goals.set(second, { status: 'active', createdAt: CREATED, updatedAt: CREATED + 3 });
    h.goals.set(third, { status: 'active', createdAt: CREATED, updatedAt: CREATED + 4 });
    h.recorded.push({ threadId: third, sender: { computer: 'third-host' },
      notice: { status: 'usageLimited', reason: 'usage_limit', createdAt: CREATED, updatedAt: CREATED + 1 } });
    await h.notices.reconcile();
    expect(h.recorded.slice(1)).toEqual([
      { threadId: thread, sender, notice: { status: 'blocked', reason: 'unknown', createdAt: CREATED, updatedAt: CREATED + 9 } },
      { threadId: third, sender: { computer: 'third-host' },
        notice: { status: 'active', reason: 'unknown', createdAt: CREATED, updatedAt: CREATED + 4 } },
    ]);
    // A second startup finds every state already reported.
    await h.notices.reconcile();
    expect(h.recorded).toHaveLength(3);
  });

  test('reconciliation logs each thread whose Goal it cannot read, without the read error', async () => {
    const h = harness();
    const second = '00000000-0000-4000-8000-000000000002';
    h.senders.set(second, sender);
    h.unreadable.add(thread);
    h.goals.set(second, { status: 'blocked', createdAt: CREATED, updatedAt: CREATED + 2 });
    await h.notices.reconcile();
    expect(h.logs.filter(line => line.includes('reconcile skipped'))).toEqual([
      `[goal-notices] reconcile skipped threadId=${thread} reason=goal-read-unavailable`,
    ]);
    expect(h.logs.join('\n')).not.toContain(OBJECTIVE);
    // The other threads are still reconciled.
    expect(h.recorded.map(item => item.threadId)).toEqual([second]);
  });

  test('reconciliation is bounded and defers to live notifications', async () => {
    const h = harness();
    for (let index = 0; index < GOAL_NOTICE_RECONCILE_LIMIT + 10; index++) {
      const id = `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`;
      h.senders.set(id, sender);
    }
    h.goal('blocked');
    h.goals.set(thread, { status: 'blocked', createdAt: CREATED, updatedAt: 1 });
    await h.notices.reconcile();
    expect(h.reads).toHaveLength(GOAL_NOTICE_RECONCILE_LIMIT);
    expect(h.recorded).toEqual([]);
  });

  test('the delivery ID is stable for one change and differs between changes', () => {
    const goal = { status: 'blocked' as const, createdAt: CREATED, updatedAt: CREATED + 5 };
    expect(goalNoticeId(thread, goal)).toBe(goalNoticeId(thread, { ...goal }));
    expect(goalNoticeId(thread, goal)).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([goal, { ...goal, status: 'paused' as const }, { ...goal, updatedAt: CREATED + 6 },
      { ...goal, createdAt: CREATED + 1 }].map(item => goalNoticeId(thread, item))).size).toBe(4);
    expect(goalNoticeDue({ status: 'blocked', createdAt: CREATED }, null)).toBe(true);
    expect(goalNoticeDue({ status: 'active', createdAt: CREATED }, null)).toBe(false);
    expect(goalNoticeDue({ status: 'blocked', createdAt: CREATED + 1 },
      { status: 'blocked', reason: 'unknown', createdAt: CREATED, updatedAt: CREATED })).toBe(true);
    // Only the transient notice of a pending resume has a distinct ID input.
    expect(goalNoticeId(thread, { ...goal, reason: 'turn_error' })).toBe(goalNoticeId(thread, goal));
    expect(goalNoticeId(thread, { ...goal, reason: 'capacity_retry_pending' })).not.toBe(goalNoticeId(thread, goal));
    const transient = { status: 'blocked' as const, reason: 'capacity_retry_pending' as const, createdAt: CREATED,
      updatedAt: CREATED };
    expect(goalNoticeDue({ status: 'blocked', createdAt: CREATED, reason: 'capacity_retry_pending' }, transient))
      .toBe(false);
    expect(goalNoticeDue({ status: 'blocked', createdAt: CREATED, reason: 'model_capacity_exhausted' }, transient))
      .toBe(true);
    expect(goalNoticeDue({ status: 'active', createdAt: CREATED }, transient)).toBe(true);
  });

  test('the native Goal identity and revisions are added only when the read shows the same Goal and status', async () => {
    const h = harness();
    h.setRevision({ goalId: GOAL_ID, status: 'blocked', missionRevision: 2, lifecycleRevision: 5 });
    h.goal('active');
    h.goal('blocked');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    const notice = h.recorded[0]!.notice;
    expect(notice).toEqual({ status: 'blocked', previousStatus: 'active', reason: 'changed_outside_turn',
      createdAt: CREATED, updatedAt: h.updatedAt(), goalId: GOAL_ID, missionRevision: 2, lifecycleRevision: 5 });
    expect(goalNoticeSummary(thread, notice)).toBe(`Goal on thread ${thread} is blocked (status blocked, ` +
      `previously active; reason changed_outside_turn; goal ${GOAL_ID}, mission revision 2, lifecycle revision 5).`);
    // A read that no longer shows this status adds nothing.
    h.goal('active');
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded[1]!.notice).not.toHaveProperty('goalId');
    expect(h.recorded[1]!.notice).not.toHaveProperty('missionRevision');
  });

  test('the assigner is bound when the Goal is first observed, with the turn that shows it', async () => {
    const h = harness();
    h.goal('active', 'turn_1');
    h.goal('active', 'turn_2');
    await h.flush();
    expect(h.binds).toEqual([{ threadId: thread, goalCreatedAt: CREATED, turnId: 'turn_1' }]);
  });
});

async function withStore(run: (store: OutcomeReturns) => Promise<void>, command?: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goal-notices-'));
  const store = new OutcomeReturns({ root, command: command && JSON.stringify(command), recheckMs: 0 });
  await store.initialize();
  try { await run(store); } finally { await store.stop(); await rm(root, { recursive: true, force: true }); }
}

const goalEntries = (store: OutcomeReturns) => store.list().flatMap(entry => 'kind' in entry ? [entry] : []);

describe('goal notices with the outcome-return store', () => {
  test('the agent that assigned a Goal alone is told of each change, whoever sends to the thread later', async () => {
    await withStore(async store => {
      const h = harness({ store });
      const assigner = { computer: 'assigner-host', thread: 'assigner_thread' };
      await store.watch(thread, 'turn_1', assigner, 'handoff_1');
      // The Goal is created during the assigner's turn.
      h.goal('active', 'turn_1');
      await h.flush();
      // Two later senders: one with a thread, one without.
      await store.watch(thread, 'turn_2', { computer: 'other-host', thread: 'other_thread' }, 'handoff_2');
      await store.watch(thread, 'turn_3', { computer: 'plain-host' }, 'handoff_3');
      for (const status of ['blocked', 'active', 'paused', 'active', 'complete']) {
        h.goal(status, 'turn_3');
        await h.advance(GOAL_NOTICE_SETTLE_MS);
        // Repeated observations of the settled state report nothing more.
        h.goal(status, 'turn_3');
        await h.advance(GOAL_NOTICE_SETTLE_MS);
      }
      expect(goalEntries(store).map(entry => [entry.goal.status, 'sender' in entry ? entry.sender : null,
        entry.status])).toEqual(['blocked', 'active', 'paused', 'active', 'complete']
        .map(status => [status, assigner, 'pending']));
    });
  }, 30_000);

  test('a Goal with no sender thread, or several, gets typed unrouted notices that are never delivered', async () => {
    for (const [reason, senders] of [
      ['no_assigner', [{ computer: 'plain-host' }, { computer: 'second-host' }]],
      ['ambiguous_assigner', [{ computer: 'first-host', thread: 'first_thread' },
        { computer: 'second-host', thread: 'second_thread' }]],
    ] as const) {
      // A command that would count a failed attempt if it were ever run.
      await withStore(async store => {
        const h = harness({ store });
        for (const [index, from] of senders.entries()) {
          await store.watch(thread, `turn_${index}`, from, `handoff_${index}`);
        }
        h.goal('active');
        for (const status of ['blocked', 'active', 'blocked']) {
          h.goal(status);
          await h.advance(GOAL_NOTICE_SETTLE_MS);
          h.goal(status);
          await h.advance(GOAL_NOTICE_SETTLE_MS);
        }
        await store.deliverDue();
        // The last notice's log line follows its durable write.
        for (let tries = 0; tries < 200 && h.logs.filter(line => line.includes('unrouted')).length < 3; tries++) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const entries = goalEntries(store);
        expect(entries.map(entry => [entry.goal.status, entry.status, 'unrouted' in entry && entry.unrouted,
          entry.attempts])).toEqual([['blocked', 'unrouted', reason, 0], ['active', 'unrouted', reason, 0],
          ['blocked', 'unrouted', reason, 0]]);
        expect(entries.every(entry => !('sender' in entry))).toBe(true);
        expect(h.logs.filter(line => line.includes('unrouted'))).toEqual(['blocked', 'active', 'blocked']
          .map(status => `[goal-notices] unrouted threadId=${thread} status=${status} reason=${reason}`));
      }, [process.execPath, '-e', 'process.exit(1)']);
    }
  }, 30_000);

  test('a purely local Goal stays silent', async () => {
    await withStore(async store => {
      const h = harness({ store });
      h.goal('active');
      h.goal('blocked');
      await h.advance(GOAL_NOTICE_SETTLE_MS);
      expect(store.list()).toEqual([]);
      expect(h.logs).toEqual([]);
    });
  });
});
