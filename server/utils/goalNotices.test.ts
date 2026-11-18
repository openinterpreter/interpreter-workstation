import { describe, expect, test } from 'bun:test';
import type { GoalAutoResumeState } from '../../src/lib/codex/goal-auto-resume';
import type { AppServerNotification } from '../../src/lib/codex/protocol';
import {
  GOAL_NOTICE_RECONCILE_LIMIT,
  GOAL_NOTICE_SETTLE_MS,
  GoalNotices,
  goalNoticeDue,
  type ObservedGoal,
} from './goalNotices';
import type { SubmissionSender } from './nativeSubmissionJournal';
import { goalNoticeId, type GoalNotice } from './outcomeReturns';

const thread = '00000000-0000-4000-8000-000000000001';
const sender: SubmissionSender = { computer: 'peer-host', thread: 'origin_thread' };
const OBJECTIVE = 'Process every item in the confidential manifest';
const CREATED = 1_700_000_000;

type Timer = { at: number; callback: () => void; cleared: boolean };

function harness(options: { sender?: SubmissionSender | null; settleMs?: number } = {}) {
  let now = Date.parse('2026-11-16T00:00:00.000Z');
  let updatedAt = CREATED;
  const timers: Timer[] = [];
  const recorded: Array<{ threadId: string; sender: SubmissionSender; notice: GoalNotice }> = [];
  const autoResume = new Map<string, GoalAutoResumeState>();
  const goals = new Map<string, ObservedGoal>();
  const reads: string[] = [];
  const senders = new Map<string, SubmissionSender>();
  if (options.sender !== null) senders.set(thread, options.sender ?? sender);
  const notices = new GoalNotices({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = { at: now + delayMs, callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: handle => { (handle as Timer).cleared = true; },
    latestSender: async threadId => senders.get(threadId) ?? null,
    lastNotice: async threadId => [...recorded].reverse().find(item => item.threadId === threadId)?.notice ?? null,
    record: async (threadId, to, notice) => { recorded.push({ threadId, sender: to, notice }); },
    autoResumeState: threadId => autoResume.get(threadId) ?? null,
    recentSenderThreads: async limit => [...senders.keys()].slice(0, limit),
    readGoal: async threadId => { reads.push(threadId); return goals.get(threadId) ?? null; },
    log: () => undefined,
    settleMs: options.settleMs,
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const send = (method: string, params: Record<string, unknown>) =>
    notices.handleNotification({ method, params } as unknown as AppServerNotification);
  return {
    notices, recorded, autoResume, goals, reads, senders, timers,
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

  test('a capacity block that will be resumed automatically is reported only when resuming gives up', async () => {
    const h = harness();
    h.goal('active');
    h.failedTurn('turn_1');
    h.goal('blocked', 'turn_1');
    h.autoResume.set(thread, { state: 'scheduled', attempt: 1, retryAt: Date.parse('2026-11-16T00:00:30.000Z') });
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded).toEqual([]);
    // The resume works, then the next continuation fails again.
    h.autoResume.set(thread, { state: 'waiting', attempt: 1 });
    await h.advance(10_000);
    h.goal('active');
    await h.advance(60_000);
    h.failedTurn('turn_2');
    h.goal('blocked', 'turn_2');
    h.autoResume.set(thread, { state: 'scheduled', attempt: 2, retryAt: Date.parse('2026-11-16T00:03:35.000Z') });
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded).toEqual([]);
    // Two hours later the resume gives up after another failed attempt.
    h.goal('active');
    await h.advance(60_000);
    h.failedTurn('turn_3');
    h.goal('blocked', 'turn_3');
    h.autoResume.set(thread, { state: 'exhausted', reason: 'model at capacity since …' });
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded.map(item => item.notice)).toEqual([{ status: 'blocked', previousStatus: 'active',
      reason: 'model_capacity_exhausted', createdAt: CREATED, updatedAt: h.updatedAt() }]);
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
    expect(h.recorded).toEqual([]);
    await h.advance(GOAL_NOTICE_SETTLE_MS);
    expect(h.recorded.map(item => item.notice.reason)).toEqual(['turn_error']);
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
  });
});
