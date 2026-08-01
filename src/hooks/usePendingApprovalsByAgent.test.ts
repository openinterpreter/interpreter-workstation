import { describe, test, expect } from 'bun:test';
import type { QuestionRequest } from '../../shared/types/approval';
import type { Tab } from '../../shared/types/layout';
import { buildPendingApprovalsByAgent } from './usePendingApprovalsByAgent';

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
  };
}

function makeAgentTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: overrides.id ?? 'agent-tab-1',
    type: 'agent',
    label: overrides.label ?? 'Agent',
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
        ...(typeof (overrides as any).codexThreadId === 'string' ? { codexThreadId: (overrides as any).codexThreadId } : {}),
      },
    },
  };
}

describe('buildPendingApprovalsByAgent', () => {
  test('should_count_approvals_with_explicit_agent_ids', () => {
    const counts = buildPendingApprovalsByAgent(
      [
        makeApproval({ id: 'a1', agentId: 'agent-tab-1' }),
        makeApproval({ id: 'a2', agentId: 'agent-tab-1' }),
        makeApproval({ id: 'a3', agentId: 'agent-tab-2' }),
      ],
      {},
    );

    expect(counts.get('agent-tab-1')).toBe(2);
    expect(counts.get('agent-tab-2')).toBe(1);
  });

  test('should_count_orphan_approvals_against_the_agent_tab_with_matching_thread', () => {
    const counts = buildPendingApprovalsByAgent(
      [
        makeApproval({ id: 'orphan', context: { threadId: 'thr-123' } }),
      ],
      {
        'agent-tab-1': makeAgentTab({ id: 'agent-tab-1', codexThreadId: 'thr-123' }),
      },
    );

    expect(counts.get('agent-tab-1')).toBe(1);
  });

  test('should_ignore_orphan_approvals_without_a_matching_agent_thread', () => {
    const counts = buildPendingApprovalsByAgent(
      [
        makeApproval({ id: 'orphan', context: { threadId: 'thr-missing' } }),
      ],
      {
        'agent-tab-1': makeAgentTab({ id: 'agent-tab-1', codexThreadId: 'thr-123' }),
      },
    );

    expect(counts.size).toBe(0);
  });

  test('should_prefer_explicit_agent_id_over_thread_lookup', () => {
    const counts = buildPendingApprovalsByAgent(
      [
        makeApproval({
          id: 'mixed',
          agentId: 'agent-tab-2',
          context: { threadId: 'thr-123' },
        }),
      ],
      {
        'agent-tab-1': makeAgentTab({ id: 'agent-tab-1', codexThreadId: 'thr-123' }),
        'agent-tab-2': makeAgentTab({ id: 'agent-tab-2', codexThreadId: 'thr-456' }),
      },
    );

    expect(counts.get('agent-tab-2')).toBe(1);
    expect(counts.has('agent-tab-1')).toBe(false);
  });
});
