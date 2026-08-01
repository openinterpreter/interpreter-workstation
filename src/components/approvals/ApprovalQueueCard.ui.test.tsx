import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { QuestionRequest } from '../../../shared/types/approval';
import { APPROVAL_ITEM_ID } from '../../../shared/element-ids';
import type { ApprovalQueueItem } from '../../lib/approvals/approvalQueue';
import { ApprovalQueueCard } from './ApprovalQueueCard';

const browserControlMocks = vi.hoisted(() => ({
  activateTab: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/ipc', () => ({
  browserControl: browserControlMocks,
}));

function makeApproval(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: overrides.id ?? 'approval-1',
    toolName: overrides.toolName ?? 'shell_exec',
    serverId: overrides.serverId ?? 'builtin-shell',
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
      message: 'Interpreter wants to run this command.',
      sessionAware: true,
    },
    timestamp: overrides.timestamp ?? Date.now(),
    isSimpleApproval: overrides.isSimpleApproval ?? true,
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    ...(overrides.owner !== undefined ? { owner: overrides.owner } : {}),
  };
}

function makeItem(overrides: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem {
  return {
    approval: overrides.approval ?? makeApproval(),
    owner: overrides.owner ?? {
      kind: 'normal-agent',
      agentId: 'agent-1',
      threadId: 'thread-1',
      windowSessionKey: 'window-1',
      workspacePath: '/workspace',
      displayName: 'Research agent',
      color: '#0f766e',
    },
  };
}

function renderCard(item = makeItem(), overrides: Partial<Parameters<typeof ApprovalQueueCard>[0]> = {}) {
  const props = {
    item,
    pendingCount: 1,
    questionSettings: { enabled: true, seconds: 15 },
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onQuestionRespond: vi.fn(),
    onRevealAgent: vi.fn(),
    ...overrides,
  };

  render(<ApprovalQueueCard {...props} />);
  return props;
}

describe('ApprovalQueueCard', () => {
  beforeEach(() => {
    browserControlMocks.activateTab.mockClear();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  test('renders owner-aware permission card content without owning queue filtering', () => {
    const item = makeItem();
    renderCard(item);

    const card = screen.getByTestId(APPROVAL_ITEM_ID(item.approval.id));
    expect(card).toHaveStyle({ boxShadow: `inset 3px 0 0 ${item.owner.color}` });
    expect(screen.getByText('Research agent')).toBeInTheDocument();
    expect(screen.getByText('builtin-shell')).toBeInTheDocument();
    expect(screen.getByText('Interpreter wants to run a command.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow for this session' })).toBeInTheDocument();
  });

  test('reveals the owning agent when an agent owner is present', async () => {
    const user = userEvent.setup();
    const onRevealAgent = vi.fn();
    const item = makeItem();
    renderCard(item, { onRevealAgent });

    await user.click(screen.getByRole('button', { name: 'Show' }));

    expect(onRevealAgent).toHaveBeenCalledWith('agent-1', item.approval);
  });

  test('resolves permission cards through quick one-click actions', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const item = makeItem();

    renderCard(item, { onApprove, onDeny });

    await user.click(screen.getByRole('button', { name: "Don't allow" }));
    expect(onDeny).toHaveBeenCalledWith(item.approval.id);

    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(onApprove).toHaveBeenCalledWith(item.approval.id, 'once', item.approval);

    await user.click(screen.getByRole('button', { name: 'Allow for this session' }));
    expect(onApprove).toHaveBeenCalledWith(item.approval.id, 'session', item.approval);
  });

  test('submits schema-backed editable permission-card draft fields with approval', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const item = makeItem({
      approval: makeApproval({
        context: {
          message: 'Create this image?',
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
                  {
                    id: '<script>',
                    type: 'text',
                    label: '',
                    value: 'ignored',
                  },
                ],
              },
            ],
          },
        },
      }),
    });

    renderCard(item, { onApprove });

    await user.clear(screen.getByLabelText('Prompt'));
    await user.type(screen.getByLabelText('Prompt'), 'brushed steel texture');
    await user.click(screen.getByLabelText('Save generated asset'));
    await user.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(onApprove).toHaveBeenCalledWith(item.approval.id, 'once', item.approval, {
      permission_card_draft_json: JSON.stringify({
        prompt: 'brushed steel texture',
        save_asset: false,
      }),
    });
    expect(screen.queryByDisplayValue('ignored')).not.toBeInTheDocument();
  });

  test('does not show an active-agent reveal button for non-tab global approvals', () => {
    const item = makeItem({
      owner: {
        kind: 'overlay-agent',
        agentId: null,
        threadId: 'overlay-thread',
        windowSessionKey: 'overlay-window',
        workspacePath: '/workspace',
        displayName: 'Overlay',
        color: '#0891b2',
      },
    });
    renderCard(item);

    expect(screen.getByText('Overlay')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show' })).not.toBeInTheDocument();
  });

  test('renders browser permission support content for question cards', async () => {
    const user = userEvent.setup();
    const item = makeItem({
      approval: makeApproval({
        isSimpleApproval: false,
        toolName: 'interpreter_browser_page_click',
        serverId: 'builtin-interpreter',
        questions: [
          {
            question: 'Browser page control is blocked by Settings > Browser.',
            options: [{ label: 'Dismiss', value: 'dismiss' }],
          },
        ],
        context: {
          message: 'Browser permission needed',
          description: 'Interpreter browser settings blocked this request.',
          permissionCard: {
            version: 1,
            blocks: [
              {
                type: 'list',
                items: [
                  {
                    label: 'Attempted action',
                    description: 'Click ref browser-element:rev-1:0 in frame 0.',
                  },
                ],
              },
              {
                type: 'browser-tab',
                title: 'Checkout',
                url: 'https://shop.example.test/checkout',
                tabRef: 'install:work:chrome-tab:91',
                description: 'Show the tab to review it.',
              },
            ],
          },
        },
      }),
    });

    renderCard(item);

    expect(screen.getAllByText('Checkout').length).toBeGreaterThan(0);
    expect(screen.getByText('Attempted action')).toBeInTheDocument();
    expect(screen.getByText('Click ref browser-element:rev-1:0 in frame 0.')).toBeInTheDocument();
    expect(screen.getByText('https://shop.example.test/checkout')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show tab' }));
    expect(browserControlMocks.activateTab).toHaveBeenCalledWith({ tabRef: 'install:work:chrome-tab:91' });
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});
