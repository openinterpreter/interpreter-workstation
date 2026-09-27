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
export function readyWakeSources(): Promise<void> {
  return initialization ??= wakeSources.initialize().catch(error => {
    initialization = undefined;
    throw error;
  });
}
export function startWakeSources(): void {
  void readyWakeSources().catch(error => {
    console.error('[Wake sources] Durable state unavailable; no wake input will be acknowledged.', error);
  });
}
