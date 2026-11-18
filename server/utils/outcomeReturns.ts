import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { getInterpreterAppDataDir } from '../configStore';
import { parseSubmissionSender, SUBMISSION_ID, type SubmissionSender } from './nativeSubmissionJournal';

export type OutcomeReturnStatus = 'watching' | 'pending' | 'delivered' | 'failed';
export type TurnOutcome = 'completed' | 'failed' | 'interrupted';
export type OutcomeReturn = {
  /** Always absent on turn outcomes, which keeps the stored format unchanged. */
  kind?: undefined;
  id: string;
  threadId: string;
  turnId: string;
  sender: SubmissionSender;
  clientUserMessageId: string;
  status: OutcomeReturnStatus;
  outcome?: TurnOutcome;
  summary?: string;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};
export type GoalNoticeStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
/** Fixed vocabulary for why a Goal changed; never free text. */
export type GoalNoticeReason = 'turn_error' | 'model_capacity_exhausted' | 'usage_limit' | 'budget_limit' |
  'changed_during_turn' | 'changed_outside_turn' | 'unknown';
/** A Goal status change reported to the thread's most recent sender. Status
 * words, timestamps and a reason only: never the objective or message text. */
export type GoalNotice = {
  status: GoalNoticeStatus;
  previousStatus?: GoalNoticeStatus;
  reason: GoalNoticeReason;
  /** The native Goal's creation and update times; they identify the Goal and this change. */
  createdAt: number;
  updatedAt: number;
};
/** A stored Goal notice, delivered by the same command as turn outcomes. */
export type GoalNoticeReturn = {
  kind: 'goal';
  id: string;
  threadId: string;
  sender: SubmissionSender;
  goal: GoalNotice;
  status: Exclude<OutcomeReturnStatus, 'watching'>;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};
type StoredEntry = OutcomeReturn | GoalNoticeReturn;
/** What the visibility route exposes: never the summary text. */
export type OutcomeReturnView = Pick<OutcomeReturn, 'id' | 'threadId' | 'turnId' | 'sender' | 'status' |
  'outcome' | 'attempts' | 'nextAttemptAt' | 'updatedAt'> |
  Pick<GoalNoticeReturn, 'kind' | 'id' | 'threadId' | 'sender' | 'goal' | 'status' | 'attempts' |
    'nextAttemptAt' | 'updatedAt'>;
/** The single JSON object written to the configured command's standard input. */
export type OutcomeReturnPayload = {
  version: 1;
  kind: 'turn';
  id: string;
  to: SubmissionSender;
  from: { threadId: string; turnId: string };
  clientUserMessageId: string;
  outcome: TurnOutcome;
  summary: string;
} | {
  version: 1;
  kind: 'goal';
  id: string;
  to: SubmissionSender;
  from: { threadId: string };
  goal: GoalNotice;
  /** A fixed-template sentence built from the fields above, for receivers
   * that deliver an unknown kind as a plain message. */
  summary: string;
};

export const OUTCOME_SUMMARY_LIMIT = 3000;
export const OUTCOME_RETURN_LIMIT = 500;
export const OUTCOME_MAX_ATTEMPTS = 40;
const COMMAND_TIMEOUT_MS = 120_000;
const TICK_MS = 5_000;
const RECONCILE_TIMEOUT_MS = 10_000;
const RECENTLY_ENDED_LIMIT = 64;
const STATUSES: OutcomeReturnStatus[] = ['watching', 'pending', 'delivered', 'failed'];
const OUTCOMES: TurnOutcome[] = ['completed', 'failed', 'interrupted'];
export const GOAL_NOTICE_STATUSES: readonly GoalNoticeStatus[] =
  ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'];
const GOAL_NOTICE_REASONS: readonly GoalNoticeReason[] = ['turn_error', 'model_capacity_exhausted', 'usage_limit',
  'budget_limit', 'changed_during_turn', 'changed_outside_turn', 'unknown'];

