import type { GoalAutoResumeState } from '../../src/lib/codex/goal-auto-resume';
import type { ThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import type { AppServerNotification } from '../../src/lib/codex/protocol';
import { CAPACITY_RETRY_PENDING, GOAL_NOTICE_STATUSES, type GoalAssigner, type GoalNotice, type GoalNoticeReason,
  type GoalNoticeStatus } from './outcomeReturns';

/**
 * Tells the agent that assigned a thread's Goal when that Goal stops (paused,
 * blocked, usage or budget limited), completes, or becomes active again after
 * such a notice.
 *
 * Each Goal's assigner is bound once, the first time the Goal is observed, and
 * later senders to the thread never replace it. A Goal whose assigner cannot
 * be determined gets unrouted notices, recorded but never delivered.
 *
 * A change must stay settled for a short delay before it counts, so a Goal
 * that flips back and forth produces at most one notice per settled state. A
 * block that the automatic capacity resume is about to retry is reported once
 * as pending that resume (`capacity_retry_pending`); its outcome follows as an
 * active notice when the resume works, or as a second blocked notice when it
 * gives up. Notices carry status words, Goal times, native identity and a
 * fixed reason only, and go through the durable outcome-return store and its
 * configured command.
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
  /** The Goal's assigner record, bound on first call and immutable after;
   * null for a thread with no recorded attributed input. */
  bindAssigner(threadId: string, goalCreatedAt: number, turnId: string | null): Promise<GoalAssigner | null>;
  /** The last notice recorded for the thread, or null. */
  lastNotice(threadId: string): Promise<GoalNotice | null>;
  /** Durably queue a notice for delivery to the assigner, or record it unrouted. */
  record(threadId: string, assigner: GoalAssigner, notice: GoalNotice): Promise<void>;
  /** The thread's current native Goal identity and revisions; may throw. */
  readRevision(threadId: string): Promise<{ createdAt: number; revision: ThreadGoalRevision } | null>;
  /** The automatic capacity resume's view of the thread. */
  autoResumeState(threadId: string): GoalAutoResumeState | null;
  /** Startup only: threads with a known sender, most recent first. */
  recentSenderThreads(limit: number): Promise<string[]>;
  /** Startup only: the thread's current Goal, or null when it has none. */
  readGoal(threadId: string): Promise<ObservedGoal | null>;
  log(line: string): void;
  settleMs?: number;
};

/** Whether `current` differs from what the assigner was last told. Active is
 * reported only to correct an earlier stopped notice; a completed Goal stays
 * reported as complete. After a notice that an automatic resume is pending,
 * the same block is reported again once with its final reason. */
export function goalNoticeDue(current: Pick<ObservedGoal, 'status' | 'createdAt'> & { reason?: GoalNoticeReason },
  last: GoalNotice | null): boolean {
  if (current.status === 'active') return !!last && STOPPED.has(last.status);
  if (!last || last.status !== current.status || last.createdAt !== current.createdAt) return true;
  return last.reason === CAPACITY_RETRY_PENDING && current.reason !== undefined &&
    current.reason !== CAPACITY_RETRY_PENDING;
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
type ThreadState = { lastSeen?: GoalNoticeStatus; failedTurns: string[]; pending?: Pending; generation: number;
  /** Creation time of the Goal whose assigner record is known to exist. */
  boundGoal?: number };

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
    if (state.boundGoal !== goal.createdAt) this.bind(threadId, state, goal.createdAt, turnId);
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
        try { goal = await this.deps.readGoal(threadId); } catch {
          // The read's own error text may carry runtime detail; only the id is logged.
          this.deps.log(`[goal-notices] reconcile skipped threadId=${threadId} reason=goal-read-unavailable`);
          continue;
        }
        // A live notification since startup is newer than this read.
        if (!goal || this.stopped || this.threads.has(threadId)) continue;
        try { await this.serialize(() => this.decide(threadId, goal, { reason: 'unknown' }, null)); }
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

  /** Bind the Goal's assigner when it is first observed, in the turn that
   * shows it, before any later decision about that Goal. */
  private bind(threadId: string, state: ThreadState, goalCreatedAt: number, turnId: string | null): void {
    void this.serialize(async () => {
      if (this.stopped || state.boundGoal === goalCreatedAt) return;
      if (await this.deps.bindAssigner(threadId, goalCreatedAt, turnId)) state.boundGoal = goalCreatedAt;
    }).catch(error => this.deps.log(`[goal-notices] failed threadId=${threadId} error=${String(error)}`));
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
    if (autoResume?.state === 'scheduled' || (autoResume?.state === 'waiting' && pending.waitingChecks < 1)) {
      // The automatic resume acts first. Report the block once as pending
      // that resume, then look again after its attempt settles.
      const current = () => state.generation === generation && state.pending === pending;
      await this.decide(threadId, goal, { reason: CAPACITY_RETRY_PENDING, from: pending.from }, turnId, current);
      if (this.stopped || !current()) return;
      if (autoResume.state === 'scheduled') {
        this.arm(threadId, state, Math.max(0, autoResume.retryAt - this.deps.now()) + this.settleMs);
      } else {
        // Between scheduling and an attempt's result; give it one more delay.
        pending.waitingChecks += 1;
        this.arm(threadId, state, this.settleMs);
      }
      return;
    }
    state.pending = undefined;
    const reason = goalChangeReason(goal.status, turnId, !!turnId && state.failedTurns.includes(turnId), autoResume);
    await this.decide(threadId, goal, { reason, from: pending.from }, turnId, () => state.generation === generation);
  }

  private async decide(threadId: string, goal: ObservedGoal, cause: { reason: GoalNoticeReason;
    from?: GoalNoticeStatus }, turnId: string | null, current: () => boolean = () => true): Promise<void> {
    const assigner = await this.deps.bindAssigner(threadId, goal.createdAt, turnId);
    if (!assigner || this.stopped || !current()) return;
    const due = goalNoticeDue({ ...goal, reason: cause.reason }, await this.deps.lastNotice(threadId));
    if (!due || this.stopped || !current()) return;
    const notice: GoalNotice = { status: goal.status, reason: cause.reason, createdAt: goal.createdAt,
      updatedAt: goal.updatedAt, ...(cause.from && cause.from !== goal.status && { previousStatus: cause.from }),
      ...await this.identity(threadId, goal) };
    if (this.stopped || !current()) return;
    await this.deps.record(threadId, assigner, notice);
    this.deps.log('unrouted' in assigner
      ? `[goal-notices] unrouted threadId=${threadId} status=${goal.status} reason=${assigner.unrouted}`
      : `[goal-notices] queued threadId=${threadId} status=${goal.status} reason=${cause.reason}`);
  }

  /** The native Goal identity and revisions, only when the read shows this
   * same Goal (creation time) in this same status. */
  private async identity(threadId: string, goal: ObservedGoal):
    Promise<Pick<GoalNotice, 'goalId' | 'missionRevision' | 'lifecycleRevision'>> {
    try {
      const read = await this.deps.readRevision(threadId);
      if (!read || read.createdAt !== goal.createdAt || read.revision.status !== goal.status) return {};
      const { goalId, missionRevision, lifecycleRevision } = read.revision;
      return { goalId, missionRevision, lifecycleRevision };
    } catch {
      // An old runtime or an unavailable read: the notice goes without them.
      return {};
    }
  }

  /** One decision at a time, so two changes never both see "no earlier notice". */
  private serialize(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
