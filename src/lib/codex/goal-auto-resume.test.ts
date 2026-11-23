import { describe, expect, test } from 'bun:test';
import {
  GOAL_AUTO_RESUME_WINDOW_MS,
  GoalAutoResume,
  goalAutoResumeDelayMs,
  isTransientCapacityError,
} from './goal-auto-resume';
import { GoalMutationUnconfirmedError, GoalRevisionConflictError, type ThreadGoalRevision } from './goal-revision';
import type { AppServerNotification } from './protocol';

const CAPACITY = 'Selected model is at capacity. Please try a different model.';
const thread = '00000000-0000-4000-8000-000000000001';
const goalId = '00000000-0000-4000-8000-0000000000aa';

describe('isTransientCapacityError', () => {
  test('accepts the runtime capacity refusal with and without its structured code', () => {
    expect(isTransientCapacityError({ message: CAPACITY, codexErrorInfo: 'serverOverloaded' })).toBe(true);
    expect(isTransientCapacityError({ message: CAPACITY, codexErrorInfo: null })).toBe(true);
    expect(isTransientCapacityError({ message: CAPACITY })).toBe(true);
    expect(isTransientCapacityError({ message: CAPACITY, codexErrorInfo: 'other' })).toBe(true);
    expect(isTransientCapacityError({ message: 'anything', codexErrorInfo: 'serverOverloaded' })).toBe(true);
  });

  test('accepts near variants of temporary provider unavailability', () => {
    for (const message of [
      'The model is currently overloaded. Try again later.',
      'Overloaded',
      "We're currently experiencing high demand, which may cause temporary errors.",
      'Service Unavailable',
      'upstream temporarily unavailable',
    ]) {
      expect(isTransientCapacityError({ message, codexErrorInfo: null })).toBe(true);
    }
    expect(isTransientCapacityError({ message: "We're currently experiencing high demand, which may cause temporary errors.",
      codexErrorInfo: 'internalServerError' })).toBe(true);
    for (const status of [502, 503, 504, 529]) {
      expect(isTransientCapacityError({ message: 'x',
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: status } } })).toBe(true);
      expect(isTransientCapacityError({ message: 'x',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } } })).toBe(true);
    }
  });

  test('rejects usage limits, auth, context length, interrupts, policy and other failures', () => {
    const negatives: unknown[] = [
      { message: "You've hit your usage limit. Try again at 5 PM.", codexErrorInfo: 'usageLimitExceeded' },
      { message: 'Selected model is at capacity.', codexErrorInfo: 'usageLimitExceeded' },
      { message: 'Quota exceeded. Check your plan and billing details.', codexErrorInfo: null },
      { message: 'Rate limit reached', codexErrorInfo: 'rateLimitExceeded' },
      { message: '401 Unauthorized', codexErrorInfo: 'unauthorized' },
      { message: 'overloaded', codexErrorInfo: 'unauthorized' },
      { message: "Codex ran out of room in the model's context window.", codexErrorInfo: 'contextWindowExceeded' },
      { message: 'interrupted (Ctrl-C).', codexErrorInfo: null },
      { message: 'This request violates policy', codexErrorInfo: 'cyberPolicy' },
      { message: 'misaligned', codexErrorInfo: 'misalignmentPolicyViolation' },
      { message: 'internal error; agent loop died unexpectedly', codexErrorInfo: 'internalServerError' },
      { message: 'Bad request.', codexErrorInfo: 'badRequest' },
      { message: 'x', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } } },
      { message: 'overloaded', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } },
      { message: 'x', codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } } },
      null,
      'Selected model is at capacity.',
    ];
    for (const error of negatives) expect(isTransientCapacityError(error)).toBe(false);
  });
});

describe('goalAutoResumeDelayMs', () => {
  test('backs off 30 s, 2 min, 5 min, 10 min, then every 15 min', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(goalAutoResumeDelayMs))
      .toEqual([30_000, 120_000, 300_000, 600_000, 900_000, 900_000, 900_000]);
  });
});

type Timer = { at: number; callback: () => void; cleared: boolean };

