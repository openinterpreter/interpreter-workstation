import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { getInterpreterAppDataDir } from '../configStore';
import { parseSubmissionSender, SUBMISSION_ID, type SubmissionSender } from './nativeSubmissionJournal';

export type OutcomeReturnStatus = 'watching' | 'pending' | 'delivered' | 'failed';
export type TurnOutcome = 'completed' | 'failed' | 'interrupted';
export type TerminalOutcome = TurnOutcome | 'usageLimited';
export type CreatedTurnOutcome = TerminalOutcome | 'unknown';
/** How an input entered its turn: it started the turn, it was steered into
 * the running turn, or that is not known (its item was not found, or the
 * entry was recorded without the ID of its item). */
export type InputAdmission = 'started' | 'steered' | 'unknown';
/** What an outcome's summary is: the last assistant text that followed this
 * input before the next input of the turn (`own_reply`); the turn's final
 * assistant text, only on an outcome that was already stored as pending
 * before inputs had their own outcome (`turn_reply`); a fixed sentence saying
 * the agent did not reply to this input separately (`no_separate_reply`); or a
 * fixed sentence saying the reply could not be determined, which is all an
 * entry recorded without its item ID can report (`unknown`). */
export type OutcomeReply = 'own_reply' | 'turn_reply' | 'no_separate_reply' | 'unknown';
export const NO_SEPARATE_REPLY_SUMMARY = 'The agent gave no separate reply to this input before the next input ' +
  'reached the same turn or the turn ended.';
export const UNKNOWN_REPLY_SUMMARY = 'The reply to this input could not be determined from its turn.';
export type OutcomeReturn = {
  /** Always absent on turn outcomes, which keeps the stored format unchanged. */
  kind?: undefined;
  id: string;
  threadId: string;
  turnId: string;
  sender: SubmissionSender;
  clientUserMessageId: string;
  /** Client ID of the input's user message item in the turn; absent on
   * entries recorded without it. */
  inputClientId?: string;
  status: OutcomeReturnStatus;
  outcome?: TurnOutcome;
  /** Set with the outcome; absent on entries resolved by earlier releases. */
  admission?: InputAdmission;
  reply?: OutcomeReply;
  summary?: string;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};
export type GoalNoticeStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
/** Fixed vocabulary for why a Goal changed; never free text. */
export type GoalNoticeReason = 'turn_error' | 'model_capacity_exhausted' | 'capacity_retry_pending' |
  'usage_limit' | 'budget_limit' | 'changed_during_turn' | 'changed_outside_turn' | 'unknown' |
  'resumed_on_input' | 'resume_bound_reached' | 'resume_result_unconfirmed';
/** Reason of the one transient notice for a block the automatic capacity
 * resume is about to retry; the block's outcome is reported after it. */
export const CAPACITY_RETRY_PENDING = 'capacity_retry_pending';
/** A Goal status change reported to the agent that assigned the Goal. Status
 * words, timestamps, native identity and a reason only: never the objective
 * or message text. */
export type GoalNotice = {
  status: GoalNoticeStatus;
  previousStatus?: GoalNoticeStatus;
  reason: GoalNoticeReason;
  /** The native Goal's creation and update times; they identify the Goal and this change. */
  createdAt: number;
  updatedAt: number;
  /** The native Goal's identity and revisions, when the runtime reported them. */
  goalId?: string;
  missionRevision?: number;
  lifecycleRevision?: number;
  /** Hash of an admitted input. Replayed bounded refusals dedupe by native Goal revision instead. */
  inputId?: string;
};
/** Why a Goal has no agent to tell: no sender of its thread named a thread,
 * or several did and none is known to have assigned it. */
export type GoalUnroutedReason = 'no_assigner' | 'ambiguous_assigner';
/** The immutable recipient of one Goal's notices. A native ID disambiguates
 * Goals created during the same second; older persisted records lack it. */
export type GoalAssigner = { threadId: string; goalCreatedAt: number; goalId?: string } & (
  { sender: SubmissionSender; source: 'turn' | 'sole_sender' } | { unrouted: GoalUnroutedReason });
type GoalNoticeReturnBase = {
  kind: 'goal';
  id: string;
  threadId: string;
  goal: GoalNotice;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};
/** A first-turn notification carries identifiers only, never assistant text. */
export type CreatedTurnReturn = {
  kind: 'created_turn'; origin: 'create'; id: string; threadId: string; turnId: string | null;
  sender: SubmissionSender; clientUserMessageId: string; status: OutcomeReturnStatus;
  outcome?: CreatedTurnOutcome; lastAgentMessageItemId?: string | null;
  attempts: number; nextAttemptAt?: string; createdAt: string; updatedAt: string;
};
/** A stored Goal notice, delivered by the same command as turn outcomes. An
 * unrouted notice is kept for visibility and never delivered. */
export type GoalNoticeReturn = GoalNoticeReturnBase & (
  { sender: SubmissionSender; unrouted?: undefined; status: Exclude<OutcomeReturnStatus, 'watching'> } |
  { sender?: undefined; unrouted: GoalUnroutedReason; status: 'unrouted' });
type StoredEntry = OutcomeReturn | GoalNoticeReturn | CreatedTurnReturn;
/** What the visibility route exposes: never the summary text. */
export type OutcomeReturnView = Pick<OutcomeReturn, 'id' | 'threadId' | 'turnId' | 'sender' | 'status' |
  'outcome' | 'admission' | 'reply' | 'attempts' | 'nextAttemptAt' | 'updatedAt'> |
  Pick<CreatedTurnReturn, 'kind' | 'origin' | 'id' | 'threadId' | 'turnId' | 'sender' | 'status' |
    'outcome' | 'lastAgentMessageItemId' | 'attempts' | 'nextAttemptAt' | 'updatedAt'> |
  (Pick<GoalNoticeReturnBase, 'kind' | 'id' | 'threadId' | 'goal' | 'attempts' | 'nextAttemptAt' | 'updatedAt'> &
    ({ sender: SubmissionSender; status: Exclude<OutcomeReturnStatus, 'watching'> } |
      { unrouted: GoalUnroutedReason; status: 'unrouted' }));
