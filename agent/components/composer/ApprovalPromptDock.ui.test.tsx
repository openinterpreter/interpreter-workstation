import type { HTMLAttributes, ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { QuestionRequest } from '../../../shared/types/approval';
import { ApprovalPromptDock } from './ApprovalPromptDock';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => children ?? null,
  motion: {
    div: ({
      children,
      animate: _animate,
      exit: _exit,
      initial: _initial,
      layout: _layout,
      transition: _transition,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      animate?: unknown;
      exit?: unknown;
      initial?: unknown;
      layout?: unknown;
      transition?: unknown;
    }) => <div {...props}>{children}</div>,
  },
  useReducedMotion: () => true,
}));

const testState = vi.hoisted(() => ({
  approvals: [] as QuestionRequest[],
}));

const ipcMocks = vi.hoisted(() => ({
  approvals: {
    get: vi.fn(async () => ({ approvals: testState.approvals })),
    respond: vi.fn(async () => ({ success: true })),
    deny: vi.fn(async () => ({ success: true })),
    onListChanged: vi.fn(() => () => {}),
  },
  settings: {
    get: vi.fn(async () => ({
      questionAutoTimeoutEnabled: true,
      questionAutoTimeoutSeconds: 3,
    })),
  },
}));

const APP_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

vi.mock('../../../src/ipc', () => ipcMocks);
vi.mock('../../../src/hooks/useLayout', () => ({
  useLayout: () => ({
    state: {
      tabs: {},
    },
  }),
}));

function createQuestionRequest(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: 'approval-1',
    toolName: 'ask_user_question',
    serverId: 'builtin-ask-user',
    timestamp: 1,
    questions: [
      {
        header: 'Confirmation',
        question: 'Continue with the action?',
        options: [
          { label: 'Continue', value: 'continue', recommended: true },
          { label: 'Cancel', value: 'cancel' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('ApprovalPromptDock', () => {
  beforeEach(() => {
    testState.approvals = [];
    vi.clearAllMocks();
  });

  test('keeps optional single-choice approvals on the timed question prompt path', async () => {
    testState.approvals = [
      createQuestionRequest({
        questions: [
          {
            header: 'Confirmation',
            question: 'Continue with the action?',
            optional: true,
            options: [
              { label: 'Continue', value: 'continue', recommended: true },
              { label: 'Cancel', value: 'cancel' },
            ],
          },
        ],
      }),
    ];

    const { container } = render(<ApprovalPromptDock />);

    expect(await screen.findByText('Continue with the action?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Auto-selecting in \d+s\./)).toBeInTheDocument();
    });
    expect(container.querySelector('[data-kind="question"]')).toBeTruthy();
    expect(container.querySelector('[data-kind="quick-action"]')).toBeNull();
  });

  test('still uses the quick-action prompt for required single-choice approvals', async () => {
    testState.approvals = [createQuestionRequest()];

    const { container } = render(<ApprovalPromptDock />);

    expect(await screen.findByText('Confirmation')).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector('[data-kind="quick-action"]')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    expect(screen.queryByText('Continue with the action?')).not.toBeInTheDocument();
  });

  test('shows app icons on permission approvals', async () => {
    testState.approvals = [
      createQuestionRequest({
        toolName: 'cua_driver:control:Calculator',
        serverId: 'builtin-cua-driver',
        isSimpleApproval: true,
        context: {
          appIconDataUrl: APP_ICON_DATA_URL,
          appIconLabel: 'Calculator',
          message: 'Let Interpreter control "Calculator"?',
          sessionAware: true,
        },
      }),
    ];

    const { container } = render(<ApprovalPromptDock />);

    expect(await screen.findByText('Let Interpreter control "Calculator"?')).toBeInTheDocument();
    const icon = screen.getByRole('img', { name: 'Calculator app icon' });
    expect(icon).toHaveAttribute('src', APP_ICON_DATA_URL);
    expect(container.querySelector('.oa-approval-app-icon')).toBeTruthy();
    expect(screen.queryByText(APP_ICON_DATA_URL)).not.toBeInTheDocument();
  });

  test('submits editable permission-card draft fields from simple active-agent approvals', async () => {
    const user = userEvent.setup();
    testState.approvals = [
      createQuestionRequest({
        id: 'editable-card-approval',
        toolName: 'run_media_model',
        serverId: 'builtin-media-ai',
        isSimpleApproval: true,
        context: {
          message: 'Create this texture?',
          permissionCard: {
            version: 1,
            blocks: [
              {
                type: 'form',
                fields: [
                  {
                    id: 'prompt',
                    type: 'text',
                    label: 'Prompt',
                    value: 'mossy stone texture',
                  },
                  {
                    id: 'save_asset',
                    type: 'checkbox',
                    label: 'Save generated asset',
                    checked: true,
                  },
                ],
              },
            ],
          },
        },
      }),
    ];

    render(<ApprovalPromptDock />);

    expect(await screen.findByText('Create this texture?')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Prompt'));
    await user.type(screen.getByLabelText('Prompt'), 'brushed steel texture');
    await user.click(screen.getByLabelText('Save generated asset'));
    await user.click(screen.getByRole('button', { name: 'Allow once' }));

    await waitFor(() => {
      expect(ipcMocks.approvals.respond).toHaveBeenCalledWith({
        id: 'editable-card-approval',
        result: {
          answers: {
            '0': 'approve',
            permission_card_draft_json: JSON.stringify({
              prompt: 'brushed steel texture',
              save_asset: false,
            }),
          },
          approvalMode: 'once',
        },
      });
    });
  });

  test('shows only the active agent owned approval inside the agent dock', async () => {
    testState.approvals = [
      createQuestionRequest({
        id: 'other-agent-approval',
        isSimpleApproval: true,
        context: {
          message: 'Let Interpreter inspect another agent target?',
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
      createQuestionRequest({
        id: 'active-agent-approval',
        isSimpleApproval: true,
        context: {
          message: 'Let Interpreter inspect the active agent target?',
        },
        owner: {
          approvalOwnerKind: 'normal-agent',
          displayName: 'Active agent',
          color: '#2563eb',
          capturedAt: 11,
          identity: {
            agentId: 'agent-active',
            threadId: 'thread-active',
            windowSessionKey: 'window-active',
            workspacePath: '/workspace',
          },
        },
      }),
    ];

    const { container } = render(<ApprovalPromptDock agentId="agent-active" />);

    expect(await screen.findByText('Let Interpreter inspect the active agent target?')).toBeInTheDocument();
    expect(screen.queryByText('Let Interpreter inspect another agent target?')).not.toBeInTheDocument();
    expect(container.querySelector('[data-kind="permission"]')).toHaveStyle({
      boxShadow: 'inset 3px 0 0 #2563eb',
    });
  });
});
