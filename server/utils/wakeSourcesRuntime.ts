import { getCodexService } from '../../src/lib/codex/service';
import { WakeSources, WakeAdmissionFailure } from './wakeSources';

export async function startWakeThreadTurn(
  threadId: string,
  message: string,
  service = getCodexService(),
  clientUserMessageId?: string,
): Promise<string> {
  let thread;
  try { thread = await service.readThread(threadId); }
  catch (error) { throw new WakeAdmissionFailure('preflight', error); }
  if (thread.id !== threadId) throw new Error('Wake destination changed');
  // An existing OIX thread retains its shell policy and caller token. Adding
  // keys during resume is rejected for loaded threads, while minting a token
  // here would not rotate the token already held by that native thread. The
  // original scoped caller remains recoverable through its persisted hash.
  let phase: 'resume' | 'start' = 'resume';
  try { return await service.startExistingThreadTurn(threadId, message, thread.cwd ?? undefined, {
    mcp_servers: {},
  }, clientUserMessageId, next => { phase = next; }); }
  catch (error) { throw new WakeAdmissionFailure(phase, error); }
}

export const wakeSources = new WakeSources({
  async inspect(threadId) {
    const thread = await getCodexService().readThread(threadId);
    if (thread.id !== threadId) throw new Error('Wake destination changed');
    return {
      activeTurnId: [...thread.turns].reverse().find(turn => turn.status === 'inProgress')?.id,
      messages: thread.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'userMessage'
        ? item.content.filter(input => input.type === 'text').map(input => input.text)
        : [])),
      clientIds: thread.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'userMessage' && item.clientId
        ? [item.clientId] : [])),
    };
  },
  async custody(threadId, turnId) {
    const service = getCodexService();
    const [thread, custody] = await Promise.all([service.readThread(threadId), service.readNativeCustody(threadId)]);
    return {
      turnStatus: thread.turns.find(turn => turn.id === turnId)?.status,
      queuedSubmissionCount: custody.queuedSubmissionCount,
      lastTurnId: custody.lastTurnId,
      threadStatus: custody.status,
    };
  },
  steer(threadId, turnId, message, clientUserMessageId) {
    return getCodexService().steer(threadId, { turnId, message, clientUserMessageId });
  },
  async start(threadId, message, clientUserMessageId) {
    return startWakeThreadTurn(threadId, message, getCodexService(), clientUserMessageId);
  },
});
let initialization: Promise<void> | undefined;
let stopping = false;
export function readyWakeSources(): Promise<void> {
  if (stopping) return Promise.reject(new Error('Wake admission is draining for restart'));
  return initialization ??= wakeSources.initialize().catch(error => {
    initialization = undefined;
    throw error;
  });
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
