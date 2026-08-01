import { describe, expect, test } from 'bun:test';
import type { ApprovalOwnerSnapshot, QuestionRequest } from '../../../shared/types/approval';
import type { Tab } from '../../../shared/types/layout';
import {
  buildApprovalQueueGroups,
  buildApprovalQueueItems,
  filterApprovalQueueItems,
  resolveApprovalOwnerAgentId,
} from './approvalQueue';

function makeApproval(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: overrides.id ?? 'approval-1',
    toolName: overrides.toolName ?? 'view_image',
    serverId: overrides.serverId ?? 'main-agent-server',
    questions: overrides.questions ?? [],
    timestamp: overrides.timestamp ?? 1,
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
    ...(overrides.toolCallId !== undefined ? { toolCallId: overrides.toolCallId } : {}),
    ...(overrides.isSimpleApproval !== undefined ? { isSimpleApproval: overrides.isSimpleApproval } : {}),
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    ...(overrides.owner !== undefined ? { owner: overrides.owner } : {}),
  };
}

type OwnerOverrides = Omit<Partial<ApprovalOwnerSnapshot>, 'identity'> & {
  identity?: Partial<ApprovalOwnerSnapshot['identity']>;
};

function makeOwner(overrides: OwnerOverrides = {}): ApprovalOwnerSnapshot {
  return {
    approvalOwnerKind: overrides.approvalOwnerKind ?? 'normal-agent',
    displayName: overrides.displayName ?? 'Research agent',
    color: overrides.color ?? '#2563eb',
    capturedAt: overrides.capturedAt ?? 100,
    identity: {
      agentId: overrides.identity && 'agentId' in overrides.identity ? overrides.identity.agentId ?? null : 'agent-tab-1',
      threadId: overrides.identity?.threadId,
      windowSessionKey: overrides.identity && 'windowSessionKey' in overrides.identity ? overrides.identity.windowSessionKey ?? null : 'window-1',
      workspacePath: overrides.identity && 'workspacePath' in overrides.identity ? overrides.identity.workspacePath ?? null : '/workspace',
      allowedToolNames: overrides.identity?.allowedToolNames,
      toolProfileId: overrides.identity?.toolProfileId,
      parentOwner: overrides.identity?.parentOwner,
    },
  };
}

function makeAgentTab(overrides: Partial<Tab> & { codexThreadId?: string } = {}): Tab {
  return {
    id: overrides.id ?? 'agent-tab-1',
    type: 'agent',
    label: overrides.label ?? 'Agent tab',
    agent: {
      runtime: {
        modelConfig: {
          profileId: 'interpreter',
          provider: 'api',
          modelId: 'test-model',
          apiFormat: 'responses',
        } as any,
      },
      session: {
        callerToken: 'caller-token',
        ...(overrides.codexThreadId ? { codexThreadId: overrides.codexThreadId } : {}),
      },
    },
  };
}

describe('approvalQueue', () => {
  test('uses approval owner snapshots as the shared queue owner metadata', () => {
    const owner = makeOwner({
      approvalOwnerKind: 'overlay-agent',
      displayName: 'Overlay',
      color: '#0891b2',
      identity: {
        agentId: 'overlay-agent-1',
        threadId: 'thread-1',
        windowSessionKey: 'overlay-window',
        workspacePath: '/workspace',
      },
    });
    const [item] = buildApprovalQueueItems([
      makeApproval({ owner }),
    ], {});

    expect(item?.owner).toEqual({
      kind: 'overlay-agent',
      agentId: 'overlay-agent-1',
      threadId: 'thread-1',
      windowSessionKey: 'overlay-window',
      workspacePath: '/workspace',
      displayName: 'Overlay',
      color: '#0891b2',
    });
  });

  test('filters the same queue items for active agent-window rendering', () => {
    const items = buildApprovalQueueItems([
      makeApproval({ id: 'a1', owner: makeOwner({ identity: { agentId: 'agent-tab-1', windowSessionKey: 'w1', workspacePath: '/workspace' } }) }),
      makeApproval({ id: 'a2', owner: makeOwner({ identity: { agentId: 'agent-tab-2', windowSessionKey: 'w2', workspacePath: '/workspace' } }) }),
    ], {});

    expect(filterApprovalQueueItems(items, 'agent-tab-1').map((item) => item.approval.id)).toEqual(['a1']);
    expect(filterApprovalQueueItems(items).map((item) => item.approval.id)).toEqual(['a1', 'a2']);
  });

  test('groups non-tab overlay and hidden-agent approvals without dropping them', () => {
    const items = buildApprovalQueueItems([
      makeApproval({
        id: 'overlay-approval',
        owner: makeOwner({
          approvalOwnerKind: 'overlay-agent',
          displayName: 'Overlay',
          identity: {
            agentId: null,
            threadId: 'overlay-thread',
            windowSessionKey: 'overlay-window',
            workspacePath: '/workspace',
          },
        }),
      }),
      makeApproval({
        id: 'hidden-approval',
        owner: makeOwner({
          approvalOwnerKind: 'hidden-agent',
          displayName: 'Hidden delegate',
          identity: {
            agentId: null,
            threadId: 'hidden-thread',
            windowSessionKey: 'overlay-window',
            workspacePath: '/workspace',
          },
        }),
      }),
    ], {});
    const groups = buildApprovalQueueGroups(items);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.owner.kind)).toEqual(['overlay-agent', 'hidden-agent']);
    expect(groups.flatMap((group) => group.items.map((item) => item.approval.id))).toEqual([
      'overlay-approval',
      'hidden-approval',
    ]);
  });

  test('falls back to matching a thread to an agent tab when the approval has no agent id', () => {
    const tabs = {
      'agent-tab-1': makeAgentTab({ id: 'agent-tab-1', codexThreadId: 'thread-1' }),
    };

    expect(resolveApprovalOwnerAgentId(makeApproval({ context: { threadId: 'thread-1' } }), tabs)).toBe('agent-tab-1');
  });
});