export function outcomeReturnId(threadId: string, turnId: string): string {
  return createHash('sha256').update(`${threadId}:${turnId}`).digest('hex');
}

/** Stable delivery ID of one Goal change: the thread, the Goal (its creation
 * time), the new status and the Goal's update time of that change. */
export function goalNoticeId(threadId: string, goal: Pick<GoalNotice, 'status' | 'createdAt' | 'updatedAt'>): string {
  return createHash('sha256').update(`goal:${threadId}:${goal.createdAt}:${goal.status}:${goal.updatedAt}`)
    .digest('hex');
}

const GOAL_STATUS_WORDS: Record<GoalNoticeStatus, string> = { active: 'active again', paused: 'paused',
  blocked: 'blocked', usageLimited: 'stopped by a usage limit', budgetLimited: 'stopped by its token budget',
  complete: 'complete' };

/** The plain sentence a receiver can deliver for a Goal notice. Built only
 * from status words and IDs. */
export function goalNoticeSummary(threadId: string, goal: GoalNotice): string {
  const previous = goal.previousStatus ? `, previously ${goal.previousStatus}` : '';
  return `Goal on thread ${threadId} is ${GOAL_STATUS_WORDS[goal.status]} (status ${goal.status}${previous}; ` +
    `reason ${goal.reason}).`;
}

function validGoalNotice(value: unknown): value is GoalNotice {
  const goal = value as GoalNotice;
  return !!goal && typeof goal === 'object' && GOAL_NOTICE_STATUSES.includes(goal.status) &&
    (goal.previousStatus === undefined || GOAL_NOTICE_STATUSES.includes(goal.previousStatus)) &&
    GOAL_NOTICE_REASONS.includes(goal.reason) && Number.isFinite(goal.createdAt) &&
    Number.isFinite(goal.updatedAt) &&
    Object.keys(goal).every(key => ['status', 'previousStatus', 'reason', 'createdAt', 'updatedAt'].includes(key));
}

/** Prefix of the client message ID under which a return command delivers an
 * outcome or a Goal notice to the sender's thread (`outcome-<id>`). */
export const OUTCOME_DELIVERY_ID_PREFIX = 'outcome-';

/**
 * True when a submission is itself the delivery of an outcome or Goal notice.
 * Such a turn is never watched and never makes its sender the thread's
 * sender: returning the outcome of an outcome would make two idle threads
 * answer each other without end.
 */
export function isOutcomeDelivery(clientUserMessageId: string): boolean {
  return clientUserMessageId.startsWith(OUTCOME_DELIVERY_ID_PREFIX);
}

/** A JSON array of non-empty argv strings (no shell), or null when unusable. */
export function parseOutcomeReturnCommand(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  try {
    const argv = JSON.parse(raw) as unknown;
    return Array.isArray(argv) && argv.length > 0 &&
      argv.every(part => typeof part === 'string' && part.length > 0) ? argv as string[] : null;
  } catch { return null; }
}

/** Delay before the next attempt after `attempts` failed deliveries. */
export function outcomeRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

export function truncateOutcomeSummary(text: string): string {
  if (text.length <= OUTCOME_SUMMARY_LIMIT) return text;
  const cut = text.slice(0, OUTCOME_SUMMARY_LIMIT);
  // Never end on half of a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export type OutcomeReturnsOptions = {
  /** Directory holding `outcome-returns.json`; defaults to the app data dir. */
  root?: string;
  /** Raw `WORKSTATION_OUTCOME_RETURN_COMMAND` value. */
  command: string | undefined;
  now?: () => number;
  /** One cheap read of whether a watched turn already ended (startup only). */
  readTurn?: (threadId: string, turnId: string) =>
    Promise<{ outcome: TurnOutcome; summary: string } | null>;
  commandTimeoutMs?: number;
};

