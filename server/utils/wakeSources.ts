import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { getInterpreterAppDataDir } from '../configStore';
import { nextCivilDaily } from './civilSchedule';
import { parseSubmissionSender, type SubmissionSender } from './nativeSubmissionJournal';
import { isSubagentDirectInputRefusal, SUBAGENT_DIRECT_INPUT_UNSUPPORTED, SubagentDirectInputError }
  from '../../src/lib/codex/subagent-input';

// A wake source belongs to an ordinary conversation. These records only keep
// custody until the native transcript contains the input; they do not track
// completion or outbound delivery. Only sender-attributed programmatic tasks
// have their outcome returned, by the separate store in outcomeReturns.ts.
export type WakeSource = {
  id: string;
  threadId: string;
  kind: 'schedule' | 'command';
  message?: string;
  at?: string;
  everyMs?: number;
  dailyAt?: string;
  timeZone?: string;
  argv?: string[];
  /** Command only: delay between ordinary polls, at least 2 seconds (default 30 seconds). */
  rearmMs?: number;
  status: 'waiting' | 'running' | 'delivered' | 'error' | 'cancelled';
  nextAt?: string;
  error?: string;
  sequence: number;
  /** Persisted admission gate. A running command drains naturally; no child is killed. */
  paused?: boolean;
  /** Command only: the last run emitted events (or reported more), so the
   * source runs again as soon as its last input is admitted. */
  moreAvailable?: boolean;
  /** An operator decision or runtime refusal is not cleared by a later
   * event receipt or restart; reconfiguration requires explicit recovery. */
  stopped?: 'refusal' | 'operator_review';
};
export type WakeSourceDrain = {
  drained: true;
  commandInFlight: false;
  nativeOfferInFlight: false;
  pendingEvents: number;
  offeredEvents: number;
};
export type WakeEvent = {
  threadId: string;
  sourceId: string;
  eventId: string;
  message: string;
  status: 'pending' | 'offered' | 'admitted' | 'held' | 'refused';
  createdAt: string;
  offeredAt?: string;
  turnId?: string;
  nextAttemptAt?: string;
  error?: string;
  /** Safe, durable exception metadata; never stores native/provider content. */
  failure?: { phase: 'preflight' | 'resume' | 'start' | 'steer' | 'persist' | 'inspect';
    name: string; category: 'loaded-environment' | 'timeout' | 'unavailable' | 'unknown';
    code?: string; messageSha256: string };
  /** The host and optional thread that handed this input over. Kept after
   * admission: the outcome of the admitting turn is returned to it. */
  sender?: SubmissionSender;
  /** The admission of a sender-attributed input has been recorded for its outcome return. */
  outcomeWatched?: true;
  /** When the receipt was observed. An admitted input without it was admitted
   * by an earlier release. */
  admittedAt?: string;
  /** The runtime refused direct input to this thread (a sub-agent thread
   * takes work only through its parent). The input was never admitted. */
  refusal?: { code: typeof SUBAGENT_DIRECT_INPUT_UNSUPPORTED; parentThreadId: string | null };
  /** SHA-256 of the message and sender given at ingestion; kept after
   * admission, so a repeat of the ID with other content is recognised. */
  contentSha256?: string;
  /** Automatic re-offers made after native custody proved an offer did not land. */
  offerAttempts?: number;
  /** A sender-attributed input admitted without a known turn: no outcome can be returned for it. */
  outcomeReturn?: 'turn_unknown';
  /** Durable handoff for the input-triggered Goal check, never inferred for older events. */
  goalInputPending?: boolean;
};
/** An accepted offer: the runtime returned a turn for the steer or start and
 * that turn is saved, but the input's receipt is not yet in thread history. */
export const isAcceptedOffer = (event: WakeEvent) => event.status === 'offered' && !!event.turnId;
const isSettledEvent = (event?: WakeEvent) =>
  event?.status === 'admitted' || event?.status === 'held' || event?.status === 'refused';
/** The content-free custody view of one thread input: never its message. */
export function threadInputCustody(event: WakeEvent) {
  return { status: event.status, ...(event.turnId && { turnId: event.turnId }),
    ...(isAcceptedOffer(event) && { accepted: true as const }),
    ...(event.outcomeReturn && { outcomeReturn: event.outcomeReturn }),
    ...(event.refusal && { code: event.refusal.code, parentThreadId: event.refusal.parentThreadId }) };
}
/** An admitted, sender-attributed input, handed to `WakeNative.onAdmitted`. */
export type WakeAdmission = { threadId: string; sourceId: string; eventId: string; turnId: string;
  sender: SubmissionSender };
export type GoalInputAdmission = Pick<WakeEvent, 'threadId' | 'sourceId' | 'eventId' | 'turnId'> &
  { turnId: string };
export type GoalInputIntent = { goalId: string; goalCreatedAt: number; goalUpdatedAt: number;
  missionRevision: number; lifecycleRevision: number;
  /** The stopped status the input found; absent in entries that predate it (blocked). */
  goalStatus?: 'blocked' | 'usageLimited';
  phase: 'reserved' | 'confirmed' | 'bounded' | 'rejected'; resultUpdatedAt?: number };
export type GoalInputLedger = {
  lookup(): Promise<GoalInputIntent | undefined>;
  reserve(intent: Omit<GoalInputIntent, 'phase' | 'resultUpdatedAt'>):
    Promise<'reserved' | 'bounded' | 'duplicate'>;
  confirm(goalId: string, resultUpdatedAt: number): Promise<void>;
  reject(goalId: string): Promise<void>;
};
export class WakeAdmissionFailure extends Error {
  constructor(readonly phase: 'preflight' | 'resume' | 'start', readonly original: unknown) {
    super('Native wake admission failed');
    this.name = 'WakeAdmissionFailure';
  }
}
/** Bounded operator diagnostics; never include native messages or tool input. */
export class HistoricalHoldConflict extends Error {
  constructor(readonly code: 'BUSY' | 'CUSTODY_MISMATCH' | 'CUSTODY_CHANGED' |
    'RECEIPT_EXISTS' | 'INSPECTION_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'HistoricalHoldConflict';
  }
}
export class WakeRecoveryError extends Error {
  constructor(readonly category: 'invalid_request' | 'stale_revision' | 'refused_ambiguous' |
    'native_unavailable') {
    super(category);
    this.name = 'WakeRecoveryError';
  }
}
export class PausedCommandConflictError extends Error {
  constructor() { super('Paused command precondition rejected'); this.name = 'PausedCommandConflictError'; }
}
/** An event ID already holds an input with a different message or sender. */
export class WakeContentConflictError extends Error {
  constructor() { super('Event ID already used for different input'); this.name = 'WakeContentConflictError'; }
}
/** The source was cancelled: it takes no more input until it is saved again. */
export class WakeSourceCancelledError extends Error {
  constructor() { super('Wake source is cancelled'); this.name = 'WakeSourceCancelledError'; }
}
/** The input is held in memory but its write did not complete: retry with the same ID. */
export class WakeUnsavedError extends Error {
  constructor() { super('Wake state could not be saved; retry with the same ID'); this.name = 'WakeUnsavedError'; }
}
function nativeFailure(error: unknown, phase: NonNullable<WakeEvent['failure']>['phase']): NonNullable<WakeEvent['failure']> {
  const original = error instanceof WakeAdmissionFailure ? error.original : error;
  const name = original instanceof Error && /^(?:Error|[A-Za-z]{1,60}Error)$/.test(original.name)
    ? original.name : 'UnknownError';
  const message = original instanceof Error ? original.message : '';
  const category = /loaded thread may only rotate existing shell environment values/i.test(message)
    ? 'loaded-environment' : /timed? ?out|deadline/i.test(message) ? 'timeout'
      : /unavailable|disconnect|connection refused/i.test(message) ? 'unavailable' : 'unknown';
  const rawCode = original && typeof original === 'object' && 'code' in original ? original.code : undefined;
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : undefined;
  const messageSha256 = createHash('sha256').update(message).digest('hex');
  return { phase: error instanceof WakeAdmissionFailure ? error.phase : phase, name, category,
    ...(code ? { code } : {}), messageSha256 };
}
type GoalResumeAttempt = { threadId: string; goalId: string; inputKey: string; at: number } & GoalInputIntent;
type State = { sources: WakeSource[]; events: WakeEvent[]; goalResumeAttempts?: GoalResumeAttempt[] };
const EMPTY: State = { sources: [], events: [] };
type NativeView = Awaited<ReturnType<WakeNative['inspect']>>;
/** What one delivery step means for the later inputs of its thread in this pass:
 * - `ok`: later inputs proceed (admitted, held, refused, accepted and awaiting
 *   its receipt, or a paused source's input returned to pending);
 * - `fence`: nothing more is offered on the thread in this pass, but its later
 *   offered inputs are still reconciled;
 * - `failed`: the thread's history could not be read; the thread waits for a later pass. */
type Delivery = 'ok' | 'fence' | 'failed';
/** Per-thread state of one pass, computed once from all of the thread's
 * inputs when the pass reaches the thread and kept current by its own steps. */
type ThreadPass = {
  /** Lower bound of the history read: the oldest input awaiting admission. */
  since?: string;
  /** The one history read of this thread in this pass, shared by all its inputs. */
  view?: Promise<NativeView>;
  failed?: boolean;
  /** Offers of unknown outcome (offered, no turn saved) on the thread, from
   * any source, paused or not: while one exists no turn is started. */
  unknown: number;
  /** Turns of accepted, unconfirmed offers, with the latest offer time of
   * each: the steer target when history shows no active turn. */
  accepted: Map<string, number>;
  /** Nothing more is offered on the thread in this pass. */
  noOffers: boolean;
};
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const MAX_MESSAGE = 32_000;
const MAX_COMMAND_EVENTS = 16;
// Room for MAX_COMMAND_EVENTS lines at the per-event message bound even when
// the encoder escapes every UTF-16 unit as \uXXXX (6 bytes), plus 1 KiB per
// line for the ID and keys. 16 * (32,000 * 6 + 1,024) = 3,088,384 bytes.
const MAX_STDOUT = MAX_COMMAND_EVENTS * (MAX_MESSAGE * 6 + 1024);
const MIN_INTERVAL = 60_000;
// Leave room for a hyphen and the full decimal safe-integer sequence.
const MAX_SCHEDULE_ID = 143;
const COMMAND_REARM_MS = 30_000;
const MIN_COMMAND_REARM_MS = 2_000;
// Keep persisted delays inside both the JS timer range and Date's future range.
const MAX_COMMAND_REARM_MS = 2_147_483_647;
const commandRearmMs = (source: WakeSource): number =>
  Number.isSafeInteger(source.rearmMs) && source.rearmMs! >= MIN_COMMAND_REARM_MS &&
    source.rearmMs! <= MAX_COMMAND_REARM_MS
    ? source.rearmMs! : COMMAND_REARM_MS;
// A short follow-up pass after a pass that changed something while accepted
// inputs await their receipts, so a burst is not paced by the 2 s interval.
const FOLLOW_UP_MS = 250;
/** An offer must be this old before native custody may prove it did not land. */
const OFFER_PROOF_MS = 60_000;
/** A complete proof must be observed again, in a later pass at least this
 * much later, before the input is offered again. */
const PROOF_CONFIRM_MS = 15_000;
/** Retry of admission hand-overs whose outcome watch is not yet recorded. */
const HAND_OVER_RETRY_MS = 60_000;
/** Automatic re-offers of one input before it needs operator review. */
const MAX_REOFFERS = 3;
const UNCONFIRMED_OFFER = 'Input could not be confirmed; operator review required';
/** History is read back to the oldest unadmitted input, less this margin. */
const INSPECT_MARGIN_MS = 60_000;
const TERMINAL_TURN = ['completed', 'interrupted', 'failed'];
/** In-flight keys: an event and a source never share a key. */
const eventKey = (threadId: string, sourceId: string, eventId: string) =>
  `event:${JSON.stringify([threadId, sourceId, eventId])}`;
const sourceKey = (threadId: string, sourceId: string) => `source:${JSON.stringify([threadId, sourceId])}`;
/** The lower time bound of a history read covering inputs created at or after `createdAt`. */
const inspectSince = (createdAt: string): string | undefined => {
  const at = Date.parse(createdAt);
  return Number.isFinite(at) ? new Date(at - INSPECT_MARGIN_MS).toISOString() : undefined;
};
const contentDigest = (message: string, sender: SubmissionSender | undefined) =>
  createHash('sha256').update(JSON.stringify([message, sender ?? null])).digest('hex');
/** Advertised in the wake-sources listing: command stdout may hold several lines. */
export const WAKE_COMMAND_OUTPUT = 'ndjson' as const;
/** Source of programmatic input addressed to an existing thread. It has no
 * source record; its event IDs are the callers' client message IDs. */
export const THREAD_INPUT_SOURCE = 'thread-input' as const;
/** Longest accepted event message, in UTF-16 code units. */
export const WAKE_MESSAGE_LIMIT = MAX_MESSAGE;
/** True for a valid thread, source or event ID. */
export const isWakeId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
type WakeBatchItem = { id: string; message: string; sender?: SubmissionSender };
type CommandOutput = { waiting: true } | { waiting: false; events: WakeBatchItem[]; more: boolean };
/** Newline-delimited JSON: one `{"status":"waiting"}` line, or 1-16 event
 * lines optionally followed by one `{"status":"more"}` line. Every line is
 * validated before anything is ingested; any violation rejects the run. */
