import type { GoalAutoResumeState } from '../../src/lib/codex/goal-auto-resume';
import type { AppServerNotification } from '../../src/lib/codex/protocol';
import type { SubmissionSender } from './nativeSubmissionJournal';
import { GOAL_NOTICE_STATUSES, type GoalNotice, type GoalNoticeReason, type GoalNoticeStatus } from './outcomeReturns';

/**
 * Tells the agent that last handed work to a thread when that thread's Goal
 * stops (paused, blocked, usage or budget limited), completes, or becomes
 * active again after such a notice.
 *
 * A change must stay settled for a short delay before it counts, so a Goal
 * that flips back and forth produces at most one notice per settled state. A
 * block that the automatic capacity resume is about to reverse is not
 * reported; it is reported once that resume gives up. Notices carry status
 * words, Goal times and a fixed reason only, and go through the durable
 * outcome-return store and its configured command.
 */

export const GOAL_NOTICE_SETTLE_MS = 25_000;
/** Startup reconciliation reads at most this many recently attributed threads. */
export const GOAL_NOTICE_RECONCILE_LIMIT = 50;
const RECONCILE_CONCURRENCY = 5;
const TRACKED_THREAD_LIMIT = 1_000;
const FAILED_TURNS_KEPT = 4;
const STOPPED: ReadonlySet<GoalNoticeStatus> = new Set(['paused', 'blocked', 'usageLimited', 'budgetLimited']);

/** The native Goal fields a notice uses. */
export type ObservedGoal = { status: GoalNoticeStatus; createdAt: number; updatedAt: number };

export type GoalNoticesDeps = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** Sender of the most recent attributed work on the thread, or null. */
  latestSender(threadId: string): Promise<SubmissionSender | null>;
  /** The last notice recorded for the thread, or null. */
  lastNotice(threadId: string): Promise<GoalNotice | null>;
  /** Durably queue a notice for delivery. */
  record(threadId: string, sender: SubmissionSender, notice: GoalNotice): Promise<void>;
  /** The automatic capacity resume's view of the thread. */
  autoResumeState(threadId: string): GoalAutoResumeState | null;
  /** Startup only: threads with a known sender, most recent first. */
  recentSenderThreads(limit: number): Promise<string[]>;
  /** Startup only: the thread's current Goal, or null when it has none. */
  readGoal(threadId: string): Promise<ObservedGoal | null>;
  log(line: string): void;
  settleMs?: number;
};

/** Whether `current` differs from what the sender was last told. Active is
 * reported only to correct an earlier stopped notice; a completed Goal stays
 * reported as complete. */
export function goalNoticeDue(current: Pick<ObservedGoal, 'status' | 'createdAt'>, last: GoalNotice | null): boolean {
  if (current.status === 'active') return !!last && STOPPED.has(last.status);
  return !last || last.status !== current.status || last.createdAt !== current.createdAt;
}

/** The fixed-vocabulary cause of a change, from what the notifications show. */
export function goalChangeReason(status: GoalNoticeStatus, turnId: string | null, turnFailed: boolean,
  autoResume: GoalAutoResumeState | null): GoalNoticeReason {
  if (status === 'usageLimited') return 'usage_limit';
  if (status === 'budgetLimited') return 'budget_limit';
  if (status === 'blocked' && turnId && turnFailed) {
    return autoResume?.state === 'exhausted' ? 'model_capacity_exhausted' : 'turn_error';
  }
  return turnId ? 'changed_during_turn' : 'changed_outside_turn';
}

function observedGoal(value: unknown): ObservedGoal | null {
  const goal = value as Partial<ObservedGoal> | null;
  return goal && typeof goal === 'object' && GOAL_NOTICE_STATUSES.includes(goal.status as GoalNoticeStatus) &&
    Number.isFinite(goal.createdAt) && Number.isFinite(goal.updatedAt)
    ? { status: goal.status!, createdAt: goal.createdAt!, updatedAt: goal.updatedAt! } : null;
}

type Pending = {
  goal: ObservedGoal;
  turnId: string | null;
  /** Status seen just before this change began, when known. */
  from?: GoalNoticeStatus;
  timer?: unknown;
  /** Settle checks that found the automatic resume between attempts. */
  waitingChecks: number;
};
type ThreadState = { lastSeen?: GoalNoticeStatus; failedTurns: string[]; pending?: Pending; generation: number };

export class GoalNotices {
  private readonly threads = new Map<string, ThreadState>();
  private chain = Promise.resolve();
  private stopped = false;
  private readonly settleMs: number;

  constructor(private readonly deps: GoalNoticesDeps) {
    this.settleMs = deps.settleMs ?? GOAL_NOTICE_SETTLE_MS;
  }