function validEntry(value: unknown): value is StoredEntry {
  if (value && typeof value === 'object' && (value as GoalNoticeReturn).kind === 'goal') {
    const entry = value as GoalNoticeReturn;
    return typeof entry.threadId === 'string' && validGoalNotice(entry.goal) &&
      entry.id === goalNoticeId(entry.threadId, entry.goal) && !!parseSubmissionSender(entry.sender) &&
      STATUSES.includes(entry.status) && entry.status !== ('watching' as OutcomeReturnStatus) &&
      Number.isInteger(entry.attempts) && entry.attempts >= 0 &&
      (entry.nextAttemptAt === undefined || typeof entry.nextAttemptAt === 'string') &&
      typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string';
  }
  const entry = value as OutcomeReturn & { kind?: unknown };
  return !!entry && typeof entry === 'object' && entry.kind === undefined && /^[0-9a-f]{64}$/.test(entry.id) &&
    typeof entry.threadId === 'string' && typeof entry.turnId === 'string' &&
    entry.id === outcomeReturnId(entry.threadId, entry.turnId) &&
    !!parseSubmissionSender(entry.sender) && typeof entry.clientUserMessageId === 'string' &&
    SUBMISSION_ID.test(entry.clientUserMessageId) && STATUSES.includes(entry.status) &&
    (entry.outcome === undefined || OUTCOMES.includes(entry.outcome)) &&
    (entry.summary === undefined || typeof entry.summary === 'string') &&
    Number.isInteger(entry.attempts) && entry.attempts >= 0 &&
    (entry.nextAttemptAt === undefined || typeof entry.nextAttemptAt === 'string') &&
    typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string';
}

/**
 * Durable record of sender-attributed turns whose outcome is returned to the
 * sending host by a configured command, and of Goal notices sent to a thread's
 * most recent sender through the same command. One private file, atomically replaced
 * (temp file, fsync, rename, directory fsync) under a serialised write chain.
 * Delivery is at-least-once: a restart during a running command retries it,
 * so receivers must deduplicate on `id`.
 */
export class OutcomeReturns {
  private entries: StoredEntry[] = [];
  private chain = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private delivering?: Promise<void>;
  private child?: ChildProcess;
  private stopping = false;
  private refusalLogged = false;
  /** Turns that ended before their watch was recorded (in-memory, bounded). */
  private readonly recentlyEnded = new Map<string, { outcome: TurnOutcome; summary: string }>();
  private readonly file: string;
  private readonly argv: string[] | null;
  private readonly now: () => number;
  private readonly commandTimeoutMs: number;

  constructor(private readonly options: OutcomeReturnsOptions) {
    this.file = path.join(options.root ?? getInterpreterAppDataDir(), 'outcome-returns.json');
    this.argv = parseOutcomeReturnCommand(options.command);
    this.now = options.now ?? Date.now;
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  }

