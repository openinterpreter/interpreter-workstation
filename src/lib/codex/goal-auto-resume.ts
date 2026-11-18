import type { AppServerNotification } from './protocol';
import { GoalRevisionConflictError, type ThreadGoalRevision } from './goal-revision';

/**
 * Automatic resume of a Goal that the native runtime blocked only because the
 * model provider was temporarily out of capacity.
 *
 * The runtime blocks an active Goal after any turn error other than a usage
 * limit, and it does not retry a "model at capacity" refusal itself. Left
 * alone, a short provider capacity dip therefore stops a long-running Goal
 * until someone resumes it by hand. This module observes the native
 * notifications, and when a Goal was blocked by exactly such a failure it
 * resumes that same Goal (native compare-and-set on the observed revision)
 * after a bounded backoff.
 *
 * State is in memory only: after an app restart a Goal left blocked by this
 * class of failure stays blocked until resumed.
 */

const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504, 529]);
const CAPACITY_MESSAGE_RE =
  /\b(?:at capacity|overloaded|experiencing high demand|temporarily unavailable|service unavailable)\b/i;
const HTTP_ERROR_VARIANTS = [
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
] as const;

/**
 * True only for a temporary, provider-side capacity refusal: the model is at
 * capacity or overloaded, or the provider is temporarily unavailable. Usage
 * and quota limits, rate limits, authorization, context length, policy
 * refusals, bad requests and sandbox errors are never transient here, even
 * when their message happens to contain similar words.
 */
export function isTransientCapacityError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { message, codexErrorInfo: info } = error as { message?: unknown; codexErrorInfo?: unknown };
  const capacityMessage = typeof message === 'string' && CAPACITY_MESSAGE_RE.test(message);
  if (info === 'serverOverloaded') return true;
  // The runtime also reports unrelated internal failures with this code, so
  // only its high-demand wording counts.
  if (info === 'internalServerError') return capacityMessage;
  if (info && typeof info === 'object') {
    for (const variant of HTTP_ERROR_VARIANTS) {
      if (variant in info) {
        const status = (info as Record<string, { httpStatusCode?: unknown } | undefined>)[variant]?.httpStatusCode;
        return typeof status === 'number' && TRANSIENT_HTTP_STATUSES.has(status);
      }
    }
    return false;
  }
  if (info === null || info === undefined || info === 'other') return capacityMessage;
  return false;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** Delay before each automatic resume attempt; the last entry repeats. */
export const GOAL_AUTO_RESUME_DELAYS_MS: readonly number[] = [30 * SECOND, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE];
/** Attempts stop once the next one would land later than this after the first capacity block. */
export const GOAL_AUTO_RESUME_WINDOW_MS = 2 * 60 * MINUTE;
/** A turn that ran at least this long counts as progress and restarts the schedule. */
export const GOAL_PROGRESS_TURN_MS = 5 * MINUTE;

export function goalAutoResumeDelayMs(attempt: number): number {
  const index = Math.min(Math.max(0, attempt), GOAL_AUTO_RESUME_DELAYS_MS.length - 1);
  return GOAL_AUTO_RESUME_DELAYS_MS[index]!;
}

export type GoalAutoResumeDeps = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** Exact native Goal identity; throws when the runtime cannot provide it. */
  readRevision(threadId: string): Promise<ThreadGoalRevision | null>;
  /** Native compare-and-set from `expected` (blocked) to active. */
  resume(threadId: string, expected: ThreadGoalRevision): Promise<void>;
  log(line: string): void;
};

export type GoalAutoResumeState =
  | { state: 'scheduled'; attempt: number; retryAt: number }
  | { state: 'waiting'; attempt: number }
  | { state: 'exhausted'; reason: string };

type FailedTurn = { turnId: string; transient: boolean; durationMs: number | null };

type ThreadEntry = {
  /** Resume attempts issued since the episode started. */
  attempts: number;
  /** When the first capacity block of this episode was observed. */
  episodeStartedAt: number | null;
  /** Last failed turn and the turn that the runtime blamed for a block. */
  failedTurn?: FailedTurn;
  blockedTurnId?: string;
  /** Local start times for turns whose completion carries no duration. */
  turnStartedAt?: { turnId: string; at: number };
  timer?: unknown;
  retryAt?: number;
  expected?: ThreadGoalRevision;
  exhaustedReason?: string;
  /** Bumped on every cancellation so in-flight reads/resumes can tell they are stale. */
  generation: number;
};