function parseCommandOutput(stdout: string): CommandOutput {
  // The wording must not contain a word the error classifier below treats
  // as a quota or sign-in failure.
  const invalid = () => new Error('Command output must be one JSON wake event per line');
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  // Reject an oversized run before parsing any of it.
  if (!lines.length || lines.length > MAX_COMMAND_EVENTS + 1) throw invalid();
  let values: unknown[];
  try { values = lines.map(line => JSON.parse(line) as unknown); } catch { throw invalid(); }
  if (values.some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw invalid();
  const records = values as Record<string, unknown>[];
  const isStatus = (record: Record<string, unknown>, status: string) =>
    record.status === status && Object.keys(record).length === 1;
  if (records.length === 1 && isStatus(records[0], 'waiting')) return { waiting: true };
  const more = isStatus(records[records.length - 1], 'more');
  const items = more ? records.slice(0, -1) : records;
  if (!items.length || items.length > MAX_COMMAND_EVENTS) throw invalid();
  const ids = new Set<string>();
  const events = items.map(item => {
    // Exactly `id` and `message`: an unknown key is a format error, not ignored.
    if (Object.keys(item).length !== 2 || typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id) ||
        typeof item.message !== 'string' || !item.message.trim() || item.message.length > MAX_MESSAGE) throw invalid();
    ids.add(item.id);
    return { id: item.id, message: item.message };
  });
  return { waiting: false, events, more };
}
const marker = (source: string, id: string) => `[Wake event ${source}/${id}]`;
export const wakeInput = (event: WakeEvent) => `${marker(event.sourceId, event.eventId)}\n${event.message}`;
// Native user-message IDs give a second, machine-readable receipt when a
// steered input is persisted independently of the turn that accepted the RPC.
export const wakeClientId = (event: Pick<WakeEvent, 'threadId' | 'sourceId' | 'eventId'>) =>
  `wake_${createHash('sha256').update(JSON.stringify([event.threadId, event.sourceId, event.eventId])).digest('hex')}`;
const USAGE_LIMIT_ERROR = 'Usage limit reached; operator action required';
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  // A supervising SIGKILL/oversized stdout is not a subscription allowance.
  // Do not classify "Command exited after timeout or output limit" as quota.
  if (error instanceof WakeCommandExit) return error.reason === 'timeout'
    ? 'Wake command timed out before a provider receipt'
    : error.reason === 'output'
      ? 'Wake command exceeded bounded output before a provider receipt'
      : 'Wake command exited nonzero; check local service diagnostics';
  // A full local backlog is not a subscription allowance either.
  if (error instanceof WakeBacklogFull) return error.message;
  if (error instanceof WakeUnsavedError) return 'Wake state could not be saved; retrying';
  if (/usage|quota|credit|billing|limit/.test(message)) return USAGE_LIMIT_ERROR;
  if (/oauth|token|credential|authentication|unauthoriz|login/.test(message)) return 'Authentication unavailable; operator action required';
  if (/overload|capacity|unavailable|timeout|disconnect/.test(message)) return 'Runtime temporarily unavailable';
  if (/command exited/.test(message)) return 'Command exited nonzero or exceeded limits';
  return 'Wake source failed; check local service diagnostics';
}
class WakeCommandExit extends Error {
  constructor(readonly reason: 'timeout' | 'output' | 'exit') { super('Wake command failed'); }
}
class WakeBacklogFull extends Error {
  constructor() { super('Too many inputs await admission on this thread; operator action required'); }
}
/** The runtime's definite refusal of a steer: the inspected turn has ended.
 * It reaches this module as an Error or as a plain JSON-RPC error object. */