/** The single JSON object written to the configured command's standard input. */
export type OutcomeReturnPayload = {
  version: 1;
  kind: 'turn';
  id: string;
  to: SubmissionSender;
  from: { threadId: string; turnId: string };
  clientUserMessageId: string;
  outcome: TurnOutcome;
  admission: InputAdmission;
  reply: OutcomeReply;
  summary: string;
} | {
  version: 1; kind: 'created_turn'; origin: 'create'; id: string; to: SubmissionSender;
  from: { threadId: string; turnId?: string }; clientUserMessageId: string;
  outcome: CreatedTurnOutcome;
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
/** Goal assigner records kept; the oldest is dropped first. */
export const GOAL_ASSIGNER_LIMIT = 500;
const COMMAND_TIMEOUT_MS = 120_000;
const TICK_MS = 5_000;
const RECONCILE_TIMEOUT_MS = 10_000;
/** Re-check of watched turns whose end was not observed. */
const RECHECK_MS = 60_000;
export const CREATED_WATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECENTLY_ENDED_LIMIT = 64;
/** Saved reads of a turn that may lag its live final text before one is accepted. */
const EARLY_READ_LIMIT = 3;
const STATUSES: OutcomeReturnStatus[] = ['watching', 'pending', 'delivered', 'failed'];
const OUTCOMES: TurnOutcome[] = ['completed', 'failed', 'interrupted'];
const ADMISSIONS: readonly InputAdmission[] = ['started', 'steered', 'unknown'];
const REPLIES: readonly OutcomeReply[] = ['own_reply', 'turn_reply', 'no_separate_reply', 'unknown'];
export const GOAL_NOTICE_STATUSES: readonly GoalNoticeStatus[] =
  ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'];
const GOAL_NOTICE_REASONS: readonly GoalNoticeReason[] = ['turn_error', 'model_capacity_exhausted',
  CAPACITY_RETRY_PENDING, 'usage_limit', 'budget_limit', 'changed_during_turn', 'changed_outside_turn',
  'unknown', 'resumed_on_input', 'resume_bound_reached', 'resume_result_unconfirmed'];
const GOAL_UNROUTED_REASONS: readonly GoalUnroutedReason[] = ['no_assigner', 'ambiguous_assigner'];
const GOAL_ASSIGNER_SOURCES: readonly string[] = ['turn', 'sole_sender'];
const GOAL_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const GOAL_NOTICE_KEYS = ['status', 'previousStatus', 'reason', 'createdAt', 'updatedAt', 'goalId',
  'missionRevision', 'lifecycleRevision', 'inputId'];

/** Stable delivery ID of one turn's outcome for one sender's input: every
 * input that started or steered the turn gets its own return. */
export function outcomeReturnId(threadId: string, turnId: string, clientUserMessageId: string): string {
  return createHash('sha256').update(`${threadId}:${turnId}:${clientUserMessageId}`).digest('hex');
}
export function createdTurnReturnId(threadId: string, turnId: string | null,
  clientUserMessageId: string): string {
  return createHash('sha256').update(JSON.stringify(['create', threadId, turnId, clientUserMessageId])).digest('hex');
}
/** Only the native saved item ID, never the synthetic subagent UI ID. */
export function lastAgentMessageItemId(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index] as { type?: unknown; id?: unknown } | null;
    if (item?.type === 'agentMessage') {
      return typeof item.id === 'string' && SUBMISSION_ID.test(item.id) ? item.id : null;
    }
  }
  return null;
}
/** The ID of a turn's return as written before each input had its own. An
 * entry carried over from `outcome-returns.json` keeps it, so its delivery ID
 * never changes. */
export function earlierOutcomeReturnId(threadId: string, turnId: string): string {
  return createHash('sha256').update(`${threadId}:${turnId}`).digest('hex');
}
const turnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);

/** Stable delivery ID of one Goal change: the thread, the Goal (its creation
 * time), the new status and the Goal's update time of that change. The
 * transient notice of a pending automatic resume has its own ID, so the
 * block's later outcome is a separate notice even with the same times. */
export function goalNoticeId(threadId: string,
  goal: Pick<GoalNotice, 'status' | 'createdAt' | 'updatedAt' | 'inputId' | 'goalId' |
    'missionRevision' | 'lifecycleRevision'> & { reason?: GoalNoticeReason }): string {
  if (goal.reason === 'resume_bound_reached' && goal.goalId !== undefined &&
      Number.isInteger(goal.missionRevision) && Number.isInteger(goal.lifecycleRevision)) {
    return createHash('sha256').update(JSON.stringify(['goal-bound-revision-v1', threadId, goal.goalId,
      goal.missionRevision, goal.lifecycleRevision, goal.status, goal.reason])).digest('hex');
  }
  const transient = goal.reason === CAPACITY_RETRY_PENDING ? `:${CAPACITY_RETRY_PENDING}` :
    goal.inputId ? `:${goal.reason}:${goal.inputId}` : '';
  const identity = goal.goalId ? `:${goal.goalId}` : '';
  return createHash('sha256').update(`goal:${threadId}:${goal.createdAt}:${goal.status}:${goal.updatedAt}${transient}${identity}`)
    .digest('hex');
}

/** Read-only compatibility for notices persisted before native Goal IDs and
 * bounded-revision recipient IDs were incorporated into delivery IDs. */
function legacyGoalNoticeId(threadId: string,
  goal: Pick<GoalNotice, 'status' | 'createdAt' | 'updatedAt' | 'inputId'> & { reason?: GoalNoticeReason }): string {
  const transient = goal.reason === CAPACITY_RETRY_PENDING ? `:${CAPACITY_RETRY_PENDING}` :
    goal.inputId ? `:${goal.reason}:${goal.inputId}` : '';
  return createHash('sha256').update(`goal:${threadId}:${goal.createdAt}:${goal.status}:${goal.updatedAt}${transient}`)
    .digest('hex');
}

