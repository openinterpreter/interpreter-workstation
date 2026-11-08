import type { v2 } from '../../../server/handlers/codex-generated-types/index';

/** Native-owned identity for an exact, content-free Goal read. Never infer this from timestamps. */
export type ThreadGoalRevision = {
  goalId: string;
  status: v2.ThreadGoalStatus;
  missionRevision: number;
  lifecycleRevision: number;
};

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
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId)) {
    throw new GoalRevisionUnavailableError();
  }
  if (goal === null && revision === null) return null;
  if (!goal || goal.threadId !== threadId || !revision || typeof revision !== 'object') {
    throw new GoalRevisionUnavailableError();
  }
  const value = revision as Partial<ThreadGoalRevision>;
  if (typeof value.goalId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.goalId) ||
      value.status !== goal.status ||
      !Number.isSafeInteger(value.missionRevision) || (value.missionRevision ?? 0) < 1 ||
      !Number.isSafeInteger(value.lifecycleRevision) || (value.lifecycleRevision ?? 0) < 1) {
    throw new GoalRevisionUnavailableError();
  }
  return value as ThreadGoalRevision;
}
