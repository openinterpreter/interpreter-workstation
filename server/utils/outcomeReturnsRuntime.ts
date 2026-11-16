import { getCodexService, lastAgentMessageText, onTurnEnded, turnEndedOutcome } from '../../src/lib/codex/service';
import type { SubmissionSender } from './nativeSubmissionJournal';
import { OutcomeReturns } from './outcomeReturns';

export const outcomeReturns = new OutcomeReturns({
  command: process.env.WORKSTATION_OUTCOME_RETURN_COMMAND,
  // Reuses the ordinary native thread read that wake sources also use.
  async readTurn(threadId, turnId) {
    const thread = await getCodexService().readThread(threadId);
    if (thread.id !== threadId) return null;
    const turn = thread.turns.find(item => item.id === turnId);
    const outcome = turn ? turnEndedOutcome(turn.status) : null;
    return turn && outcome ? { outcome, summary: lastAgentMessageText(turn.items) } : null;
  },
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

/** Never throws: admission has already happened when this is called. */
export function watchOutcomeReturn(threadId: string, turnId: string, sender: SubmissionSender,
  clientUserMessageId: string): void {
  if (!unsubscribe) return;
  void readyOutcomeReturns().then(() => outcomeReturns.watch(threadId, turnId, sender, clientUserMessageId))
    .catch(error => console.error('[Outcome returns] Could not record a sender-attributed turn.', error));
}