function isNoActiveTurnSteer(error: unknown): boolean {
  const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
  return message === 'no active turn to steer';
}
export function wakeTokenValid(actual: string | undefined, supplied: string | undefined): boolean {
  if (!actual || !supplied) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

type LinuxProcessIdentity = { bootId: string; startTicks: string; startedAtMs?: number };
async function linuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | undefined> {
  if (process.platform !== 'linux') return undefined;
  // /proc/<pid>/stat has a parenthesized command which may itself contain spaces.
  const [raw, bootId, uptime] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    readFile('/proc/uptime', 'utf8'),
  ]);
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  const startTicks = fields[19]; // field 22, after pid and comm
  if (!/^\d+$/.test(startTicks) || !/^[0-9a-f-]{36}$/.test(bootId.trim()))
    throw new Error('Process identity unavailable');
  // Only legacy locks need a wall-clock comparison. Minimal Linux desktops
  // without getconf still use exact boot/start identity for all new locks.
  let ticksPerSecond: number | undefined;
  try { ticksPerSecond = Number(execFileSync('/usr/bin/getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 }).trim()); }
  catch { /* Legacy live locks remain conservatively owned. */ }
  const uptimeSeconds = Number(uptime.split(' ')[0]);
  return { bootId: bootId.trim(), startTicks,
    ...(ticksPerSecond && Number.isSafeInteger(ticksPerSecond) && ticksPerSecond > 0 &&
      Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0
      ? { startedAtMs: Date.now() - (uptimeSeconds - Number(startTicks) / ticksPerSecond) * 1000 }
      : {}) };
}

export interface WakeNative {
  /** Native history from `since` (an ISO time) on, or all of it without one:
   * every turn that may have ended at or after `since`, and the active turn. */
  inspect(threadId: string, since?: string): Promise<{ activeTurnId?: string; messages: string[]; clientIds?: string[];
    /** The native turn holding each persisted client message ID. */
    clientTurns?: Array<{ clientId: string; turnId: string }>;
    /** The native turn of each entry of `messages`, in the same order. */
    messageTurnIds?: string[] }>;
  /** `turnStatus` is that of `turnId`, or of the latest turn when it is omitted. */
  custody?(threadId: string, turnId?: string): Promise<{
    turnStatus?: string; queuedSubmissionCount: number;
    lastTurnId?: string | null; threadStatus?: string;
  }>;
  steer(threadId: string, turnId: string, message: string, clientId?: string): Promise<string>;
  start(threadId: string, message: string, clientId?: string): Promise<string>;
  /** Called after the admission of a sender-attributed input is saved. Resolve
   * true once its outcome return is durably recorded; false or a rejection
   * leaves it to be offered again on the retry interval and at the next
   * start. Must be idempotent. */
  onAdmitted?(admission: WakeAdmission): Promise<boolean>;
  /** A confirmed, live native input. Returning or failing never changes its admission. */
  onGoalInput?(admission: GoalInputAdmission,
    ledger: GoalInputLedger): Promise<boolean>;
}

/** One owner per application process; all transitions use an atomic, mode-0600 replace. */
export class WakeSources {
  private state: State = structuredClone(EMPTY);
  private chain = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = new Set<string>();
  private commands = new Map<string, ReturnType<typeof spawn>>();
  private commandTasks = new Set<Promise<void>>();
  private commandTasksBySource = new Map<string, Promise<void>>();
  /** A failed fsync may have followed rename. Do not claim either durable argv
   * version or allow resume until a controlled process reload reads the file. */
  private pausedRetargetUncertain = new Set<string>();
  private ticking = false;
  private stopping = false;
  private tickFinished?: Promise<void>;
  private finishTick?: () => void;
  private queuedTick?: Promise<void>;
  private followUp?: ReturnType<typeof setTimeout>;
  private followUpWanted = false;
  private started = false;
  /** How many follow-up passes have been asked for; observable in tests. */
  followUpsRequested = 0;
  /** Inputs whose last steer was definitely refused; in memory only, and
   * cleared when the input is admitted, held, refused, re-offered or removed. */
  private steerRefusals = new Set<string>();
  /** Per offered input, the pass time at which a complete proof that it did
   * not land was first observed (see resolveUnconfirmedOffer). In memory
   * only: a restart restarts the wait. */
  private proofSeenAt = new Map<string, number>();
  /** Per thread, turns known to have ended: a steer to them was refused as
   * "no active turn", or native custody reported them terminal. In memory
   * only and pruned once no offered input of the thread is bound to them. */
  private endedTurns = new Map<string, Set<string>>();
  /** The running pass made a delivery transition of its own. */
  private passChanged = false;
  private readonly file: string;
  private readonly lock: string;
  private readonly owner = randomUUID();
  /** At most one outstanding native history read per thread, with its window. */
  private readonly nativeInspections = new Map<string, { since?: string; read: ReturnType<WakeNative['inspect']> }>();
  /** Operator operations that read the runtime outside the exclusive section; stop() waits for them. */
  private readonly operations = new Set<Promise<unknown>>();
  private handOverTimer?: ReturnType<typeof setInterval>;
  /** Set just before the owner lock is released: no write may follow. */
  private released = false;
  /** Re-checked after every durable write and finished by stop(); see whenSettled(). */
  private readonly settleWaiters = new Set<{ check: () => void; finish: () => void }>();
  /** The last write failed: memory may hold state that is not on disk. Until a
   * write succeeds, nothing is offered and no ingestion is acknowledged. */
  private unsaved = false;
  /** Writes started and not yet finished: until they finish, memory may hold
   * state that is not on disk, and nothing is acknowledged from memory. */
  private writesInFlight = 0;
  /** Offered inputs whose turn ID is in memory but not yet on disk: they are
   * not reported accepted until a write succeeds. */
  private readonly turnsUnsaved = new Set<WakeEvent>();
  /** Running onAdmitted hand-overs, by thread, source and event. */
  private readonly admissionHandOvers = new Map<string, Promise<void>>();
  private readonly goalInputHandOvers = new Set<string>();

  constructor(private readonly native: WakeNative, root = getInterpreterAppDataDir(),
    private readonly inspectTimeoutMs = 30_000,
    /** Pass timing. An interval of 0 leaves every pass to explicit `tick()` calls.
     * `retryMs` (default one minute; 0 disables) re-offers admission hand-overs
     * whose outcome watch is not yet recorded. */
    private readonly timing: { intervalMs: number; followUpMs: number; retryMs?: number } =
      { intervalMs: 2000, followUpMs: FOLLOW_UP_MS }) {
    if (!Number.isInteger(inspectTimeoutMs) || inspectTimeoutMs < 1 || inspectTimeoutMs > 120_000) {
      throw new Error('Invalid native inspection timeout');
    }
    if (![timing.intervalMs, timing.followUpMs].every(ms => Number.isInteger(ms) && ms >= 0 && ms <= 60_000) ||
        (timing.retryMs !== undefined && (!Number.isInteger(timing.retryMs) || timing.retryMs < 0 ||
          timing.retryMs > 600_000))) {
      throw new Error('Invalid wake pass timing');
    }
    this.file = path.join(root, 'wake-sources.json');
    this.lock = `${this.file}.owner`;
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await this.claimOwner();
    try {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as State;
      if (!Array.isArray(raw.sources) || !Array.isArray(raw.events)) throw new Error('Invalid wake source state');
      if (raw.goalResumeAttempts !== undefined && (!Array.isArray(raw.goalResumeAttempts) ||
          raw.goalResumeAttempts.some(item => !item || typeof item.threadId !== 'string' ||
            typeof item.goalId !== 'string' || typeof item.inputKey !== 'string' ||
            !Number.isSafeInteger(item.at) || item.at < 0 ||
            !['reserved', 'confirmed', 'bounded', 'rejected'].includes(item.phase) ||
            ![item.goalCreatedAt, item.goalUpdatedAt].every(Number.isFinite) ||
            ![item.missionRevision, item.lifecycleRevision].every(value => Number.isSafeInteger(value) && value >= 0) ||
            (item.goalStatus !== undefined && item.goalStatus !== 'blocked' && item.goalStatus !== 'usageLimited') ||
            (item.phase === 'confirmed' && !Number.isFinite(item.resultUpdatedAt))))) {
        throw new Error('Invalid wake Goal resume ledger');
      }
      this.state = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A native receipt is permanent for deduplication, but the original
    // message body is not needed once admitted. Migrate older state as well.
    for (const event of this.state.events) {
      if (event.status === 'admitted') {
        event.message = '';
        delete event.error;
        delete event.failure;
        delete event.offeredAt;
        delete event.nextAttemptAt;
      }
    }
    // Recover an interrupted command without resubmitting its durable IDs.
    // A waiting command can poll for later IDs while older ones are unadmitted.
    for (const source of this.state.sources) {
      if (source.status === 'running') {
        source.status = 'waiting';
        if (!source.paused) source.nextAt = new Date(Date.now() + commandRearmMs(source)).toISOString();
      }
      // Older command sources stopped permanently on a transient source
      // error. Keep the diagnostic visible, but recover on a bounded timer
      // after a restart without creating a second consumer. A source stopped
      // by a runtime refusal or operator review stays stopped.
      if (source.kind === 'command' && source.status === 'error' && !source.nextAt &&
          !source.stopped && !this.state.events.some(event => event.threadId === source.threadId &&
            event.sourceId === source.id && event.status === 'held')) {
        source.nextAt = new Date(Date.now() + 300_000).toISOString();
      }
      if (source.kind === 'schedule' && source.status === 'waiting') {
        // Reconcile state written by an older, two-write schedule transition.
        // A persisted event is authoritative even when its sequence did not
        // make it into the source record before a crash.
        const latest = this.state.events.filter(e => e.threadId === source.threadId &&
          e.sourceId === source.id && e.eventId.startsWith(`${source.id}-`))
          .map(e => ({ event: e, sequence: Number(e.eventId.slice(source.id.length + 1)) }))
          .filter(e => Number.isSafeInteger(e.sequence) && e.sequence > source.sequence)
          .sort((a, b) => b.sequence - a.sequence)[0];
        if (latest) {
          source.sequence = latest.sequence;
          if (latest.event.status !== 'admitted') source.nextAt = undefined;
          else if (source.dailyAt && source.timeZone) source.nextAt = nextCivilDaily(Date.now(), source.timeZone, source.dailyAt);
          else if (source.everyMs) source.nextAt = new Date(Date.now() + source.everyMs).toISOString();
          else { source.status = 'delivered'; source.nextAt = undefined; }
        }
      }
    }
    this.retireEarlierHandOvers();
    await this.save();
    this.started = true;
    if (this.timing.intervalMs) {
      this.timer = setInterval(() => this.backgroundTick(), this.timing.intervalMs);
      this.timer.unref?.();
    }
    // A restart may have fallen between an admission save and its hand-over;
    // a hook that declined or failed is retried on a bounded interval.
    this.retryHandOvers();
    const retryMs = this.timing.retryMs ?? HAND_OVER_RETRY_MS;
    if (retryMs) {
      this.handOverTimer = setInterval(() => this.retryHandOvers(), retryMs);
      this.handOverTimer.unref?.();
    }
    } catch (error) { await this.stop(); throw error; }
  }

  /** Hand over every admitted, sender-attributed input whose outcome watch is
   * not recorded. An input admitted by this release is offered until its
   * watch is recorded, however long that takes. */
  private retryHandOvers(): void {
    if (this.stopping) return;
    for (const event of this.state.events) {
      this.handOverAdmission(event);
      this.handOverGoalInput(event);
    }
  }

  /** Mark admissions that carry no admission time and still await their
   * hand-over as handled, without handing them over. They were admitted by a
   * release that did not record one; their turns ended under that release,
   * and handing them over now would return old outcomes. Called once at
   * start, before the first save. */
  private retireEarlierHandOvers(): void {
    for (const event of this.state.events) {
      if (event.status === 'admitted' && event.sender && event.turnId && !event.outcomeWatched &&
          !event.admittedAt) event.outcomeWatched = true;
    }
  }

  /** Track an operation that reads the runtime outside the exclusive section, so stop() waits for it. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.operations.add(work);
    void work.finally(() => { this.operations.delete(work); }).catch(() => undefined);
    return work;
  }

  /** Forget the in-memory observations about one input once it leaves offered/pending custody. */
  private forgetEvent(event: WakeEvent): void {
    this.steerRefusals.delete(`${event.threadId}:${event.sourceId}:${event.eventId}`);
    this.proofSeenAt.delete(eventKey(event.threadId, event.sourceId, event.eventId));
  }

  /** Settle waiters still open; observable in tests. */
  waiterCount(): number { return this.settleWaiters.size; }

  private async claimOwner(): Promise<void> {
    // Resolve our identity before creating a lock, so an unavailable /proc or
    // getconf never strands a newly created, ownerless lock directory.
    const ownIdentity = await linuxProcessIdentity(process.pid);
    try {
      await mkdir(this.lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A stopped application may leave a stale PID. A recovery lock keeps
      // simultaneous starters from deleting one another's ownership record.
      const recovery = `${this.lock}.recovery`;
      await mkdir(recovery, { mode: 0o700 });
      try {
        const ownerFile = path.join(this.lock, 'owner.json');
        const prior = JSON.parse(await readFile(ownerFile, 'utf8')) as {
          pid: number; owner: string; linuxIdentity?: Pick<LinuxProcessIdentity, 'bootId' | 'startTicks'>
        };
        if (!Number.isInteger(prior.pid) || typeof prior.owner !== 'string') throw new Error('Invalid wake owner');
        let alive = true;
        try { process.kill(prior.pid, 0); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw e; }
        if (alive) {
          // A PID can be recycled across host restarts. Never evict a live
          // matching process; fail closed when the identity cannot be proved.
          const current = await linuxProcessIdentity(prior.pid);
          if (!current || (prior.linuxIdentity
            ? current.bootId === prior.linuxIdentity.bootId && current.startTicks === prior.linuxIdentity.startTicks
            : current.startedAtMs === undefined || current.startedAtMs <= (await stat(ownerFile)).mtimeMs + 60_000)) {
            throw new Error('Another Workstation owns wake dispatch');
          }
        }
        await rm(this.lock, { recursive: true });
        await mkdir(this.lock, { mode: 0o700 });
      } finally { await rm(recovery, { recursive: true, force: true }); }
    }
    const handle = await open(path.join(this.lock, 'owner.json'), 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner,
        ...(ownIdentity && { linuxIdentity: { bootId: ownIdentity.bootId, startTicks: ownIdentity.startTicks } }) }));
      await handle.sync();
    }
    finally { await handle.close(); }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.handOverTimer) clearInterval(this.handOverTimer);
    if (this.followUp) clearTimeout(this.followUp);
    this.followUp = undefined;
    for (const child of this.commands.values()) child.kill('SIGKILL');
    await Promise.allSettled([...this.commandTasks]);
    // Do not release the single-owner lock while an admission RPC, an
    // operator operation or a durable transition is still in flight. A
    // successor must never race this owner.
    await this.tickFinished;
    await Promise.allSettled([...this.operations]);
    await this.chain;
    await Promise.allSettled([...this.admissionHandOvers.values()]);
    await this.chain;
    // Waiting callers get the state each input has at shutdown.
    for (const waiter of [...this.settleWaiters]) waiter.finish();
    this.released = true;
    try {
      const current = JSON.parse(await readFile(path.join(this.lock, 'owner.json'), 'utf8')) as { owner: string };
      if (current.owner === this.owner) await rm(this.lock, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  list(threadId: string): { sources: WakeSource[]; events: WakeEvent[] } {
    return structuredClone({
      sources: this.state.sources.filter(s => s.threadId === threadId),
      events: this.state.events.filter(e => e.threadId === threadId),
    });
  }

  /** The wake-sources listing, with the accepted command output format. */
  view(threadId: string) {
    return { ...this.list(threadId), commandOutput: WAKE_COMMAND_OUTPUT };
  }

  /** A copy of one event, or undefined. */
  find(threadId: string, sourceId: string, eventId: string): WakeEvent | undefined {
    const event = this.state.events.find(e => e.threadId === threadId && e.sourceId === sourceId &&
      e.eventId === eventId);
    return event && this.copy(event);
  }

  /** Threads this queue serves (a live source or an input awaiting
   * admission), each with the number of inputs still pending or offered. */
  threadInputs(): Map<string, number> {
    const threads = new Map<string, number>();
    for (const source of this.state.sources) {
      if (source.status !== 'cancelled' && !threads.has(source.threadId)) threads.set(source.threadId, 0);
    }
    for (const event of this.state.events) {
      if (event.status !== 'pending' && event.status !== 'offered') continue;
      threads.set(event.threadId, (threads.get(event.threadId) ?? 0) + 1);
    }
    return threads;
  }

  /** The thread's Goal became active again after a usage limit: pending
   * inputs that are only waiting out a usage-limit backoff may be offered on
   * the next pass instead of minutes later. Nothing is offered, replayed or
   * removed here; order, receipts and every other backoff are unchanged. */
  async releaseUsageLimitBackoff(threadId: string): Promise<number> {
    if (this.stopping) return 0;
    return this.exclusive(async () => {
      let released = 0;
      for (const event of this.state.events) {
        if (event.threadId !== threadId || event.status !== 'pending' || !event.nextAttemptAt ||
            event.error !== USAGE_LIMIT_ERROR) continue;
        delete event.nextAttemptAt;
        released += 1;
      }
      if (released) await this.save();
      return released;
    });
  }

  /** Nothing in memory differs from disk: no write is outstanding and the last one succeeded. */
  private durable(): boolean { return !this.unsaved && this.writesInFlight === 0; }

  /** A copy of an event for a caller, without a turn ID that is not yet on disk. */
  private copy(event: WakeEvent): WakeEvent {
    const copy = structuredClone(event);
    if (this.turnsUnsaved.has(event)) delete copy.turnId;
    return copy;
  }

  /** Resolve with a copy of the event once it is durably admitted, held or
   * refused, or with its current state at the timeout, the abort or stop();
   * undefined when there is no such event. Waiting never changes the event. */
  whenSettled(threadId: string, sourceId: string, eventId: string, timeoutMs: number,
    signal?: AbortSignal): Promise<WakeEvent | undefined> {
    return this.waitFor(threadId, sourceId, eventId, timeoutMs, signal, isSettledEvent);
  }

  /** Like whenSettled, but also resolves as soon as the event is an accepted
   * offer (the runtime returned its turn and the turn is saved). */
  whenAccepted(threadId: string, sourceId: string, eventId: string, timeoutMs: number,
    signal?: AbortSignal): Promise<WakeEvent | undefined> {
    return this.waitFor(threadId, sourceId, eventId, timeoutMs, signal,
      event => isSettledEvent(event) || (!!event && isAcceptedOffer(event)));
  }

  private waitFor(threadId: string, sourceId: string, eventId: string, timeoutMs: number,
    signal: AbortSignal | undefined, isSettled: (event?: WakeEvent) => boolean): Promise<WakeEvent | undefined> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new Error('Invalid wait');
    const find = () => this.state.events.find(e => e.threadId === threadId && e.sourceId === sourceId &&
      e.eventId === eventId);
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this.settleWaiters.delete(waiter);
        signal?.removeEventListener('abort', finish);
        const event = find();
        resolve(event && this.copy(event));
      };
      // Answered only from state that is on disk; every successful write re-checks.
      const ready = () => this.durable() && isSettled(find());
      const waiter = { check: () => { if (ready()) finish(); }, finish };
      if (ready() || signal?.aborted || this.stopping) return finish();
      this.settleWaiters.add(waiter);
      signal?.addEventListener('abort', finish, { once: true });
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  }

  /** Take the native turn holding an observed receipt. It replaces the turn
   * recorded at offer time: an accepted steer may be consumed by a later turn
   * than the one that accepted it, and the admitting turn is the one holding it. */
  private receiptTurn(event: WakeEvent, state: NativeView): void {
    const clientId = wakeClientId(event);
    let turnId = state.clientTurns?.find(item => item.clientId === clientId)?.turnId;
    if (!turnId && state.messageTurnIds) {
      // A receipt found only by its marker: the turn of that message.
      const input = wakeInput(event);
      const index = state.messages.findIndex(message => message === input || message.startsWith(`${input}\n`));
      if (index >= 0) turnId = state.messageTurnIds[index];
    }
    if (turnId && ID.test(turnId)) event.turnId = turnId;
  }

  private markEnded(threadId: string, turnId: string): void {
    const ended = this.endedTurns.get(threadId);
    if (ended) ended.add(turnId); else this.endedTurns.set(threadId, new Set([turnId]));
  }

  /** Hand an admitted, sender-attributed input to onAdmitted once. The flag is
   * saved only after the hook confirms a durable record, so a restart in
   * between offers it again (the hook is idempotent) and a watch is never
   * lost; once saved it is never offered again. Never throws. */
  private handOverAdmission(event: WakeEvent): Promise<void> | undefined {
    const hook = this.native.onAdmitted;
    if (!hook || this.stopping || event.status !== 'admitted' || !event.sender || !event.turnId ||
        event.outcomeWatched) return;
    const key = `${event.threadId}:${event.sourceId}:${event.eventId}`;
    if (this.admissionHandOvers.has(key)) return this.admissionHandOvers.get(key);
    const admission: WakeAdmission = { threadId: event.threadId, sourceId: event.sourceId,
      eventId: event.eventId, turnId: event.turnId, sender: { ...event.sender } };
    const task = (async () => {
      try {
        if (!await hook.call(this.native, admission)) return;
        await this.exclusive(async () => {
          if (!this.state.events.includes(event) || this.released) return;
          event.outcomeWatched = true;
          await this.save();
        });
      } catch (error) {
        console.error('[Wake admission] Outcome return not recorded; it is offered again shortly.',
          error instanceof Error ? error.name : 'UnknownError');
      }
    })().finally(() => { this.admissionHandOvers.delete(key); });
    this.admissionHandOvers.set(key, task);
    return task;
  }

  /** Reserve before native CAS: an uncertain mutation after a crash must not
   * produce an unbounded series of retries from a chatty source. */
  private reserveGoalInput(admission: GoalInputAdmission,
    intent: Omit<GoalInputIntent, 'phase' | 'resultUpdatedAt'>):
    Promise<'reserved' | 'bounded' | 'duplicate'> {
    return this.exclusive(async () => {
      const now = Date.now();
      const inputKey = eventKey(admission.threadId, admission.sourceId, admission.eventId);
      const attempts = this.state.goalResumeAttempts ??= [];
      if (attempts.some(item => item.inputKey === inputKey)) return 'duplicate';
      const withinHour = attempts.filter(item => item.threadId === admission.threadId &&
        item.goalId === intent.goalId && item.phase !== 'bounded' &&
        item.at > now - 3_600_000 && item.at <= now);
      const bounded = withinHour.length >= 3;
      attempts.push({ threadId: admission.threadId, inputKey, at: now, ...intent,
        phase: bounded ? 'bounded' : 'reserved' });
      // Retain the per-input token after the hour: a crash between a native
      // mutation and handoff completion must never mutate the same Goal twice.
      await this.save();
      return bounded ? 'bounded' : 'reserved';
    });
  }

  private goalInputLedger(admission: GoalInputAdmission): GoalInputLedger {
    const key = eventKey(admission.threadId, admission.sourceId, admission.eventId);
    return {
      lookup: async () => {
        const attempt = this.state.goalResumeAttempts?.find(item => item.inputKey === key);
        return attempt ? { goalId: attempt.goalId, goalCreatedAt: attempt.goalCreatedAt,
          goalUpdatedAt: attempt.goalUpdatedAt, missionRevision: attempt.missionRevision,
          lifecycleRevision: attempt.lifecycleRevision, phase: attempt.phase,
          ...(attempt.goalStatus !== undefined && { goalStatus: attempt.goalStatus }),
          ...(attempt.resultUpdatedAt !== undefined && { resultUpdatedAt: attempt.resultUpdatedAt }) } : undefined;
      },
      reserve: intent => this.reserveGoalInput(admission, intent),
      confirm: (goalId, resultUpdatedAt) => this.exclusive(async () => {
        const attempt = this.state.goalResumeAttempts?.find(item => item.inputKey === key &&
          item.goalId === goalId && item.phase === 'reserved');
        if (!attempt) throw new Error('Goal input reservation unavailable');
        attempt.phase = 'confirmed'; attempt.resultUpdatedAt = resultUpdatedAt;
        await this.save();
      }),
      reject: goalId => this.exclusive(async () => {
        const attempt = this.state.goalResumeAttempts?.find(item => item.inputKey === key &&
          item.goalId === goalId && item.phase === 'reserved');
        if (!attempt) throw new Error('Goal input reservation unavailable');
        attempt.phase = 'rejected';
        await this.save();
      }),
    };
  }

  private handOverGoalInput(event: WakeEvent): void {
    const hook = this.native.onGoalInput;
    if (!hook || this.stopping || event.status !== 'admitted' || !event.turnId ||
        !event.goalInputPending) return;
    const key = eventKey(event.threadId, event.sourceId, event.eventId);
    if (this.goalInputHandOvers.has(key)) return;
    const admission: GoalInputAdmission = { threadId: event.threadId, sourceId: event.sourceId,
      eventId: event.eventId, turnId: event.turnId };
    this.goalInputHandOvers.add(key);
    const task = (async () => {
      // Goal custody is independent of the input's outcome-return store.
      // Notices use only an already-bound Goal assigner, never this retry's
      // sender, so a full outcome-return store cannot suppress the resume.
      if (!await hook.call(this.native, admission, this.goalInputLedger(admission))) return;
      await this.exclusive(async () => {
        if (!this.state.events.includes(event) || this.released) return;
        event.goalInputPending = false;
        await this.save();
      });
    })();
    void this.track(task).catch(error => {
      console.error('[Goal input resume] Admission preserved; resume unavailable.',
        error instanceof Error ? error.name : 'UnknownError');
    }).finally(() => { this.goalInputHandOvers.delete(key); });
  }

  /** A content-free, deterministic CAS token for one source and its unadmitted
   * events. It changes whenever custody relevant to recovery changes. */
  recoverySnapshot(threadId: string, id: string) {
    const source = this.state.sources.find(s => s.threadId === threadId && s.id === id);
    if (!source) throw new WakeRecoveryError('invalid_request');
    const events = this.state.events.filter(e => e.threadId === threadId && e.sourceId === id);
    const revision = createHash('sha256').update(JSON.stringify({ source, events })).digest('hex');
    return { source: structuredClone(source), events: structuredClone(events), revision };
  }

  /** Rearm only future civil or fixed-interval occurrences. The historical held event is kept
   * byte-for-byte, and an unresolved offer always refuses the operation. */
  async recoverDailyFuture(threadId: string, id: string, expectedRevision: string,
    expectedHeldEventId: string): Promise<ReturnType<WakeSources['recoverySnapshot']>> {
    if (this.stopping || ![threadId, id, expectedHeldEventId].every(x => ID.test(x)) ||
        !/^[0-9a-f]{64}$/.test(expectedRevision)) throw new WakeRecoveryError('invalid_request');
    return this.exclusive(async () => {
      const snapshot = this.recoverySnapshot(threadId, id);
      if (snapshot.revision !== expectedRevision) throw new WakeRecoveryError('stale_revision');
      const { source, events } = snapshot;
      const now = Date.now();
      const civil = !!source.dailyAt && !!source.timeZone && source.at === undefined &&
        source.everyMs === undefined;
      const interval = source.dailyAt === undefined && source.timeZone === undefined &&
        typeof source.at === 'string' && Number.isFinite(Date.parse(source.at)) &&
        Number.isSafeInteger(source.everyMs) && source.everyMs! >= MIN_INTERVAL &&
        now + source.everyMs! <= 8_640_000_000_000_000;
      if (source.kind !== 'schedule' || (!civil && !interval) || source.paused ||
          source.stopped !== undefined || source.moreAvailable !== undefined ||
          !Number.isSafeInteger(source.sequence) || source.sequence < 0 ||
          source.status !== 'error' || source.nextAt !== undefined ||
          // The persisted event schema also includes refused; unfamiliar
          // statuses must not be interpreted as settled custody.
          events.some(e => e.status !== 'held' && e.status !== 'admitted') ||
          !events.some(e => e.eventId === expectedHeldEventId && e.status === 'held' &&
            e.eventId === `${id}-${source.sequence}`)) {
        throw new WakeRecoveryError('refused_ambiguous');
      }
      const current = this.state.sources.find(s => s.threadId === threadId && s.id === id)!;
      current.nextAt = civil ? nextCivilDaily(now, current.timeZone!, current.dailyAt!)
        : new Date(now + current.everyMs!).toISOString();
      current.status = 'waiting';
      delete current.error;
      await this.save();
      return this.recoverySnapshot(threadId, id);
    });
  }

  /** Explicit own-thread read of an ambiguous offer. A positive native marker
   * alone establishes admission; absence or a failed read is never replayed. */
  async reconcileOffered(threadId: string, id: string, eventId: string,
    expectedRevision: string): Promise<ReturnType<WakeSources['recoverySnapshot']>> {
    if (this.stopping || ![threadId, id, eventId].every(x => ID.test(x)) ||
        !/^[0-9a-f]{64}$/.test(expectedRevision)) throw new WakeRecoveryError('invalid_request');
    const key = eventKey(threadId, id, eventId);
    if (this.ticking || this.inFlight.has(key)) throw new WakeRecoveryError('refused_ambiguous');
    this.inFlight.add(key);
    // Whatever its result, a proof noted before the operation is not reused after it.
    return this.track(this.reconcileOfferedOwned(threadId, id, eventId, expectedRevision)
      .finally(() => { this.inFlight.delete(key); this.proofSeenAt.delete(key); }));
  }

  private async reconcileOfferedOwned(threadId: string, id: string, eventId: string,
    expectedRevision: string): Promise<ReturnType<WakeSources['recoverySnapshot']>> {
    const before = this.recoverySnapshot(threadId, id);
    if (before.revision !== expectedRevision) throw new WakeRecoveryError('stale_revision');
    if (before.source.kind !== 'schedule' || !before.source.dailyAt || !before.source.timeZone)
      throw new WakeRecoveryError('invalid_request');
    const event = before.events.find(e => e.eventId === eventId && e.status === 'offered');
    if (!event) throw new WakeRecoveryError('refused_ambiguous');
    let native;
    try { native = await this.inspectWithDeadline(threadId, inspectSince(event.createdAt), true); }
    catch { throw new WakeRecoveryError('native_unavailable'); }
    if (!this.hasReceipt(event, native)) throw new WakeRecoveryError('refused_ambiguous');
    return this.exclusive(async () => {
      // The revision covers the source and every one of its events: an
      // unchanged revision means the native read above still applies.
      const current = this.recoverySnapshot(threadId, id);
      if (current.revision !== expectedRevision) throw new WakeRecoveryError('stale_revision');
      const owned = this.state.events.find(e => e.threadId === threadId && e.sourceId === id &&
        e.eventId === eventId && e.status === 'offered')!;
      this.receiptTurn(owned, native);
      this.admitObserved(owned, Date.now());
      await this.save();
      this.handOverAdmission(owned);
      this.handOverGoalInput(owned);
      return this.recoverySnapshot(threadId, id);
    });
  }

  private admitObserved(event: WakeEvent, now: number): void {
    this.forgetEvent(event);
    event.status = 'admitted'; event.message = ''; event.admittedAt = new Date().toISOString();
    if (event.turnId) event.goalInputPending = true;
    delete event.error; delete event.failure; delete event.offeredAt; delete event.nextAttemptAt;
    // Without its turn no outcome can be watched: say so instead of staying silent.
    if (event.sender && !event.turnId) event.outcomeReturn = 'turn_unknown';
    const source =this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
    // A command still in flight owns its own re-arm. Admission may settle
    // during that run, but must not overwrite the running or stopped state.
    if (source && source.status !== 'cancelled' && !source.stopped &&
        !this.inFlight.has(sourceKey(source.threadId, source.id)) &&
        !(source.kind === 'command' && source.status === 'error' && !source.nextAt &&
          this.state.events.some(item => item.threadId === source.threadId &&
            item.sourceId === source.id && (item.status === 'pending' || item.status === 'offered')))) {
      delete source.error;
      delete source.stopped;
      source.status = 'delivered';
      if (source.kind === 'schedule' && source.dailyAt && source.timeZone) {
        source.nextAt = nextCivilDaily(now, source.timeZone, source.dailyAt); source.status = 'waiting';
      } else if (source.kind === 'schedule' && source.everyMs) {
        source.nextAt = new Date(now + source.everyMs).toISOString(); source.status = 'waiting';
      } else if (source.kind === 'command') {
        // Once the last input of a run that produced events is admitted, run
        // again at once: the command may have more ready input. While inputs
        // remain, their stable IDs stay in the durable ledger while the next
        // command poll may discover later input without resubmitting them.
        const remaining = this.state.events.some(e => e.threadId === source.threadId &&
          e.sourceId === source.id && (e.status === 'pending' || e.status === 'offered'));
        const immediate = source.moreAvailable === true && !remaining;
        source.nextAt = new Date(now + (immediate ? 0 : commandRearmMs(source))).toISOString(); source.status = 'waiting';
        if (immediate) this.requestTick();
      }
    }
  }

  /** Schedule one short follow-up pass; a running pass defers it to its end. */
  private requestTick(): void {
    this.followUpsRequested += 1;
    if (this.stopping || !this.started || !this.timing.intervalMs || this.followUp) return;
    this.followUp = setTimeout(() => { this.followUp = undefined; this.backgroundTick(); }, this.timing.followUpMs);
    this.followUp.unref?.();
  }

  private backgroundTick(): void {
    if (this.stopping) return;
    if (this.ticking) { this.followUpWanted = true; return; }
    void this.tick().catch(console.error);
  }

  /** Stop new command launches and native offers without retracting any event.
   * Return only after this source's running command and the preceding native
   * tick settle, with a bounded, source-specific drain receipt.
   */
  async pause(threadId: string, id: string): Promise<{ source: WakeSource; drain: WakeSourceDrain }> {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    if (![threadId, id].every(value => ID.test(value))) throw new Error('Invalid source ID');
    await this.exclusive(async () => {
      const current = this.state.sources.find(item => item.threadId === threadId && item.id === id);
      if (!current || current.status === 'cancelled') throw new Error('Source not found');
      current.paused = true;
      await this.save();
    });
    // The tick waits for native offers, but launches command polls without
    // awaiting them. A pause response is not a drain receipt until BOTH have
    // settled. Never terminate a child or discard its durable event/output.
    const key = `${threadId}:${id}`;
    const inFlightKey = sourceKey(threadId, id);
    const tick = this.tickFinished;
    const command = this.commandTasksBySource.get(key);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([tick, command]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Wake source drain timed out; source remains paused')), 215_000);
        }),
      ]);
    } catch {
      // Keep the durable pause gate set. A caller must not interpret a child,
      // disk, or native failure as a completed drain, nor receive raw output.
      throw new Error('Wake source drain failed; source remains paused and custody is unverified');
    } finally { if (timeout) clearTimeout(timeout); }
    return this.exclusive(async () => {
      const source = this.state.sources.find(item => item.threadId === threadId && item.id === id);
      if (!source?.paused || source.status === 'cancelled' || this.commands.has(key) ||
          this.commandTasksBySource.has(key) || this.inFlight.has(inFlightKey) ||
          this.state.events.some(event => event.threadId === threadId && event.sourceId === id &&
            this.inFlight.has(eventKey(threadId, id, event.eventId)))) {
        throw new Error('Wake source drain changed or remains in flight; source custody must be rechecked');
      }
      const events = this.state.events.filter(event => event.threadId === threadId && event.sourceId === id);
      return { source: structuredClone(source), drain: {
        drained: true as const, commandInFlight: false as const, nativeOfferInFlight: false as const,
        pendingEvents: events.filter(event => event.status === 'pending').length,
        offeredEvents: events.filter(event => event.status === 'offered').length,
      } };
    });
  }

  async resume(threadId: string, id: string): Promise<WakeSource> {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    if (![threadId, id].every(value => ID.test(value))) throw new Error('Invalid source ID');
    return this.exclusive(async () => {
      if (this.pausedRetargetUncertain.has(`${threadId}:${id}`))
        throw new Error('Paused command persistence uncertain; source remains paused');
      const source = this.state.sources.find(item => item.threadId === threadId && item.id === id);
      if (!source || source.status === 'cancelled') throw new Error('Source not found');
      source.paused = false;
      await this.save();
      return structuredClone(source);
    });
  }

  /** The one private, atomically replaced state file backing all thread schedules. */
  configFilePath(): string { return this.file; }

  /** Write the whole state. While it runs it counts as outstanding (see
   * `writesInFlight`); a failure marks the state unsaved (see `unsaved`); a
   * success clears that and re-checks every settle waiter. */
  private async save(): Promise<void> {
    if (this.released) throw new Error('Wake state owner released');
    this.writesInFlight += 1;
    try { await this.writeState(); }
    catch (error) { this.unsaved = true; throw error; }
    finally { this.writesInFlight -= 1; }
    this.unsaved = false;
    if (this.writesInFlight === 0) this.turnsUnsaved.clear();
    for (const waiter of [...this.settleWaiters]) waiter.check();
  }

  /** A save made by a pass's own delivery transition: it asks for a follow-up pass. */
  private async saveTransition(): Promise<void> {
    await this.save();
    this.passChanged = true;
  }

  private async writeState(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(this.state)); await handle.sync(); }
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

  async put(source: Omit<WakeSource, 'status' | 'sequence' | 'nextAt' | 'error' | 'paused' | 'moreAvailable' | 'stopped'>): Promise<WakeSource> {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    if (!ID.test(source.threadId) || !ID.test(source.id)) throw new Error('Invalid thread or source ID');
    if (source.id === THREAD_INPUT_SOURCE) throw new Error('Reserved wake source ID');
    if (source.kind !== 'schedule' && source.kind !== 'command') throw new Error('Unknown wake source kind');
    if (Object.keys(source).some(key => !['id', 'threadId', 'kind', 'message', 'at', 'everyMs', 'dailyAt', 'timeZone', 'argv', 'rearmMs'].includes(key))) {
      throw new Error('Unknown wake source field');
    }
    const civil = source.kind === 'schedule' && (source.dailyAt !== undefined || source.timeZone !== undefined);
    if (source.kind === 'schedule') {
      if (source.rearmMs !== undefined) throw new Error('Only a command may set rearmMs');
      if (source.id.length > MAX_SCHEDULE_ID) throw new Error('Schedule ID is too long');
      if (!source.message?.trim() || source.message.length > MAX_MESSAGE ||
          (civil && (typeof source.dailyAt !== 'string' || typeof source.timeZone !== 'string' ||
            source.at !== undefined || source.everyMs !== undefined)) ||
          (!civil && (!source.at || !Number.isFinite(Date.parse(source.at)))) ||
          (source.everyMs !== undefined && (!Number.isInteger(source.everyMs) || source.everyMs < MIN_INTERVAL))) {
        throw new Error('Schedule needs a message and a valid one-time, interval, or civil daily time');
      }
      if (civil) nextCivilDaily(Date.now(), source.timeZone!, source.dailyAt!);
    } else if (source.dailyAt !== undefined || source.timeZone !== undefined || source.at !== undefined ||
      source.everyMs !== undefined || source.message !== undefined ||
      (source.rearmMs !== undefined && (!Number.isSafeInteger(source.rearmMs) ||
        source.rearmMs < MIN_COMMAND_REARM_MS || source.rearmMs > MAX_COMMAND_REARM_MS)) ||
      !Array.isArray(source.argv) || !source.argv.length || source.argv.length > 32 ||
      source.argv.some(arg => typeof arg !== 'string' || !arg || arg.length > 4096) ||
      !path.isAbsolute(source.argv[0])) {
      throw new Error('Command requires an absolute executable and bounded arguments');
    }
    return this.exclusive(async () => {
      const old = this.state.sources.find(s => s.id === source.id && s.threadId === source.threadId);
      if (old?.paused) throw new Error('Resume the paused source before editing it');
      const key = sourceKey(source.threadId, source.id);
      const taskKey = `${source.threadId}:${source.id}`;
      if (old?.status === 'running' || this.inFlight.has(key) ||
          this.commands.has(taskKey) || this.commandTasksBySource.has(taskKey))
        throw new Error('Wait for the running command before changing it');
      if (old && this.state.events.some(e => e.sourceId === old.id && e.threadId === old.threadId &&
        (e.status === 'pending' || e.status === 'offered'))) {
        throw new Error('Cannot change a source while its input awaits native admission');
      }
      if (old) this.state.sources.splice(this.state.sources.indexOf(old), 1);
      if (!old && this.state.sources.filter(s => s.threadId === source.threadId && s.status !== 'cancelled').length >= 32) {
        throw new Error('Thread wake source limit reached');
      }
      const result: WakeSource = { ...source, sequence: old?.sequence ?? 0, status: 'waiting',
        nextAt: civil && source.kind === 'schedule'
          ? nextCivilDaily(Date.now(), source.timeZone!, source.dailyAt!)
          : source.at ?? new Date().toISOString() };
      this.state.sources.push(result);
      await this.save();
      return structuredClone(result);
    });
  }

  /** Retarget only a drained, paused command. Its ID, status, sequence and
   * durable input ledger remain untouched; this never admits or polls input. */
  async pausedCommandMetadata(threadId: string, id: string) {
    if (![threadId, id].every(value => ID.test(value))) throw new Error('Invalid source ID');
    return this.exclusive(async () => {
      if (this.pausedRetargetUncertain.has(`${threadId}:${id}`))
        throw new Error('Paused command persistence uncertain');
      const source = this.state.sources.find(item => item.threadId === threadId && item.id === id);
      if (!source || source.kind !== 'command' || !Array.isArray(source.argv))
        throw new Error('Command source unavailable');
      const events = this.state.events.filter(item => item.threadId === threadId && item.sourceId === id);
      return { sourceId: id, threadId, status: source.status, paused: source.paused === true,
        sequence: source.sequence, argvSha256: createHash('sha256').update(JSON.stringify(source.argv)).digest('hex'),
        pendingEvents: events.filter(item => item.status === 'pending').length,
        offeredEvents: events.filter(item => item.status === 'offered').length };
    });
  }

  async retargetPausedCommand(threadId: string, id: string, expectedArgvSha256: string,
    pathComponentFrom: string, pathComponentTo: string): Promise<WakeSource> {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    if (![threadId, id].every(value => ID.test(value)) ||
      !/^[a-f0-9]{64}$/.test(expectedArgvSha256) ||
      ![pathComponentFrom, pathComponentTo].every(value => typeof value === 'string' &&
        value.length <= 4096 && path.isAbsolute(value) && !value.includes(path.delimiter) && !value.includes('\0')) ||
      pathComponentFrom === pathComponentTo) {
      throw new PausedCommandConflictError();
    }
    return this.exclusive(async () => {
      const source = this.state.sources.find(item => item.threadId === threadId && item.id === id);
      const key = `${threadId}:${id}`;
      if (this.pausedRetargetUncertain.has(key))
        throw new Error('Paused command persistence uncertain');
      if (!source || source.kind !== 'command' || !source.paused || source.status === 'cancelled' ||
          source.status === 'running' || !Array.isArray(source.argv) ||
          createHash('sha256').update(JSON.stringify(source.argv)).digest('hex') !== expectedArgvSha256 ||
          this.commands.has(key) || this.commandTasksBySource.has(key) || this.inFlight.has(sourceKey(threadId, id)) ||
          this.state.events.some(event => event.threadId === threadId && event.sourceId === id &&
            this.inFlight.has(eventKey(threadId, id, event.eventId)))) {
        throw new PausedCommandConflictError();
      }
      const pathArgs = source.argv.map((value, index) => ({ value, index }))
        .filter(item => item.value.startsWith('PATH='));
      if (pathArgs.length !== 1) throw new PausedCommandConflictError();
      const { value, index } = pathArgs[0];
      const components = value.slice(5).split(path.delimiter);
      if (components.filter(component => component === pathComponentFrom).length !== 1 ||
          components.includes(pathComponentTo)) throw new PausedCommandConflictError();
      source.argv = source.argv.map((arg, position) => position === index
        ? `PATH=${components.map(component => component === pathComponentFrom ? pathComponentTo : component).join(path.delimiter)}`
        : arg);
      try { await this.save(); }
      catch (error) { this.pausedRetargetUncertain.add(key); throw error; }
      return structuredClone(source);
    });
  }

  async cancel(threadId: string, id: string): Promise<void> {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    await this.exclusive(async () => {
      if (this.pausedRetargetUncertain.has(`${threadId}:${id}`))
        throw new Error('Paused command persistence uncertain');
      const source = this.state.sources.find(s => s.threadId === threadId && s.id === id);
      if (!source) throw new Error('Source not found');
      source.status = 'cancelled';
      this.commands.get(`${threadId}:${id}`)?.kill('SIGKILL');
      // Offered input may already be in the native turn; never retract or replay it.
      this.state.events = this.state.events.filter(e => {
        const removed = e.sourceId === id && e.threadId === threadId && e.status === 'pending';
        if (removed) this.forgetEvent(e);
        return !removed;
      });
      await this.save();
    });
  }

  async ingest(threadId: string, sourceId: string, eventId: string, message: string,
    sender?: SubmissionSender): Promise<WakeEvent> {
    return (await this.ingestBatch(threadId, sourceId, [{ id: eventId, message, ...(sender && { sender }) }]))[0];
  }

  /** Take custody of several inputs of one source, in order, with one atomic
   * save. An ID that already holds the same input is returned unchanged, so a
   * re-emitted batch is harmless; an ID holding other content rejects the
   * whole batch. Nothing is ingested if any item is invalid. */
  async ingestBatch(threadId: string, sourceId: string, batch: WakeBatchItem[]): Promise<WakeEvent[]> {
    this.checkBatch(threadId, sourceId, batch);
    return this.exclusive(async () => {
      // A cancelled source takes no input until it is saved again: its
      // events would never be offered.
      if (this.state.sources.some(s => s.threadId === threadId && s.id === sourceId && s.status === 'cancelled')) {
        throw new WakeSourceCancelledError();
      }
      const { events, fresh } = this.addEvents(threadId, sourceId, batch);
      // A known ID is answered without a write only when memory is on disk.
      if (fresh.length || !this.durable()) await this.saveForAcknowledgement();
      return events.map(event => this.copy(event));
    });
  }

  /**
   * The stored input under a caller's ID, answered without reading the
   * thread: a copy of the event when it exists and the state is on disk;
   * undefined when there is none, or while a write is outstanding or the
   * last one failed (then ingestion must save before it may acknowledge). Throws
   * WakeContentConflictError when the ID holds a different message or sender.
   */
  storedInput(threadId: string, sourceId: string, eventId: string, message: string,
    sender?: SubmissionSender): WakeEvent | undefined {
    const event = this.state.events.find(e => e.threadId === threadId && e.sourceId === sourceId &&
      e.eventId === eventId);
    if (!event) return undefined;
    const parsed = sender === undefined ? undefined : parseSubmissionSender(sender);
    if (sender !== undefined && !parsed) throw new Error('Invalid wake event');
    if (sourceId === THREAD_INPUT_SOURCE && event.contentSha256 &&
        event.contentSha256 !== contentDigest(message, parsed ?? undefined)) {
      throw new WakeContentConflictError();
    }
    return this.durable() ? this.copy(event) : undefined;
  }

  /** Save before an acknowledgement. A failed write keeps the inputs in
   * memory (they may already be on disk) and rejects with WakeUnsavedError:
   * the caller retries with the same IDs, and that retry succeeds only once
   * a write has completed. */
  private async saveForAcknowledgement(): Promise<void> {
    try { await this.save(); }
    catch { throw new WakeUnsavedError(); }
  }

  private checkBatch(threadId: string, sourceId: string, batch: WakeBatchItem[]): void {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    if (![threadId, sourceId].every(x => typeof x === 'string' && ID.test(x)) || !Array.isArray(batch) ||
        !batch.length || new Set(batch.map(item => item?.id)).size !== batch.length ||
        batch.some(item => typeof item?.id !== 'string' || !ID.test(item.id) || typeof item.message !== 'string' ||
          !item.message.trim() || item.message.length > MAX_MESSAGE)) {
      throw new Error('Invalid wake event');
    }
    if (batch.some(item => item.sender !== undefined && !parseSubmissionSender(item.sender))) {
      throw new Error('Invalid wake event');
    }
  }

  /** Caller holds the exclusive section and saves. Throws before any change. */
  private addEvents(threadId: string, sourceId: string, batch: WakeBatchItem[]): { events: WakeEvent[]; fresh: WakeEvent[] } {
    const existing = batch.map(item => this.state.events.find(e => e.threadId === threadId &&
      e.sourceId === sourceId && e.eventId === item.id));
    const digests = batch.map(item => contentDigest(item.message,
      item.sender === undefined ? undefined : parseSubmissionSender(item.sender)!));
    // A caller's own ID must not be reused for different input. A source
    // that re-emits an input it already delivered keeps the stored event
    // whatever it now prints: its wording may differ between runs, and a
    // rejection here would stop that source for good. An event stored
    // without a digest predates it and is taken as matching.
    if (sourceId === THREAD_INPUT_SOURCE &&
        existing.some((event, index) => event?.contentSha256 && event.contentSha256 !== digests[index])) {
      throw new WakeContentConflictError();
    }
    const added = existing.filter(event => !event).length;
    // Keep stable IDs as compact admission receipts indefinitely. Bound only
    // inputs still awaiting admission, so a long-running thread cannot hit
    // a permanent lifetime event ceiling.
    if (added && this.state.events.filter(e => e.threadId === threadId &&
      (e.status === 'pending' || e.status === 'offered')).length + added > 10_000) {
      throw new WakeBacklogFull();
    }
    const createdAt = new Date().toISOString();
    const fresh: WakeEvent[] = [];
    const events = batch.map((item, index) => {
      const prior = existing[index];
      if (prior) return prior;
      const event: WakeEvent = { threadId, sourceId, eventId: item.id, message: item.message, status: 'pending', createdAt,
        ...(item.sender && { sender: parseSubmissionSender(item.sender)! }), contentSha256: digests[index] };
      this.state.events.push(event);
      fresh.push(event);
      return event;
    });
    return { events, fresh };
  }

  /** Operator-only resolution of an ambiguous, terminal offer: retain its body and
   * audit ID, but never replay or mislabel it as admitted. Later inputs may proceed.
   * The caller must explicitly accept that this held event needs separate review.
   */
  async holdOffered(threadId: string, sourceId: string, eventId: string, turnId: string): Promise<WakeEvent> {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    if (![threadId, sourceId, eventId, turnId].every(x => ID.test(x))) throw new Error('Invalid wake custody ID');
    const key = eventKey(threadId, sourceId, eventId);
    if (this.ticking || this.inFlight.has(key)) throw new Error('Wake inspection in progress');
    this.inFlight.add(key);
    // Whatever its result, a proof noted before the operation is not reused after it.
    return this.track(this.holdOfferedOwned(threadId, sourceId, eventId, turnId)
      .finally(() => { this.inFlight.delete(key); this.proofSeenAt.delete(key); }));
  }

  /** The event an operator decision was checked against must be unchanged when it is applied. */
  private sameOffer(threadId: string, sourceId: string, eventId: string,
    expected: Pick<WakeEvent, 'offeredAt' | 'turnId'>): WakeEvent {
    const event = this.state.events.find(e => e.threadId === threadId && e.sourceId === sourceId && e.eventId === eventId);
    if (!event || event.status !== 'offered' || event.offeredAt !== expected.offeredAt ||
        event.turnId !== expected.turnId) throw new Error('Offered event/turn mismatch');
    return event;
  }

  private async holdOfferedOwned(threadId: string, sourceId: string, eventId: string, turnId: string): Promise<WakeEvent> {
    const found = this.state.events.find(e => e.threadId === threadId && e.sourceId === sourceId && e.eventId === eventId);
    if (!found || found.status !== 'offered' || (found.turnId && found.turnId !== turnId)) {
      throw new Error('Offered event/turn mismatch');
    }
    const event = structuredClone(found);
    const custodyOf = this.native.custody;
    if (!custodyOf) throw new Error('Native custody inspection unavailable');
    // Native reads are bounded and made outside the exclusive section, so a
    // hung runtime never blocks saves or acknowledgements; the decision is
    // applied below only if the offer is still exactly the one checked.
    const [state, custody] = await Promise.all([
      this.inspectWithDeadline(threadId, inspectSince(event.createdAt), true),
      this.withDeadline(custodyOf.call(this.native, threadId, turnId), 'Native custody timeout')]);
    // startTurn may fail before returning a turn ID, leaving a durable offer
    // with no turn association. Never infer admission or retry that offer.
    // An operator may hold it only against the exact latest failed native
    // turn after the offer has settled. A supervised host restart may leave
    // the same persisted failed turn unloaded or idle; never infer a receipt
    // from that lifecycle transition. This is deliberately stricter than
    // the bound-turn disposition above.
    if (!event.turnId && (!event.offeredAt || !Number.isFinite(Date.parse(event.offeredAt)) ||
        Date.now() - Date.parse(event.offeredAt) < 60_000 ||
        !['systemError', 'notLoaded', 'idle'].includes(custody.threadStatus ?? '') ||
        custody.lastTurnId !== turnId ||
        custody.turnStatus !== 'failed')) {
      throw new Error('Unbound offer lacks a settled failed native turn');
    }
    if (state.activeTurnId || !TERMINAL_TURN.includes(custody.turnStatus ?? '') ||
        custody.queuedSubmissionCount !== 0) {
      throw new Error('Native offer is not terminal and queue-empty');
    }
    if (this.hasReceipt(event, state)) throw new Error('Native receipt exists; reconcile admission instead');
    return this.exclusive(async () => {
      const current = this.sameOffer(threadId, sourceId, eventId, event);
      this.forgetEvent(current);
      current.status = 'held';
      current.error = 'Operator-held ambiguous native offer; not admitted or replayed';
      delete current.nextAttemptAt;
      const source = this.state.sources.find(s => s.threadId === threadId && s.id === sourceId);
      if (source && source.status !== 'cancelled') {
        source.status = 'error';
        source.nextAt = undefined;
        source.error = 'Operator-held ambiguous native offer; review source before rearming';
        source.stopped = 'operator_review';
      }
      await this.save();
      return structuredClone(current);
    });
  }

  /** Explicit operator no-replay decision for an old unbound offer after later
   * native turns made the original failed-turn binding unavailable. This never
   * asserts rejection or admission; the original event is retained as held.
   */
  async holdHistoricalOffered(threadId: string, sourceId: string, eventId: string,
    expectedClientId: string, expectedLatestTurnId: string, decisionRef: string): Promise<WakeEvent> {
    if (this.stopping) throw new HistoricalHoldConflict('BUSY', 'Wake admission is draining for restart');
    if (![threadId, sourceId, eventId, expectedLatestTurnId, decisionRef].every(x => ID.test(x)))
      throw new HistoricalHoldConflict('CUSTODY_MISMATCH', 'Invalid wake custody ID');
    const key = eventKey(threadId, sourceId, eventId);
    if (this.ticking || this.inFlight.has(key))
      throw new HistoricalHoldConflict('BUSY', 'Wake inspection in progress');
    this.inFlight.add(key);
    return this.track(this.holdHistoricalOwned(threadId, sourceId, eventId, expectedClientId,
      expectedLatestTurnId, decisionRef).finally(() => { this.inFlight.delete(key); this.proofSeenAt.delete(key); }));
  }

  private async holdHistoricalOwned(threadId: string, sourceId: string, eventId: string,
    expectedClientId: string, expectedLatestTurnId: string, decisionRef: string): Promise<WakeEvent> {
    const found = this.state.events.find(e => e.threadId === threadId && e.sourceId === sourceId && e.eventId === eventId);
    const custodyOf = this.native.custody;
    if (!found || found.status !== 'offered' || found.turnId || !found.offeredAt ||
        !Number.isFinite(Date.parse(found.offeredAt)) || Date.now() - Date.parse(found.offeredAt) < 60_000 ||
        wakeClientId(found) !== expectedClientId || !custodyOf)
      throw new HistoricalHoldConflict('CUSTODY_MISMATCH', 'Historical offer custody mismatch');
    const event = structuredClone(found);
    // Bounded native reads outside the exclusive section; see holdOfferedOwned.
    let state: Awaited<ReturnType<WakeNative['inspect']>>;
    let custody: NonNullable<Awaited<ReturnType<NonNullable<WakeNative['custody']>>>>;
    try {
      [state, custody] = await Promise.all([
        this.inspectWithDeadline(threadId, inspectSince(event.createdAt), true),
        this.withDeadline(custodyOf.call(this.native, threadId, expectedLatestTurnId), 'Native custody timeout')]);
    } catch {
      throw new HistoricalHoldConflict('INSPECTION_UNAVAILABLE', 'Native custody inspection unavailable');
    }
    if (state.activeTurnId || custody.queuedSubmissionCount !== 0 ||
        custody.lastTurnId !== expectedLatestTurnId ||
        !TERMINAL_TURN.includes(custody.turnStatus ?? '') ||
        !['idle', 'systemError', 'notLoaded'].includes(custody.threadStatus ?? ''))
      throw new HistoricalHoldConflict('CUSTODY_CHANGED', 'Historical offer requires terminal queue-empty native custody');
    if (this.hasReceipt(event, state))
      throw new HistoricalHoldConflict('RECEIPT_EXISTS', 'Native receipt exists; reconcile admission instead');
    return this.exclusive(async () => {
      let current: WakeEvent;
      try { current = this.sameOffer(threadId, sourceId, eventId, event); }
      catch { throw new HistoricalHoldConflict('CUSTODY_CHANGED', 'Historical offer changed during inspection'); }
      this.forgetEvent(current);
      current.status = 'held';
      current.error = `Operator-held historical ambiguous native offer; decision ${decisionRef}; latest terminal turn ${expectedLatestTurnId}; not admitted or replayed`;
      delete current.nextAttemptAt;
      const source = this.state.sources.find(s => s.threadId === threadId && s.id === sourceId);
      if (source && source.status !== 'cancelled') {
        source.status = 'error'; source.nextAt = undefined;
        source.error = 'Operator-held historical ambiguous native offer; review source before rearming';
        source.stopped = 'operator_review';
      }
      await this.save();
      return structuredClone(current);
    });
  }

  async tick(at?: number): Promise<void> {
    // A caller arriving during a pass gets one shared pass after it, rather
    // than a silent no-op; the interval and follow-up timers do not queue.
    if (this.ticking && !this.stopping) {
      return this.queuedTick ??= this.tickFinished!.then(() => { this.queuedTick = undefined; return this.tick(at); });
    }
    if (this.stopping) return;
    const now = at ?? Date.now();
    this.ticking = true;
    this.passChanged = false;
    this.tickFinished = new Promise<void>(resolve => { this.finishTick = resolve; });
    try {
    // Memory that is not on disk is never offered: make it durable first.
    if (this.unsaved) {
      try { await this.exclusive(() => this.save()); }
      catch { return; }
    }
    for (const source of this.state.sources) {
      if (this.stopping) break;
      if (source.paused || !(source.status === 'waiting' || (source.kind === 'command' && source.status === 'error')) ||
          !source.nextAt || Date.parse(source.nextAt) > now ||
          // A waiting command may collect later input while an older event
          // awaits admission. Schedules and errored commands retain their
          // original admission fence (including operator-held errors).
          ((source.kind === 'schedule' || source.status === 'error') &&
            this.state.events.some(e => e.threadId === source.threadId && e.sourceId === source.id &&
              (e.status === 'pending' || e.status === 'offered')))) continue;
      if (source.kind === 'schedule') {
        await this.exclusive(async () => {
          // Commit event custody and its sequence in the same atomic replace.
          if (source.status !== 'waiting' || !source.nextAt || Date.parse(source.nextAt) > now) return;
          if (!Number.isSafeInteger(source.sequence + 1)) throw new Error('Schedule sequence limit reached');
          const sequence = source.sequence + 1;
          const eventId = `${source.id}-${sequence}`;
          if (!ID.test(eventId)) {
            source.status = 'error'; source.error = 'Schedule ID is too long';
            await this.save(); return;
          }
          const existing = this.state.events.find(e => e.threadId === source.threadId &&
            e.sourceId === source.id && e.eventId === eventId);
          if (!existing) {
            if (this.state.events.filter(e => e.threadId === source.threadId &&
              (e.status === 'pending' || e.status === 'offered')).length >= 10_000) {
              source.status = 'error'; source.error = 'Thread pending wake event limit reached';
              await this.save(); return;
            }
            this.state.events.push({ threadId: source.threadId, sourceId: source.id, eventId,
              message: source.message!, status: 'pending', createdAt: new Date(now).toISOString() });
          }
          source.sequence = sequence;
          source.nextAt = existing?.status === 'admitted'
            ? source.dailyAt && source.timeZone ? nextCivilDaily(now, source.timeZone, source.dailyAt)
              : source.everyMs ? new Date(now + source.everyMs).toISOString() : undefined
            : undefined;
          if (existing?.status === 'admitted' && !source.everyMs && !source.dailyAt) source.status = 'delivered';
          await this.save();
        });
      } else if (!this.inFlight.has(sourceKey(source.threadId, source.id))) {
        const key = `${source.threadId}:${source.id}`;
        const task = this.runCommand(source);
        this.commandTasks.add(task);
        this.commandTasksBySource.set(key, task);
        void task.finally(() => {
          this.commandTasks.delete(task);
          if (this.commandTasksBySource.get(key) === task) this.commandTasksBySource.delete(key);
        }).catch(() => undefined);
      }
    }
    // An ambiguous RPC result is never automatically resubmitted while its
    // original turn is still running. The marker in native history is the receipt.
    const queues = new Map<string, WakeEvent[]>();
    for (const event of this.state.events) {
      if (event.status !== 'pending' && event.status !== 'offered') continue;
      const queue = queues.get(event.threadId);
      if (queue) queue.push(event); else queues.set(event.threadId, [event]);
    }
    for (const threadId of [...this.endedTurns.keys()]) if (!queues.has(threadId)) this.endedTurns.delete(threadId);
    for (const [threadId, queue] of queues) {
      if (this.stopping) break;
      // Preserve durable per-thread input order. Inputs of one thread are
      // offered strictly one after another, in queue order, never
      // concurrently. An accepted offer (the runtime returned its turn and the
      // turn is saved) does not hold back the next input: a burst is steered
      // into the running turn in one pass. An offer whose outcome is unknown
      // (no turn saved), an accepted offer whose turn is known to have ended,
      // a pending input in backoff, an input returned to pending for a
      // re-offer, or an offer under review fences the later inputs of the
      // thread: nothing more is offered on it in this pass, though its later
      // offered inputs are still reconciled. Other threads continue
      // independently. Only pending inputs of a paused or cancelled source are
      // skipped without fencing; an offered input fences whatever its source.
      // History is read once per thread per pass, back only to the oldest
      // input still awaiting admission, and that read serves every input.
      let oldest = queue[0]!.createdAt;
      for (const event of queue) if (event.createdAt < oldest) oldest = event.createdAt;
      const pass: ThreadPass = { since: inspectSince(oldest), unknown: 0, accepted: new Map(), noOffers: false };
      // The start fence and the fallback steer target consider every offered
      // input of the thread, wherever it is in the queue.
      for (const event of queue) {
        if (event.status !== 'offered') continue;
        if (!event.turnId) pass.unknown += 1;
        else if (event.error !== UNCONFIRMED_OFFER) {
          const at = Date.parse(event.offeredAt ?? '');
          const offeredAt = Number.isFinite(at) ? at : 0;
          if (offeredAt >= (pass.accepted.get(event.turnId) ?? -Infinity)) pass.accepted.set(event.turnId, offeredAt);
        }
      }
      for (const event of queue) {
        if (this.stopping) break;
        // Removed by cancel, or settled meanwhile by an operator decision.
        if (!this.state.events.includes(event) || (event.status !== 'pending' && event.status !== 'offered')) continue;
        const source = this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
        const paused = source?.paused === true;
        if (event.status === 'pending') {
          // Never offered while paused; never offered at all for a cancelled
          // source. Neither holds back the thread's other inputs.
          if (paused || source?.status === 'cancelled') continue;
          // Backoff gates only the act of offering; it fences what follows.
          // An input offered before may have landed late: deliver checks its
          // receipt first and applies these gates only to offering it.
          if (!event.offerAttempts) {
            if (event.nextAttemptAt && Date.parse(event.nextAttemptAt) > now) { pass.noOffers = true; continue; }
            if (pass.noOffers) continue;
          }
        }
        const key = eventKey(event.threadId, event.sourceId, event.eventId);
        // An operator operation is deciding this input: offer nothing after it,
        // and observe any proof about it again from the start afterwards.
        if (this.inFlight.has(key)) { pass.noOffers = true; this.proofSeenAt.delete(key); continue; }
        this.inFlight.add(key);
        const unknownBefore = event.status === 'offered' && !event.turnId;
        let result: Delivery = 'fence';
        try { result = await this.deliver(event, now, pass, paused); }
        finally { this.inFlight.delete(key); }
        if (unknownBefore && !(this.state.events.includes(event) && event.status === 'offered' && !event.turnId)) {
          pass.unknown -= 1;
        }
        if (result === 'failed') {
          // Without history nothing on the thread was observed: a first
          // complete proof must be observed again from the start.
          for (const e of queue) this.proofSeenAt.delete(eventKey(e.threadId, e.sourceId, e.eventId));
          break;
        }
        if (result === 'fence') pass.noOffers = true;
      }
      const ended = this.endedTurns.get(threadId);
      if (ended) {
        for (const turnId of ended) {
          if (!this.state.events.some(e => e.threadId === threadId && e.status === 'offered' && e.turnId === turnId))
            ended.delete(turnId);
        }
        if (!ended.size) this.endedTurns.delete(threadId);
      }
    }
    // Accepted inputs await receipts that appear only as their turn consumes
    // them. After a pass whose own delivery steps changed state, look again
    // shortly; after a pass that changed nothing itself, leave them to the
    // ordinary interval, so waiting on an unchanging history never becomes a
    // loop of quarter-second passes. Saves by other callers do not count.
    if (this.passChanged && this.state.events.some(isAcceptedOffer)) this.requestTick();
    } finally {
      this.ticking = false;
      this.finishTick?.();
      this.finishTick = undefined;
      this.tickFinished = undefined;
      if (this.followUpWanted) { this.followUpWanted = false; this.requestTick(); }
    }
  }

  /** The fallback steer target: the turn of the latest accepted, unconfirmed
   * offer of the thread that is not known to have ended. */
  private fallbackTurn(threadId: string, pass: ThreadPass): string | undefined {
    const ended = this.endedTurns.get(threadId);
    let latest: { turnId: string; at: number } | undefined;
    for (const [turnId, at] of pass.accepted) {
      if (!ended?.has(turnId) && (!latest || at >= latest.at)) latest = { turnId, at };
    }
    return latest?.turnId;
  }

  /**
   * Reconcile or offer one input; see `Delivery` for what the result means
   * for the later inputs of its thread. The steer target of a new offer is
   * the active turn of the pass's history read or, when that read shows none
   * (it may lag an RPC made moments earlier, in this or a recent pass), the
   * turn of the latest accepted, unconfirmed offer of the thread, anywhere in
   * its queue, that is not known to have ended. A turn is started only when
   * neither exists and no offer of the thread has an unknown outcome, so two
   * inputs never start two overlapping turns on one thread.
   */
  private async deliver(event: WakeEvent, now: number, pass: ThreadPass, paused: boolean): Promise<Delivery> {
    let admissionPhase: NonNullable<WakeEvent['failure']>['phase'] = 'inspect';
    let target: string | undefined;
    let fallback = false;
    // A pending input that may not be offered in this pass (backoff, or an
    // earlier fence); it reaches here only to have its receipt checked.
    const waiting = pass.noOffers || (!!event.nextAttemptAt && Date.parse(event.nextAttemptAt) > now);
    try {
      if (pass.failed) return 'failed';
      // A nonterminating native history read must not pin the only durable
      // scheduler tick forever. This is read-only; on expiry the thread waits
      // for a later pass. Never infer an admission receipt or resubmit an
      // ambiguous offered RPC from a timeout. Only a pending input that could
      // not be offered records the failure and its backoff: an offered input
      // is never in backoff, and an accepted one keeps waiting without fencing.
      let state: NativeView;
      try { state = await (pass.view ??= this.inspectWithDeadline(event.threadId, pass.since)); }
      catch (error) {
        pass.failed = true;
        if (event.status === 'pending' && !waiting) await this.recordFailure(event, error, 'inspect', now);
        return 'failed';
      }
      // The receipt is checked first: backoff never delays an admission.
      if (this.hasReceipt(event, state)) {
        await this.exclusive(async () => {
          this.receiptTurn(event, state);
          this.admitObserved(event, now);
          await this.saveTransition();
        });
        this.handOverAdmission(event);
        this.handOverGoalInput(event);
        return 'ok';
      }
      if (event.status === 'offered') {
        // An offered RPC is ambiguous even after a process crash: elapsed time
        // alone cannot prove the native service rejected it, and an accepted
        // steer may still be consumed. It is offered again only on positive
        // native proof, observed twice, that it is not in the thread.
        const outcome = await this.resolveUnconfirmedOffer(event, now, pass.since, state);
        if (outcome === 'held' || outcome === 'removed') return 'ok';
        // Back to pending: it is offered first in a later pass. A paused
        // source's input then waits like any pending paused input, and the
        // thread's other inputs proceed.
        if (outcome === 'reoffer') return paused ? 'ok' : 'fence';
        // Still offered: an accepted input whose turn is not known to have
        // ended waits for its receipt without fencing. Anything else (unknown
        // outcome, a turn known ended, under review) may still be offered
        // again or needs review, so later inputs must not overtake it.
        return event.turnId && event.error !== UNCONFIRMED_OFFER &&
          !this.endedTurns.get(event.threadId)?.has(event.turnId) ? 'ok' : 'fence';
      }
      if (waiting) return 'fence';
      target = state.activeTurnId ?? this.fallbackTurn(event.threadId, pass);
      // No turn to steer, and some offer of the thread has an unknown
      // outcome: a start could overlap a turn that offer began.
      if (!target && pass.unknown > 0) return 'fence';
      fallback = !!target && target !== state.activeTurnId;
      // Mark intent before the RPC: a crash between RPC and response must be
      // reconciled against native history, rather than immediately retried.
      admissionPhase = 'persist';
      const offering = await this.exclusive(async () => {
        // Removed by cancel, its source paused or cancelled, or settled while
        // the history was read: it is not offered, and holds nothing back.
        const current = this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
        if (!this.state.events.includes(event) || event.status !== 'pending' ||
            current?.status === 'cancelled' || current?.paused) return false;
        event.status = 'offered'; event.offeredAt = new Date(now).toISOString();
        try { await this.saveTransition(); }
        catch (error) {
          // The RPC was never made: the input is still pending.
          event.status = 'pending'; delete event.offeredAt;
          throw error;
        }
        return true;
      });
      if (!offering) return 'ok';
      admissionPhase = target ? 'steer' : 'start';
      const turnId = target
        ? await this.native.steer(event.threadId, target, wakeInput(event), wakeClientId(event))
        : await this.native.start(event.threadId, wakeInput(event), wakeClientId(event));
      admissionPhase = 'persist';
      this.steerRefusals.delete(`${event.threadId}:${event.sourceId}:${event.eventId}`);
      // A turn that just took an input is running, whatever was believed.
      this.endedTurns.get(event.threadId)?.delete(turnId);
      // Only once the turn is saved is the offer accepted. A crash before
      // this write leaves an offer of unknown outcome, which fences; until a
      // write succeeds the turn is not reported (see turnsUnsaved).
      await this.exclusive(async () => {
        event.turnId = turnId; this.turnsUnsaved.add(event);
        await this.saveTransition();
      });
      pass.accepted.set(turnId, now);
      return 'ok';
    } catch (error) {
      // The native steer endpoint explicitly rejected this input before
      // admission: the inspected turn ended between inspect and steer. Unlike
      // a timeout/disconnect, this is not an ambiguous accepted RPC and not a
      // source fault; the next pass inspects the SAME thread, now idle, and
      // starts it. No backoff, so the input is not held behind a finished turn.
      const refusalKey = `${event.threadId}:${event.sourceId}:${event.eventId}`;
      // The runtime definitely refused direct input to a sub-agent thread
      // before admission. Not ambiguous and never accepted on a retry: settle
      // the input as refused, so it neither replays nor fences later inputs.
      const original = error instanceof WakeAdmissionFailure ? error.original : error;
      if (event.status === 'offered' && isSubagentDirectInputRefusal(original)) {
        await this.exclusive(async () => {
          this.forgetEvent(event);
          event.status = 'refused'; event.message = '';
          event.refusal = { code: SUBAGENT_DIRECT_INPUT_UNSUPPORTED,
            parentThreadId: original instanceof SubagentDirectInputError ? original.parentThreadId : null };
          event.error = 'The thread takes work only through its parent thread';
          delete event.offeredAt; delete event.nextAttemptAt; delete event.failure;
          const source = this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
          if (source && source.status !== 'cancelled') {
            source.status = 'error'; source.nextAt = undefined; source.error = event.error;
            source.stopped = 'refusal';
          }
          await this.saveTransition();
        });
        this.requestTick();
        return 'fence';
      }
      if (event.status === 'offered' && admissionPhase === 'steer' && isNoActiveTurnSteer(error)) {
        // The steered turn has ended: not a fault, and never steered again.
        this.markEnded(event.threadId, target!);
        if (fallback) {
          // A turn history did not report active (an accepted offer's turn)
          // has ended. The input waits for the other receipts, or starts the
          // thread in a later pass; no backoff and no source error.
          await this.exclusive(async () => {
            event.status = 'pending'; delete event.offeredAt;
            await this.saveTransition();
          });
          this.requestTick();
          return 'fence';
        }
        // Once is the ordinary race. A second refusal in a row means history
        // still reports a turn the runtime no longer has: keep the input
        // pending, but retry on the normal interval and show why.
        const repeated = this.steerRefusals.has(refusalKey);
        if (repeated) this.steerRefusals.delete(refusalKey); else this.steerRefusals.add(refusalKey);
        await this.exclusive(async () => {
          event.status = 'pending'; delete event.offeredAt;
          if (repeated) {
            event.error = 'Active turn refused the input; retrying';
            event.nextAttemptAt = new Date(now + 60_000).toISOString();
            const source = this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
            if (source && source.status !== 'cancelled') { source.status = 'error'; source.error = event.error; }
          }
          await this.saveTransition();
        });
        if (!repeated) this.requestTick();
        return 'fence';
      }
      this.steerRefusals.delete(refusalKey);
      if (event.status === 'offered' && error instanceof WakeAdmissionFailure &&
          (error.phase === 'preflight' || error.phase === 'resume')) {
        // A pre-start failure cannot have submitted this user message; start
        // and steer failures remain ambiguous and must never replay blindly.
        event.status = 'pending';
        delete event.offeredAt;
      }
      // An ambiguous offer is now one of unknown outcome: no turn is started on
      // the thread until it is resolved.
      if (event.status === 'offered' && !event.turnId) pass.unknown += 1;
      await this.recordFailure(event, error, admissionPhase, now);
      return 'fence';
    }
  }

  /**
   * Record a native failure on an input: a bounded diagnostic, a visible
   * source error, and, only for an input that is (back to) pending, the
   * backoff before it is offered again. An offered input is never in
   * backoff: its receipt is checked every pass and it is offered again only
   * under the proof rule. A failed write leaves the state unsaved; the next
   * pass writes it before it offers anything.
   */
  private async recordFailure(event: WakeEvent, error: unknown,
    phase: NonNullable<WakeEvent['failure']>['phase'], now: number): Promise<void> {
    const explanation = safeError(error instanceof WakeAdmissionFailure ? error.original : error);
    const failure = nativeFailure(error, phase);
    // Diagnostic contains only bounded IDs and a digest, never native error
    // prose, user messages, provider responses or tool arguments.
    console.error('[Wake admission diagnostic]', JSON.stringify({
      sourceId: event.sourceId, eventId: event.eventId, clientId: wakeClientId(event), ...failure,
    }));
    await this.exclusive(async () => {
      if (!this.state.events.includes(event) || (event.status !== 'pending' && event.status !== 'offered')) {
        // Settled in memory (an admission whose write failed): the next pass
        // writes it; it carries no failure.
        return;
      }
      event.failure = failure;
      event.error = explanation;
      // Do not hammer auth, allowance, or transport errors.
      if (event.status === 'pending') {
        event.nextAttemptAt = new Date(now + (/operator action/.test(explanation) ? 300_000 : 60_000)).toISOString();
      }
      const source = this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
      if (source && source.status !== 'cancelled') {
        source.status = 'error';
        source.error = explanation;
      }
      await this.saveTransition();
    }).catch(() => undefined);
  }

  private hasReceipt(event: WakeEvent, state: Awaited<ReturnType<WakeNative['inspect']>>): boolean {
    return !!state.clientIds?.includes(wakeClientId(event)) ||
      state.messages.some(message => message === wakeInput(event) || message.startsWith(`${wakeInput(event)}\n`));
  }

  /**
   * An offer without a receipt is returned to pending, to be offered again
   * with the same client ID, only on positive proof that it is not in the
   * thread. This covers an offer whose RPC result was lost (timeout,
   * disconnect, crash; no turn saved) and an accepted offer whose turn ended
   * without consuming it.
   *
   * The proof, per offer, in one pass: it was offered at least a minute ago;
   * the pass's shared history read shows no active turn and no receipt; then
   * a fresh history read, the native custody read, and another fresh history
   * read are made in that order, both fresh reads show neither its client ID
   * nor its marker and no active turn, and custody reports its own turn (or,
   * with no turn saved, the latest turn, or none) ended, the thread not
   * active, and an empty native queue. A complete proof is only noted
   * (`proofSeenAt`); the input is acted on only when a later pass, at least
   * PROOF_CONFIRM_MS after that, observes the complete proof again. Any
   * contrary observation (a receipt, an active turn or thread, a queued
   * submission, a turn not terminal, a failed read) clears the note, as do
   * admission, hold, refusal and removal; a restart clears it too. The two
   * observations cover an accepted steer the runtime carries over into its
   * next turn: between turns it is in none of the reads above, but the next
   * turn is active, or holds its receipt, by the second observation.
   *
   * Each open offer of a thread is judged on its own. Without a custody
   * reader, or without that proof, it stays offered (`none`). After
   * MAX_REOFFERS re-offers it needs operator review (`review`); a thread input
   * (which has no source to review) is then held (`held`) so later inputs
   * proceed. An input of a cancelled source is removed instead (`removed`):
   * cancelling discards input not delivered, and it was proved not delivered.
   */
  private async resolveUnconfirmedOffer(event: WakeEvent, now: number, since: string | undefined,
    view: NativeView): Promise<'none' | 'reoffer' | 'review' | 'held' | 'removed'> {
    const key = eventKey(event.threadId, event.sourceId, event.eventId);
    const contrary = (): 'none' => { this.proofSeenAt.delete(key); return 'none'; };
    const custodyOf = this.native.custody;
    if (!custodyOf || !event.offeredAt) return contrary();
    const offeredAt = Date.parse(event.offeredAt);
    if (!Number.isFinite(offeredAt) || now - offeredAt < OFFER_PROOF_MS) return contrary();
    const attempts = event.offerAttempts ?? 0;
    if (attempts >= MAX_REOFFERS && event.error === UNCONFIRMED_OFFER) { contrary(); return 'review'; }
    if (view.activeTurnId || this.hasReceipt(event, view)) return contrary();
    let observed: { before: NativeView; custody: Awaited<ReturnType<NonNullable<WakeNative['custody']>>>;
      after: NativeView };
    try {
      // Both history reads are fresh, made here, never the pass's shared read.
      const before = await this.inspectWithDeadline(event.threadId, since, true);
      const custody = await this.withDeadline(custodyOf.call(this.native, event.threadId, event.turnId),
        'Native custody timeout');
      // Read again after custody, so an input that landed meanwhile is seen.
      const after = await this.inspectWithDeadline(event.threadId, since, true);
      observed = { before, custody, after };
    } catch { return contrary(); }
    const { before, custody, after } = observed;
    const ended = event.turnId
      ? TERMINAL_TURN.includes(custody.turnStatus ?? '')
      : custody.lastTurnId == null || TERMINAL_TURN.includes(custody.turnStatus ?? '');
    // A terminal turn never takes another steer: later inputs must not be
    // steered into it, nor overtake this offer while it is unresolved.
    if (event.turnId && ended) this.markEnded(event.threadId, event.turnId);
    if (!ended || custody.queuedSubmissionCount !== 0 || custody.threadStatus === 'active' ||
        before.activeTurnId || after.activeTurnId || this.hasReceipt(event, before) ||
        this.hasReceipt(event, after)) return contrary();
    const seen = this.proofSeenAt.get(key);
    if (seen === undefined || now < seen) { this.proofSeenAt.set(key, now); return 'none'; }
    if (now - seen < PROOF_CONFIRM_MS) return 'none';
    const expected = { offeredAt: event.offeredAt, turnId: event.turnId };
    return this.exclusive(async () => {
      // The offer must still be exactly the one the proof was about.
      if (!this.state.events.includes(event) || event.status !== 'offered' ||
          event.offeredAt !== expected.offeredAt || event.turnId !== expected.turnId) return contrary();
      this.forgetEvent(event);
      const source = this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
      if (source?.status === 'cancelled') {
        this.state.events = this.state.events.filter(e => e !== event);
        await this.saveTransition();
        return 'removed';
      }
      if (attempts < MAX_REOFFERS) {
        event.status = 'pending';
        event.offerAttempts = attempts + 1;
        delete event.offeredAt; delete event.turnId; delete event.nextAttemptAt;
        await this.saveTransition();
        this.requestTick();
        return 'reoffer';
      }
      event.error = UNCONFIRMED_OFFER;
      delete event.nextAttemptAt;
      if (source) {
        source.status = 'error'; source.nextAt = undefined; source.error = UNCONFIRMED_OFFER;
      }
      if (event.sourceId !== THREAD_INPUT_SOURCE) { await this.saveTransition(); return 'review'; }
      // No source record to review: hold it, retaining its text and ID, so
      // the caller's custody read reports `held` and later inputs proceed.
      event.status = 'held';
      await this.saveTransition();
      return 'held';
    });
  }

  private async withDeadline<T>(work: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), this.inspectTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * One native history read, bounded by the inspection timeout. At most one
   * read per thread is outstanding: a timed-out read may still complete
   * later, and no further read is started for that thread until it settles
   * (its entry is dropped then), so a hung runtime is never sent a new read
   * every pass and the map holds at most one entry per thread. A caller may
   * join the outstanding read when its window covers the one asked for;
   * `fresh` never joins, so a proof's reads are made after the call. A read
   * that can be neither joined nor started fails like a timeout.
   */
  private async inspectWithDeadline(threadId: string, since?: string, fresh = false): ReturnType<WakeNative['inspect']> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outstanding = this.nativeInspections.get(threadId);
    let inspection: ReturnType<WakeNative['inspect']>;
    if (outstanding) {
      const covers = outstanding.since === undefined || (since !== undefined && outstanding.since <= since);
      if (fresh || !covers) throw new Error('Native inspect busy; timeout');
      inspection = outstanding.read;
    } else {
      inspection = since === undefined ? this.native.inspect(threadId) : this.native.inspect(threadId, since);
      const entry = { since, read: inspection };
      this.nativeInspections.set(threadId, entry);
      void inspection.finally(() => {
        if (this.nativeInspections.get(threadId) === entry) this.nativeInspections.delete(threadId);
      }).catch(() => undefined);
    }
    try {
      return await Promise.race([
        inspection,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Native inspect timeout')), this.inspectTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runCommand(source: WakeSource): Promise<void> {
    const key = `${source.threadId}:${source.id}`;
    const inFlightKey = sourceKey(source.threadId, source.id);
    let transitioned = false;
    this.inFlight.add(inFlightKey);
    try {
      const shouldRun = await this.exclusive(async () => {
        if (source.paused || source.stopped ||
            !(source.status === 'waiting' || (source.status === 'error' && !!source.nextAt)) ||
            (source.status === 'error' && this.state.events.some(event =>
              event.threadId === source.threadId && event.sourceId === source.id &&
              (event.status === 'pending' || event.status === 'offered')))) return false;
        source.status = 'running';
        await this.save();
        return true;
      });
      if (!shouldRun) return;
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(source.argv![0], source.argv!.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
        this.commands.set(key, child);
        const chunks: Buffer[] = [];
        let size = 0;
        // A command source may run several bounded reads in sequence. This
        // limit must outlive them, otherwise an ordinary timeout is mistaken
        // for an allowance error.
        let reason: 'timeout' | 'output' | undefined;
        const timeout = setTimeout(() => { reason = 'timeout'; child.kill('SIGKILL'); }, 200_000);
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_STDOUT) { reason = 'output'; child.kill('SIGKILL'); }
          else chunks.push(chunk);
        });
        child.on('error', reject);
        child.on('close', code => { this.commands.delete(key); clearTimeout(timeout);
          code === 0 && size <= MAX_STDOUT ? resolve(Buffer.concat(chunks, size).toString('utf8')) :
            reject(new WakeCommandExit(reason ?? 'exit')); });
      });
      if (source.status === 'cancelled') return;
      const output = parseCommandOutput(stdout);
      if (output.waiting) {
        await this.exclusive(async () => {
          if (source.status === 'running') {
            source.status = 'waiting';
            transitioned = true;
            delete source.error;
            const outstanding = this.state.events.some(event => event.threadId === source.threadId &&
              event.sourceId === source.id && (event.status === 'pending' || event.status === 'offered'));
            source.moreAvailable = source.moreAvailable === true && outstanding;
            source.nextAt = new Date(Date.now() + commandRearmMs(source)).toISOString();
          }
          await this.save();
        });
        return;
      }
      this.checkBatch(source.threadId, source.id, output.events);
      // Events and the source transition commit in one section and one save,
      // so an admission can never observe the batch before its source re-arm.
      const added = await this.exclusive(async () => {
        if (source.status === 'cancelled') return 0;
        const { fresh } = this.addEvents(source.threadId, source.id, output.events);
        if (source.status === 'running') {
          source.status = 'waiting';
          transitioned = true;
          delete source.error;
          const outstanding = this.state.events.some(event => event.threadId === source.threadId &&
            event.sourceId === source.id && (event.status === 'pending' || event.status === 'offered'));
          // An empty or duplicate-only re-poll cannot erase an earlier fresh
          // batch's immediate drain before its last admission.
          source.moreAvailable = fresh.length > 0 || (source.moreAvailable === true && outstanding);
          source.nextAt = new Date(Date.now() + commandRearmMs(source)).toISOString();
        }
        // On a failed write the batch stays in memory, unsaved: nothing is
        // offered until a later write succeeds. The catch records this run's
        // error even after its status transition; re-emitted IDs stay stable.
        await this.saveForAcknowledgement();
        return fresh.length;
      });
      if (added) this.requestTick();
    } catch (error) {
      await this.exclusive(async () => {
        if (source.status !== 'running' &&
            !(transitioned && source.status === 'waiting' && !source.stopped)) return;
        source.status = 'error';
        source.error = safeError(error);
        source.nextAt = new Date(Date.now() + (/operator action/.test(source.error) ? 300_000 : 60_000)).toISOString();
        await this.save();
      });
    } finally { this.commands.delete(key); this.inFlight.delete(inFlightKey); }
  }
}
