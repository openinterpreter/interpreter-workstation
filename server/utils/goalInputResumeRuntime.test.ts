import { describe, expect, test } from 'bun:test';
import { resumeBlockedGoalOnInput, type GoalInputResumeDeps } from './goalInputResumeRuntime';
import type { GoalInputAdmission, GoalInputIntent, GoalInputLedger } from './wakeSources';
import { GoalRevisionConflictError } from '../../src/lib/codex/goal-revision';

const THREAD = '00000000-0000-4000-8000-000000000071';
const GOAL = '00000000-0000-4000-8000-000000000072';
const TURN = '00000000-0000-4000-8000-000000000073';

function fixture(status: 'blocked' | 'paused' | 'usageLimited' | 'budgetLimited' |
  'complete' | 'active' = 'blocked') {
  const admission: GoalInputAdmission = { threadId: THREAD, sourceId: 'peer', eventId: 'input-1', turnId: TURN };
  const revision = { goalId: GOAL, status, missionRevision: 1, lifecycleRevision: 3 };
  const goal = { threadId: THREAD, status, objective: 'unreported', tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 };
  const notices: string[] = [];
  const statuses: string[] = [];
  let resumes = 0;
  let reads = 0;
  let custodyReads = 0;
  let intent: GoalInputIntent | undefined;
  const ledger: GoalInputLedger = {
    lookup: async () => intent,
    reserve: async candidate => { intent = { ...candidate, phase: 'reserved' }; return 'reserved'; },
    confirm: async (_goalId, resultUpdatedAt) => {
      if (!intent) throw Error('missing reservation');
      intent = { ...intent, phase: 'confirmed', resultUpdatedAt };
    },
    reject: async () => {
      if (!intent) throw Error('missing reservation');
      intent = { ...intent, phase: 'rejected' };
    },
  };
  const boundLedger: GoalInputLedger = { ...ledger, reserve: async candidate => {
    intent = { ...candidate, phase: 'bounded' }; return 'bounded';
  } };
  const deps = {
    custody: async () => { custodyReads++; return { status: 'active', lastTurnId: TURN,
      lastTurnStatus: 'inProgress', queuedSubmissionCount: 0 }; },
    read: async () => { reads++; return { goal, revision }; },
    resume: async () => { resumes++; return { goal: { ...goal, status: 'active', updatedAt: 3 },
      revision: { ...revision, status: 'active', lifecycleRevision: 4 }, continuation: 'already_running' }; },
    notice: async (_admission: GoalInputAdmission, _goal: unknown, revision: { status: string },
      reason: string, _updatedAt?: number, stoppedStatus?: string) => {
      notices.push(reason);
      statuses.push(`${revision.status}<-${stoppedStatus}`);
    },
  } as unknown as GoalInputResumeDeps;
  return { admission, deps, ledger, boundLedger, notices, statuses, reads: () => reads,
    intent: () => intent,
    custodyReads: () => custodyReads, resumes: () => resumes };
}

