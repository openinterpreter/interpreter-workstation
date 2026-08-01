import type { ApprovalOwnerKind, QuestionRequest } from '../../../shared/types/approval';
import { isAgentTab, type Tab } from '../../../shared/types/layout';

export interface ApprovalQueueOwner {
  kind: ApprovalOwnerKind;
  agentId: string | null;
  threadId: string | null;
  windowSessionKey: string | null;
  workspacePath: string | null;
  displayName: string;
  color: string;
}

export interface ApprovalQueueItem {
  approval: QuestionRequest;
  owner: ApprovalQueueOwner;
}

export interface ApprovalQueueGroup {
  key: string;
  owner: ApprovalQueueOwner;
  items: ApprovalQueueItem[];
}

function threadIdFromApproval(approval: QuestionRequest): string | null {
  if (typeof approval.owner?.identity.threadId === 'string') {
    return approval.owner.identity.threadId;
  }

  if (typeof approval.context?.threadId === 'string') {
    return approval.context.threadId;
  }

  return null;
}

export function resolveApprovalOwnerAgentId(
  approval: QuestionRequest,
  tabs: Record<string, Tab>,
): string | undefined {
  const ownerAgentId = approval.owner?.identity.agentId ?? approval.agentId;
  if (ownerAgentId) {
    return ownerAgentId;
  }

  const threadId = threadIdFromApproval(approval);
  if (!threadId) {
    return undefined;
  }

  for (const tab of Object.values(tabs)) {
    if (!isAgentTab(tab) || tab.agent.session.codexThreadId !== threadId) continue;
    return tab.id;
  }

  return undefined;
}

function ownerDisplayName(approval: QuestionRequest, ownerAgentId: string | undefined, tabs: Record<string, Tab>): string {
  if (approval.owner?.displayName.trim()) {
    return approval.owner.displayName.trim();
  }

  if (ownerAgentId && tabs[ownerAgentId]?.label.trim()) {
    return tabs[ownerAgentId].label.trim();
  }

  return 'Interpreter';
}

function ownerGroupKey(owner: ApprovalQueueOwner): string {
  if (owner.agentId) {
    return `agent:${owner.agentId}`;
  }

  return [
    owner.kind,
    owner.threadId ?? 'no-thread',
    owner.windowSessionKey ?? 'no-window',
    owner.workspacePath ?? 'no-workspace',
  ].join(':');
}

export function buildApprovalQueueItems(
  approvals: QuestionRequest[],
  tabs: Record<string, Tab>,
): ApprovalQueueItem[] {
  return approvals.map((approval) => {
    const ownerAgentId = resolveApprovalOwnerAgentId(approval, tabs);
    const owner = approval.owner;
    const identity = owner?.identity;

    return {
      approval,
      owner: {
        kind: owner?.approvalOwnerKind ?? (ownerAgentId ? 'normal-agent' : 'cli'),
        agentId: ownerAgentId ?? null,
        threadId: threadIdFromApproval(approval),
        windowSessionKey: identity?.windowSessionKey ?? null,
        workspacePath: identity?.workspacePath ?? null,
        displayName: ownerDisplayName(approval, ownerAgentId, tabs),
        color: owner?.color ?? '#6b7280',
      },
    };
  });
}

export function filterApprovalQueueItems(
  items: ApprovalQueueItem[],
  ownerAgentId?: string,
): ApprovalQueueItem[] {
  if (!ownerAgentId) {
    return items;
  }

  return items.filter((item) => item.owner.agentId === ownerAgentId);
}

export function buildApprovalQueueGroups(items: ApprovalQueueItem[]): ApprovalQueueGroup[] {
  const groups = new Map<string, ApprovalQueueGroup>();

  for (const item of items) {
    const key = ownerGroupKey(item.owner);
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      continue;
    }

    groups.set(key, {
      key,
      owner: item.owner,
      items: [item],
    });
  }

  return Array.from(groups.values());
}

export function buildPendingApprovalsByAgent(
  approvals: QuestionRequest[],
  tabs: Record<string, Tab>,
): Map<string, number> {
  const countsByAgent = new Map<string, number>();

  for (const item of buildApprovalQueueItems(approvals, tabs)) {
    if (!item.owner.agentId) continue;
    countsByAgent.set(item.owner.agentId, (countsByAgent.get(item.owner.agentId) || 0) + 1);
  }

  return countsByAgent;
}