function sameBoundRevision(a: GoalNotice, b: GoalNotice): boolean {
  return a.reason === 'resume_bound_reached' && b.reason === 'resume_bound_reached' &&
    a.goalId !== undefined && a.goalId === b.goalId && a.status === b.status &&
    a.missionRevision !== undefined && a.missionRevision === b.missionRevision &&
    a.lifecycleRevision !== undefined && a.lifecycleRevision === b.lifecycleRevision;
}

function sameGoalRecipient(entry: GoalNoticeReturn, route: { sender: SubmissionSender } |
  { unrouted: GoalUnroutedReason }): boolean {
  if ('sender' in route) return entry.sender?.computer === route.sender.computer &&
    (entry.sender.thread ?? null) === (route.sender.thread ?? null);
  return entry.status === 'unrouted' && entry.unrouted === route.unrouted;
}

function recipientGoalNoticeId(baseId: string, sender: SubmissionSender): string {
  return createHash('sha256').update(`${baseId}:${JSON.stringify([sender.computer,
    sender.thread ?? null])}`).digest('hex');
}

function unroutedBoundNoticeId(baseId: string, reason: GoalUnroutedReason): string {
  return createHash('sha256').update(JSON.stringify(['goal-bound-unrouted-v1', baseId, reason])).digest('hex');
}

const GOAL_STATUS_WORDS: Record<GoalNoticeStatus, string> = { active: 'active again', paused: 'paused',
  blocked: 'blocked', usageLimited: 'stopped by a usage limit', budgetLimited: 'stopped by its token budget',
  complete: 'complete' };

/** The plain sentence a receiver can deliver for a Goal notice. Built only
 * from status words, IDs and revisions. */
export function goalNoticeSummary(threadId: string, goal: GoalNotice): string {
  if (goal.reason === 'resume_result_unconfirmed') {
    return `Goal resume on thread ${threadId} has an unconfirmed result` +
      (goal.goalId ? ` (goal ${goal.goalId}).` : '.');
  }
  const previous = goal.previousStatus ? `, previously ${goal.previousStatus}` : '';
  const identity = [goal.goalId !== undefined && `goal ${goal.goalId}`,
    goal.missionRevision !== undefined && `mission revision ${goal.missionRevision}`,
    goal.lifecycleRevision !== undefined && `lifecycle revision ${goal.lifecycleRevision}`].filter(Boolean).join(', ');
  return `Goal on thread ${threadId} is ${GOAL_STATUS_WORDS[goal.status]} (status ${goal.status}${previous}; ` +
    `reason ${goal.reason}${identity ? `; ${identity}` : ''}).`;
}

const validRevision = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);

function validGoalNotice(value: unknown): value is GoalNotice {
  const goal = value as GoalNotice;
  return !!goal && typeof goal === 'object' && GOAL_NOTICE_STATUSES.includes(goal.status) &&
    (goal.previousStatus === undefined || GOAL_NOTICE_STATUSES.includes(goal.previousStatus)) &&
    GOAL_NOTICE_REASONS.includes(goal.reason) && Number.isFinite(goal.createdAt) &&
    Number.isFinite(goal.updatedAt) &&
    (goal.goalId === undefined || (typeof goal.goalId === 'string' && GOAL_ID.test(goal.goalId))) &&
    validRevision(goal.missionRevision) && validRevision(goal.lifecycleRevision) &&
    (goal.inputId === undefined || /^[0-9a-f]{64}$/.test(goal.inputId)) &&
    Object.keys(goal).every(key => GOAL_NOTICE_KEYS.includes(key));
}

function validGoalAssigner(value: unknown): value is GoalAssigner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.threadId !== 'string' || !Number.isFinite(record.goalCreatedAt)) return false;
  if (record.goalId !== undefined && (typeof record.goalId !== 'string' || !GOAL_ID.test(record.goalId))) return false;
  const keys = Object.keys(record).filter(key => key !== 'goalId').sort().join();
  if (keys === 'goalCreatedAt,threadId,unrouted') {
    return GOAL_UNROUTED_REASONS.includes(record.unrouted as GoalUnroutedReason);
  }
  return keys === 'goalCreatedAt,sender,source,threadId' && !!parseSubmissionSender(record.sender)?.thread &&
    GOAL_ASSIGNER_SOURCES.includes(record.source as string);
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

/** One user input of a turn and the last non-empty assistant text that
 * followed it before the next user input ('' when none did). */
export type TurnInputReply = { clientId: string | null; reply: string };

/** The user inputs of a turn in order, each with its own reply, from the
 * turn's ordered items. Null when the items are not a list. */
export function turnInputReplies(items: unknown): TurnInputReply[] | null {
  if (!Array.isArray(items)) return null;
  const inputs: TurnInputReply[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const { type, clientId, text } = item as { type?: unknown; clientId?: unknown; text?: unknown };
    if (type === 'userMessage') {
      inputs.push({ clientId: typeof clientId === 'string' ? clientId : null, reply: '' });
    } else if (type === 'agentMessage' && typeof text === 'string' && text && inputs.length) {
      inputs[inputs.length - 1]!.reply = truncateOutcomeSummary(text);
    }
  }
  return inputs;
}

/** The outcome of one input of an ended turn, or null while the turn's items
 * are needed and have not been read. An input is found by the client ID of
 * its user message item, never by its text. An entry recorded without that ID
 * cannot be matched to an item at all: a turn holding a single input may hold
 * another one than this entry's, so it reports that its reply is unknown and
 * never receives any text of the turn. */
export function inputOutcome(inputClientId: string | undefined,
  turn: { summary: string; inputs: TurnInputReply[] | null }):
  { summary: string; admission: InputAdmission; reply: OutcomeReply } | null {
  const none = (admission: InputAdmission) =>
    ({ summary: NO_SEPARATE_REPLY_SUMMARY, admission, reply: 'no_separate_reply' as const });
  if (inputClientId === undefined) {
    return { summary: UNKNOWN_REPLY_SUMMARY, admission: 'unknown', reply: 'unknown' };
  }
  // Never decided without the turn's saved items.
  if (!turn.inputs) return null;
  const index = turn.inputs.findIndex(input => input.clientId === inputClientId);
  // Not found, or found twice: never another input's reply.
  if (index < 0 || turn.inputs.some((input, at) => at !== index && input.clientId === inputClientId)) {
    return { summary: UNKNOWN_REPLY_SUMMARY, admission: 'unknown', reply: 'unknown' };
  }
  const admission = index === 0 ? 'started' : 'steered';
  const text = turn.inputs[index]!.reply;
  return text ? { summary: text, admission, reply: 'own_reply' } : none(admission);
}

