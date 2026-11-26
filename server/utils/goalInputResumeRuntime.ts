import { createHash } from 'node:crypto';
import { getCodexService } from '../../src/lib/codex/service';
import type { ThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import { outcomeReturns, readyOutcomeReturns } from './outcomeReturnsRuntime';
import type { GoalInputAdmission } from './wakeSources';
import type { GoalNotice, GoalNoticeReason } from './outcomeReturns';

type Read = Awaited<ReturnType<ReturnType<typeof getCodexService>['getThreadGoalWithRevision']>>;
type Resume = Awaited<ReturnType<ReturnType<typeof getCodexService>['resumeThreadGoalWithRevision']>>;
type Custody = Awaited<ReturnType<ReturnType<typeof getCodexService>['readNativeCustody']>>;

export type GoalInputResumeDeps = {
  custody(threadId: string): Promise<Custody>;
  read(threadId: string): Promise<Read>;
  resume(threadId: string, expected: ThreadGoalRevision): Promise<Resume>;
  notice(admission: GoalInputAdmission, goal: NonNullable<Read['goal']>,
    revision: ThreadGoalRevision, reason: GoalNoticeReason, updatedAt?: number): Promise<void>;
};

/** Native admission is already saved by the caller. A failed Goal read, CAS,
 * notice, or bounded reservation must never revoke or resubmit that input. */
export async function resumeBlockedGoalOnInput(admission: GoalInputAdmission,
  reserve: (goalId: string) => Promise<'reserved' | 'bounded' | 'duplicate'>,
  deps: GoalInputResumeDeps): Promise<void> {
  const custody = await deps.custody(admission.threadId);
  if (custody.lastTurnId !== admission.turnId || custody.lastTurnStatus !== 'inProgress' ||
      custody.status !== 'active') return;
  const { goal, revision } = await deps.read(admission.threadId);
  if (!goal || !revision || goal.threadId !== admission.threadId ||
      goal.status !== 'blocked' || revision.status !== 'blocked') return;
  const decision = await reserve(revision.goalId);
  if (decision === 'duplicate') return;
  if (decision === 'bounded') {
    await deps.notice(admission, goal, revision, 'resume_bound_reached');
    return;
  }
  // The CAS verifies that this is still the observed blocked Goal. A conflict
  // or ambiguous transport outcome must not be retried from this admission.
  const resumed = await deps.resume(admission.threadId, revision);
  await deps.notice(admission, goal, resumed.revision, 'resumed_on_input', resumed.goal.updatedAt);
}

/** Record fixed, input-specific notices; never relay message text or logs. */
async function noticeGoalInput(admission: GoalInputAdmission, goal: NonNullable<Read['goal']>,
  revision: ThreadGoalRevision, reason: GoalNoticeReason, updatedAt = goal.updatedAt): Promise<void> {
  await readyOutcomeReturns();
  const assigner = await outcomeReturns.bindGoalAssigner(admission.threadId, goal.createdAt, admission.turnId);
  const inputId = createHash('sha256').update(JSON.stringify([
    admission.threadId, admission.sourceId, admission.eventId,
  ])).digest('hex');
  const notice: GoalNotice = { status: reason === 'resumed_on_input' ? 'active' : 'blocked',
    previousStatus: reason === 'resumed_on_input' ? 'blocked' : undefined,
    reason, createdAt: goal.createdAt, updatedAt, goalId: revision.goalId,
    missionRevision: revision.missionRevision, lifecycleRevision: revision.lifecycleRevision,
    inputId };
  await outcomeReturns.noticeGoal(admission.threadId,
    assigner && 'sender' in assigner ? { sender: assigner.sender } :
      { unrouted: assigner && 'unrouted' in assigner ? assigner.unrouted : 'no_assigner' }, notice);
}

export async function resumeBlockedGoalOnNativeInput(admission: GoalInputAdmission,
  reserve: (goalId: string) => Promise<'reserved' | 'bounded' | 'duplicate'>): Promise<void> {
  const service = getCodexService();
  await resumeBlockedGoalOnInput(admission, reserve, {
    custody: id => service.readNativeCustody(id),
    read: id => service.getThreadGoalWithRevision(id),
    resume: (id, expected) => service.resumeThreadGoalWithRevision(id, expected),
    notice: noticeGoalInput,
  });
}
