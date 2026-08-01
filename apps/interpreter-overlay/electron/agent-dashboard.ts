import type { AgentWindowBindingSnapshot } from '../../../server/agentTabManager';
import type { OverlayRunningAgent } from '../shared/ipc.js';

export function buildOverlayRunningAgents(
  bindings: AgentWindowBindingSnapshot[],
): OverlayRunningAgent[] {
  return bindings
    .filter((binding) => binding.activity?.isRunning === true)
    .sort((left, right) => {
      const leftUpdatedAt = left.activity?.updatedAt ?? '';
      const rightUpdatedAt = right.activity?.updatedAt ?? '';
      return rightUpdatedAt.localeCompare(leftUpdatedAt) || left.agentId.localeCompare(right.agentId);
    })
    .map((binding) => {
      const activity = binding.activity;
      const label = activity?.label.trim() || binding.agentId;
      const latestAction = activity?.lastMessagePreview.trim() || null;
      return {
        agentId: binding.agentId,
        threadId: binding.threadId ?? null,
        windowSessionKey: binding.windowSessionKey ?? null,
        workspacePath: binding.workspacePath ?? null,
        label,
        latestAction,
        unreadCount: activity?.unreadCount ?? 0,
        updatedAt: activity?.updatedAt ?? null,
      };
    });
}
