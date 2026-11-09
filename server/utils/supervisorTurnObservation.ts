import type { v2 } from '../handlers/codex-generated-types/index';

/** Native thread/read is a saved-turn observation, never a live OS process probe. */
export function projectSupervisorTurn(thread: v2.Thread, expectedThreadId: string) {
  if (thread.id !== expectedThreadId || !Array.isArray(thread.turns)) throw new Error('thread unavailable');
  const turns = thread.turns;
  const current = turns[turns.length - 1];
  if (!current) return { threadId: expectedThreadId, turn: null,
    latestMessage: null, command: null,
    modelPhase: { available: false, category: 'native_model_phase_unavailable' },
    observation: 'saved-native-thread-only' };
  if (!['inProgress', 'completed', 'interrupted', 'failed'].includes(current.status) ||
      !Array.isArray(current.items)) throw new Error('turn unavailable');
  let latestMessageTurnId: string | null = null;
  let messageAvailable = true;
  for (let index = turns.length - 1; index >= 0; index--) {
    if (turns[index].itemsView !== 'full' || !Array.isArray(turns[index].items)) {
      messageAvailable = false;
      break;
    }
    if (turns[index].items.some(item => item.type === 'agentMessage')) {
      latestMessageTurnId = turns[index].id;
      break;
    }
  }
  const commands = current.itemsView === 'full' ?
    current.items.filter(item => item.type === 'commandExecution') : [];
  const command = commands[commands.length - 1];
  return { threadId: expectedThreadId,
    turn: { id: current.id, status: current.status, startedAt: current.startedAt,
      completedAt: current.completedAt },
    latestMessage: !messageAvailable ? { relation: 'unavailable' } : latestMessageTurnId ? {
      turnId: latestMessageTurnId,
      relation: latestMessageTurnId === current.id ? 'current-turn' : 'historical' } : null,
    preview: { relation: 'initial-thread-historical-non-authoritative' },
    command: current.itemsView !== 'full' ? { observation: 'saved-items-unavailable' } : command ? {
      itemId: command.id, status: command.status,
      exitCode: command.exitCode, processId: command.processId,
      observation: 'saved-command-item-not-os-process-custody' } : null,
    // A turn's saved status and model configuration are not a live model call.
    modelPhase: { available: false, category: 'native_model_phase_unavailable' },
    observation: 'saved-native-thread-only' };
}
