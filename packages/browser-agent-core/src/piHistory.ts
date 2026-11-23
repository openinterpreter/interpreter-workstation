import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { v2 } from '../../../server/handlers/codex-generated-types/index';
import type { JsonValue } from '../../../server/handlers/codex-generated-types/serde_json/JsonValue';

function protocolJson(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Browser Pi history contains non-JSON tool data');
  return JSON.parse(encoded) as JsonValue;
}

/** Restore a Pi transcript as the *existing* app-server thread history contract. */
export function projectPiHistory(projectId: string, threadId: string, modelProvider: string,
  modelId: string, messages: readonly AgentMessage[], interruptedTurnIds: readonly string[] = [],
  failedTurns: Readonly<Record<string, 'failed' | 'truncated' | 'storage'>> = {}): v2.Thread {
  const interrupted = new Set(interruptedTurnIds);
  const turns: v2.Turn[] = [];
  const pending = new Map<string, Extract<v2.ThreadItem, { type: 'mcpToolCall' }>>();
  let turn: v2.Turn | null = null;
  let lastTimestamp = Date.now() / 1000;

  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') {
      if (pending.size) throw new Error('Browser Pi history has an unfinished tool call');
      const text = typeof message.content === 'string' ? message.content :
        message.content.map(part => {
          if (part.type !== 'text') throw new Error('Browser Pi image history capability unavailable');
          return part.text;
        }).join('');
      if (!text) throw new Error('Browser Pi history has an empty user turn');
      lastTimestamp = message.timestamp / 1000;
      turn = { id: `pi-turn-${index}`, items: [{ type: 'userMessage', id: `pi-user-${index}`,
        clientId: null, content: [{ type: 'text', text, text_elements: [] }] }],
      itemsView: 'full', status: failedTurns[`pi-turn-${index}`] ? 'failed' :
        interrupted.has(`pi-turn-${index}`) ? 'interrupted' : 'completed',
      error: failedTurns[`pi-turn-${index}`] ? { message: failedTurns[`pi-turn-${index}`] === 'truncated'
        ? 'Browser local model output truncated' : failedTurns[`pi-turn-${index}`] === 'storage'
          ? 'Browser model outcome not recorded; completed tools retained' : 'Browser local model turn failed',
        codexErrorInfo: failedTurns[`pi-turn-${index}`] === 'truncated' ? 'other' : null,
        additionalDetails: failedTurns[`pi-turn-${index}`] === 'truncated' ? 'browserModelTruncated' : null,
        misalignment: null } : null,
      startedAt: lastTimestamp, completedAt: lastTimestamp, durationMs: null };
      turns.push(turn);
      continue;
    }
    if (message.role === 'system') continue;
    if (!turn) throw new Error('Browser Pi history has a response without a user turn');
    lastTimestamp = message.timestamp / 1000;
    turn.completedAt = lastTimestamp;
    if (message.role === 'assistant') {
      turn.status = failedTurns[turn.id] || message.stopReason === 'error' ? 'failed' :
        interrupted.has(turn.id) ? 'interrupted' :
        message.stopReason === 'aborted' ? 'interrupted' : 'completed';
      // Never persist raw model/provider exception text into the Workstation
      // history or reveal it through a reloaded public browser session.
      const truncated = failedTurns[turn.id] === 'truncated' ||
        message.stopReason === 'error' && message.errorMessage === 'Browser local model output truncated';
      turn.error = turn.status === 'failed' ? { message: truncated
        ? 'Browser local model output truncated' : failedTurns[turn.id] === 'storage'
          ? 'Browser model outcome not recorded; completed tools retained' : 'Browser local model turn failed',
        codexErrorInfo: truncated ? 'other' : null,
        additionalDetails: truncated ? 'browserModelTruncated' : null, misalignment: null } : null;
      for (const [partIndex, part] of message.content.entries()) {
        if (part.type === 'text' && part.text) {
          turn.items.push({ type: 'agentMessage', id: `pi-message-${index}-${partIndex}`,
            text: part.text, phase: 'final_answer', memoryCitation: null,
            delivery: null, questions: null });
        } else if (part.type === 'toolCall') {
          if (pending.has(part.id)) throw new Error('Browser Pi history has an overlapping tool call');
          const item: Extract<v2.ThreadItem, { type: 'mcpToolCall' }> = {
            type: 'mcpToolCall', id: `pi-tool-${turn.id}-${turn.items.filter(item => item.type === 'mcpToolCall').length + 1}`,
            server: 'browser-project', tool: part.name,
            status: 'inProgress', arguments: protocolJson(part.arguments),
            appContext: null, mcpAppUi: null,
            pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
          };
          turn.items.push(item);
          pending.set(part.id, item);
        } else if (part.type !== 'thinking') {
          throw new Error('Browser Pi history contains unsupported assistant content');
        }
      }
    } else if (message.role === 'toolResult') {
      const item = pending.get(message.toolCallId);
      if (!item || item.tool !== message.toolName)
        throw new Error('Browser Pi history has an unmatched tool result');
      pending.delete(message.toolCallId);
      const completed: typeof item = { ...item, status: message.isError ? 'failed' : 'completed',
        result: message.isError ? null : { content: message.content.map(protocolJson),
          structuredContent: null, _meta: null },
        error: message.isError ? { message: message.content.filter(part => part.type === 'text')
          .map(part => part.text).join('\n') } : null };
      const itemIndex = turn.items.findIndex(part => part.id === item.id);
      if (itemIndex < 0) throw new Error('Browser Pi result crossed a user turn');
      turn.items[itemIndex] = completed;
    }
  }
  if (pending.size) throw new Error('Browser Pi history has an unfinished tool call');
  const createdAt = turns[0]?.startedAt ?? lastTimestamp;
  return { id: threadId, sessionId: threadId, forkedFromId: null, parentThreadId: null,
    preview: turns[0]?.items[0]?.type === 'userMessage' ? turns[0].items[0].content[0]?.type === 'text'
      ? turns[0].items[0].content[0].text.slice(0, 200) : '' : '',
    ephemeral: false, section: null, sectionEnteredAt: null, projectId,
    historyMode: 'paginated', modelProvider, model: modelId, reasoningEffort: null,
    createdAt, updatedAt: lastTimestamp, recencyAt: lastTimestamp,
    status: { type: 'idle' }, path: null, cwd: `browser-project:${projectId}`,
    cliVersion: '', originator: null, source: 'appServer', threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: null, turns };
}
