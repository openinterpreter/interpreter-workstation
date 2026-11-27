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
 * The runtime adapter persists only bounded, exact-identity episodes. A
 * pre-CAS intent is recorded before submission; an interrupted submission is
 * terminally unconfirmed, never automatically repeated after restart.
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
  persist?(entries: GoalAutoResumeSnapshot[]): void;
  /** Recheck the saved failed turn, not merely a blocked Goal on a reused thread. */
  verifyFailedTurn?(threadId: string, turnId: string): Promise<boolean>;
  log(line: string): void;
};

export type GoalAutoResumeSnapshot = { threadId: string; turnId: string; expected?: ThreadGoalRevision;
  goalId?: string; observedGoalId?: string; missionRevision?: number; goalCreatedAt?: number;
  preflightChecks?: number; attempts: number; episodeStartedAt: number; retryAt: number;
  phase: 'preflight' | 'scheduled' | 'uncertain' | 'exhausted' };

export type GoalAutoResumeState =
  | { state: 'scheduled'; attempt: number; retryAt: number }
  | { state: 'waiting'; attempt: number }
  | { state: 'exhausted'; reason: string; outcome?: 'unconfirmed'; expected?: ThreadGoalRevision };

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
  goalId?: string;
  missionRevision?: number;
  goalCreatedAt?: number;
  /** Immutable native identity from the block notification, not a later GET. */
  observedGoalId?: string;
  preflight?: boolean;
  preflightChecks?: number;
  sourceTurnId?: string;
  uncertain?: boolean;
  exhaustedReason?: string;
  /** Bumped on every cancellation so in-flight reads/resumes can tell they are stale. */
  generation: number;
};

export class GoalAutoResume {
  private readonly threads = new Map<string, ThreadEntry>();
  private stopped = false;

  constructor(private readonly deps: GoalAutoResumeDeps) {}

  threadIds(): string[] { return [...this.threads.keys()]; }

  snapshot(): GoalAutoResumeSnapshot[] {
    return [...this.threads].flatMap(([threadId, entry]) => entry.sourceTurnId &&
      entry.episodeStartedAt !== null && (entry.retryAt !== undefined || entry.exhaustedReason || entry.preflight)
      ? [{ threadId, turnId: entry.sourceTurnId, expected: entry.expected,
        goalId: entry.goalId, observedGoalId: entry.preflight ? entry.observedGoalId : undefined,
        preflightChecks: entry.preflight ? entry.preflightChecks : undefined,
        missionRevision: entry.missionRevision, goalCreatedAt: entry.goalCreatedAt,
        attempts: entry.attempts,
        episodeStartedAt: entry.episodeStartedAt, retryAt: entry.retryAt ?? this.deps.now(),
        phase: entry.preflight ? 'preflight' as const : entry.uncertain ? 'uncertain' as const :
          entry.exhaustedReason ? 'exhausted' as const : 'scheduled' as const }]
      : []);
  }

