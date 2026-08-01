/**
 * Agent Metadata Context
 *
 * Provides agent metadata to all child components without prop drilling.
 * Used to pass agent configuration (model config with permissions, etc.) down the tree.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AgentTabState } from '../../shared/types/layout';

export interface AgentMetadata {
  id: string;
  createdAt: number;  // Unix timestamp in milliseconds (runtime format)
  agent: AgentTabState;
}

const AgentMetadataContext = createContext<AgentMetadata | null>(null);

export function AgentMetadataProvider({
  agent,
  children,
}: {
  agent: AgentMetadata;
  children: ReactNode;
}) {
  // Memoize value to prevent unnecessary re-renders
  const memoizedAgent = useMemo(() => agent, [
    agent.id,
    agent.createdAt,
    agent.agent,
  ]);

  return (
    <AgentMetadataContext.Provider value={memoizedAgent}>
      {children}
    </AgentMetadataContext.Provider>
  );
}

export function useAgentMetadata(): AgentMetadata {
  const context = useContext(AgentMetadataContext);
  if (!context) {
    throw new Error('useAgentMetadata must be used within AgentMetadataProvider');
  }
  return context;
}

/**
 * Optional version that returns null if not within AgentMetadataProvider.
 * Use this when you're unsure if the component is within the provider context.
 */
export function useAgentMetadataOptional(): AgentMetadata | null {
  return useContext(AgentMetadataContext);
}