  handleNotification(notification: AppServerNotification): void {
    if (this.stopped) return;
    const method = notification.method as string;
    const params = notification.params as Record<string, unknown> | undefined;
    const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
    if (!threadId) return;

    if (method === 'turn/completed') {
      const turn = params?.turn as { id?: unknown; status?: unknown } | undefined;
      if (turn?.status !== 'failed' || typeof turn.id !== 'string') return;
      const state = this.state(threadId);
      state.failedTurns = [...state.failedTurns, turn.id].slice(-FAILED_TURNS_KEPT);
      return;
    }

    if (method === 'thread/goal/cleared') {
      // No notice: a cleared Goal has no status to report.
      const state = this.threads.get(threadId);
      if (state) {
        this.cancel(state);
        state.lastSeen = undefined;
      }
      return;
    }

    if (method !== 'thread/goal/updated') return;
    const goal = observedGoal(params?.goal);
    if (!goal) return;
    const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
    const state = this.state(threadId);
    const previous = state.lastSeen;
    state.lastSeen = goal.status;
    if (state.pending) {
      const statusChanged = state.pending.goal.status !== goal.status;
      state.pending.goal = goal;
      // Usage accounting refreshes an unchanged status; only a real change restarts the settle delay.
      if (!statusChanged) return;
      state.pending.from ??= previous;
      state.pending.turnId = turnId;
      state.pending.waitingChecks = 0;
      this.arm(threadId, state, this.settleMs);
      return;
    }
    if (previous === goal.status) return;
    state.pending = { goal, turnId, from: previous, waitingChecks: 0 };
    this.arm(threadId, state, this.settleMs);
  }

  /** Once at startup: report a Goal that stopped, completed or resumed while
   * this server was not running and was never reported. */
  async reconcile(): Promise<void> {
    const threads = await this.deps.recentSenderThreads(GOAL_NOTICE_RECONCILE_LIMIT);
    let next = 0;
    const worker = async () => {
      while (!this.stopped && next < threads.length) {
        const threadId = threads[next++]!;
        let goal: ObservedGoal | null;
        try { goal = await this.deps.readGoal(threadId); } catch { continue; }
        // A live notification since startup is newer than this read.
        if (!goal || this.stopped || this.threads.has(threadId)) continue;
        try { await this.serialize(() => this.decide(threadId, goal, { reason: 'unknown' })); }
        catch (error) { this.deps.log(`[goal-notices] failed threadId=${threadId} error=${String(error)}`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, threads.length) }, worker));
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.threads.values()) this.cancel(state);
    this.threads.clear();
  }

  private state(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      if (this.threads.size >= TRACKED_THREAD_LIMIT) {
        for (const [id, candidate] of this.threads) {
          if (!candidate.pending) { this.threads.delete(id); break; }
        }
      }
      state = { failedTurns: [], generation: 0 };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private arm(threadId: string, state: ThreadState, delayMs: number): void {
    if (state.pending?.timer !== undefined) this.deps.clearTimer(state.pending.timer);
    const generation = ++state.generation;
    state.pending!.timer = this.deps.setTimer(() => {
      void this.serialize(() => this.settle(threadId, state, generation))
        .catch(error => this.deps.log(`[goal-notices] failed threadId=${threadId} error=${String(error)}`));
    }, delayMs);
  }

  private cancel(state: ThreadState): void {
    state.generation += 1;
    if (state.pending?.timer !== undefined) this.deps.clearTimer(state.pending.timer);
    state.pending = undefined;
  }

  private async settle(threadId: string, state: ThreadState, generation: number): Promise<void> {
    const pending = state.pending;
    if (this.stopped || state.generation !== generation || !pending) return;
    pending.timer = undefined;
    const { goal, turnId } = pending;
    const autoResume = goal.status === 'blocked' ? this.deps.autoResumeState(threadId) : null;
    if (autoResume?.state === 'scheduled') {
      // The automatic resume will act first; look again after its attempt settles.
      this.arm(threadId, state, Math.max(0, autoResume.retryAt - this.deps.now()) + this.settleMs);
      return;
    }
    if (autoResume?.state === 'waiting' && pending.waitingChecks < 1) {
      // Between scheduling and an attempt's result; give it one more delay.
      pending.waitingChecks += 1;
      this.arm(threadId, state, this.settleMs);
      return;
    }
    state.pending = undefined;
    const reason = goalChangeReason(goal.status, turnId, !!turnId && state.failedTurns.includes(turnId), autoResume);
    await this.decide(threadId, goal, { reason, from: pending.from }, () => state.generation === generation);
  }

  private async decide(threadId: string, goal: ObservedGoal, cause: { reason: GoalNoticeReason;
    from?: GoalNoticeStatus }, current: () => boolean = () => true): Promise<void> {
    const sender = await this.deps.latestSender(threadId);
    if (!sender || this.stopped || !current()) return;
    if (!goalNoticeDue(goal, await this.deps.lastNotice(threadId)) || this.stopped || !current()) return;
    const notice: GoalNotice = { status: goal.status, reason: cause.reason, createdAt: goal.createdAt,
      updatedAt: goal.updatedAt, ...(cause.from && cause.from !== goal.status && { previousStatus: cause.from }) };
    await this.deps.record(threadId, sender, notice);
    this.deps.log(`[goal-notices] queued threadId=${threadId} status=${goal.status} reason=${cause.reason}`);
  }

  /** One decision at a time, so two changes never both see "no earlier notice". */
  private serialize(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
