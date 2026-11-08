import type { v2 } from '../handlers/codex-generated-types/index';

/** Native thread/read is a saved-turn observation, never a live OS process probe. */
export function projectSupervisorTurn(thread: v2.Thread, expectedThreadId: string) {
  if (thread.id !== expectedThreadId || !Array.isArray(thread.turns)) throw new Error('thread unavailable');
  const turns = thread.turns;
  const current = turns[turns.length - 1];
  if (!current) return { threadId: expectedThreadId, turn: null,
    latestMessage: null, command: null, observation: 'saved-native-thread-only' };
  if (!['inProgress', 'completed', 'interrupted', 'failed'].includes(current.status) ||
      !Array.isArray(current.items)) throw new Error('turn unavailable');
  let latestMessageTurnId: string | null = null;
  for (let index = turns.length - 1; index >= 0; index--) {
    if (!Array.isArray(turns[index].items)) throw new Error('items unavailable');
    if (turns[index].items.some(item => item.type === 'agentMessage')) {
      latestMessageTurnId = turns[index].id;
      break;
    }
  }
  const commands = current.items.filter(item => item.type === 'commandExecution');
  const command = commands[commands.length - 1];
  return { threadId: expectedThreadId,
    turn: { id: current.id, status: current.status, startedAt: current.startedAt,
      completedAt: current.completedAt },
    latestMessage: latestMessageTurnId ? { turnId: latestMessageTurnId,
      relation: latestMessageTurnId === current.id ? 'current-turn' : 'historical' } : null,
    preview: { relation: 'initial-thread-historical-non-authoritative' },
    command: command ? { itemId: command.id, status: command.status,
      exitCode: command.exitCode, processId: command.processId,
      observation: 'saved-command-item-not-os-process-custody' } : null,
    observation: 'saved-native-thread-only' };
}
