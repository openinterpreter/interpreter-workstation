import { describe, expect, test } from 'bun:test';
import { resumeBlockedGoalOnInput, type GoalInputResumeDeps } from './goalInputResumeRuntime';
import type { GoalInputAdmission } from './wakeSources';

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
  let resumes = 0;
  let reads = 0;
  const deps = {
    custody: async () => ({ status: 'active', lastTurnId: TURN, lastTurnStatus: 'inProgress',
      queuedSubmissionCount: 0 }),
    read: async () => { reads++; return { goal, revision }; },
    resume: async () => { resumes++; return { goal: { ...goal, status: 'active', updatedAt: 3 },
      revision: { ...revision, status: 'active', lifecycleRevision: 4 }, continuation: 'already_running' }; },
    notice: async (_admission: GoalInputAdmission, _goal: unknown, _revision: unknown, reason: string) => {
      notices.push(reason);
    },
  } as unknown as GoalInputResumeDeps;
  return { admission, deps, notices, reads: () => reads, resumes: () => resumes };
}

describe('blocked Goal resume on a native input receipt', () => {
  test.each(['peer', 'thread-input', 'wake-event'])('resumes once for %s input', async sourceId => {
    const f = fixture(); f.admission.sourceId = sourceId;
    await resumeBlockedGoalOnInput(f.admission, async () => 'reserved', f.deps);
    expect(f.resumes()).toBe(1);
    expect(f.notices).toEqual(['resumed_on_input']);
  });

  test.each(['paused', 'usageLimited', 'budgetLimited', 'complete', 'active'] as const)(
    'does not resume a %s Goal', async status => {
      const f = fixture(status);
      await resumeBlockedGoalOnInput(f.admission, async () => { throw Error('unexpected reserve'); }, f.deps);
      expect(f.resumes()).toBe(0);
      expect(f.notices).toEqual([]);
    });

  test('does not read a Goal when its admitting turn ended or changed', async () => {
    const f = fixture();
    f.deps.custody = async () => ({ status: 'idle', lastTurnId: TURN,
      lastTurnStatus: 'completed', queuedSubmissionCount: 0 }) as never;
    await resumeBlockedGoalOnInput(f.admission, async () => 'reserved', f.deps);
    expect(f.reads()).toBe(0);
  });

  test('a bound refusal leaves the native input delivered and records its notice', async () => {
    const f = fixture();
    await resumeBlockedGoalOnInput(f.admission, async () => 'bounded', f.deps);
    expect(f.resumes()).toBe(0);
    expect(f.notices).toEqual(['resume_bound_reached']);
  });

  test('a stale native CAS does not retry, reverse admission, or claim a resume', async () => {
    const f = fixture();
    f.deps.resume = async () => { throw Error('revision changed'); };
    await expect(resumeBlockedGoalOnInput(f.admission, async () => 'reserved', f.deps))
      .rejects.toThrow('revision changed');
    expect(f.notices).toEqual([]);
  });
});