export type OutcomeReturnsOptions = {
  /** Directory holding `outcome-returns-2.json`; defaults to the app data dir. */
  root?: string;
  /** Raw `WORKSTATION_OUTCOME_RETURN_COMMAND` value. */
  command: string | undefined;
  now?: () => number;
  /** One bounded read of whether a watched turn already ended: at startup for
   * every watched turn, when a watch is recorded for a turn not seen ending,
   * and then periodically for every turn still watched. */
  readTurn?: (threadId: string, turnId: string) =>
    Promise<{ outcome: TurnOutcome; terminalOutcome?: TerminalOutcome; summary: string; items?: unknown[] } | null>;
  commandTimeoutMs?: number;
  /** Interval of the periodic re-check of watched turns; 0 disables it. */
  recheckMs?: number;
  /** How long a caller waits for one end check (default 10 seconds). */
  readTimeoutMs?: number;
};

function validEntry(value: unknown): value is StoredEntry {
  if (value && typeof value === 'object' && (value as CreatedTurnReturn).kind === 'created_turn') {
    const entry = value as CreatedTurnReturn;
    return entry.origin === 'create' && typeof entry.threadId === 'string' && !!entry.threadId &&
      (entry.turnId === null || typeof entry.turnId === 'string') &&
      (entry.turnId !== null || entry.outcome === 'unknown' && entry.status !== 'watching') &&
      !!parseSubmissionSender(entry.sender)?.thread &&
      SUBMISSION_ID.test(entry.clientUserMessageId) &&
      entry.id === createdTurnReturnId(entry.threadId, entry.turnId, entry.clientUserMessageId) &&
      STATUSES.includes(entry.status) &&
      (entry.status === 'watching'
        ? entry.outcome === undefined && entry.lastAgentMessageItemId === undefined
        : entry.outcome !== undefined && entry.lastAgentMessageItemId !== undefined) &&
      (entry.outcome === undefined || [...OUTCOMES, 'usageLimited', 'unknown'].includes(entry.outcome)) &&
      (entry.lastAgentMessageItemId === undefined || entry.lastAgentMessageItemId === null ||
        SUBMISSION_ID.test(entry.lastAgentMessageItemId)) &&
      Number.isInteger(entry.attempts) && entry.attempts >= 0 &&
      (entry.nextAttemptAt === undefined || typeof entry.nextAttemptAt === 'string') &&
      typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string' &&
      Object.keys(entry).every(key => ['kind', 'origin', 'id', 'threadId', 'turnId', 'sender',
        'clientUserMessageId', 'status', 'outcome', 'lastAgentMessageItemId', 'attempts',
        'nextAttemptAt', 'createdAt', 'updatedAt'].includes(key));
  }
  if (value && typeof value === 'object' && (value as GoalNoticeReturn).kind === 'goal') {
    const entry = value as GoalNoticeReturn;
    const route = entry.status === 'unrouted'
      ? entry.sender === undefined && GOAL_UNROUTED_REASONS.includes(entry.unrouted) && entry.attempts === 0 &&
        entry.nextAttemptAt === undefined
      : entry.unrouted === undefined && !!parseSubmissionSender(entry.sender) && STATUSES.includes(entry.status) &&
        entry.status !== ('watching' as OutcomeReturnStatus);
    return typeof entry.threadId === 'string' && validGoalNotice(entry.goal) &&
      (entry.id === goalNoticeId(entry.threadId, entry.goal) ||
        entry.goal.goalId !== undefined &&
        entry.id === legacyGoalNoticeId(entry.threadId, entry.goal) ||
        entry.sender !== undefined && entry.id === recipientGoalNoticeId(
          goalNoticeId(entry.threadId, entry.goal), entry.sender) ||
        entry.goal.reason === 'resume_bound_reached' && entry.status === 'unrouted' &&
          entry.id === unroutedBoundNoticeId(goalNoticeId(entry.threadId, entry.goal), entry.unrouted)) && route &&
      Number.isInteger(entry.attempts) && entry.attempts >= 0 &&
      (entry.nextAttemptAt === undefined || typeof entry.nextAttemptAt === 'string') &&
      typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string';
  }
  const entry = value as OutcomeReturn & { kind?: unknown };
  return !!entry && typeof entry === 'object' && entry.kind === undefined && /^[0-9a-f]{64}$/.test(entry.id) &&
    typeof entry.threadId === 'string' && typeof entry.turnId === 'string' &&
    !!parseSubmissionSender(entry.sender) && typeof entry.clientUserMessageId === 'string' &&
    SUBMISSION_ID.test(entry.clientUserMessageId) &&
    (entry.inputClientId === undefined ||
      (typeof entry.inputClientId === 'string' && SUBMISSION_ID.test(entry.inputClientId))) &&
    (entry.admission === undefined || ADMISSIONS.includes(entry.admission)) &&
    (entry.reply === undefined || REPLIES.includes(entry.reply)) &&
    (entry.id === outcomeReturnId(entry.threadId, entry.turnId, entry.clientUserMessageId) ||
      entry.id === earlierOutcomeReturnId(entry.threadId, entry.turnId)) &&
    STATUSES.includes(entry.status) &&
    (entry.outcome === undefined || OUTCOMES.includes(entry.outcome)) &&
    (entry.summary === undefined || typeof entry.summary === 'string') &&
    Number.isInteger(entry.attempts) && entry.attempts >= 0 &&
    (entry.nextAttemptAt === undefined || typeof entry.nextAttemptAt === 'string') &&
    typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string';
}