describe('blocked Goal resume on a native input receipt', () => {
  test.each(['peer', 'thread-input', 'wake-event'])('resumes once for %s input', async sourceId => {
    const f = fixture(); f.admission.sourceId = sourceId;
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.resumes()).toBe(1);
    expect(f.notices).toEqual(['resumed_on_input']);
  });

  test.each(['blocked', 'usageLimited'] as const)(
    'an outcome or Goal notice delivery neither resumes a %s Goal nor records a notice', async status => {
      // A delivered notice that resumed the receiver's Goal and told its
      // assigner would make two threads answer each other without end.
      for (const ledger of ['ledger', 'boundLedger'] as const) {
        const f = fixture(status);
        f.admission.sourceId = 'thread-input';
        f.admission.eventId = `outcome-${'a'.repeat(64)}`;
        expect(await resumeBlockedGoalOnInput(f.admission, f[ledger], f.deps)).toBe(true);
        expect(f.resumes()).toBe(0);
        expect(f.notices).toEqual([]);
        expect(f.reads()).toBe(0);
        expect(f.intent()).toBeUndefined();
      }
    });

  test('a delivery with a reservation left by an earlier release records no notice', async () => {
    const f = fixture();
    f.admission.eventId = `outcome-${'b'.repeat(64)}`;
    await f.ledger.reserve({ goalId: GOAL, goalCreatedAt: 1, goalUpdatedAt: 2, missionRevision: 1,
      lifecycleRevision: 3 });
    expect(await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps)).toBe(true);
    expect(f.notices).toEqual([]);
    expect(f.resumes()).toBe(0);
  });

  test.each(['paused', 'budgetLimited', 'complete', 'active'] as const)(
    'does not resume a %s Goal', async status => {
      const f = fixture(status);
      await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
      expect(f.resumes()).toBe(0);
      expect(f.notices).toEqual([]);
      expect(f.custodyReads()).toBe(0);
    });

  test('reads the Goal but does not resume when its admitting turn ended or changed', async () => {
    const f = fixture();
    f.deps.custody = async () => ({ status: 'idle', lastTurnId: TURN,
      lastTurnStatus: 'completed', queuedSubmissionCount: 0 }) as never;
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.reads()).toBe(1);
    expect(f.resumes()).toBe(0);
  });

  test('an unavailable custody read on a blocked Goal leaves the hand-off pending', async () => {
    const f = fixture();
    let calls = 0;
    f.deps.custody = async () => { calls++; throw Error('native custody unavailable'); };
    expect(await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps)).toBe(false);
    expect(calls).toBe(1);
    expect(f.reads()).toBe(1);
    expect(f.resumes()).toBe(0);
    expect(f.notices).toEqual([]);
  });

  test('a bound refusal leaves the native input delivered and records its notice', async () => {
    const f = fixture();
    await resumeBlockedGoalOnInput(f.admission, f.boundLedger, f.deps);
    expect(f.resumes()).toBe(0);
    expect(f.notices).toEqual(['resume_bound_reached']);
  });

  test('a known stale CAS is rejected without an unconfirmed notice', async () => {
    const f = fixture();
    f.deps.resume = async () => { throw new GoalRevisionConflictError(); };
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.notices).toEqual([]);
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.resumes()).toBe(0);
  });

  test('an ambiguous native resume records an unconfirmed result without retrying CAS', async () => {
    const f = fixture();
    f.deps.resume = async () => { throw Error('transport unavailable'); };
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.notices).toEqual(['resume_result_unconfirmed']);
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.notices).toEqual(['resume_result_unconfirmed', 'resume_result_unconfirmed']);
  });

  test('a confirmed CAS with a failed notice retries only the notice', async () => {
    const f = fixture();
    const notice = f.deps.notice;
    f.deps.notice = async () => { throw Error('notice store full'); };
    await expect(resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps))
      .rejects.toThrow('notice store full');
    expect(f.resumes()).toBe(1);
    f.deps.notice = notice;
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.resumes()).toBe(1);
    expect(f.notices).toEqual(['resumed_on_input']);
  });

  test('a reserved pre-CAS intent after restart reports unconfirmed without native mutation', async () => {
    const f = fixture();
    await f.ledger.reserve({ goalId: GOAL, goalCreatedAt: 1, goalUpdatedAt: 2,
      missionRevision: 1, lifecycleRevision: 3 });
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.resumes()).toBe(0);
    expect(f.notices).toEqual(['resume_result_unconfirmed']);
  });
});

describe('usage-limited Goal resume on a native input receipt', () => {
  test('an input whose turn is running resumes the usage-limited Goal once, by exact revision', async () => {
    const f = fixture('usageLimited');
    let expected: unknown;
    const resume = f.deps.resume;
    f.deps.resume = async (threadId, revision) => { expected = revision; return resume(threadId, revision); };
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.resumes()).toBe(1);
    expect(expected).toEqual({ goalId: GOAL, status: 'usageLimited', missionRevision: 1, lifecycleRevision: 3 });
    expect(f.notices).toEqual(['resumed_on_input']);
    expect(f.statuses).toEqual(['active<-usageLimited']);
    expect(f.intent()?.goalStatus).toBe('usageLimited');
    // The same admission handed over again never mutates a second time.
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.resumes()).toBe(1);
  });

  test('an input whose turn already failed (still limited) does not resume', async () => {
    const f = fixture('usageLimited');
    f.deps.custody = async () => ({ status: 'systemError', lastTurnId: TURN,
      lastTurnStatus: 'failed', queuedSubmissionCount: 0 }) as never;
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.resumes()).toBe(0);
    expect(f.notices).toEqual([]);
  });

  test('the shared per-Goal bound applies and reports the usage-limited status', async () => {
    const f = fixture('usageLimited');
    await resumeBlockedGoalOnInput(f.admission, f.boundLedger, f.deps);
    expect(f.resumes()).toBe(0);
    expect(f.notices).toEqual(['resume_bound_reached']);
    expect(f.statuses).toEqual(['usageLimited<-usageLimited']);
  });

  test('a concurrent change is rejected without a retry', async () => {
    const f = fixture('usageLimited');
    f.deps.resume = async () => { throw new GoalRevisionConflictError(); };
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.intent()?.phase).toBe('rejected');
    await resumeBlockedGoalOnInput(f.admission, f.ledger, f.deps);
    expect(f.notices).toEqual([]);
  });
});
