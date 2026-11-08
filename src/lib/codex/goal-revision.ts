import type { v2 } from '../../../server/handlers/codex-generated-types/index';

/** Native-owned identity for an exact, content-free Goal read. Never infer this from timestamps. */
export type ThreadGoalRevision = {
  goalId: string;
  status: v2.ThreadGoalStatus;
  missionRevision: number;
  lifecycleRevision: number;
};

export type GoalCasExpectedParams = {
  expectedGoalId: string;
  expectedStatus: v2.ThreadGoalStatus;
  expectedMissionRevision: number;
  expectedLifecycleRevision: number;
};

const GOAL_STATUSES: readonly string[] = [
  'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete',
];
const GOAL_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function validRevision(value: Partial<ThreadGoalRevision>): value is ThreadGoalRevision {
  return typeof value.goalId === 'string' && GOAL_ID.test(value.goalId) &&
    typeof value.status === 'string' && GOAL_STATUSES.includes(value.status) &&
    Number.isSafeInteger(value.missionRevision) && (value.missionRevision ?? 0) >= 1 &&
    Number.isSafeInteger(value.lifecycleRevision) && (value.lifecycleRevision ?? 0) >= 1;
}

export class GoalRevisionUnavailableError extends Error {
  readonly category = 'read_unavailable';

  constructor() {
    super('Native Goal identity and revision are unavailable.');
    this.name = 'GoalRevisionUnavailableError';
  }
}

/** An old native runtime can return a Goal without the CAS identity: fail closed. */
export function verifyThreadGoalRevision(
  goal: v2.ThreadGoal | null,
  revision: unknown,
  threadId: string,
): ThreadGoalRevision | null {
  if (!GOAL_ID.test(threadId)) {
    throw new GoalRevisionUnavailableError();
  }
  if (goal === null && revision === null) return null;
  if (!goal || goal.threadId !== threadId || !revision || typeof revision !== 'object') {
    throw new GoalRevisionUnavailableError();
  }
  const value = revision as Partial<ThreadGoalRevision>;
  if (!validRevision(value) || value.status !== goal.status) {
    throw new GoalRevisionUnavailableError();
  }
  return value as ThreadGoalRevision;
}

/** A full native precondition, never a read-then-write approximation of CAS. */
export function goalCasExpectedParams(revision: ThreadGoalRevision): GoalCasExpectedParams {
  if (!revision || !validRevision(revision)) throw new GoalRevisionUnavailableError();
  return {
    expectedGoalId: revision.goalId,
    expectedStatus: revision.status,
    expectedMissionRevision: revision.missionRevision,
    expectedLifecycleRevision: revision.lifecycleRevision,
  };
}