/**
 * Durable record of sender-attributed turns whose outcome is returned to the
 * sending host by a configured command, and of Goal notices sent to the agent
 * bound as each Goal's assigner through the same command, with those
 * bindings. One private file, atomically replaced
 * (temp file, fsync, rename, directory fsync) under a serialised write chain.
 * Delivery is at-least-once: a restart during a running command retries it,
 * so receivers must deduplicate on `id`.
 */
export class OutcomeReturns {
  private entries: StoredEntry[] = [];
  private assigners: GoalAssigner[] = [];
  private chain = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private recheckTimer?: ReturnType<typeof setInterval>;
  /** The one outstanding end check per watched turn. */
  private readonly checks = new Map<string, Promise<void>>();
  private delivering?: Promise<void>;
  private child?: ChildProcess;
  private stopping = false;
  private refusalLogged = false;
  /** Turns that ended before their watch was recorded (in-memory, bounded). */
  private readonly recentlyEnded = new Map<string,
    { outcome: TurnOutcome; terminalOutcome: TerminalOutcome; summary: string;
      inputs: TurnInputReply[] | null; lastAgentMessageItemId: string | null }>();
  /** Saved reads refused as earlier than a turn's live final text, per turn (in-memory). */
  private readonly earlyReads = new Map<string, number>();
  private readonly file: string;
  /** The state file of releases before Goal assigners were bound. */
  private readonly earlierFile: string;
  private readonly argv: string[] | null;
  private readonly now: () => number;
  private readonly commandTimeoutMs: number;

  constructor(private readonly options: OutcomeReturnsOptions) {
    const root = options.root ?? getInterpreterAppDataDir();
    this.file = path.join(root, 'outcome-returns-2.json');
    this.earlierFile = path.join(root, 'outcome-returns.json');
    this.argv = parseOutcomeReturnCommand(options.command);
    this.now = options.now ?? Date.now;
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  }

  /** Load durable state, reconcile watched turns once, and start delivery. */
  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const read = async (file: string) => {
      try { return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      }
    };
    const state = await read(this.file);
    if (state) {
      if (state.version !== 2 || !Array.isArray(state.entries) || !state.entries.every(validEntry) ||
          !Array.isArray(state.goalAssigners) || state.goalAssigners.length > GOAL_ASSIGNER_LIMIT ||
          !state.goalAssigners.every(validGoalAssigner)) {
        throw new Error('Invalid outcome return state');
      }
      this.entries = state.entries;
      this.assigners = state.goalAssigners;
    } else {
      // First start on this format: carry over the earlier file's entries. That
      // file is left as it is, so the release that wrote it can still read it.
      const earlier = await read(this.earlierFile);
      if (earlier) {
        if (earlier.version !== 1 || !Array.isArray(earlier.entries) || !earlier.entries.every(validEntry)) {
          throw new Error('Invalid outcome return state');
        }
        this.entries = earlier.entries;
      }
      // Written now rather than on the first change, so the file shows what
      // this start loaded.
      await this.save();
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
    // A turn whose end was missed (a failed or timed-out read, a lost
    // notification) is read again on a bounded interval while it is watched.
    const recheckMs = this.options.recheckMs ?? RECHECK_MS;
    if (recheckMs > 0) {
      this.recheckTimer = setInterval(() => { void this.reconcileWatching(); }, recheckMs);
      this.recheckTimer.unref?.();
    }
  }

  /** Stop the timers and any running command; a stopped attempt stays pending. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.timer = undefined;
    this.recheckTimer = undefined;
    this.child?.kill('SIGKILL');
    await this.delivering;
    // A hung read is not waited for beyond its bound; its late result is ignored.
    await Promise.allSettled([...this.checks.values()].map(check => this.bounded(check)));
    await this.chain;
  }

  /** Record that one sender's input started or steered a turn. Each input of a
   * turn is watched separately and gets its own return. Idempotent per input;
   * false when the store is full. A turn not seen ending is read once, so a
   * watch recorded after its turn ended still resolves. `inputClientId` is
   * the client ID of the input's user message item in the turn, which finds
   * the part of the turn that answered this input. */
  async watch(threadId: string, turnId: string, sender: SubmissionSender,
    clientUserMessageId: string, inputClientId?: string): Promise<boolean> {
    const checked = parseSubmissionSender(sender);
    if (!checked || !SUBMISSION_ID.test(clientUserMessageId) ||
        (inputClientId !== undefined && !SUBMISSION_ID.test(inputClientId))) throw new Error('Invalid outcome return');
    if (isOutcomeDelivery(clientUserMessageId)) return true;
    const id = outcomeReturnId(threadId, turnId, clientUserMessageId);
    const result = await this.exclusive(async () => {
      // A carried-over entry has the earlier ID; the input itself identifies it.
      if (this.entries.some(entry => entry.id === id || (entry.kind === undefined && entry.threadId === threadId &&
          entry.turnId === turnId && entry.clientUserMessageId === clientUserMessageId))) return 'known' as const;
      if (!this.makeRoom()) return 'full' as const;
      const at = new Date(this.now()).toISOString();
      const entry: OutcomeReturn = { id, threadId, turnId, sender: checked, clientUserMessageId,
        ...(inputClientId !== undefined && { inputClientId }),
        status: 'watching', attempts: 0, createdAt: at, updatedAt: at };
      // Kept, not taken: another input of the same turn may be watched next.
      const ended = this.recentlyEnded.get(turnKey(threadId, turnId));
      const resolved = ended && inputOutcome(inputClientId, ended);
      if (ended && resolved) {
        Object.assign(entry, { status: 'pending', outcome: ended.outcome, ...resolved, nextAttemptAt: at });
      }
      this.entries.push(entry);
      // A watch that is not on disk is not kept: a retry records it again
      // rather than finding it known and reporting it recorded.
      try { await this.save(); }
      catch (error) { this.entries.splice(this.entries.indexOf(entry), 1); throw error; }
      return resolved ? 'known' as const : 'watching' as const;
    });
    if (result === 'full') return false;
    if (result === 'watching') await this.checkEnded(threadId, turnId);
    return true;
  }

