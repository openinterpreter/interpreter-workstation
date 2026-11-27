import { GoalRevisionConflictError, type ThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import type { AppServerNotification } from '../../src/lib/codex/protocol';
import type { v2 } from '../handlers/codex-generated-types/index';

/**
 * Automatic resume of Goals stopped by an account usage limit.
 *
 * The runtime sets a Goal to `usageLimited` when a turn fails on the
 * account's usage limit, and nothing in the runtime ever sets it back: once
 * the allowance returns (a reset, or credits added) every such Goal stays
 * stopped until someone resumes it. The saved Goal status therefore cannot be
 * the signal; this module polls the account's allowance instead.
 *
 * While any tracked Goal is usage-limited it reads the allowance every
 * interval (one backend usage read per tick, never a model call). When the
 * allowance is available, or cannot be read and the Goal's backoff has
 * elapsed, it resumes a few Goals per tick through the same exact-revision
 * resume an operator uses (expected status `usageLimited`). The same Goal and
 * thread continue; no Goal, thread or input is created, replayed or dropped.
 * State is in memory; a startup pass finds Goals that were already limited.
 */

const MINUTE = 60_000;
export const USAGE_RESUME_DEFAULT_INTERVAL_MS = 5 * MINUTE;
export const USAGE_RESUME_MIN_INTERVAL_MS = MINUTE;
export const USAGE_RESUME_DEFAULT_STEP = 2;
/** Wait before each attempt on one Goal; the last entry repeats. The first
 * attempt waits only when the allowance cannot be read. */
export const USAGE_RESUME_BACKOFF_MS: readonly number[] = [5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 30 * MINUTE];
/** Startup pass bounds: threads read and concurrent Goal reads. */
export const USAGE_RESUME_RECONCILE_LIMIT = 100;
const RECONCILE_CONCURRENCY = 2;
const TRACKED_LIMIT = 1_000;

export type Allowance = 'available' | 'exhausted' | 'unknown';

type RateLimits = Pick<v2.GetAccountRateLimitsResponse, 'ordinaryUsageAllowed' | 'rateLimits'> &
  Partial<Pick<v2.GetAccountRateLimitsResponse, 'rateLimitsByLimitId'>>;

function exhaustedWindow(snapshot: v2.RateLimitSnapshot): boolean {
  return [snapshot.primary, snapshot.secondary].some(window => !!window && window.usedPercent >= 100) ||
    snapshot.rateLimitReachedType !== null && snapshot.rateLimitReachedType !== undefined;
}

/**
 * Whether the account can run the model now, from one usage read.
 *
 * Credits count: an account whose included usage is used up still runs on
 * credits unless its spend control is reached, and the backend may then
 * report ordinary usage as not allowed. A missing permission (null) is not a
 * recovery signal; without credits it is `unknown`, which falls back to a
 * real attempt under backoff. `null` input (an unreadable read) is `unknown`.
 */
export function usageAllowance(read: RateLimits | null): Allowance {
  if (!read || typeof read !== 'object' || !read.rateLimits || typeof read.rateLimits !== 'object') return 'unknown';
  const snapshots = [read.rateLimits, ...Object.values(read.rateLimitsByLimitId ?? {})]
    .filter((snapshot): snapshot is v2.RateLimitSnapshot => !!snapshot && typeof snapshot === 'object');
  const credits = snapshots.some(snapshot => !!snapshot.credits &&
    (snapshot.credits.unlimited || snapshot.credits.hasCredits) && snapshot.spendControlReached !== true);
  if (credits || read.ordinaryUsageAllowed === true) return 'available';
  if (read.ordinaryUsageAllowed === false || exhaustedWindow(read.rateLimits)) return 'exhausted';
  return 'unknown';
}

export function usageResumeBackoffMs(attempts: number): number {
  return USAGE_RESUME_BACKOFF_MS[Math.min(Math.max(0, attempts), USAGE_RESUME_BACKOFF_MS.length - 1)]!;
}

/** Interval and step from the environment, with their bounds. */
export function usageResumeSettings(env: NodeJS.ProcessEnv = process.env): { intervalMs: number; step: number } {
  const minutes = Number(env.INTERPRETER_USAGE_RESUME_INTERVAL_MINUTES);
  const step = Number(env.INTERPRETER_USAGE_RESUME_STEP);
  return {
    intervalMs: Number.isFinite(minutes) && minutes > 0
      ? Math.max(USAGE_RESUME_MIN_INTERVAL_MS, Math.round(minutes * MINUTE)) : USAGE_RESUME_DEFAULT_INTERVAL_MS,
    step: Number.isSafeInteger(step) && step >= 1 && step <= 50 ? step : USAGE_RESUME_DEFAULT_STEP,
  };
}

export type UsageLimitResumeDeps = {
  now(): number;
  /** One backend usage read; throws when unavailable. */
  readAllowance(): Promise<RateLimits>;
  /** Exact native Goal identity; null when the thread has no Goal; may throw. */
  readRevision(threadId: string): Promise<ThreadGoalRevision | null>;
  /** Native compare-and-set from `expected` to active, then continuation. */
  resume(threadId: string, expected: ThreadGoalRevision): Promise<void>;
  /** Inputs awaiting admission on the thread; they go first. */
  pendingInputs(threadId: string): number;
  /** The Goal is active again: let its waiting inputs be offered. */
  resumed(threadId: string): Promise<void>;
  /** Startup only: threads worth reading for an already limited Goal. */
  candidates(limit: number): Promise<string[]>;
  log(line: string): void;
  step?: number;
};

type Entry = {
  /** The Goal is usage-limited as far as last observed. */
  limited: boolean;
  /** When this episode was first observed; older Goals go first. */
  since: number;
  /** Resume attempts in this episode. */
  attempts: number;
  /** Earliest next attempt when the allowance is unknown, or after any attempt. */
  nextAttemptAt: number;
};

function isUsageLimitError(error: unknown): boolean {
  const info = error && typeof error === 'object' ? (error as { codexErrorInfo?: unknown }).codexErrorInfo : undefined;
  return info === 'usageLimitExceeded' || info === 'usageLimitReached' ||
    (!!info && typeof info === 'object' && ('usageLimitExceeded' in info || 'usageLimitReached' in info));
}

export class UsageLimitResume {
  private readonly entries = new Map<string, Entry>();
  private ticking = false;
  private reconciled = false;
  private stopped = false;
  private readonly step: number;

  constructor(private readonly deps: UsageLimitResumeDeps) {
    this.step = deps.step ?? USAGE_RESUME_DEFAULT_STEP;
  }

  /** Tracked threads, for tests and diagnostics. */
  tracked(): Map<string, Readonly<Entry>> { return new Map(this.entries); }

  stop(): void {
    this.stopped = true;
    this.entries.clear();
  }

  handleNotification(notification: AppServerNotification): void {
    if (this.stopped) return;
    const method = notification.method as string;
    const params = notification.params as Record<string, unknown> | undefined;
    const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
    if (!threadId) return;
    if (method === 'thread/goal/updated') {
      const status = (params?.goal as { status?: unknown } | undefined)?.status;
      if (status === 'usageLimited') this.markLimited(threadId);
      // Resumed by this module or anyone else. Keep the episode, so a turn
      // that fails on the limit again continues the backoff.
      else if (status === 'active') { const entry = this.entries.get(threadId); if (entry) entry.limited = false; }
      else this.entries.delete(threadId);
      return;
    }
    if (method === 'thread/goal/cleared') { this.entries.delete(threadId); return; }
    if (method === 'turn/completed') {
      const turn = params?.turn as { status?: unknown; error?: unknown } | undefined;
      if (turn?.status === 'completed') {
        // A completed turn is progress: a later limit starts a new episode.
        // On a still limited Goal it also shows the model runs again, so
        // that Goal is due on the next tick whatever the usage read says.
        const entry = this.entries.get(threadId);
        if (entry?.limited) { entry.attempts = 0; entry.nextAttemptAt = this.deps.now(); }
        else this.entries.delete(threadId);
      }
      // The Goal update normally follows; a thread without a Goal is dropped
      // on the next tick's read.
      else if (turn?.status === 'failed' && isUsageLimitError(turn.error)) this.markLimited(threadId);
    }
  }

  private markLimited(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (entry) { entry.limited = true; return; }
    if (this.entries.size >= TRACKED_LIMIT) {
      for (const [id, candidate] of this.entries) if (!candidate.limited) { this.entries.delete(id); break; }
      if (this.entries.size >= TRACKED_LIMIT) return;
    }
    const now = this.deps.now();
    this.entries.set(threadId, { limited: true, since: now, attempts: 0, nextAttemptAt: now + usageResumeBackoffMs(0) });
  }

  /** Read once: threads whose Goal was already usage-limited at startup. */
  async reconcile(): Promise<void> {
    if (this.reconciled) return;
    this.reconciled = true;
    let threads: string[];
    try { threads = await this.deps.candidates(USAGE_RESUME_RECONCILE_LIMIT); }
    catch { this.deps.log('[usage-resume] reconcile skipped reason=candidates-unavailable'); return; }
    let next = 0;
    let found = 0;
    const worker = async () => {
      while (!this.stopped && next < threads.length) {
        const threadId = threads[next++]!;
        if (this.entries.has(threadId)) continue;
        try {
          if ((await this.deps.readRevision(threadId))?.status === 'usageLimited') { this.markLimited(threadId); found++; }
        } catch { /* An unreadable Goal is not guessed; a live notification still tracks it. */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, threads.length) }, worker));
    if (found) this.deps.log(`[usage-resume] reconcile found=${found}`);
  }

  /** One poll. Never overlaps itself; reads nothing when no Goal is limited. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.reconcile();
      const limited = [...this.entries].filter(([, entry]) => entry.limited);
      if (!limited.length || this.stopped) return;
      let allowance: Allowance;
      try { allowance = usageAllowance(await this.deps.readAllowance()); }
      catch { allowance = 'unknown'; }
      const now = this.deps.now();
      if (allowance === 'exhausted') {
        this.deps.log(`[usage-resume] waiting limited=${limited.length} allowance=exhausted`);
        return;
      }
      const due = limited.filter(([, entry]) =>
        (allowance === 'available' && entry.attempts === 0) || now >= entry.nextAttemptAt);
      // Stable order: threads with inputs waiting, then the longest stopped.
      due.sort(([a, x], [b, y]) => Number(this.deps.pendingInputs(b) > 0) - Number(this.deps.pendingInputs(a) > 0) ||
        x.since - y.since || (a < b ? -1 : a > b ? 1 : 0));
      if (!due.length) return;
      this.deps.log(`[usage-resume] tick limited=${limited.length} due=${due.length} allowance=${allowance} ` +
        `step=${this.step}`);
      for (const [threadId, entry] of due.slice(0, this.step)) {
        if (this.stopped) return;
        await this.attempt(threadId, entry, now);
      }
    } finally { this.ticking = false; }
  }

  private async attempt(threadId: string, entry: Entry, now: number): Promise<void> {
    let revision: ThreadGoalRevision | null;
    try { revision = await this.deps.readRevision(threadId); }
    catch {
      // Not an attempt, but never re-read on every tick either.
      entry.nextAttemptAt = now + usageResumeBackoffMs(entry.attempts);
      this.deps.log(`[usage-resume] skipped threadId=${threadId} reason=goal-revision-unavailable`);
      return;
    }
    if (this.entries.get(threadId) !== entry) return;
    if (!revision) { this.entries.delete(threadId); return; }
    if (revision.status !== 'usageLimited') {
      if (revision.status === 'active') entry.limited = false; else this.entries.delete(threadId);
      return;
    }
    entry.attempts += 1;
    entry.nextAttemptAt = now + usageResumeBackoffMs(entry.attempts);
    try {
      await this.deps.resume(threadId, revision);
    } catch (error) {
      if (error instanceof GoalRevisionConflictError) {
        // Changed between the read and the CAS: the next tick reads it again.
        // Someone else's decision is never overridden.
        this.deps.log(`[usage-resume] skipped threadId=${threadId} attempt=${entry.attempts} reason=goal-changed`);
        return;
      }
      // Unknown outcome: never resubmitted; the Goal notification or the next read shows it.
      this.deps.log(`[usage-resume] unconfirmed threadId=${threadId} attempt=${entry.attempts}`);
      return;
    }
    if (this.entries.get(threadId) === entry) entry.limited = false;
    this.deps.log(`[usage-resume] resumed threadId=${threadId} attempt=${entry.attempts}`);
    try { await this.deps.resumed(threadId); } catch { /* Inputs are still offered on their own schedule. */ }
  }
}