export class GoalAutoResume {
  private readonly threads = new Map<string, ThreadEntry>();
  private stopped = false;

  constructor(private readonly deps: GoalAutoResumeDeps) {}

  state(threadId: string): GoalAutoResumeState | null {
    const entry = this.threads.get(threadId);
    if (!entry) return null;
    if (entry.exhaustedReason) return { state: 'exhausted', reason: entry.exhaustedReason };
    if (entry.timer !== undefined && entry.retryAt !== undefined) {
      return { state: 'scheduled', attempt: entry.attempts + 1, retryAt: entry.retryAt };
    }
    return entry.episodeStartedAt === null ? null : { state: 'waiting', attempt: entry.attempts };
  }

  /** Cancel every pending resume; later notifications are ignored. */
  stop(): void {
    this.stopped = true;
    for (const [threadId] of this.threads) this.cancel(threadId, 'shutdown');
    this.threads.clear();
  }

  handleNotification(notification: AppServerNotification): void {
    if (this.stopped) return;
    const method = notification.method as string;
    const params = notification.params as Record<string, unknown> | undefined;
    const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
    if (!threadId) return;

    if (method === 'turn/started') {
      const turn = params?.turn as { id?: unknown } | undefined;
      // Any new turn (a message, a wake, or the runtime's own continuation)
      // supersedes a pending automatic resume.
      this.cancel(threadId, 'turn started');
      if (typeof turn?.id === 'string') {
        this.entry(threadId).turnStartedAt = { turnId: turn.id, at: this.deps.now() };
      }
      return;
    }

    if (method === 'turn/completed') {
      const turn = params?.turn as { id?: unknown; status?: unknown; error?: unknown;
        durationMs?: unknown } | undefined;
      if (!turn || typeof turn.id !== 'string') return;
      this.turnCompleted(threadId, turn.id, turn.status, turn.error,
        typeof turn.durationMs === 'number' ? turn.durationMs : null);
      return;
    }

    if (method === 'thread/goal/cleared') {
      this.forget(threadId, 'goal cleared');
      return;
    }

    if (method === 'thread/goal/updated') {
      const goal = params?.goal as { status?: unknown } | undefined;
      const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
      this.goalUpdated(threadId, goal?.status, turnId);
    }
  }

  private entry(threadId: string): ThreadEntry {
    let entry = this.threads.get(threadId);
    if (!entry) {
      entry = { attempts: 0, episodeStartedAt: null, generation: 0 };
      this.threads.set(threadId, entry);
    }
    return entry;
  }

  private turnCompleted(threadId: string, turnId: string, status: unknown, error: unknown,
    durationMs: number | null): void {
    const entry = this.entry(threadId);
    const startedAt = entry.turnStartedAt?.turnId === turnId ? entry.turnStartedAt.at : null;
    entry.turnStartedAt = undefined;
    const ranMs = durationMs ?? (startedAt === null ? null : this.deps.now() - startedAt);
    if (status === 'completed' || (ranMs !== null && ranMs >= GOAL_PROGRESS_TURN_MS)) {
      // A turn that made progress ends the episode: a later capacity block
      // starts again from the shortest delay with a fresh time window.
      entry.attempts = 0;
      entry.episodeStartedAt = null;
      entry.exhaustedReason = undefined;
    }
    if (status !== 'failed') {
      entry.failedTurn = undefined;
      if (entry.episodeStartedAt === null && !entry.exhaustedReason && entry.timer === undefined) {
        this.threads.delete(threadId);
      }
      return;
    }
    entry.failedTurn = { turnId, transient: isTransientCapacityError(error), durationMs: ranMs };
    this.maybeSchedule(threadId);
  }

  private goalUpdated(threadId: string, status: unknown, turnId: string | null): void {
    if (status === 'blocked' && turnId) {
      // The runtime attributes its own turn-error block to the failed turn.
      this.cancel(threadId, 'goal blocked again');
      const entry = this.entry(threadId);
      entry.blockedTurnId = turnId;
      this.maybeSchedule(threadId);
      return;
    }
    if (status === 'active') {
      // Resumed, by this module or anyone else. Keep the episode so an
      // immediate repeat failure continues the backoff instead of restarting.
      this.cancel(threadId, 'goal resumed');
      const entry = this.threads.get(threadId);
      if (entry) {
        entry.blockedTurnId = undefined;
        entry.exhaustedReason = undefined;
      }
      return;
    }
    // Paused, completed, limited, or blocked by a person or tool rather than a turn.
    this.forget(threadId, `goal ${typeof status === 'string' ? status : 'changed'}`);
  }