  /** Persist the exact first turn before acknowledging a sender-attributed create. */
  async watchCreated(threadId: string, turnId: string, sender: SubmissionSender,
    clientUserMessageId: string): Promise<boolean> {
    const checked = parseSubmissionSender(sender);
    if (!checked?.thread || !SUBMISSION_ID.test(clientUserMessageId)) throw new Error('Invalid created-turn return');
    if (isOutcomeDelivery(clientUserMessageId)) return true;
    const id = createdTurnReturnId(threadId, turnId, clientUserMessageId);
    const state = await this.exclusive(async () => {
      if (this.entries.some(entry => entry.id === id)) return 'known' as const;
      if (!this.makeRoom()) return 'full' as const;
      const at = new Date(this.now()).toISOString();
      const entry: CreatedTurnReturn = { kind: 'created_turn', origin: 'create', id, threadId, turnId,
        sender: checked, clientUserMessageId, status: 'watching', attempts: 0, createdAt: at, updatedAt: at };
      const ended = this.recentlyEnded.get(turnKey(threadId, turnId));
      if (ended?.inputs) {
        const matches = ended.inputs[0]?.clientId === clientUserMessageId &&
          ended.inputs.filter(input => input.clientId === clientUserMessageId).length === 1;
        Object.assign(entry, { status: 'pending', outcome: matches ? ended.terminalOutcome : 'unknown',
          lastAgentMessageItemId: matches ? ended.lastAgentMessageItemId : null, nextAttemptAt: at });
      }
      this.entries.push(entry);
      try { await this.save(); } catch (error) { this.entries.splice(this.entries.indexOf(entry), 1); throw error; }
      return entry.status === 'pending' ? 'known' as const : 'watching' as const;
    });
    if (state === 'full') return false;
    if (state === 'watching') await this.checkEnded(threadId, turnId);
    return true;
  }

  /** A created native thread without a first turn ID still owes exactly one
   * sender notice. Pre-native failures cannot name a thread and owe none. */
  async createdWithoutTurn(threadId: string, sender: SubmissionSender,
    clientUserMessageId: string): Promise<boolean> {
    const checked = parseSubmissionSender(sender);
    if (!checked?.thread || !SUBMISSION_ID.test(clientUserMessageId) || !threadId ||
        !SUBMISSION_ID.test(threadId)) throw new Error('Invalid created-turn return');
    if (isOutcomeDelivery(clientUserMessageId)) return true;
    return this.exclusive(async () => {
      const id = createdTurnReturnId(threadId, null, clientUserMessageId);
      if (this.entries.some(entry => entry.id === id)) return true;
      if (!this.makeRoom()) return false;
      const at = new Date(this.now()).toISOString();
      const entry: CreatedTurnReturn = { kind: 'created_turn', origin: 'create', id,
        threadId, turnId: null, sender: checked, clientUserMessageId,
        status: 'pending', outcome: 'unknown', lastAgentMessageItemId: null,
        attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at };
      this.entries.push(entry);
      try { await this.save(); } catch (error) { this.entries.splice(this.entries.indexOf(entry), 1); throw error; }
      return true;
    });
  }

  /** Mark every watch of a turn as ended, each with the outcome of its own
   * input (see `inputOutcome`); an unknown turn is only remembered briefly in
   * memory in case a watch is recorded just after it ends. `items` are the
   * turn's ordered items from a full history read; without them (`undefined`,
   * a live notification) a watch that needs them stays watching and the turn
   * is read. */
  async turnEnded(threadId: string, turnId: string, outcome: TurnOutcome, summary: string,
    items?: unknown, terminalOutcome: TerminalOutcome = outcome): Promise<void> {
    const awaitingItems = await this.exclusive(async () => {
      const key = turnKey(threadId, turnId);
      const previous = this.recentlyEnded.get(key);
      // A saved turn read before its final assistant item was written would
      // report an input as unanswered. The live notification carried the
      // turn's final text: while the saved items do not end with it yet, keep
      // watching and let the re-check read again, a bounded number of times.
      if (items !== undefined && previous && previous.inputs === null && previous.summary &&
          previous.summary !== truncateOutcomeSummary(summary)) {
        const early = (this.earlyReads.get(key) ?? 0) + 1;
        if (early <= EARLY_READ_LIMIT) {
          this.earlyReads.set(key, early);
          return false;
        }
      }
      this.earlyReads.delete(key);
      this.recentlyEnded.delete(key);
      const ended = { outcome, terminalOutcome, summary: truncateOutcomeSummary(summary),
        inputs: turnInputReplies(items) ?? previous?.inputs ?? null,
        lastAgentMessageItemId: items === undefined ? previous?.lastAgentMessageItemId ?? null
          : lastAgentMessageItemId(items) };
      this.recentlyEnded.set(key, ended);
      if (this.recentlyEnded.size > RECENTLY_ENDED_LIMIT) {
        this.recentlyEnded.delete(this.recentlyEnded.keys().next().value!);
      }
      const ofTurn = this.entries.filter((item): item is OutcomeReturn | CreatedTurnReturn =>
        (item.kind === undefined || item.kind === 'created_turn') &&
        item.threadId === threadId && item.turnId === turnId);
      const watching = ofTurn.filter(item => item.status === 'watching');
      if (!watching.length) return false;
      const at = new Date(this.now()).toISOString();
      let waiting = false;
      let changed = false;
      for (const entry of watching) {
        if (entry.kind === 'created_turn') {
          if (ended.inputs === null) { waiting = true; continue; }
          const matches = ended.inputs[0]?.clientId === entry.clientUserMessageId &&
            ended.inputs.filter(input => input.clientId === entry.clientUserMessageId).length === 1;
          Object.assign(entry, { status: 'pending', outcome: matches ? ended.terminalOutcome : 'unknown',
            lastAgentMessageItemId: matches ? ended.lastAgentMessageItemId : null,
            nextAttemptAt: at, updatedAt: at });
          changed = true;
          continue;
        }
        const resolved = inputOutcome(entry.inputClientId, ended);
        if (!resolved) { waiting = true; continue; }
        Object.assign(entry, { status: 'pending', outcome, ...resolved, nextAttemptAt: at, updatedAt: at });
        changed = true;
      }
      if (changed) await this.save();
      return waiting;
    });
    // The read reports the turn again with its items; a failed or empty read
    // is retried on the re-check interval.
    if (awaitingItems && items === undefined) await this.checkEnded(threadId, turnId);
  }

