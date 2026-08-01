/**
 * Agent Notifications Hook
 *
 * Listens for system notifications and routes them appropriately:
 * - If agent is running: send as the same after-next-tool follow-up as composer send
 * - If agent is idle: send through the same runtime path as composer send
 */

import { useEffect, useRef } from 'react';
import { agentNotifications } from '../../src/ipc';

interface AgentNotificationEvent {
  agentId: string;
  content: string;
  source: string;
}

interface UseAgentNotificationsOptions {
  agentId: string;
  isRunning: boolean;
  queueAfterNextTool: (text: string) => Promise<{ success: boolean }>;
  sendNow: (text: string) => void;
}

export function useAgentNotifications({ agentId, isRunning, queueAfterNextTool, sendNow }: UseAgentNotificationsOptions) {
  const localSendInFlightRef = useRef(false);

  useEffect(() => {
    if (!isRunning) {
      localSendInFlightRef.current = false;
    }
  }, [isRunning]);

  useEffect(() => {
  const unsub = agentNotifications.onNotification(({ agentId: targetId, content, source }: AgentNotificationEvent) => {
      if (targetId !== agentId) return;

      const text = source === 'whatsapp'
        ? content
        : `<system-notification source="${source}">${content}</system-notification>`;

      if (isRunning || localSendInFlightRef.current) {
        queueAfterNextTool(text);
      } else {
        localSendInFlightRef.current = true;
        sendNow(text);
      }
    });
    return unsub;
  }, [agentId, isRunning, queueAfterNextTool, sendNow]);
}
