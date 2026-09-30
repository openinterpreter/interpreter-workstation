import { getCodexService } from '../../src/lib/codex/service';
import { WakeSources } from './wakeSources';

export const wakeSources = new WakeSources({
  async inspect(threadId) {
    const thread = await getCodexService().readThread(threadId);
    if (thread.id !== threadId) throw new Error('Wake destination changed');
    return {
      activeTurnId: [...thread.turns].reverse().find(turn => turn.status === 'inProgress')?.id,
      messages: thread.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'userMessage'
        ? item.content.filter(input => input.type === 'text').map(input => input.text)
        : [])),
    };
  },
  steer(threadId, turnId, message) {
    return getCodexService().steer(threadId, { turnId, message });
  },
  async start(threadId, message) {
    const thread = await getCodexService().readThread(threadId);
    if (thread.id !== threadId) throw new Error('Wake destination changed');
    return getCodexService().startExistingThreadTurn(threadId, message, thread.cwd ?? undefined);
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