  /**
   * The Goal's assigner, bound the first time it is asked for and never
   * changed afterwards. From the recorded attributed inputs of the thread
   * (deliveries of outcomes and Goal notices are never recorded):
   * the one sender with a thread among the inputs of `turnId` (the turn in
   * which the Goal was observed), else the one sender with a thread among all
   * of the thread's inputs. A thread with no recorded input gets no record (a
   * local Goal); otherwise the Goal is recorded unrouted rather than guessed.
   */
  async bindGoalAssigner(threadId: string, goalCreatedAt: number, turnId: string | null,
    goalId?: string): Promise<GoalAssigner | null> {
    return this.exclusive(async () => {
      if (goalId !== undefined && !GOAL_ID.test(goalId)) return null;
      const known = this.assigners.find(item => item.threadId === threadId && item.goalCreatedAt === goalCreatedAt &&
        item.goalId === goalId);
      if (known) return structuredClone(known);
      const inputs = this.entries.filter((entry): entry is OutcomeReturn | CreatedTurnReturn =>
        (entry.kind === undefined || entry.kind === 'created_turn') &&
        entry.threadId === threadId);
      if (!inputs.length) return null;
      const threaded = (list: Array<OutcomeReturn | CreatedTurnReturn>) => {
        const senders = new Map<string, SubmissionSender>();
        for (const { sender } of list) {
          if (sender.thread) senders.set(JSON.stringify([sender.computer, sender.thread]), sender);
        }
        return [...senders.values()];
      };
      const ofTurn = turnId ? threaded(inputs.filter(entry => entry.turnId === turnId)) : [];
      const all = threaded(inputs);
      const identity = { threadId, goalCreatedAt, ...(goalId && { goalId }) };
      const record: GoalAssigner = ofTurn.length === 1
        ? { ...identity, sender: { ...ofTurn[0]! }, source: 'turn' }
        : all.length === 1 ? { ...identity, sender: { ...all[0]! }, source: 'sole_sender' }
          : { ...identity, unrouted: all.length ? 'ambiguous_assigner' : 'no_assigner' };
      this.assigners.push(record);
      const dropped = this.assigners.length > GOAL_ASSIGNER_LIMIT ? this.assigners.shift() : undefined;
      try { await this.save(); } catch (error) {
        this.assigners.splice(this.assigners.indexOf(record), 1);
        if (dropped) this.assigners.unshift(dropped);
        throw error;
      }
      return structuredClone(record);
    });
  }

  /** A retrying input cannot establish who originally assigned a Goal. */
  existingGoalAssigner(threadId: string, goalCreatedAt: number, goalId?: string): GoalAssigner | null {
    const known = this.assigners.find(item => item.threadId === threadId && item.goalCreatedAt === goalCreatedAt &&
      item.goalId === goalId);
    return known ? structuredClone(known) : null;
  }

  /** Threads with a recorded sender, most recently attributed first. */
  recentSenderThreads(limit: number): string[] {
    const threads: string[] = [];
    for (let index = this.entries.length - 1; index >= 0 && threads.length < limit; index--) {
      const entry = this.entries[index]!;
      if ((entry.kind === undefined || entry.kind === 'created_turn') && entry.threadId !== null &&
          !threads.includes(entry.threadId)) {
        threads.push(entry.threadId);
      }
    }
    return threads;
  }

  /** The thread's most recent distinct senders that named a thread, newest
   * first, at most `limit`. Used only when a Goal's assigner is ambiguous. */
  recentThreadedSenders(threadId: string, limit: number): SubmissionSender[] {
    const senders = new Map<string, SubmissionSender>();
    for (let index = this.entries.length - 1; index >= 0 && senders.size < limit; index--) {
      const entry = this.entries[index]!;
      if ((entry.kind !== undefined && entry.kind !== 'created_turn') || entry.threadId !== threadId ||
          !entry.sender.thread) continue;
      const key = JSON.stringify([entry.sender.computer, entry.sender.thread]);
      if (!senders.has(key)) senders.set(key, { ...entry.sender });
    }
    return [...senders.values()];
  }

