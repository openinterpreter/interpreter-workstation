import { getCodexService } from '../../src/lib/codex/service';
import type { v2 } from '../handlers/codex-generated-types/index';
import { isSubagentDirectInputRefusal, SubagentDirectInputError } from '../../src/lib/codex/subagent-input';
import { WakeSources, WakeAdmissionFailure, type WakeNative } from './wakeSources';
import { recordOutcomeReturn } from './outcomeReturnsRuntime';

export async function startWakeThreadTurn(
  threadId: string,
  message: string,
  service = getCodexService(),
  clientUserMessageId?: string,
): Promise<string> {
  let thread;
  try { thread = await service.readThreadShell(threadId); }
  catch (error) { throw new WakeAdmissionFailure('preflight', error); }
  if (thread.id !== threadId) throw new Error('Wake destination changed');
  // An existing OIX thread retains its shell policy and caller token. Adding
  // keys during resume is rejected for loaded threads, while minting a token
  // here would not rotate the token already held by that native thread. The
  // original scoped caller remains recoverable through its persisted hash.
  // A saved thread that is not loaded has no live shell; the service resumes
  // it with a fresh caller from the registered unloaded-thread carrier.
  let phase: 'resume' | 'start' = 'resume';
  try { return await service.startExistingThreadTurn(threadId, message, thread.cwd ?? undefined, {
    mcp_servers: {},
  }, clientUserMessageId, next => { phase = next; }); }
  catch (error) { throw new WakeAdmissionFailure(phase, error); }
}

/** Turns newest first, back to the first turn that is recorded as having
 * ended before `since` (an ISO time), or every turn when `since` is absent.
 * Only a turn with a recorded end time older than the bound stops the scan: a
 * turn that ended before the oldest input still awaiting admission was
 * created cannot hold that input. A turn without an end time (running, or
 * interrupted by a crash) may have taken input steered into it long after it
 * started, so it is always read, and the scan continues past it. A scan that
 * reaches the page bound fails; it never reports the rest as absent. */
export async function readTurnsSince(threadId: string, since: string | undefined,
  service = getCodexService()): Promise<v2.Turn[]> {
  const bound = since === undefined ? undefined : Date.parse(since) / 1000;
  const turns: v2.Turn[] = [];
  await service.scanTurnsNewestFirst(threadId, turn => {
    if (bound !== undefined && Number.isFinite(bound) && turn.status !== 'inProgress' &&
        typeof turn.completedAt === 'number' && turn.completedAt < bound) return true;
    turns.push(turn);
    return false;
  });
  return turns.reverse();
}

/** The wake queue's view of a thread's history from `since` on: its active
 * turn and every persisted user message and client ID with its turn. */
export async function inspectThread(threadId: string, since: string | undefined,
  service = getCodexService()): ReturnType<WakeNative['inspect']> {
  await service.readThreadShell(threadId);
  const turns = await readTurnsSince(threadId, since, service);
  const messages: string[] = [];
  const messageTurnIds: string[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue;
      for (const input of item.content) {
        if (input.type === 'text') { messages.push(input.text); messageTurnIds.push(turn.id); }
      }
    }
  }
  return {
    activeTurnId: [...turns].reverse().find(turn => turn.status === 'inProgress')?.id,
    messages,
    messageTurnIds,
    clientIds: turns.flatMap(turn => turn.items.flatMap(item => item.type === 'userMessage' && item.clientId
      ? [item.clientId] : [])),
    clientTurns: turns.flatMap(turn => turn.items.flatMap(item => item.type === 'userMessage' && item.clientId
      ? [{ clientId: item.clientId, turnId: turn.id }] : [])),
  };
}

const TERMINAL_TURN = ['completed', 'interrupted', 'failed'];

/** The production native adapter of the wake queue. Exported for route tests. */
export const wakeNative: WakeNative = {
  inspect(threadId, since) {
    return inspectThread(threadId, since);
  },
  async custody(threadId, turnId) {
    const service = getCodexService();
    // Status, the latest turn and the native queue, without the history.
    const custody = await service.readNativeCustody(threadId);
    const observed: { turnStatus?: string } = { turnStatus: custody.lastTurnStatus ?? undefined };
    if (turnId && turnId !== custody.lastTurnId) {
      // An older turn: page back only as far as that turn, and report it only
      // when its own record says it ended. The scan stops at that exact turn,
      // never at a time bound; a turn not found leaves the status unknown, and
      // a scan that reaches the page bound fails, so neither proves anything.
      observed.turnStatus = undefined;
      await service.scanTurnsNewestFirst(threadId, turn => {
        if (turn.id !== turnId) return false;
        if (TERMINAL_TURN.includes(turn.status)) observed.turnStatus = turn.status;
        return true;
      });
    }
    return {
      turnStatus: observed.turnStatus,
      queuedSubmissionCount: custody.queuedSubmissionCount,
      lastTurnId: custody.lastTurnId,
      threadStatus: custody.status,
    };
  },
  async steer(threadId, turnId, message, clientUserMessageId) {
    try {
      return await getCodexService().steer(threadId, { turnId, message, clientUserMessageId });
    } catch (error) {
      if (!isSubagentDirectInputRefusal(error) || error instanceof SubagentDirectInputError) throw error;
      // Name the parent thread, so the sender can hand the work to it instead.
      let parentThreadId: string | null = null;
      try { parentThreadId = (await getCodexService().readThreadShell(threadId)).parentThreadId; }
      catch { /* The refusal stands without a parent ID. */ }
      throw new SubagentDirectInputError(threadId, parentThreadId);
    }
  },
  async start(threadId, message, clientUserMessageId) {
    return startWakeThreadTurn(threadId, message, getCodexService(), clientUserMessageId);
  },
  // The outcome of the turn that admitted a sender-attributed input goes back
  // to its sender. The event ID is the sender's client message ID, so an
  // `outcome-` delivery is never itself watched.
  onAdmitted({ threadId, eventId, turnId, sender }) {
    return recordOutcomeReturn(threadId, turnId, sender, eventId);
  },
};

const defaultWakeSources = new WakeSources(wakeNative);
export let wakeSources: WakeSources = defaultWakeSources;
let initialization: Promise<void> | undefined;
let stopping = false;
export function readyWakeSources(): Promise<void> {
  if (stopping) return Promise.reject(new Error('Wake admission is draining for restart'));
  const instance = wakeSources;
  return initialization ??= instance.initialize().catch(error => {
    initialization = undefined;
    throw error;
  });
}
/** Tests only: serve routes from an already initialized instance, or restore
 * the process instance (uninitialized) when called without one. */
export function useWakeSourcesForTest(instance?: WakeSources): void {
  wakeSources = instance ?? defaultWakeSources;
  initialization = instance ? Promise.resolve() : undefined;
  stopping = false;
}
/** Fence new admission, finish in-flight custody, then release the sole owner. */
export async function stopWakeSources(): Promise<void> {
  stopping = true;
  if (initialization) {
    try { await initialization; } catch { return; }
    await wakeSources.stop();
  }
}
export function startWakeSources(): void {
  void readyWakeSources().catch(error => {
    console.error('[Wake sources] Durable state unavailable; no wake input will be acknowledged.', error);
  });
}