  /** Load durable state, reconcile watched turns once, and start delivery. */
  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { version?: unknown; entries?: unknown };
      if (raw.version !== 1 || !Array.isArray(raw.entries) || !raw.entries.every(validEntry)) {
        throw new Error('Invalid outcome return state');
      }
      this.entries = raw.entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!this.argv) {
      if (this.options.command?.trim()) {
        console.error('[Outcome returns] WORKSTATION_OUTCOME_RETURN_COMMAND is not a JSON array of strings; outcomes stay pending.');
      } else {
        console.info('[Outcome returns] No return command configured; outcomes stay pending.');
      }
    }
    await this.reconcileWatching();
    this.timer = setInterval(() => { void this.deliverDue().catch(console.error); }, TICK_MS);
    this.timer.unref?.();
  }

  /** Stop the timer and any running command; a stopped attempt stays pending. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.child?.kill('SIGKILL');
    await this.delivering;
    await this.chain;
  }

  /** Record a sender-attributed turn. Idempotent; false when the store is full. */
  async watch(threadId: string, turnId: string, sender: SubmissionSender,
    clientUserMessageId: string): Promise<boolean> {
    const checked = parseSubmissionSender(sender);
    if (!checked || !SUBMISSION_ID.test(clientUserMessageId)) throw new Error('Invalid outcome return');
    if (isOutcomeDelivery(clientUserMessageId)) return true;
    const id = outcomeReturnId(threadId, turnId);
    return this.exclusive(async () => {
      if (this.entries.some(entry => entry.id === id)) return true;
      if (!this.makeRoom()) return false;
      const at = new Date(this.now()).toISOString();
      const entry: OutcomeReturn = { id, threadId, turnId, sender: checked, clientUserMessageId,
        status: 'watching', attempts: 0, createdAt: at, updatedAt: at };
      const ended = this.recentlyEnded.get(id);
      if (ended) {
        this.recentlyEnded.delete(id);
        Object.assign(entry, { status: 'pending', outcome: ended.outcome,
          summary: truncateOutcomeSummary(ended.summary), nextAttemptAt: at });
      }
      this.entries.push(entry);
      await this.save();
      return true;
    });
  }

  /** Mark a watched turn as ended; unknown turns are only remembered briefly
   * in memory in case their watch is recorded just after the turn ends. */
  async turnEnded(threadId: string, turnId: string, outcome: TurnOutcome, summary: string): Promise<void> {
    const id = outcomeReturnId(threadId, turnId);
    await this.exclusive(async () => {
      const entry = this.entries.find(item => item.id === id);
      if (!entry) {
        this.recentlyEnded.set(id, { outcome, summary: truncateOutcomeSummary(summary) });
        if (this.recentlyEnded.size > RECENTLY_ENDED_LIMIT) {
          this.recentlyEnded.delete(this.recentlyEnded.keys().next().value!);
        }
        return;
      }
      if (entry.status !== 'watching') return;
      const at = new Date(this.now()).toISOString();
      Object.assign(entry, { status: 'pending', outcome, summary: truncateOutcomeSummary(summary),
        nextAttemptAt: at, updatedAt: at });
      await this.save();
    });
  }

  /** The sender of the most recently recorded attributed turn on a thread.
   * Deliveries of outcomes and Goal notices are never recorded, so they never
   * count as a sender. */
  latestSender(threadId: string): SubmissionSender | null {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!;
      if (entry.kind === undefined && entry.threadId === threadId) return { ...entry.sender };
    }
    return null;
  }

  /** Threads with a recorded sender, most recently attributed first. */
  recentSenderThreads(limit: number): string[] {
    const threads: string[] = [];
    for (let index = this.entries.length - 1; index >= 0 && threads.length < limit; index--) {
      const entry = this.entries[index]!;
      if (entry.kind === undefined && !threads.includes(entry.threadId)) threads.push(entry.threadId);
    }
    return threads;
  }

  /** The last Goal notice recorded for a thread, delivered or not. */
  lastGoalNotice(threadId: string): GoalNotice | null {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!;
      if (entry.kind === 'goal' && entry.threadId === threadId) return { ...entry.goal };
    }
    return null;
  }

  /** Record a Goal notice as pending delivery. Idempotent on its ID; false
   * when the store is full of undelivered entries. */
  async noticeGoal(threadId: string, sender: SubmissionSender, goal: GoalNotice): Promise<boolean> {
    const checked = parseSubmissionSender(sender);
    if (!checked || !validGoalNotice(goal)) throw new Error('Invalid Goal notice');
    const id = goalNoticeId(threadId, goal);
    return this.exclusive(async () => {
      if (this.entries.some(entry => entry.id === id)) return true;
      if (!this.makeRoom()) return false;
      const at = new Date(this.now()).toISOString();
      this.entries.push({ kind: 'goal', id, threadId, sender: checked, goal: { ...goal }, status: 'pending',
        attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at });
      await this.save();
      return true;
    });
  }

  list(): OutcomeReturnView[] {
    return this.entries.map(entry => {
      const { id, threadId, sender, status, attempts, nextAttemptAt, updatedAt } = entry;
      return entry.kind === 'goal'
        ? { kind: 'goal' as const, id, threadId, sender: { ...sender }, goal: { ...entry.goal },
          status: entry.status, attempts, nextAttemptAt, updatedAt }
        : { id, threadId, turnId: entry.turnId, sender: { ...sender }, status, outcome: entry.outcome, attempts,
          nextAttemptAt, updatedAt };
    });
  }

  /** Drop the oldest delivered or failed entry while the store is full. */
  private makeRoom(): boolean {
    while (this.entries.length >= OUTCOME_RETURN_LIMIT) {
      const index = this.entries.findIndex(entry => entry.status === 'delivered' || entry.status === 'failed');
      if (index < 0) {
        if (!this.refusalLogged) {
          console.error('[Outcome returns] Store is full of undelivered outcomes; new outcomes are not recorded.');
          this.refusalLogged = true;
        }
        return false;
      }
      this.entries.splice(index, 1);
    }
    return true;
  }

  /** One delivery pass over due pending entries (the timer tick). */
  deliverDue(): Promise<void> {
    this.delivering ??= this.deliverPass().finally(() => { this.delivering = undefined; });
    return this.delivering;
  }

  private async deliverPass(): Promise<void> {
    const argv = this.argv;
    if (!argv || this.stopping) return;
    const due = this.entries.filter(entry => entry.status === 'pending' &&
      (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= this.now())).map(entry => entry.id);
    for (const id of due) {
      if (this.stopping) return;
      const entry = this.entries.find(item => item.id === id);
      if (!entry || entry.status !== 'pending') continue;
      const payload: OutcomeReturnPayload = entry.kind === 'goal'
        ? { version: 1, kind: 'goal', id: entry.id, to: { ...entry.sender }, from: { threadId: entry.threadId },
          goal: { ...entry.goal }, summary: goalNoticeSummary(entry.threadId, entry.goal) }
        : { version: 1, kind: 'turn', id: entry.id, to: { ...entry.sender },
          from: { threadId: entry.threadId, turnId: entry.turnId },
          clientUserMessageId: entry.clientUserMessageId, outcome: entry.outcome ?? 'failed',
          summary: entry.summary ?? '' };
      const delivered = await this.run(argv, payload);
      if (this.stopping && !delivered) return;
      await this.exclusive(async () => {
        const current = this.entries.find(item => item.id === id);
        if (!current || current.status !== 'pending') return;
        const now = this.now();
        current.updatedAt = new Date(now).toISOString();
        if (delivered) {
          current.status = 'delivered';
          if (current.kind === undefined) delete current.summary;
          delete current.nextAttemptAt;
        } else {
          current.attempts += 1;
          if (current.attempts >= OUTCOME_MAX_ATTEMPTS) {
            current.status = 'failed';
            delete current.nextAttemptAt;
          } else {
            current.nextAttemptAt = new Date(now + outcomeRetryDelayMs(current.attempts)).toISOString();
          }
        }
        await this.save();
      });
    }
  }

  private run(argv: string[], payload: OutcomeReturnPayload): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.child = undefined;
        resolve(ok);
      };
      let child: ChildProcess;
      try { child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] }); }
      catch { done(false); return; }
      this.child = child;
      timer = setTimeout(() => { child.kill('SIGKILL'); done(false); }, this.commandTimeoutMs);
      child.on('error', () => done(false));
      child.on('close', code => done(code === 0));
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(JSON.stringify(payload));
    });
  }

  private async reconcileWatching(): Promise<void> {
    const readTurn = this.options.readTurn;
    if (!readTurn) return;
    const watching = this.entries.filter((entry): entry is OutcomeReturn => entry.status === 'watching');
    await Promise.all(watching.map(async entry => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ended = await Promise.race([
          readTurn(entry.threadId, entry.turnId),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), RECONCILE_TIMEOUT_MS); }),
        ]);
        if (ended) await this.turnEnded(entry.threadId, entry.turnId, ended.outcome, ended.summary);
      } catch {
        // The turn may still end; its live notification remains authoritative.
      } finally { if (timer) clearTimeout(timer); }
    }));
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, entries: this.entries })); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, this.file);
    const directory = await open(path.dirname(this.file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}
