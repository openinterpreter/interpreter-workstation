import { createHash } from 'node:crypto';
import { getCodexService } from '../../src/lib/codex/service';
import { GoalRevisionConflictError, type ThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import { outcomeReturns, readyOutcomeReturns } from './outcomeReturnsRuntime';
import type { GoalInputAdmission, GoalInputIntent, GoalInputLedger } from './wakeSources';
import type { GoalNotice, GoalNoticeReason } from './outcomeReturns';

type Read = Awaited<ReturnType<ReturnType<typeof getCodexService>['getThreadGoalWithRevision']>>;
type Resume = Awaited<ReturnType<ReturnType<typeof getCodexService>['resumeThreadGoalWithRevision']>>;
type Custody = Awaited<ReturnType<ReturnType<typeof getCodexService>['readNativeCustody']>>;

export type GoalInputResumeDeps = {
  custody(threadId: string): Promise<Custody>;
  read(threadId: string): Promise<Read>;
  resume(threadId: string, expected: ThreadGoalRevision): Promise<Resume>;
  notice(admission: GoalInputAdmission, goal: NonNullable<Read['goal']>,
    revision: ThreadGoalRevision, reason: GoalNoticeReason, updatedAt?: number,
    stoppedStatus?: StoppedStatus): Promise<void>;
};
type StoppedStatus = NonNullable<GoalInputIntent['goalStatus']>;

function observedGoal(admission: GoalInputAdmission, intent: GoalInputIntent) {
  return { threadId: admission.threadId, createdAt: intent.goalCreatedAt,
    updatedAt: intent.goalUpdatedAt } as NonNullable<Read['goal']>;
}

async function noticeIntent(admission: GoalInputAdmission, intent: GoalInputIntent,
  deps: GoalInputResumeDeps): Promise<void> {
  const reason: GoalNoticeReason = intent.phase === 'confirmed' ? 'resumed_on_input' :
    intent.phase === 'bounded' ? 'resume_bound_reached' : 'resume_result_unconfirmed';
  await deps.notice(admission, observedGoal(admission, intent), {
    goalId: intent.goalId, status: intent.phase === 'confirmed' ? 'active' : intent.goalStatus ?? 'blocked',
    missionRevision: intent.missionRevision, lifecycleRevision: intent.lifecycleRevision +
      (intent.phase === 'confirmed' ? 1 : 0),
  }, reason, intent.resultUpdatedAt ?? intent.goalUpdatedAt, intent.goalStatus ?? 'blocked');
}

/** Goal statuses an admitted input may resume. A usage-limited Goal never
 * resumes by itself; a turn that is running the admitted input shows that
 * the account can run the model again. */
const RESUMABLE_ON_INPUT: ReadonlySet<string> = new Set(['blocked', 'usageLimited']);

/** Native admission is already saved by the caller. A failed Goal read, CAS,
 * notice, or bounded reservation must never revoke or resubmit that input. */
export async function resumeBlockedGoalOnInput(admission: GoalInputAdmission,
  ledger: GoalInputLedger,
  deps: GoalInputResumeDeps): Promise<boolean> {
  // A persisted pre-CAS intent is the recovery boundary. No retry may make a
  // second native mutation; an unconfirmed result is reported as such, never
  // inferred from a later Goal status that another actor could have changed.
  const existing = await ledger.lookup();
  if (existing) {
    if (existing.phase !== 'rejected') await noticeIntent(admission, existing, deps);
    return true;
  }
  const { goal, revision } = await deps.read(admission.threadId);
  if (!goal || !revision || goal.threadId !== admission.threadId ||
      !RESUMABLE_ON_INPUT.has(goal.status) || revision.status !== goal.status) return true;
  // Most inputs have no stopped Goal. Native custody can reject long turns;
  // it is only needed before mutating a blocked Goal, never for delivery.
  let custody: Custody;
  try { custody = await deps.custody(admission.threadId); }
  // The admission is durable, but an unavailable custody read cannot prove
  // whether its turn is live. Keep this input's hand-over pending for a later
  // pass instead of silently losing its one opportunity to resume the Goal.
  catch { return false; }
  if (custody.lastTurnId !== admission.turnId || custody.lastTurnStatus !== 'inProgress' ||
      custody.status !== 'active') return true;
  const intent = { goalId: revision.goalId, goalCreatedAt: goal.createdAt,
    goalUpdatedAt: goal.updatedAt, missionRevision: revision.missionRevision,
    lifecycleRevision: revision.lifecycleRevision,
    ...(revision.status === 'usageLimited' && { goalStatus: 'usageLimited' as const }) };
  const decision = await ledger.reserve(intent);
  if (decision === 'duplicate') {
    const saved = await ledger.lookup();
    if (!saved) throw new Error('Goal input reservation unavailable');
    await noticeIntent(admission, saved, deps);
    return true;
  }
  if (decision === 'bounded') {
    await noticeIntent(admission, { ...intent, phase: 'bounded' }, deps);
    return true;
  }
  // The CAS verifies that this is still the observed blocked Goal. A conflict
  // or ambiguous transport outcome must not be retried from this admission.
  let resumed: Resume;
  try { resumed = await deps.resume(admission.threadId, revision); }
  catch (error) {
    if (error instanceof GoalRevisionConflictError) {
      await ledger.reject(revision.goalId);
      return true;
    }
    await noticeIntent(admission, { ...intent, phase: 'reserved' }, deps);
    return true;
  }
  await ledger.confirm(revision.goalId, resumed.goal.updatedAt);
  await noticeIntent(admission, { ...intent, phase: 'confirmed',
    resultUpdatedAt: resumed.goal.updatedAt }, deps);
  return true;
}

/** Record fixed, input-specific notices; never relay message text or logs. */
async function noticeGoalInput(admission: GoalInputAdmission, goal: NonNullable<Read['goal']>,
  revision: ThreadGoalRevision, reason: GoalNoticeReason, updatedAt = goal.updatedAt,
  stoppedStatus: StoppedStatus = 'blocked'): Promise<void> {
  await readyOutcomeReturns();
  const assigner = outcomeReturns.existingGoalAssigner(admission.threadId, goal.createdAt);
  const inputId = createHash('sha256').update(JSON.stringify([
    admission.threadId, admission.sourceId, admission.eventId,
  ])).digest('hex');
  const notice: GoalNotice = { status: reason === 'resumed_on_input' ? 'active' : stoppedStatus,
    previousStatus: reason === 'resumed_on_input' ? stoppedStatus : undefined,
    reason, createdAt: goal.createdAt, updatedAt, goalId: revision.goalId,
    missionRevision: revision.missionRevision, lifecycleRevision: revision.lifecycleRevision,
    inputId };
  const stored = await outcomeReturns.noticeGoal(admission.threadId,
    assigner && 'sender' in assigner ? { sender: assigner.sender } :
      { unrouted: assigner && 'unrouted' in assigner ? assigner.unrouted : 'no_assigner' }, notice);
  if (!stored) throw new Error('Goal notice store full');
}

export async function resumeBlockedGoalOnNativeInput(admission: GoalInputAdmission,
  ledger: GoalInputLedger): Promise<boolean> {
  const service = getCodexService();
  return resumeBlockedGoalOnInput(admission, ledger, {
    custody: id => service.readNativeCustody(id),
    read: id => service.getThreadGoalWithRevision(id),
    resume: (id, expected) => service.resumeThreadGoalWithRevision(id, expected),
    notice: noticeGoalInput,
  });
}
