/**
 * Agent Notifications
 *
 * General-purpose system for sending notifications to agents.
 * Frontend sends into the target agent tab's normal message path.
 */

import { IPC_CHANNELS } from '../../electron/ipc/registry';
import { broadcastEvent } from './broadcast';

export function notifyAgent(
  agentId: string,
  content: string,
  source: string = 'system'
): void {
  console.log(`[notifyAgent] Notifying agent ${agentId} from ${source}`);
  broadcastEvent(IPC_CHANNELS.AGENT_NOTIFICATION, { agentId, content, source });
}
