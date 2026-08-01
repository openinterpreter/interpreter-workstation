import { describe, expect, test } from 'bun:test';
import type { QuestionRequest } from '../../../shared/types/approval';
import { buildOverlayDashboardApprovals } from './approval-dashboard';

function approval(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: 'approval-1',
    serverId: 'builtin-shell',
    toolName: 'run_command',
    questions: [{
      question: 'Approve command?',
      options: [
        { label: 'Approve', value: 'approve' },
        { label: 'Deny', value: 'deny' },
      ],
    }],
    context: {
      message: 'Run command',
      command: 'echo hello',
      sessionAware: true,
    },
    timestamp: 20,
    isSimpleApproval: true,
    owner: {
      approvalOwnerKind: 'normal-agent',
      displayName: 'Research agent',
      color: '#38bdf8',
      capturedAt: 10,
      identity: {
        agentId: 'agent-1',
        threadId: 'thread-1',
        windowSessionKey: 'window-1',
        workspacePath: '/workspace',
      },
    },
    ...overrides,
  };
}

describe('buildOverlayDashboardApprovals', () => {
  test('keeps all approvals with owner identity and safe summaries', () => {
    const approvals = buildOverlayDashboardApprovals([
      approval({ id: 'approval-2', timestamp: 30 }),
      approval({ id: 'approval-1', timestamp: 20 }),
    ]);

    expect(approvals.map((item) => item.id)).toEqual(['approval-1', 'approval-2']);
    expect(approvals[0]).toEqual({
      id: 'approval-1',
      ownerAgentId: 'agent-1',
      ownerKind: 'normal-agent',
      ownerDisplayName: 'Research agent',
      ownerColor: '#38bdf8',
      title: 'Run command',
      detail: 'echo hello',
      isSimpleApproval: true,
      supportsSessionApproval: true,
      timestamp: 20,
    });
    expect(JSON.stringify(approvals)).not.toContain('callerToken');
    expect(JSON.stringify(approvals)).not.toContain('allowedToolNames');
  });

  test('identifies background or non-tab approvals from captured owner snapshots', () => {
    const [item] = buildOverlayDashboardApprovals([
      approval({
        id: 'hidden-approval',
        agentId: undefined,
        owner: {
          approvalOwnerKind: 'hidden-agent',
          displayName: 'Hidden overlay helper',
          color: '#a78bfa',
          capturedAt: 12,
          identity: {
            agentId: 'hidden-agent-1',
            threadId: 'thread-hidden',
            windowSessionKey: null,
            workspacePath: null,
          },
        },
      }),
    ]);

    expect(item?.ownerAgentId).toBe('hidden-agent-1');
    expect(item?.ownerKind).toBe('hidden-agent');
    expect(item?.ownerDisplayName).toBe('Hidden overlay helper');
  });

  test('keeps multiple agent-owned approvals distinct for dashboard grouping', () => {
    const approvals = buildOverlayDashboardApprovals([
      approval({
        id: 'approval-agent-2',
        timestamp: 40,
        context: {
          message: 'Send email',
          command: 'send drafted email',
        },
        owner: {
          approvalOwnerKind: 'normal-agent',
          displayName: 'Email agent',
          color: '#f97316',
          capturedAt: 11,
          identity: {
            agentId: 'agent-2',
            threadId: 'thread-2',
            windowSessionKey: 'window-2',
            workspacePath: '/workspace',
          },
        },
      }),
      approval({
        id: 'approval-agent-1',
        timestamp: 30,
        context: {
          message: 'Run shell command',
          command: 'pnpm test',
        },
      }),
    ]);

    expect(approvals).toMatchObject([
      {
        id: 'approval-agent-1',
        ownerAgentId: 'agent-1',
        ownerDisplayName: 'Research agent',
        title: 'Run shell command',
        detail: 'pnpm test',
      },
      {
        id: 'approval-agent-2',
        ownerAgentId: 'agent-2',
        ownerDisplayName: 'Email agent',
        title: 'Send email',
        detail: 'send drafted email',
      },
    ]);
  });
});
