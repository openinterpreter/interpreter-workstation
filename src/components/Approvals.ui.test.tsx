import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { QuestionRequest } from '../../shared/types/approval';
import type { AgentActivityState } from '../../shared/utils/agentAttention';
import { Approvals } from './Approvals';
import {
  resetApprovalsStoreForTests,
  setApprovalsStoreClientForTests,
} from '../stores/approvalsStore';

const apiMocks = vi.hoisted(() => ({
  denyApproval: vi.fn(async () => ({ success: true })),
  respondApproval: vi.fn(async () => ({ success: true })),
}));

const toastMocks = vi.hoisted(() => ({
  dismissToast: vi.fn(),
  showToast: vi.fn(() => 'toast-id'),
}));

const activityMock = vi.hoisted(() => ({
  map: new Map<string, AgentActivityState>(),
}));

const runtimeMocks = vi.hoisted(() => ({
  onRestarting: vi.fn<(callback: (event: { requestedAt: number; runningAgentCount: number }) => void) => () => void>(() => () => {}),
  onRestarted: vi.fn<(callback: (event: { restartedAt: number }) => void) => () => void>(() => () => {}),
  restartedCallback: null as ((event: { restartedAt: number }) => void) | null,
}));

vi.mock('../api', () => apiMocks);

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => toastMocks,
}));

vi.mock('../hooks/useAgentActivityMap', () => ({
  useAgentActivityMap: () => activityMock.map,
}));

vi.mock('../hooks/useLayout', () => ({
  useLayout: () => ({ state: { tabs: {} } }),
}));

vi.mock('@/ipc', () => ({
  approvals: {
    get: vi.fn(async () => ({ approvals: [] })),
    onListChanged: vi.fn(() => () => {}),
  },
  settings: {
    get: vi.fn(async () => ({
      questionAutoTimeoutEnabled: true,
      questionAutoTimeoutSeconds: 15,
    })),
  },
  runtime: {
    onRestarting: runtimeMocks.onRestarting,
    onRestarted: runtimeMocks.onRestarted,
  },
}));

function runtimeRestartApproval(): QuestionRequest {
  return {
    id: 'approval-runtime-restart',
    toolName: 'interpreter_config_restart_runtime',
    serverId: 'builtin-interpreter',
    questions: [
      {
        question: 'Do you approve this action?',
        options: [
          { label: 'Approve', value: 'approve' },
          { label: 'Deny', value: 'deny' },
        ],
      },
    ],
    context: {
      message: 'Interpreter wants to restart its agent runtime.',
      runtimeRestart: true,
    },
    timestamp: Date.now(),
    isSimpleApproval: true,
  };
}

function permissionApproval(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: overrides.id ?? 'approval-permission',
    toolName: overrides.toolName ?? 'cua_driver:inspect:Finder',
    serverId: overrides.serverId ?? 'builtin-cua-driver',
    questions: overrides.questions ?? [
      {
        question: 'Do you approve this action?',
        options: [
          { label: 'Approve', value: 'approve' },
          { label: 'Deny', value: 'deny' },
        ],
      },
    ],
    context: overrides.context ?? {
      message: 'Let Interpreter inspect Finder?',
      sessionAware: true,
    },
    timestamp: overrides.timestamp ?? Date.now(),
    isSimpleApproval: overrides.isSimpleApproval ?? true,
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    ...(overrides.owner !== undefined ? { owner: overrides.owner } : {}),
  };
}

function runningActivity(): AgentActivityState {
  return {
    label: 'Running',
    isRunning: true,
    messageCount: 1,
    unreadCount: 0,
    lastMessagePreview: '',
    updatedAt: null,
  };
}

function renderWithApprovals(approvals: QuestionRequest[]) {
  setApprovalsStoreClientForTests({
    get: vi.fn(async () => ({ approvals })),
    onListChanged: vi.fn(() => () => {}),
  });

  render(<Approvals />);
}

describe('Approvals runtime restart UX', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityMock.map = new Map();
    runtimeMocks.restartedCallback = null;
    runtimeMocks.onRestarted.mockImplementation((callback) => {
      runtimeMocks.restartedCallback = callback;
      return () => {};
    });
    resetApprovalsStoreForTests();
  });

  afterEach(() => {
    resetApprovalsStoreForTests();
  });

  test('restarts immediately with progress and completion toasts when no conversations are running', async () => {
    const user = userEvent.setup();

    renderWithApprovals([runtimeRestartApproval()]);

    await screen.findByText('Interpreter wants to restart its agent runtime.');
    await user.click(screen.getByRole('button', { name: 'Allow once' }));

    await waitFor(() => {
      expect(apiMocks.respondApproval).toHaveBeenCalledWith(
        'approval-runtime-restart',
        { answers: { '0': 'approve' }, approvalMode: 'once' },
      );
    });

    expect(screen.queryByText('Restart Interpreter?')).not.toBeInTheDocument();
    expect(toastMocks.showToast).toHaveBeenNthCalledWith(
      1,
      'Interpreter is restarting the agent...',
      'info',
    );
    expect(toastMocks.dismissToast).not.toHaveBeenCalled();
    expect(toastMocks.showToast).toHaveBeenCalledTimes(1);

    runtimeMocks.restartedCallback?.({ restartedAt: Date.now() });

    expect(toastMocks.dismissToast).toHaveBeenCalledWith('toast-id');
    expect(toastMocks.showToast).toHaveBeenNthCalledWith(
      2,
      'Interpreter restarted. New changes have taken effect.',
      'success',
      5000,
    );
  });

  test('warns about running conversations before approving a restart', async () => {
    const user = userEvent.setup();
    activityMock.map = new Map([
      ['agent-a', runningActivity()],
      ['agent-b', runningActivity()],
    ]);

    renderWithApprovals([runtimeRestartApproval()]);

    await screen.findByText('Interpreter wants to restart its agent runtime.');
    await user.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(await screen.findByText('Restart Interpreter?')).toBeVisible();
    expect(
      screen.getByText('2 conversations are still running. Restarting will stop those conversations for every agent.'),
    ).toBeVisible();
    expect(apiMocks.respondApproval).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Restart now' }));

    await waitFor(() => {
      expect(apiMocks.respondApproval).toHaveBeenCalledWith(
        'approval-runtime-restart',
        { answers: { '0': 'approve' }, approvalMode: 'once' },
      );
    });
  });

  test('shows other-agent permission prompts in the global approvals surface', async () => {
    renderWithApprovals([
      permissionApproval({
        id: 'approval-other-agent',
        context: {
          message: 'Let Interpreter inspect another agent target?',
          sessionAware: true,
        },
        owner: {
          approvalOwnerKind: 'normal-agent',
          displayName: 'Other agent',
          color: '#dc2626',
          capturedAt: 10,
          identity: {
            agentId: 'agent-other',
            threadId: 'thread-other',
            windowSessionKey: 'window-other',
            workspacePath: '/workspace',
          },
        },
      }),
    ]);

    expect(await screen.findByText('Let Interpreter inspect another agent target?')).toBeInTheDocument();
    expect(screen.getByText('Other agent')).toBeInTheDocument();
  });
});
