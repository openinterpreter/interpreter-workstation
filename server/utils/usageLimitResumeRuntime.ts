import { getCodexService, subscribeCodexNotifications } from '../../src/lib/codex/service';
import { outcomeReturns, readyOutcomeReturns } from './outcomeReturnsRuntime';
import { UsageLimitResume, usageResumeSettings } from './usageLimitResume';
import { readyWakeSources, wakeSources } from './wakeSourcesRuntime';

let instance: UsageLimitResume | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;

/** Resume Goals stopped by an account usage limit once the allowance is back.
 * Started beside the automatic capacity resume. */
export function startUsageLimitResume(env: NodeJS.ProcessEnv = process.env): void {
  if (instance) return;
  const { intervalMs, step } = usageResumeSettings(env);
  const resume = new UsageLimitResume({
    now: () => Date.now(),
    // A backend usage read through the runtime; it does not run the model.
    readAllowance: () => getCodexService().readAccountRateLimits(),
    readRevision: async threadId => (await getCodexService().getThreadGoalWithRevision(threadId)).revision,
    // The same exact-revision resume the operator and supervisor routes use;
    // it also loads an unloaded thread so the runtime continues the Goal.
    resume: async (threadId, expected) => {
      await getCodexService().resumeThreadGoalWithRevision(threadId, expected);
    },
    pendingInputs: threadId => {
      try { return wakeSources.threadInputs().get(threadId) ?? 0; } catch { return 0; }
    },
    resumed: async threadId => {
      await readyWakeSources();
      await wakeSources.releaseUsageLimitBackoff(threadId);
    },
    // Threads with wake inputs or sources first, then recently attributed ones.
    candidates: async limit => {
      const threads = new Set<string>();
      try { await readyWakeSources(); for (const id of wakeSources.threadInputs().keys()) threads.add(id); }
      catch { /* Recently attributed threads are still read. */ }
      try { await readyOutcomeReturns(); for (const id of outcomeReturns.recentSenderThreads(limit)) threads.add(id); }
      catch { /* Wake threads are still read. */ }
      return [...threads].slice(0, limit);
    },
    log: line => console.info(line),
    step,
  });
  instance = resume;
  unsubscribe = subscribeCodexNotifications(notification => resume.handleNotification(notification));
  timer = setInterval(() => {
    void resume.tick().catch(error => console.error('[usage-resume] tick failed', error instanceof Error ? error.name : 'Error'));
  }, intervalMs);
  timer.unref?.();
  console.info(`[usage-resume] started intervalMs=${intervalMs} step=${step}`);
}

export function stopUsageLimitResume(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  instance?.stop();
  instance = undefined;
}