  /** Startup only. Never reconstruct a CAS from a Goal status alone. */
  async restore(saved: GoalAutoResumeSnapshot[]): Promise<void> {
    for (const item of saved.slice(0, 500)) {
      // Notifications that arrived while the startup read was pending win.
      if (this.threads.has(item.threadId)) continue;
      if (this.stopped || !item || !/^[0-9a-f-]{36}$/i.test(item.threadId) ||
          typeof item.turnId !== 'string' || (item.phase === 'scheduled' && item.expected?.status !== 'blocked') ||
          (item.phase !== 'preflight' && (typeof item.goalId !== 'string' ||
            !/^[0-9a-f-]{36}$/i.test(item.goalId) || !Number.isSafeInteger(item.missionRevision))) ||
          (item.phase === 'preflight' && (item.expected !== undefined || item.goalId !== undefined ||
            item.missionRevision !== undefined)) ||
          (item.observedGoalId !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item.observedGoalId)) ||
          (item.preflightChecks !== undefined && (!Number.isSafeInteger(item.preflightChecks) ||
            item.preflightChecks < 0 || item.preflightChecks > 100)) ||
          (item.expected && (item.expected.goalId !== item.goalId ||
            item.expected.missionRevision !== item.missionRevision)) ||
          !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > 100 ||
          !Number.isFinite(item.episodeStartedAt) || !Number.isFinite(item.retryAt) ||
          !['preflight', 'scheduled', 'uncertain', 'exhausted'].includes(item.phase)) continue;
      const entry = this.entry(item.threadId);
      entry.attempts = item.attempts;
      entry.episodeStartedAt = item.episodeStartedAt;
      entry.sourceTurnId = item.turnId;
      entry.expected = item.expected;
      entry.goalId = item.goalId ?? item.expected?.goalId;
      entry.missionRevision = item.missionRevision ?? item.expected?.missionRevision;
      entry.retryAt = item.retryAt;
      entry.goalCreatedAt = item.goalCreatedAt;
      if (item.phase === 'preflight') {
        entry.preflight = true;
        entry.observedGoalId = item.observedGoalId;
        entry.preflightChecks = item.preflightChecks ?? 0;
        // An old runtime's second-resolution createdAt cannot identify its
        // Goal. An exact event ID may instead be revalidated after restart.
        if (!item.observedGoalId) {
          entry.exhaustedReason = 'model capacity native Goal identity absent from block notification';
          continue;
        }
        const generation = ++entry.generation;
        await this.resolvePreflight(item.threadId, entry, generation);
        continue;
      }
      if (item.phase !== 'scheduled') {
        entry.exhaustedReason = item.phase === 'uncertain' ? 'model capacity resume outcome unconfirmed' :
          'model capacity retry bound reached';
        entry.uncertain = item.phase === 'uncertain';
        if (item.phase === 'exhausted') {
          // A preceding attempt's revision cannot identify the final failed
          // turn. Recover the terminal notice identity from this turn only.
          entry.expected = undefined;
          const generation = ++entry.generation;
          try {
            const current = await this.deps.readRevision(item.threadId);
            const sameTurn = await this.deps.verifyFailedTurn?.(item.threadId, item.turnId);
            if (!this.stopped && entry.generation === generation &&
                this.threads.get(item.threadId) === entry && current?.status === 'blocked' && sameTurn === true &&
                current.goalId === entry.goalId && current.missionRevision === entry.missionRevision)
              entry.expected = current;
          } catch { /* No unverified identity or retry from a failed native read. */ }
        }
        continue;
      }
      const generation = ++entry.generation;
      try {
        const current = await this.deps.readRevision(item.threadId);
        const same = current && current.goalId === item.expected!.goalId &&
          current.missionRevision === item.expected!.missionRevision &&
          current.lifecycleRevision === item.expected!.lifecycleRevision && current.status === 'blocked';
        const turn = await this.deps.verifyFailedTurn?.(item.threadId, item.turnId);
        if (this.stopped || entry.generation !== generation || this.threads.get(item.threadId) !== entry) continue;
        if (!same || turn !== true || item.retryAt - item.episodeStartedAt > GOAL_AUTO_RESUME_WINDOW_MS) {
          entry.exhaustedReason = 'model capacity retry identity could not be verified after restart';
          continue;
        }
        entry.timer = this.deps.setTimer(() => { void this.fire(item.threadId, entry, generation); },
          Math.max(0, item.retryAt - this.deps.now()));
      } catch {
        entry.exhaustedReason = 'model capacity retry identity unavailable after restart';
      }
    }
    this.persist();
  }

  private persist(): void { this.deps.persist?.(this.snapshot()); }

  state(threadId: string): GoalAutoResumeState | null {
    const entry = this.threads.get(threadId);
    if (!entry) return null;
    // No native Goal ID was observed. Leave ordinary turn-error notice
    // handling in place; do not call it a terminal notice for an unverified
    // Goal or leave its assigner waiting for an identity we cannot obtain.
    if (entry.preflight) return null;
    if (entry.exhaustedReason) return { state: 'exhausted', reason: entry.exhaustedReason,
      ...(entry.uncertain && { outcome: 'unconfirmed' as const }), expected: entry.expected };
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
      const goal = params?.goal as { status?: unknown; createdAt?: unknown } | undefined;
      const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
      this.goalUpdated(threadId, goal?.status, turnId, goal?.createdAt, params?.goalId);
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
      entry.goalId = undefined;
      entry.missionRevision = undefined;
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

  private goalUpdated(threadId: string, status: unknown, turnId: string | null,
    createdAt?: unknown, nativeGoalId?: unknown): void {
    if (status === 'blocked' && turnId) {
      // The runtime attributes its own turn-error block to the failed turn.
      this.cancel(threadId, 'goal blocked again');
      const entry = this.entry(threadId);
      entry.blockedTurnId = turnId;
      entry.goalCreatedAt = typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : undefined;
      entry.observedGoalId = typeof nativeGoalId === 'string' && /^[0-9a-f-]{36}$/i.test(nativeGoalId)
        ? nativeGoalId : undefined;
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
    // Persist the event's immutable Goal ID and turn BEFORE the native read.
    // Without that ID, seconds-resolution createdAt cannot identify a Goal.
    entry.sourceTurnId = failed.turnId;
    entry.preflight = true;
    entry.retryAt = retryAt;
    try { this.persist(); } catch {
      entry.exhaustedReason = 'model capacity preflight custody unavailable';
      this.deps.log(`[goal-auto-resume] not scheduled threadId=${threadId} reason=custody-unavailable`);
      return;
    }
    if (!entry.observedGoalId) {
      entry.exhaustedReason = 'model capacity native Goal identity absent from block notification';
      this.persist();
      this.deps.log(`[goal-auto-resume] not scheduled threadId=${threadId} turnId=${failed.turnId} reason=native-goal-id-absent`);
      return;
    }
    void this.resolvePreflight(threadId, entry, generation);
  }

  private async resolvePreflight(threadId: string, entry: ThreadEntry, generation: number): Promise<void> {
    const turnId = entry.sourceTurnId;
    if (this.stopped || !turnId || !entry.observedGoalId || !entry.preflight ||
        entry.generation !== generation || this.threads.get(threadId) !== entry) return;
    if (entry.episodeStartedAt === null ||
        Math.max(this.deps.now(), entry.retryAt ?? 0) - entry.episodeStartedAt > GOAL_AUTO_RESUME_WINDOW_MS) {
      entry.exhaustedReason = 'model capacity preflight window exhausted';
      this.persist();
      return;
    }
    try {
      const revision = await this.deps.readRevision(threadId);
      if (this.stopped || entry.generation !== generation || this.threads.get(threadId) !== entry) return;
      if (!revision || revision.status !== 'blocked' || revision.goalId !== entry.observedGoalId) {
        entry.exhaustedReason = 'model capacity original Goal no longer blocked';
        this.persist();
        this.deps.log(`[goal-auto-resume] not scheduled threadId=${threadId} turnId=${turnId} reason=goal-not-blocked`);
        return;
      }
      if (entry.goalId && (revision.goalId !== entry.goalId ||
          revision.missionRevision !== entry.missionRevision)) {
        entry.exhaustedReason = 'model capacity Goal identity changed';
        this.persist();
        this.deps.log(`[goal-auto-resume] not scheduled threadId=${threadId} reason=goal-identity-changed`);
        return;
      }
      try {
        if (this.deps.verifyFailedTurn && !await this.deps.verifyFailedTurn(threadId, turnId)) {
          entry.exhaustedReason = 'model capacity failed turn changed';
          this.persist();
          this.deps.log(`[goal-auto-resume] not scheduled threadId=${threadId} reason=failed-turn-changed`);
          return;
        }
      } catch {
        this.retryPreflight(threadId, entry, generation);
        return;
      }
      if (this.stopped || entry.generation !== generation || this.threads.get(threadId) !== entry) return;
      if (entry.episodeStartedAt === null ||
          Math.max(this.deps.now(), entry.retryAt ?? 0) - entry.episodeStartedAt > GOAL_AUTO_RESUME_WINDOW_MS) {
        entry.exhaustedReason = 'model capacity preflight window exhausted';
        this.persist();
        return;
      }
      entry.expected = revision;
      entry.goalId = revision.goalId;
      entry.missionRevision = revision.missionRevision;
      entry.preflight = false;
      entry.preflightChecks = undefined;
      entry.observedGoalId = undefined;
      try { this.persist(); } catch {
        entry.exhaustedReason = 'model capacity retry custody unavailable';
        this.deps.log(`[goal-auto-resume] not scheduled threadId=${threadId} reason=custody-unavailable`);
        return;
      }
      const remainingMs = Math.max(0, (entry.retryAt ?? this.deps.now()) - this.deps.now());
      entry.timer = this.deps.setTimer(() => { void this.fire(threadId, entry, generation); }, remainingMs);
      this.deps.log(`[goal-auto-resume] scheduled threadId=${threadId} turnId=${turnId} attempt=${entry.attempts + 1} retryAt=${new Date(entry.retryAt ?? 0).toISOString()} reason=model-at-capacity`);
    } catch {
      if (entry.generation === generation) this.retryPreflight(threadId, entry, generation);
    }
  }

  private retryPreflight(threadId: string, entry: ThreadEntry, generation: number): void {
    if (this.stopped || entry.exhaustedReason || entry.generation !== generation ||
        this.threads.get(threadId) !== entry) return;
    const checks = (entry.preflightChecks ?? 0) + 1;
    const next = this.deps.now() + Math.min(30_000 * 2 ** Math.min(checks - 1, 5), 15 * MINUTE);
    if (entry.episodeStartedAt === null || next - entry.episodeStartedAt > GOAL_AUTO_RESUME_WINDOW_MS) {
      entry.exhaustedReason = 'model capacity Goal identity unavailable before CAS';
      try { this.persist(); } catch {
        this.deps.log(`[goal-auto-resume] preflight custody unavailable threadId=${threadId}`);
      }
      this.deps.log(`[goal-auto-resume] not scheduled threadId=${threadId} reason=preflight-window-exhausted`);
      return;
    }
    entry.preflightChecks = checks;
    entry.retryAt = next;
    try { this.persist(); } catch {
      entry.exhaustedReason = 'model capacity preflight custody unavailable';
      this.deps.log(`[goal-auto-resume] preflight custody unavailable threadId=${threadId}`);
      return;
    }
    entry.timer = this.deps.setTimer(() => {
      entry.timer = undefined;
      void this.resolvePreflight(threadId, entry, generation);
    }, Math.max(0, next - this.deps.now()));
    this.deps.log(`[goal-auto-resume] preflight retry threadId=${threadId} attempt=${checks} reason=goal-revision-unavailable`);
  }

  private async fire(threadId: string, entry: ThreadEntry, generation: number): Promise<void> {
    entry.timer = undefined;
    const expected = entry.expected;
    if (this.stopped || entry.generation !== generation || !expected) return;
    entry.attempts += 1;
    const attempt = entry.attempts;
    entry.uncertain = true;
    try { this.persist(); } catch {
      entry.exhaustedReason = 'model capacity resume custody unavailable';
      this.deps.log(`[goal-auto-resume] not submitted threadId=${threadId} reason=custody-unavailable`);
      return;
    }
    try {
      await this.deps.resume(threadId, expected);
      this.deps.log(`[goal-auto-resume] resumed threadId=${threadId} attempt=${attempt}`);
    } catch (error) {
      if (error instanceof GoalRevisionConflictError) {
        // The Goal changed after the block (a person resumed, paused, edited
        // or replaced it). Never override that decision.
        this.deps.log(`[goal-auto-resume] skipped threadId=${threadId} attempt=${attempt} reason=goal-changed`);
        if (this.threads.get(threadId) === entry && entry.generation === generation) {
          this.threads.delete(threadId);
          this.persist();
        }
        return;
      }
      // The outcome is unknown. Do not resubmit; a later native Goal
      // notification shows whether the Goal resumed.
      this.deps.log(`[goal-auto-resume] unconfirmed threadId=${threadId} attempt=${attempt}`);
      entry.exhaustedReason = 'model capacity resume outcome unconfirmed';
      this.persist();
    }
  }

  private exhaust(threadId: string, entry: ThreadEntry, turnId: string): void {
    const startedAt = new Date(entry.episodeStartedAt ?? this.deps.now()).toISOString();
    const reason = `model at capacity since ${startedAt}; stopped retrying automatically after ${entry.attempts} attempts`;
    this.cancel(threadId, 'exhausted', false);
    entry.sourceTurnId = turnId;
    entry.exhaustedReason = reason;
    this.persist();
    const generation = entry.generation;
    void this.deps.readRevision(threadId).then(async revision => {
      if (!revision || revision.status !== 'blocked' || revision.goalId !== entry.goalId ||
          revision.missionRevision !== entry.missionRevision ||
          !await this.deps.verifyFailedTurn?.(threadId, turnId)) return;
      if (this.stopped || this.threads.get(threadId) !== entry || entry.generation !== generation) return;
      entry.expected = revision;
      this.persist();
    }).catch(() => this.deps.log(`[goal-auto-resume] terminal identity unavailable threadId=${threadId}`));
    this.deps.log(`[goal-auto-resume] gave up threadId=${threadId} turnId=${turnId} reason="${reason}"`);
  }

  private cancel(threadId: string, why: string, persist = true): void {
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
    entry.sourceTurnId = undefined;
    entry.uncertain = undefined;
    entry.preflight = undefined;
    entry.preflightChecks = undefined;
    entry.observedGoalId = undefined;
    if (!this.stopped && persist) this.persist();
  }

  private forget(threadId: string, why: string): void {
    this.cancel(threadId, why);
    this.threads.delete(threadId);
  }
}
