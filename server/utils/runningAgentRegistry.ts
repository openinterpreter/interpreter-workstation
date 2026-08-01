/**
 * Running Agent Registry
 *
 * Tracks all running agents with their AbortControllers.
 * When an agent is stopped, ALL descendants are also stopped.
 *
 * This is critical for the stop button to work properly -
 * when user clicks stop, we need to kill:
 * 1. The main agent's stream
 * 2. All subagent streams (which may be deeply nested)
 */

interface RunningAgent {
  agentId: string;
  abortController: AbortController;
  parentId: string | null;  // null for root agents
  childIds: Set<string>;
  onStop?: () => void | Promise<void>;  // Optional cleanup callback for runtime-owned subprocesses
}

// Map of agentId -> RunningAgent
const registry = new Map<string, RunningAgent>();

/**
 * Register a running agent with its AbortController
 * Call this when starting any agent/subagent
 *
 * @param onStop - Optional cleanup callback called when agent is stopped
 */
export function registerRunningAgent(
  agentId: string,
  abortController: AbortController,
  parentId: string | null = null,
  onStop?: () => void | Promise<void>
): void {
  // If this agent already exists, unregister it first
  if (registry.has(agentId)) {
    unregisterRunningAgent(agentId);
  }

  const agent: RunningAgent = {
    agentId,
    abortController,
    parentId,
    childIds: new Set(),
    onStop,
  };

  registry.set(agentId, agent);

  // Register as child of parent
  if (parentId) {
    const parent = registry.get(parentId);
    if (parent) {
      parent.childIds.add(agentId);
      console.log(`[RunningAgentRegistry] registered agentId=${agentId} parentId=${parentId} childCount=${parent.childIds.size} total=${registry.size}`);
    } else {
      console.log(`[RunningAgentRegistry] registered agentId=${agentId} parentId=${parentId} parentFound=false total=${registry.size}`);
    }
  } else {
    console.log(`[RunningAgentRegistry] registered agentId=${agentId} parentId=none total=${registry.size}`);
  }
}

/**
 * Unregister a running agent (call when agent completes normally)
 */
export function unregisterRunningAgent(agentId: string): void {
  const agent = registry.get(agentId);
  if (!agent) return;

  // Remove from parent's children
  if (agent.parentId) {
    const parent = registry.get(agent.parentId);
    if (parent) {
      parent.childIds.delete(agentId);
    }
  }

  // Recursively unregister all children
  for (const childId of agent.childIds) {
    unregisterRunningAgent(childId);
  }

  registry.delete(agentId);
}

/**
 * Stop an agent and ALL its descendants
 * This is called when user clicks the stop button
 */
export async function stopAgentAndDescendants(agentId: string): Promise<void> {
  const agent = registry.get(agentId);
  if (!agent) {
    console.log(`[RunningAgentRegistry] stop_skipped agentId=${agentId} reason=not_registered total=${registry.size}`);
    return;
  }

  console.log(`[RunningAgentRegistry] stopping agentId=${agentId} childCount=${agent.childIds.size}`);

  // First, stop all descendants (depth-first)
  for (const childId of agent.childIds) {
    await stopAgentAndDescendants(childId);
  }

  // Then abort this agent
  if (!agent.abortController.signal.aborted) {
    agent.abortController.abort();
  }

  // Call cleanup callback if provided.
  if (agent.onStop) {
    try {
      await agent.onStop();
    } catch (err) {
      console.error(`[RunningAgentRegistry] onStop_failed agentId=${agentId}`, err);
    }
  }

  // Unregister the agent
  unregisterRunningAgent(agentId);
  console.log(`[RunningAgentRegistry] stopped agentId=${agentId} total=${registry.size}`);
}

/**
 * Stop every registered running agent.
 *
 * Root agents are stopped first so each subtree still gets depth-first cleanup.
 * Any orphaned entries left behind by out-of-order unregisters are then stopped
 * directly.
 */
export async function stopAllRunningAgents(): Promise<string[]> {
  const stoppedAgentIds = Array.from(registry.keys());
  const rootAgentIds = Array.from(registry.values())
    .filter((agent) => !agent.parentId || !registry.has(agent.parentId))
    .map((agent) => agent.agentId);

  for (const agentId of rootAgentIds) {
    await stopAgentAndDescendants(agentId);
  }

  for (const agentId of Array.from(registry.keys())) {
    await stopAgentAndDescendants(agentId);
  }

  return stoppedAgentIds;
}

/**
 * Get count of running agents (for debugging)
 */
export function getRunningAgentCount(): number {
  return registry.size;
}

/**
 * Get all running agent IDs (for debugging)
 */
export function getRunningAgentIds(): string[] {
  return Array.from(registry.keys());
}

/**
 * Clear all running agents (for shutdown)
 */
export function clearAllRunningAgents(): void {

  // Abort all agents
  for (const agent of registry.values()) {
    if (!agent.abortController.signal.aborted) {
      agent.abortController.abort();
    }
  }

  registry.clear();
}
