export interface AgentActivityState {
  label: string;
  isRunning: boolean;
  messageCount: number;
  unreadCount: number;
  lastMessagePreview: string;
  updatedAt: string | null;
}

export type AgentIndicatorTone = 'idle' | 'running' | 'unread' | 'attention';

export function getAgentIndicatorTone(input: {
  hasPendingApproval: boolean;
  isRunning: boolean;
  unreadCount: number;
}): AgentIndicatorTone {
  if (input.hasPendingApproval) return 'attention';
  if (input.isRunning) return 'running';
  if (input.unreadCount > 0) return 'unread';
  return 'idle';
}

export function computeUnreadCount(input: {
  hasInitialized: boolean;
  previousMessageCount: number;
  nextMessageCount: number;
  previousUnreadCount: number;
  isVisible: boolean;
}): number {
  if (!input.hasInitialized || input.isVisible) {
    return 0;
  }

  if (input.nextMessageCount < input.previousMessageCount) {
    return 0;
  }

  if (input.nextMessageCount === input.previousMessageCount) {
    return input.previousUnreadCount;
  }

  return input.previousUnreadCount + (input.nextMessageCount - input.previousMessageCount);
}
