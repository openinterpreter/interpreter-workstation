import { describe, expect, test } from 'bun:test';
import { GoalRevisionConflictError, type ThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import { UsageLimitResume, usageAllowance, usageResumeSettings, type UsageLimitResumeDeps } from './usageLimitResume';

const MINUTE = 60_000;
const thread = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GOAL = '00000000-0000-4000-8000-0000000000aa';

type Snapshot = Parameters<typeof usageAllowance>[0];
function read(options: { allowed?: boolean | null; used?: number; hasCredits?: boolean; unlimited?: boolean;
  spendControlReached?: boolean | null; credits?: false } = {}): NonNullable<Snapshot> {
  return {
    ordinaryUsageAllowed: options.allowed === undefined ? null : options.allowed,
    rateLimits: {
      limitId: 'codex', limitName: null, normalModelSlug: null,
      primary: { usedPercent: options.used ?? 10, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: options.used ?? 10, windowDurationMins: 10_080, resetsAt: null },
      credits: options.credits === false ? null
        : { hasCredits: options.hasCredits ?? false, unlimited: options.unlimited ?? false, balance: null },
      individualLimit: null, spendControlReached: options.spendControlReached ?? null,
      planType: null, rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  } as NonNullable<Snapshot>;
}

describe('usage allowance decision', () => {
  test.each([
    ['all limits used, credits available', read({ allowed: false, used: 100, hasCredits: true }), 'available'],
    ['all limits used, unlimited credits', read({ allowed: false, used: 100, unlimited: true }), 'available'],
    ['all limits used, credits but spend control reached',
      read({ allowed: false, used: 100, hasCredits: true, spendControlReached: true }), 'exhausted'],
    ['all limits used, no credits', read({ allowed: false, used: 100 }), 'exhausted'],
    ['permission unknown, limits used, no credits', read({ allowed: null, used: 100 }), 'exhausted'],
    ['ordinary usage allowed', read({ allowed: true, used: 40 }), 'available'],
    ['permission unknown, limits not used, no credits', read({ allowed: null, used: 40 }), 'unknown'],
    ['permission unknown, no credit snapshot', read({ allowed: null, used: 40, credits: false }), 'unknown'],
    ['unreadable', null, 'unknown'],
  ] as const)('%s -> %s', (_name, input, expected) => {
    expect(usageAllowance(input)).toBe(expected);
  });

  test('credits in another limit bucket count', () => {
    const value = read({ allowed: false, used: 100 });
    value.rateLimitsByLimitId = { other: { ...value.rateLimits,
      credits: { hasCredits: true, unlimited: false, balance: '5' } } };
    expect(usageAllowance(value)).toBe('available');
  });

  test('interval and step come from the environment, with bounds', () => {
    expect(usageResumeSettings({})).toEqual({ intervalMs: 5 * MINUTE, step: 2 });
    expect(usageResumeSettings({ INTERPRETER_USAGE_RESUME_INTERVAL_MINUTES: '0.1',
      INTERPRETER_USAGE_RESUME_STEP: '4' })).toEqual({ intervalMs: MINUTE, step: 4 });
    expect(usageResumeSettings({ INTERPRETER_USAGE_RESUME_INTERVAL_MINUTES: 'x',
      INTERPRETER_USAGE_RESUME_STEP: '0' })).toEqual({ intervalMs: 5 * MINUTE, step: 2 });
  });
});

function harness(options: { allowance?: () => Promise<NonNullable<Snapshot>>; step?: number;
  pending?: Record<string, number>; candidates?: string[] } = {}) {
  let now = 1_000_000;
  const goals = new Map<string, ThreadGoalRevision>();
  const resumes: Array<[string, ThreadGoalRevision]> = [];
  const released: string[] = [];
  const logs: string[] = [];
  let allowanceReads = 0;
  let resumeImpl: (threadId: string, expected: ThreadGoalRevision) => Promise<void> = async (threadId, expected) => {
    const current = goals.get(threadId);
    if (!current || current.status !== expected.status || current.lifecycleRevision !== expected.lifecycleRevision) {
      throw new GoalRevisionConflictError();
    }
    goals.set(threadId, { ...current, status: 'active', lifecycleRevision: current.lifecycleRevision + 1 });
  };
  const deps: UsageLimitResumeDeps = {
    now: () => now,
    readAllowance: async () => { allowanceReads++; return (options.allowance ?? (async () => read({ allowed: true })))(); },
    readRevision: async threadId => goals.get(threadId) ?? null,
    resume: async (threadId, expected) => { resumes.push([threadId, { ...expected }]); await resumeImpl(threadId, expected); },
    pendingInputs: threadId => options.pending?.[threadId] ?? 0,
    resumed: async threadId => { released.push(threadId); },
    candidates: async () => options.candidates ?? [],
    log: line => logs.push(line),
    step: options.step,
  };
  const resume = new UsageLimitResume(deps);
  const limit = (threadId: string, lifecycleRevision = 3) => {
    goals.set(threadId, { goalId: GOAL, status: 'usageLimited', missionRevision: 1, lifecycleRevision });
    resume.handleNotification({ method: 'thread/goal/updated',
      params: { threadId, turnId: 'turn', goal: { status: 'usageLimited' } } } as never);
  };
  /** The runtime runs the continuation and it fails on the limit again. */
  const failAgain = (threadId: string) => {
    const goal = goals.get(threadId)!;
    resume.handleNotification({ method: 'thread/goal/updated',
      params: { threadId, goal: { status: 'active' } } } as never);
    goals.set(threadId, { ...goal, status: 'usageLimited', lifecycleRevision: goal.lifecycleRevision + 1 });
    resume.handleNotification({ method: 'thread/goal/updated',
      params: { threadId, turnId: 'turn-2', goal: { status: 'usageLimited' } } } as never);
  };
  return { resume, goals, resumes, released, logs, limit, failAgain,
    advance: (ms: number) => { now += ms; }, allowanceReads: () => allowanceReads,
    setResume: (fn: typeof resumeImpl) => { resumeImpl = fn; } };
}

describe('usage-limited Goal resume loop', () => {
  test('reads nothing while no Goal is usage-limited', async () => {
    const h = harness();
    await h.resume.tick();
    expect(h.allowanceReads()).toBe(0);
    expect(h.resumes).toEqual([]);
  });

  test('resumes with the observed CAS values and offers waiting inputs', async () => {
    const h = harness();
    h.limit(thread(1), 7);
    await h.resume.tick();
    expect(h.resumes).toEqual([[thread(1), { goalId: GOAL, status: 'usageLimited', missionRevision: 1,
      lifecycleRevision: 7 }]]);
    expect(h.goals.get(thread(1))!.status).toBe('active');
    expect(h.released).toEqual([thread(1)]);
    // Active now: the next tick neither reads the allowance nor resumes.
    await h.resume.tick();
    expect(h.allowanceReads()).toBe(1);
    expect(h.resumes.length).toBe(1);
  });

  test('an exhausted allowance resumes nothing however long it lasts', async () => {
    const h = harness({ allowance: async () => read({ allowed: false, used: 100 }) });
    h.limit(thread(1));
    for (let i = 0; i < 20; i++) { h.advance(30 * MINUTE); await h.resume.tick(); }
    expect(h.resumes).toEqual([]);
    expect(h.allowanceReads()).toBe(20);
  });

  test('resumes at most the step per tick, inputs first, then oldest', async () => {
    const h = harness({ step: 2, pending: { [thread(4)]: 1 } });
    h.limit(thread(1)); h.advance(1); h.limit(thread(2)); h.advance(1);
    h.limit(thread(3)); h.advance(1); h.limit(thread(4));
    await h.resume.tick();
    expect(h.resumes.map(([id]) => id)).toEqual([thread(4), thread(1)]);
    await h.resume.tick();
    expect(h.resumes.map(([id]) => id)).toEqual([thread(4), thread(1), thread(2), thread(3)]);
  });

  test('an unreadable allowance falls back to attempts under backoff: 5, 10, 20, then 30 minutes', async () => {
    const h = harness({ allowance: async () => { throw Error('usage read unavailable'); } });
    h.limit(thread(1));
    const attemptsAt: number[] = [];
    for (let minute = 1; minute <= 125; minute++) {
      h.advance(MINUTE);
      const before = h.resumes.length;
      await h.resume.tick();
      if (h.resumes.length > before) { attemptsAt.push(minute); h.failAgain(thread(1)); }
    }
    expect(attemptsAt).toEqual([5, 15, 35, 65, 95, 125]);
  });

  test('an available allowance resumes at once, and a repeat failure backs off instead of looping', async () => {
    const h = harness();
    h.limit(thread(1));
    await h.resume.tick();
    expect(h.resumes.length).toBe(1);
    h.failAgain(thread(1));
    for (let minute = 1; minute <= 9; minute++) { h.advance(MINUTE); await h.resume.tick(); }
    expect(h.resumes.length).toBe(1);
    h.advance(MINUTE);
    await h.resume.tick();
    expect(h.resumes.length).toBe(2);
  });

  test('a concurrent change between read and CAS is not overridden or retried at once', async () => {
    const h = harness();
    h.limit(thread(1));
    h.setResume(async () => { throw new GoalRevisionConflictError(); });
    await h.resume.tick();
    expect(h.resumes.length).toBe(1);
    expect(h.released).toEqual([]);
    expect(h.logs.some(line => line.includes('reason=goal-changed'))).toBe(true);
    await h.resume.tick();
    expect(h.resumes.length).toBe(1);
  });

  test('a Goal changed by someone else is dropped without a resume', async () => {
    const h = harness({ allowance: async () => { throw Error('unavailable'); } });
    h.limit(thread(1));
    h.goals.set(thread(1), { ...h.goals.get(thread(1))!, status: 'paused' });
    h.advance(5 * MINUTE);
    await h.resume.tick();
    expect(h.resumes).toEqual([]);
    expect(h.resume.tracked().size).toBe(0);
  });

  test('an unconfirmed resume is never resubmitted on the next tick', async () => {
    const h = harness();
    h.limit(thread(1));
    h.setResume(async () => { throw Error('transport closed'); });
    await h.resume.tick();
    await h.resume.tick();
    expect(h.resumes.length).toBe(1);
    expect(h.released).toEqual([]);
  });

  test('a usage-limit turn failure tracks the thread; a thread without a Goal is dropped', async () => {
    const h = harness();
    h.resume.handleNotification({ method: 'turn/completed', params: { threadId: thread(5),
      turn: { id: 't', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } } } as never);
    expect(h.resume.tracked().get(thread(5))?.limited).toBe(true);
    await h.resume.tick();
    expect(h.resumes).toEqual([]);
    expect(h.resume.tracked().size).toBe(0);
  });

  test('startup finds Goals that were already usage-limited', async () => {
    const h = harness({ candidates: [thread(1), thread(2)] });
    h.goals.set(thread(2), { goalId: GOAL, status: 'usageLimited', missionRevision: 1, lifecycleRevision: 2 });
    h.goals.set(thread(1), { goalId: GOAL, status: 'active', missionRevision: 1, lifecycleRevision: 2 });
    await h.resume.tick();
    expect(h.resumes.map(([id]) => id)).toEqual([thread(2)]);
  });
});