function harness(options: { revision?: () => ThreadGoalRevision | null;
  resume?: (expected: ThreadGoalRevision) => Promise<void> } = {}) {
  let now = Date.parse('2026-11-16T00:00:00.000Z');
  let lifecycle = 7;
  const timers: Timer[] = [];
  const resumed: ThreadGoalRevision[] = [];
  const logs: string[] = [];
  const blocked = (): ThreadGoalRevision => ({ goalId, status: 'blocked', missionRevision: 1, lifecycleRevision: lifecycle });
  const auto = new GoalAutoResume({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = { at: now + delayMs, callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: handle => { (handle as Timer).cleared = true; },
    readRevision: async () => (options.revision ?? blocked)(),
    resume: async (_threadId, expected) => {
      resumed.push(expected);
      if (options.resume) await options.resume(expected);
    },
    log: line => logs.push(line),
  });
  const send = (method: string, params: Record<string, unknown>) =>
    auto.handleNotification({ method, params } as unknown as AppServerNotification);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const pending = () => timers.filter(timer => !timer.cleared && timer.at !== Infinity);
  return {
    auto, timers, resumed, logs, send, settle, pending,
    advance: async (ms: number) => {
      now += ms;
      for (const timer of timers) {
        if (!timer.cleared && timer.at <= now) {
          timer.cleared = true;
          timer.callback();
        }
      }
      await settle();
    },
    /** One continuation turn that fails with `error` after `durationMs`, then the runtime block. */
    failTurn: async (turnId: string, durationMs: number, error: unknown = { message: CAPACITY, codexErrorInfo: 'serverOverloaded' },
      order: 'turn-first' | 'goal-first' = 'turn-first') => {
      send('turn/started', { threadId: thread, turn: { id: turnId } });
      now += durationMs;
      lifecycle += 1;
      const completed = () => send('turn/completed', { threadId: thread,
        turn: { id: turnId, status: 'failed', error, durationMs, items: [] } });
      const goal = () => send('thread/goal/updated', { threadId: thread, turnId,
        goal: { threadId: thread, objective: 'o', status: 'blocked' } });
      if (order === 'turn-first') { completed(); goal(); } else { goal(); completed(); }
      await settle();
    },
    resumedByUs: () => { lifecycle += 1;
      send('thread/goal/updated', { threadId: thread, turnId: null, goal: { threadId: thread, objective: 'o', status: 'active' } }); },
  };
}

describe('GoalAutoResume', () => {
  test('resumes the exact blocked revision after 30 s, in either notification order', async () => {
    for (const order of ['turn-first', 'goal-first'] as const) {
      const h = harness();
      await h.failTurn('t1', 60 * 60_000, undefined, order);
      expect(h.auto.state(thread)).toMatchObject({ state: 'scheduled', attempt: 1 });
      expect(h.pending().map(timer => timer.at - Date.parse('2026-11-16T01:00:00.000Z'))).toEqual([30_000]);
      await h.advance(29_999);
      expect(h.resumed).toEqual([]);
      await h.advance(1);
      expect(h.resumed).toEqual([{ goalId, status: 'blocked', missionRevision: 1, lifecycleRevision: 8 }]);
      expect(h.logs.some(line => line.startsWith('[goal-auto-resume] scheduled') && line.includes('attempt=1'))).toBe(true);
      expect(h.logs.some(line => line.startsWith('[goal-auto-resume] resumed') && line.includes('attempt=1'))).toBe(true);
    }
  });

  test('follows the incident: an immediate repeat failure backs off to 2 min, then 5 min', async () => {
    const h = harness();
    await h.failTurn('t1', 60 * 60_000);
    await h.advance(30_000);
    h.resumedByUs();
    await h.failTurn('t2', 6_000);
    expect(h.pending().length).toBe(1);
    expect(h.auto.state(thread)).toMatchObject({ state: 'scheduled', attempt: 2 });
    await h.advance(119_999);
    expect(h.resumed.length).toBe(1);
    await h.advance(1);
    expect(h.resumed.length).toBe(2);
    h.resumedByUs();
    await h.failTurn('t3', 6_000);
    expect(h.auto.state(thread)).toMatchObject({ state: 'scheduled', attempt: 3 });
    await h.advance(300_000);
    expect(h.resumed.length).toBe(3);
  });

  test('stops after the bounded window and leaves the Goal blocked with a recorded reason', async () => {
    const g = harness();
    let attempts = 0;
    for (let index = 1; index < 50; index += 1) {
      await g.failTurn(`u${index}`, 1_000);
      const state = g.auto.state(thread);
      if (state?.state !== 'scheduled') break;
      await g.advance(goalAutoResumeDelayMs(attempts));
      attempts += 1;
      g.resumedByUs();
    }
    expect(g.resumed.length).toBe(attempts);
    expect(attempts).toBeGreaterThan(4);
    expect(attempts).toBeLessThan(15);
    const final = g.auto.state(thread);
    expect(final?.state).toBe('exhausted');
    expect(final && 'reason' in final ? final.reason : '').toContain('model at capacity since');
    expect(g.logs.some(line => line.startsWith('[goal-auto-resume] gave up'))).toBe(true);
    expect(g.pending()).toEqual([]);
    const totalDelay = Array.from({ length: attempts }, (_, index) => goalAutoResumeDelayMs(index)).reduce((a, b) => a + b, 0);
    expect(totalDelay).toBeLessThanOrEqual(GOAL_AUTO_RESUME_WINDOW_MS);
  });

  test('a progressing turn resets the attempt counter and window', async () => {
    const h = harness();
    await h.failTurn('t1', 1_000);
    await h.advance(30_000);
    h.resumedByUs();
    await h.failTurn('t2', 1_000);
    expect(h.auto.state(thread)).toMatchObject({ attempt: 2 });
    await h.advance(120_000);
    h.resumedByUs();
    // This continuation runs long enough to count as progress before failing.
    await h.failTurn('t3', 20 * 60_000);
    expect(h.auto.state(thread)).toMatchObject({ state: 'scheduled', attempt: 1 });
    await h.advance(30_000);
    h.resumedByUs();
    // A completed turn also resets.
    h.send('turn/started', { threadId: thread, turn: { id: 't4' } });
    h.send('turn/completed', { threadId: thread, turn: { id: 't4', status: 'completed', error: null, durationMs: 1_000, items: [] } });
    await h.failTurn('t5', 1_000);
    expect(h.auto.state(thread)).toMatchObject({ state: 'scheduled', attempt: 1 });
  });

  test('a changed revision is never overridden', async () => {
    const h = harness({ resume: async () => { throw new GoalRevisionConflictError(); } });
    await h.failTurn('t1', 1_000);
    await h.advance(30_000);
    expect(h.resumed.length).toBe(1);
    expect(h.auto.state(thread)).toBeNull();
    expect(h.pending()).toEqual([]);
    expect(h.logs.some(line => line.includes('reason=goal-changed'))).toBe(true);
  });

  test('an unconfirmed resume is not resubmitted', async () => {
    const h = harness({ resume: async () => { throw new GoalMutationUnconfirmedError('deadline'); } });
    await h.failTurn('t1', 1_000);
    await h.advance(30_000);
    await h.advance(60 * 60_000);
    expect(h.resumed.length).toBe(1);
    expect(h.pending()).toEqual([]);
  });

  test('does not schedule when the Goal is no longer blocked or its revision is unavailable', async () => {
    const h = harness({ revision: () => ({ goalId, status: 'active', missionRevision: 1, lifecycleRevision: 9 }) });
    await h.failTurn('t1', 1_000);
    expect(h.pending()).toEqual([]);
    const u = harness({ revision: () => { throw new Error('old runtime'); } });
    await u.failTurn('t1', 1_000);
    expect(u.pending()).toEqual([]);
    expect(u.logs.some(line => line.includes('reason=goal-revision-unavailable'))).toBe(true);
  });

  test('ignores non-transient failures and blocks not caused by a turn', async () => {
    const h = harness();
    await h.failTurn('t1', 1_000, { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' });
    await h.failTurn('t2', 1_000, { message: 'Unauthorized', codexErrorInfo: 'unauthorized' });
    await h.failTurn('t3', 1_000, { message: 'context', codexErrorInfo: 'contextWindowExceeded' });
    h.send('turn/started', { threadId: thread, turn: { id: 't4' } });
    h.send('turn/completed', { threadId: thread, turn: { id: 't4', status: 'interrupted', error: null, durationMs: 1, items: [] } });
    h.send('thread/goal/updated', { threadId: thread, turnId: null, goal: { threadId: thread, objective: 'o', status: 'blocked' } });
    await h.settle();
    expect(h.pending()).toEqual([]);
    expect(h.resumed).toEqual([]);
  });

  test('cancels the pending resume when anyone resumes, pauses, clears or completes the Goal', async () => {
    for (const [method, status] of [
      ['thread/goal/updated', 'active'],
      ['thread/goal/updated', 'paused'],
      ['thread/goal/updated', 'complete'],
      ['thread/goal/cleared', null],
    ] as const) {
      const h = harness();
      await h.failTurn('t1', 1_000);
      expect(h.pending().length).toBe(1);
      h.send(method, status
        ? { threadId: thread, turnId: null, goal: { threadId: thread, objective: 'o', status } }
        : { threadId: thread });
      expect(h.pending()).toEqual([]);
      await h.advance(60 * 60_000);
      expect(h.resumed).toEqual([]);
      expect(h.logs.some(line => line.startsWith('[goal-auto-resume] cancelled'))).toBe(true);
    }
  });

  test('cancels when a new turn starts and on shutdown', async () => {
    const h = harness();
    await h.failTurn('t1', 1_000);
    h.send('turn/started', { threadId: thread, turn: { id: 'user-turn' } });
    expect(h.pending()).toEqual([]);
    await h.advance(60 * 60_000);
    expect(h.resumed).toEqual([]);

    const s = harness();
    await s.failTurn('t1', 1_000);
    s.auto.stop();
    expect(s.pending()).toEqual([]);
    await s.advance(60 * 60_000);
    await s.failTurn('t2', 1_000);
    expect(s.pending()).toEqual([]);
    expect(s.resumed).toEqual([]);
  });

  test('a cancellation during the revision read prevents scheduling', async () => {
    let release: (value: ThreadGoalRevision) => void = () => {};
    const h = harness();
    const slow = new GoalAutoResume({
      now: () => 0, setTimer: (callback, delayMs) => h.timers.push({ at: delayMs, callback, cleared: false }),
      clearTimer: () => {}, resume: async () => {}, log: () => {},
      readRevision: () => new Promise(resolve => { release = resolve; }),
    });
    const send = (method: string, params: Record<string, unknown>) =>
      slow.handleNotification({ method, params } as unknown as AppServerNotification);
    send('turn/completed', { threadId: thread, turn: { id: 't1', status: 'failed',
      error: { message: CAPACITY, codexErrorInfo: 'serverOverloaded' }, durationMs: 1, items: [] } });
    send('thread/goal/updated', { threadId: thread, turnId: 't1', goal: { status: 'blocked' } });
    send('thread/goal/updated', { threadId: thread, turnId: null, goal: { status: 'paused' } });
    release({ goalId, status: 'blocked', missionRevision: 1, lifecycleRevision: 1 });
    await h.settle();
    expect(h.timers).toEqual([]);
  });

  test('never runs two timers for one thread', async () => {
    const h = harness();
    await h.failTurn('t1', 1_000);
    // A duplicate block notification for the same failure replaces, not adds.
    h.send('turn/completed', { threadId: thread, turn: { id: 't1', status: 'failed',
      error: { message: CAPACITY, codexErrorInfo: 'serverOverloaded' }, durationMs: 1_000, items: [] } });
    h.send('thread/goal/updated', { threadId: thread, turnId: 't1', goal: { status: 'blocked' } });
    await h.settle();
    expect(h.pending().length).toBe(1);
    await h.advance(30_000);
    expect(h.resumed.length).toBe(1);
  });
});
