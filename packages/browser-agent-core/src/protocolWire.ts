import type { AppServerNotification } from '../../../src/lib/codex/protocol';
import type { SseStreamEvent } from '../../../src/lib/codex/event-mapper';

/** The browser backend emits this narrow subset of the canonical app-server wire. */
export const CLIENT_METHOD = {
  interpreterProviderList: 'interpreter/provider/list', interpreterModelList: 'interpreter/model/list',
  modelList: 'model/list', threadRead: 'thread/read', threadTurnsList: 'thread/turns/list',
  turnStart: 'turn/start', turnInterrupt: 'turn/interrupt',
} as const;
export const SERVER_METHOD = {
  turnStarted: 'turn/started', turnCompleted: 'turn/completed',
  itemStarted: 'item/started', itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
} as const;

/** Only notifications emitted by this backend are projected; the shape is the desktop SSE contract. */
export function mapBrowserNotificationToUiEvents(notification: AppServerNotification): SseStreamEvent[] {
  if (notification.method === SERVER_METHOD.agentMessageDelta)
    return [{ event: 'delta', payload: { text: notification.params.delta,
      itemId: notification.params.itemId } }];
  if (notification.method === SERVER_METHOD.itemStarted ||
      notification.method === SERVER_METHOD.itemCompleted) {
    const item = notification.params.item;
    if (item.type === 'userMessage') {
      if (notification.method !== SERVER_METHOD.itemCompleted) return [];
      return [{ event: 'userMessage', payload: { itemId: item.id,
        text: item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') } }];
    }
    if (item.type === 'agentMessage') {
      if (notification.method !== SERVER_METHOD.itemCompleted || !item.text.trim()) return [];
      return [{ event: 'final', payload: { text: item.text, itemId: item.id } }];
    }
    return [{ event: 'tool', payload: { phase: notification.method === SERVER_METHOD.itemStarted
      ? 'started' : 'completed', type: item.type, item } }];
  }
  if (notification.method === SERVER_METHOD.turnCompleted)
    return [{ event: 'completed', payload: { turnId: notification.params.turn.id,
      status: notification.params.turn.status, error: notification.params.turn.error } }];
  return [];
}
