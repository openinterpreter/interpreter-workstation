import type { QuestionRequest } from '../../../shared/types/approval';
import type { OverlayDashboardApproval } from '../shared/ipc.js';

function getApprovalTitle(approval: QuestionRequest): string {
  const context = approval.context && typeof approval.context === 'object'
    ? approval.context as Record<string, unknown>
    : {};
  if (typeof context.message === 'string' && context.message.trim()) {
    return context.message.trim();
  }
  if (typeof context.description === 'string' && context.description.trim()) {
    return context.description.trim();
  }
  if (approval.isSimpleApproval) {
    return 'Approval needed';
  }
  return approval.questions?.[0]?.header?.trim()
    || approval.questions?.[0]?.question?.trim()
    || 'Input needed';
}

function getApprovalDetail(approval: QuestionRequest): string {
  const context = approval.context && typeof approval.context === 'object'
    ? approval.context as Record<string, unknown>
    : {};
  if (typeof context.warning === 'string' && context.warning.trim()) {
    return context.warning.trim();
  }
  if (typeof context.command === 'string' && context.command.trim()) {
    return context.command.trim();
  }
  if (typeof context.toolName === 'string' && context.toolName.trim()) {
    return context.toolName.trim();
  }
  return `${approval.serverId}:${approval.toolName}`;
}

export function buildOverlayDashboardApprovals(
  approvals: QuestionRequest[],
): OverlayDashboardApproval[] {
  return approvals
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    .map((approval) => ({
      id: approval.id,
      ownerAgentId: approval.owner?.identity.agentId ?? approval.agentId ?? null,
      ownerKind: approval.owner?.approvalOwnerKind ?? (approval.agentId ? 'normal-agent' : 'cli'),
      ownerDisplayName: approval.owner?.displayName ?? (approval.agentId ? 'Agent' : 'Interpreter CLI'),
      ownerColor: approval.owner?.color ?? '#94a3b8',
      title: getApprovalTitle(approval),
      detail: getApprovalDetail(approval),
      isSimpleApproval: approval.isSimpleApproval === true,
      supportsSessionApproval: (
        approval.context
        && typeof approval.context === 'object'
        && !Array.isArray(approval.context)
        && (approval.context as { sessionAware?: unknown }).sessionAware === true
      ),
      timestamp: approval.timestamp,
    }));
}
