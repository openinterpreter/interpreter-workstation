import { GoalAutoResume, type GoalAutoResumeState } from '../../src/lib/codex/goal-auto-resume';
import { getCodexService, subscribeCodexNotifications } from '../../src/lib/codex/service';

let autoResume: GoalAutoResume | undefined;
let unsubscribe: (() => void) | undefined;

/** Resume Goals blocked by a temporary model-capacity refusal. Started beside
 * the wake-source runtime so headless agents recover without a person. */
export function startGoalAutoResume(): void {
  if (autoResume) return;
  const instance = new GoalAutoResume({
    now: () => Date.now(),
    setTimer: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    },
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    readRevision: async threadId => (await getCodexService().getThreadGoalWithRevision(threadId)).revision,
    // The same exact-revision transition the operator resume path uses. An
    // idle blocked thread may have been unloaded during the backoff, so the
    // resume also loads it; a thread that cannot be loaded is logged there.
    resume: async (threadId, expected) => {
      await getCodexService().resumeThreadGoalWithRevision(threadId, expected);
    },
    log: line => console.info(line),
  });
  autoResume = instance;
  unsubscribe = subscribeCodexNotifications(notification => instance.handleNotification(notification));
}

/** The running automatic resume's view of a thread, or null when it is not running. */
export function goalAutoResumeState(threadId: string): GoalAutoResumeState | null {
  return autoResume?.state(threadId) ?? null;
}

export function stopGoalAutoResume(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  autoResume?.stop();
  autoResume = undefined;
}
