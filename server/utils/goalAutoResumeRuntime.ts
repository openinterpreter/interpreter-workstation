import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getInterpreterAppDataDir } from '../configStore';
import { GoalAutoResume, isTransientCapacityError, type GoalAutoResumeSnapshot,
  type GoalAutoResumeState } from '../../src/lib/codex/goal-auto-resume';
import { getCodexService, subscribeCodexNotifications } from '../../src/lib/codex/service';

let autoResume: GoalAutoResume | undefined;
let unsubscribe: (() => void) | undefined;
const MAX_EPISODES = 500;
function episodePath(): string { return path.join(getInterpreterAppDataDir(), 'goal-capacity-episodes.json'); }

function readEpisodes(): GoalAutoResumeSnapshot[] {
  const file = episodePath();
  if (!existsSync(file)) return [];
  const payload: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!payload || typeof payload !== 'object' || (payload as { version?: unknown }).version !== 1 ||
      !Array.isArray((payload as { entries?: unknown }).entries) ||
      (payload as { entries: unknown[] }).entries.length > MAX_EPISODES) throw new Error('Invalid Goal capacity custody ledger');
  const entries = (payload as { entries: GoalAutoResumeSnapshot[] }).entries;
  if (entries.some(item => !item || typeof item !== 'object' || typeof item.threadId !== 'string' ||
    typeof item.turnId !== 'string' || !['preflight', 'scheduled', 'uncertain', 'exhausted'].includes(item.phase) ||
    (item.phase !== 'preflight' && (typeof item.goalId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(item.goalId) || !Number.isSafeInteger(item.missionRevision))) ||
    (item.phase === 'preflight' && (item.goalId !== undefined || item.expected !== undefined ||
      item.missionRevision !== undefined)) ||
    (item.observedGoalId !== undefined && (item.phase !== 'preflight' ||
      typeof item.observedGoalId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item.observedGoalId))) ||
    (item.preflightChecks !== undefined && (item.phase !== 'preflight' ||
      !Number.isSafeInteger(item.preflightChecks) || item.preflightChecks < 0 || item.preflightChecks > 100)) ||
    !Number.isSafeInteger(item.attempts) || !Number.isFinite(item.episodeStartedAt) ||
    !Number.isFinite(item.retryAt) || (item.phase === 'scheduled' && item.expected?.status !== 'blocked'))) {
    throw new Error('Invalid Goal capacity custody episode');
  }
  return entries;
}

function writeEpisodes(entries: GoalAutoResumeSnapshot[]): void {
  if (entries.length > MAX_EPISODES) throw new Error('Goal capacity custody ledger full');
  const file = episodePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ version: 1, entries }), 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, file);
  const dir = openSync(path.dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** Resume Goals blocked by a temporary model-capacity refusal. Started beside
 * the wake-source runtime so headless agents recover without a person. */
export function startGoalAutoResume(): void {
  if (autoResume) return;
  let saved: GoalAutoResumeSnapshot[];
  try { saved = readEpisodes(); }
  catch { console.error('[goal-auto-resume] custody ledger unavailable; automatic resume disabled'); return; }
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
    verifyFailedTurn: async (threadId, turnId) => {
      let newest: { id: string; status: string; error: unknown } | undefined;
      await getCodexService().scanTurnsNewestFirst(threadId, turn => {
        newest = { id: turn.id, status: turn.status, error: turn.error };
        return true;
      });
      return newest?.id === turnId && newest.status === 'failed' && isTransientCapacityError(newest.error);
    },
    persist: writeEpisodes,
    log: line => console.info(line),
  });
  autoResume = instance;
  unsubscribe = subscribeCodexNotifications(notification => {
    try { instance.handleNotification(notification); }
    catch {
      instance.stop();
      console.error('[goal-auto-resume] custody write failed; automatic resume disabled');
    }
  });
  void instance.restore(saved).catch(() => console.error('[goal-auto-resume] restoration unavailable; no unverified resume issued'));
}

/** The running automatic resume's view of a thread, or null when it is not running. */
export function goalAutoResumeState(threadId: string): GoalAutoResumeState | null {
  return autoResume?.state(threadId) ?? null;
}

export async function refreshGoalAutoResumeTerminalIdentity(threadId: string): Promise<void> {
  await autoResume?.refreshExhaustedIdentity(threadId);
}

export function goalAutoResumeThreadIds(): string[] { return autoResume?.threadIds() ?? []; }

export function stopGoalAutoResume(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  autoResume?.stop();
  autoResume = undefined;
}