  /** The last Goal notice recorded for a thread, delivered or not. */
  lastGoalNotice(threadId: string): GoalNotice | null {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!;
      if (entry.kind === 'goal' && entry.threadId === threadId) return { ...entry.goal };
    }
    return null;
  }

  /** Record a Goal notice: pending delivery to its assigner, or unrouted
   * (kept for visibility, never delivered). Idempotent on its ID; false when
   * the store is full of undelivered entries. `perRecipient` gives each
   * recipient of the same change its own entry. */
  async noticeGoal(threadId: string, route: { sender: SubmissionSender } | { unrouted: GoalUnroutedReason },
    goal: GoalNotice, options: { perRecipient?: boolean } = {}): Promise<boolean> {
    const checked = 'sender' in route ? parseSubmissionSender(route.sender) : null;
    if (('sender' in route ? !checked : !GOAL_UNROUTED_REASONS.includes(route.unrouted)) || !validGoalNotice(goal)) {
      throw new Error('Invalid Goal notice');
    }
    // One change told to several recipients needs one entry, and one ID, per recipient.
    const boundRevision = goal.reason === 'resume_bound_reached' && goal.goalId !== undefined &&
      Number.isInteger(goal.missionRevision) && Number.isInteger(goal.lifecycleRevision);
    const id = checked && (options.perRecipient || boundRevision)
      ? recipientGoalNoticeId(goalNoticeId(threadId, goal), checked)
      : boundRevision && 'unrouted' in route
        ? unroutedBoundNoticeId(goalNoticeId(threadId, goal), route.unrouted)
        : goalNoticeId(threadId, goal);
    return this.exclusive(async () => {
      if (this.entries.some(entry => entry.id === id ||
        entry.kind === 'goal' && entry.threadId === threadId && sameBoundRevision(entry.goal, goal) &&
        sameGoalRecipient(entry, checked ? { sender: checked } : route))) return true;
      if (!this.makeRoom()) return false;
      const at = new Date(this.now()).toISOString();
      this.entries.push(checked
        ? { kind: 'goal', id, threadId, sender: checked, goal: { ...goal }, status: 'pending', attempts: 0,
          nextAttemptAt: at, createdAt: at, updatedAt: at }
        : { kind: 'goal', id, threadId, unrouted: (route as { unrouted: GoalUnroutedReason }).unrouted,
          goal: { ...goal }, status: 'unrouted', attempts: 0, createdAt: at, updatedAt: at });
      await this.save();
      return true;
    });
  }

  list(): OutcomeReturnView[] {
    return this.entries.map((entry): OutcomeReturnView => {
      const { id, attempts, nextAttemptAt, updatedAt } = entry;
      if (entry.kind === undefined) {
        return { id, threadId: entry.threadId, turnId: entry.turnId, sender: { ...entry.sender }, status: entry.status,
          outcome: entry.outcome, admission: entry.admission, reply: entry.reply, attempts, nextAttemptAt, updatedAt };
      }
      if (entry.kind === 'created_turn') return { kind: 'created_turn', origin: 'create', id,
        threadId: entry.threadId, turnId: entry.turnId, sender: { ...entry.sender }, status: entry.status,
        outcome: entry.outcome, lastAgentMessageItemId: entry.lastAgentMessageItemId,
        attempts, nextAttemptAt, updatedAt };
      const base = { kind: 'goal' as const, id, threadId: entry.threadId, goal: { ...entry.goal },
        attempts, nextAttemptAt, updatedAt };
      return entry.status === 'unrouted'
        ? { ...base, unrouted: entry.unrouted, status: entry.status }
        : { ...base, sender: { ...entry.sender }, status: entry.status };
    });
  }

  /** Drop the oldest delivered, failed or unrouted entry while the store is full. */
  private makeRoom(): boolean {
    while (this.entries.length >= OUTCOME_RETURN_LIMIT) {
      const index = this.entries.findIndex(entry => entry.status === 'delivered' || entry.status === 'failed' ||
        entry.status === 'unrouted');
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
        : entry.kind === 'created_turn'
          ? { version: 1, kind: 'created_turn', origin: 'create', id: entry.id, to: { ...entry.sender },
            from: { threadId: entry.threadId, ...(entry.turnId !== null ? { turnId: entry.turnId } : {}) },
            clientUserMessageId: entry.clientUserMessageId, outcome: entry.outcome ?? 'failed' }
        : { version: 1, kind: 'turn', id: entry.id, to: { ...entry.sender },
          from: { threadId: entry.threadId, turnId: entry.turnId },
          clientUserMessageId: entry.clientUserMessageId, outcome: entry.outcome ?? 'failed',
          // An entry resolved by an earlier release carries the turn's final text.
          admission: entry.admission ?? 'unknown', reply: entry.reply ?? 'turn_reply',
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

  /** Check every turn still watched once (at startup and on the re-check interval). */
  private async reconcileWatching(): Promise<void> {
    const turns = new Map<string, { threadId: string; turnId: string }>();
    for (const entry of this.entries) {
      if ((entry.kind === undefined || entry.kind === 'created_turn') && entry.status === 'watching' &&
          entry.threadId !== null && entry.turnId !== null) {
        turns.set(turnKey(entry.threadId, entry.turnId), { threadId: entry.threadId, turnId: entry.turnId });
      }
    }
    await Promise.all([...turns.values()].map(({ threadId, turnId }) => this.checkEnded(threadId, turnId)));
    await this.expireCreatedWatches();
  }

  /** A native terminal read can be unavailable indefinitely. Close that
   * bounded uncertainty without inventing completed or a message pointer. */
  private async expireCreatedWatches(): Promise<void> {
    await this.exclusive(async () => {
      const due = this.entries.filter((entry): entry is CreatedTurnReturn => entry.kind === 'created_turn' &&
        entry.status === 'watching' && this.now() - Date.parse(entry.createdAt) >= CREATED_WATCH_MAX_AGE_MS);
      if (!due.length) return;
      const at = new Date(this.now()).toISOString();
      for (const entry of due) Object.assign(entry, { status: 'pending', outcome: 'unknown',
        lastAgentMessageItemId: null, nextAttemptAt: at, updatedAt: at });
      await this.save();
    });
  }

  /** One read of whether a turn ended; never throws, and the caller waits for
   * it only up to the read bound. A turn has at most one read outstanding,
   * until that read itself settles: a caller during one shares it, and a hung
   * runtime is not sent another read for the turn on every re-check. */
  private checkEnded(threadId: string, turnId: string): Promise<void> {
    const key = turnKey(threadId, turnId);
    let check = this.checks.get(key);
    if (!check) {
      const read = this.readEnded(threadId, turnId)
        .finally(() => { if (this.checks.get(key) === read) this.checks.delete(key); });
      this.checks.set(key, read);
      check = read;
    }
    return this.bounded(check);
  }

  private async readEnded(threadId: string, turnId: string): Promise<void> {
    const readTurn = this.options.readTurn;
    if (!readTurn || this.stopping) return;
    try {
      const ended = await readTurn(threadId, turnId);
      // `null` when the read carried no items: this call never reads again itself.
      if (ended && !this.stopping) {
        await this.turnEnded(threadId, turnId, ended.outcome, ended.summary, ended.items ?? null,
          ended.terminalOutcome ?? ended.outcome);
      }
    } catch {
      // Read again on the re-check interval; a live notification still counts.
    }
  }

  /** Wait for a check at most the read bound. */
  private async bounded(check: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([check, new Promise<void>(resolve => {
        timer = setTimeout(resolve, this.options.readTimeoutMs ?? RECONCILE_TIMEOUT_MS);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 2, entries: this.entries,
      goalAssigners: this.assigners })); await handle.sync(); }
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
