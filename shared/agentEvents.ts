export const AGENT_SEED_COMPOSER_EVENT = 'agent:seed-composer' as const;

export interface AgentSeedComposerDetail {
  agentId: string;
  prompt: string;
  autoSend: boolean;
}

const PENDING_AGENT_COMPOSER_SEEDS_KEY = '__interpreterPendingComposerSeeds';

type PendingAgentComposerSeedStore = Map<string, AgentSeedComposerDetail>;

function getPendingAgentComposerSeedStore(): PendingAgentComposerSeedStore | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const windowWithStore = window as Window & {
    [PENDING_AGENT_COMPOSER_SEEDS_KEY]?: PendingAgentComposerSeedStore;
  };
  if (!windowWithStore[PENDING_AGENT_COMPOSER_SEEDS_KEY]) {
    windowWithStore[PENDING_AGENT_COMPOSER_SEEDS_KEY] = new Map();
  }
  return windowWithStore[PENDING_AGENT_COMPOSER_SEEDS_KEY] ?? null;
}

export function enqueuePendingAgentComposerSeed(detail: AgentSeedComposerDetail): void {
  getPendingAgentComposerSeedStore()?.set(detail.agentId, detail);
}

export function peekPendingAgentComposerSeed(agentId: string): AgentSeedComposerDetail | null {
  const store = getPendingAgentComposerSeedStore();
  return store?.get(agentId) ?? null;
}

export function consumePendingAgentComposerSeed(agentId: string): AgentSeedComposerDetail | null {
  const store = getPendingAgentComposerSeedStore();
  const detail = store?.get(agentId) ?? null;
  if (detail && store) {
    store.delete(agentId);
  }
  return detail;
}