  private maybeSchedule(threadId: string): void {
    const entry = this.threads.get(threadId);
    const failed = entry?.failedTurn;
    if (!entry || !failed || entry.blockedTurnId !== failed.turnId) return;
    entry.failedTurn = undefined;
    entry.blockedTurnId = undefined;
    if (!failed.transient) return;

    const now = this.deps.now();
    entry.episodeStartedAt ??= now;
    entry.exhaustedReason = undefined;
    const delayMs = goalAutoResumeDelayMs(entry.attempts);
    const retryAt = now + delayMs;
    if (retryAt - entry.episodeStartedAt > GOAL_AUTO_RESUME_WINDOW_MS) {
      this.exhaust(threadId, entry, failed.turnId);
      return;
    }

    const generation = ++entry.generation;
    void this.deps.readRevision(threadId).then(revision => {
      if (this.stopped || entry.generation !== generation || this.threads.get(threadId) !== entry) return;
      if (!revision || revision.status !== 'blocked') {
        this.deps.log(`[goal-auto-resume] not scheduled threadId=${threadId} turnId=${failed.turnId} reason=goal-not-blocked`);
        return;
      }
      entry.expected = revision;
      entry.retryAt = retryAt;
      const remainingMs = Math.max(0, retryAt - this.deps.now());
      entry.timer = this.deps.setTimer(() => { void this.fire(threadId, entry, generation); }, remainingMs);
      this.deps.log(`[goal-auto-resume] scheduled threadId=${threadId} turnId=${failed.turnId} attempt=${entry.attempts + 1} delayMs=${delayMs} retryAt=${new Date(retryAt).toISOString()} reason=model-at-capacity`);
    }, () => {
      if (entry.generation !== generation) return;
      this.deps.log(`[goal-auto-resume] not scheduled threadId=${threadId} turnId=${failed.turnId} reason=goal-revision-unavailable`);
    });
  }

  private async fire(threadId: string, entry: ThreadEntry, generation: number): Promise<void> {
    entry.timer = undefined;
    entry.retryAt = undefined;
    const expected = entry.expected;
    entry.expected = undefined;
    if (this.stopped || entry.generation !== generation || !expected) return;
    entry.attempts += 1;
    const attempt = entry.attempts;
    try {
      await this.deps.resume(threadId, expected);
      this.deps.log(`[goal-auto-resume] resumed threadId=${threadId} attempt=${attempt}`);
    } catch (error) {
      if (error instanceof GoalRevisionConflictError) {
        // The Goal changed after the block (a person resumed, paused, edited
        // or replaced it). Never override that decision.
        this.deps.log(`[goal-auto-resume] skipped threadId=${threadId} attempt=${attempt} reason=goal-changed`);
        if (this.threads.get(threadId) === entry && entry.generation === generation) this.threads.delete(threadId);
        return;
      }
      // The outcome is unknown. Do not resubmit; a later native Goal
      // notification shows whether the Goal resumed.
      this.deps.log(`[goal-auto-resume] unconfirmed threadId=${threadId} attempt=${attempt}`);
    }
  }

  private exhaust(threadId: string, entry: ThreadEntry, turnId: string): void {
    const startedAt = new Date(entry.episodeStartedAt ?? this.deps.now()).toISOString();
    const reason = `model at capacity since ${startedAt}; stopped retrying automatically after ${entry.attempts} attempts`;
    this.cancel(threadId, 'exhausted');
    entry.attempts = 0;
    entry.episodeStartedAt = null;
    entry.exhaustedReason = reason;
    this.deps.log(`[goal-auto-resume] gave up threadId=${threadId} turnId=${turnId} reason="${reason}"`);
  }

  private cancel(threadId: string, why: string): void {
    const entry = this.threads.get(threadId);
    if (!entry) return;
    entry.generation += 1;
    if (entry.timer !== undefined) {
      this.deps.clearTimer(entry.timer);
      this.deps.log(`[goal-auto-resume] cancelled threadId=${threadId} reason="${why}"`);
    }
    entry.timer = undefined;
    entry.retryAt = undefined;
    entry.expected = undefined;
  }

  private forget(threadId: string, why: string): void {
    this.cancel(threadId, why);
    this.threads.delete(threadId);
  }
}
