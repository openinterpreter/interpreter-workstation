import { getCodexService, lastAgentMessageText, onTurnEnded, turnEndedOutcome } from '../../src/lib/codex/service';
import type { v2 } from '../handlers/codex-generated-types/index';
import type { SubmissionSender } from './nativeSubmissionJournal';
import { OutcomeReturns, type TerminalOutcome, type TurnOutcome } from './outcomeReturns';

/** Native terminal usage limits are failed turns with a structured category,
 * not a fourth native TurnStatus. Never classify from free-form error text. */
export function createdTurnOutcome(outcome: TurnOutcome, error: unknown): TerminalOutcome {
  if (outcome !== 'failed' || !error || typeof error !== 'object') return outcome;
  const info = (error as { codexErrorInfo?: unknown }).codexErrorInfo;
  return info === 'usageLimitExceeded' || info === 'usageLimitReached' ||
    (info !== null && typeof info === 'object' && !Array.isArray(info) &&
      ('usageLimitExceeded' in info || 'usageLimitReached' in info)) ? 'usageLimited' : outcome;
}

/** The outcome of one turn if it ended, with its ordered items, paging back
 * newest first only as far as that turn; never the whole history in one read. */
export async function readEndedTurn(threadId: string, turnId: string, service = getCodexService()):
  Promise<{ outcome: TurnOutcome; terminalOutcome: TerminalOutcome; summary: string; items: unknown[] } | null> {
  let found: v2.Turn | undefined;
  await service.scanTurnsNewestFirst(threadId, turn => {
    if (turn.id !== turnId) return false;
    found = turn;
    return true;
  });
  const turn = found as v2.Turn | undefined;
  const outcome = turn ? turnEndedOutcome(turn.status) : null;
  return turn && outcome ? { outcome, terminalOutcome: createdTurnOutcome(outcome, turn.error),
    summary: lastAgentMessageText(turn.items), items: turn.items } : null;
}

export const outcomeReturns = new OutcomeReturns({
  command: process.env.WORKSTATION_OUTCOME_RETURN_COMMAND,
  readTurn: (threadId, turnId) => readEndedTurn(threadId, turnId),
});

let initialization: Promise<void> | undefined;
let stopping = false;
let unsubscribe: (() => void) | undefined;

export function readyOutcomeReturns(): Promise<void> {
  if (stopping) return Promise.reject(new Error('Outcome returns are stopping'));
  return initialization ??= outcomeReturns.initialize().catch(error => {
    initialization = undefined;
    throw error;
  });
}

/** Started beside the wake-source runtime; only a started runtime records outcomes. */
export function startOutcomeReturns(): void {
  unsubscribe ??= onTurnEnded(event => {
    void initialization?.then(() => outcomeReturns.turnEnded(event.threadId, event.turnId, event.outcome, event.summary))
      .catch(error => console.error('[Outcome returns] Could not record a turn ending.', error));
  });
  void readyOutcomeReturns().catch(error => {
    console.error('[Outcome returns] Durable state unavailable; outcomes will not be returned.', error);
  });
}

export async function stopOutcomeReturns(): Promise<void> {
  stopping = true;
  unsubscribe?.();
  unsubscribe = undefined;
  if (initialization) {
    try { await initialization; } catch { return; }
    await outcomeReturns.stop();
  }
}

/** Record the admitting turn of a sender-attributed input. True once the watch
 * is durable (or the input is itself an outcome delivery, which is never
 * watched); false when outcome returns are not running here or the store is
 * full. Rejects when the store cannot be written. `inputClientId` is the
 * client ID of the input's user message item in that turn. */
export async function recordOutcomeReturn(threadId: string, turnId: string, sender: SubmissionSender,
  clientUserMessageId: string, inputClientId?: string): Promise<boolean> {
  if (!unsubscribe) return false;
  await readyOutcomeReturns();
  return outcomeReturns.watch(threadId, turnId, sender, clientUserMessageId, inputClientId);
}

export async function recordCreatedTurnReturn(threadId: string, turnId: string, sender: SubmissionSender,
  clientUserMessageId: string): Promise<boolean> {
  if (!unsubscribe) return false;
  await readyOutcomeReturns();
  return outcomeReturns.watchCreated(threadId, turnId, sender, clientUserMessageId);
}

export async function recordCreatedTurnWithoutId(threadId: string, sender: SubmissionSender,
  clientUserMessageId: string): Promise<boolean> {
  if (!unsubscribe) return false;
  await readyOutcomeReturns();
  return outcomeReturns.createdWithoutTurn(threadId, sender, clientUserMessageId);
}

/** Refuse a sender-attributed create before native submission when custody
 * cannot run here; the exact-turn watch still has to be durably written later. */
export async function readyCreatedTurnReturns(): Promise<void> {
  if (!unsubscribe) throw new Error('Created-turn outcome custody unavailable.');
  await readyOutcomeReturns();
}
