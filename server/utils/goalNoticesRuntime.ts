import { getCodexService, subscribeCodexNotifications } from '../../src/lib/codex/service';
import { goalAutoResumeState } from './goalAutoResumeRuntime';
import { GoalNotices, type ObservedGoal } from './goalNotices';
import { outcomeReturns, readyOutcomeReturns } from './outcomeReturnsRuntime';

const READ_GOAL_TIMEOUT_MS = 5_000;
const RECONCILE_START_DELAY_MS = 3 * 60_000;

let notices: GoalNotices | undefined;
let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | undefined;

/** Tell the agent that assigned a thread's Goal when it stops, completes or
 * resumes. Started after outcome returns and the automatic Goal resume. */
export function startGoalNotices(): void {
  if (notices) return;
  const instance = new GoalNotices({
    now: () => Date.now(),
    setTimer: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    },
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    bindAssigner: async (threadId, goalCreatedAt, turnId) => {
      await readyOutcomeReturns();
      return outcomeReturns.bindGoalAssigner(threadId, goalCreatedAt, turnId);
    },
    lastNotice: async threadId => { await readyOutcomeReturns(); return outcomeReturns.lastGoalNotice(threadId); },
    record: async (threadId, assigner, notice) => {
      await readyOutcomeReturns();
      await outcomeReturns.noticeGoal(threadId, assigner, notice);
    },
    // Bounded, and never reconnects the runtime; an old runtime has no revision.
    readRevision: async threadId => {
      const { goal, revision } = await getCodexService().getThreadGoalWithRevision(threadId);
      return goal && revision ? { createdAt: goal.createdAt, revision } : null;
    },
    autoResumeState: goalAutoResumeState,
    recentSenderThreads: async limit => { await readyOutcomeReturns(); return outcomeReturns.recentSenderThreads(limit); },
    // One bounded native Goal read per recently attributed thread, at startup only.
    readGoal: async threadId => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const goal = await Promise.race([
          getCodexService().getThreadGoal(threadId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Goal read timed out')), READ_GOAL_TIMEOUT_MS);
          }),
        ]);
        return goal ? { status: goal.status, createdAt: goal.createdAt, updatedAt: goal.updatedAt } as ObservedGoal : null;
      } finally { if (timer) clearTimeout(timer); }
    },
    log: line => console.info(line),
  });
  notices = instance;
  unsubscribe = subscribeCodexNotifications(notification => instance.handleNotification(notification));
  // The startup pass waits until the server has finished starting, so its
  // Goal reads never compete with the first requests after a restart.
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined;
    void instance.reconcile().catch(error => {
      console.error('[goal-notices] Startup reconciliation failed; live changes are still reported.', error);
    });
  }, RECONCILE_START_DELAY_MS);
  reconcileTimer.unref?.();
}

export function stopGoalNotices(): void {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  notices?.stop();
  notices = undefined;
}
