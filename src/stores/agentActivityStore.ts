import type { AgentActivityState } from '../../shared/utils/agentAttention';
import { tr } from '../i18n';

type Listener = () => void;

const DEFAULT_AGENT_ACTIVITY: AgentActivityState = {
  label: tr('common.newAgent'),
  isRunning: false,
  messageCount: 0,
  unreadCount: 0,
  lastMessagePreview: '',
  updatedAt: null,
};

let agentActivityMap = new Map<string, AgentActivityState>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAgentActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentActivitySnapshot(): Map<string, AgentActivityState> {
  return agentActivityMap;
}

export function getAgentActivity(agentId: string): AgentActivityState {
  return agentActivityMap.get(agentId) ?? DEFAULT_AGENT_ACTIVITY;
}

export function updateAgentActivity(agentId: string, updates: Partial<AgentActivityState>): void {
  const previous = getAgentActivity(agentId);
  const next: AgentActivityState = {
    ...previous,
    ...updates,
  };

  if (
    previous.label === next.label
    && previous.isRunning === next.isRunning
    && previous.messageCount === next.messageCount
    && previous.unreadCount === next.unreadCount
    && previous.lastMessagePreview === next.lastMessagePreview
    && previous.updatedAt === next.updatedAt
  ) {
    return;
  }

  const nextMap = new Map(agentActivityMap);
  nextMap.set(agentId, next);
  agentActivityMap = nextMap;
  notify();
}

export function removeAgentActivity(agentId: string): void {
  if (!agentActivityMap.has(agentId)) return;
  const nextMap = new Map(agentActivityMap);
  nextMap.delete(agentId);
  agentActivityMap = nextMap;
  notify();
}
