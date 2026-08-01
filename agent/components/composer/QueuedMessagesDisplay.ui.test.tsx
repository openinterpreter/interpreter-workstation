import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { AgentPendingInput } from '../../../src/stores/agentPendingInputStore';
import { QueuedMessagesDisplay } from './QueuedMessagesDisplay';

vi.mock('../prompt-kit/markdown', () => ({
  Markdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

function makePendingInput(overrides: Partial<AgentPendingInput> = {}): AgentPendingInput {
  return {
    id: 'pending-1',
    agentId: 'agent-1',
    draftText: 'Help me debug this',
    previewText: 'Help me debug this',
    messageText: 'Help me debug this',
    afterNextToolState: null,
    submittedText: null,
    workspacePath: null,
    contextSnapshot: null,
    stage: 'endOfTurn',
    createdAt: 1,
    ...overrides,
  };
}

describe('QueuedMessagesDisplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('shows submitted after-next-tool messages as steered without queue actions', () => {
    render(
      <QueuedMessagesDisplay
        pendingInputs={[
          makePendingInput({
            stage: 'afterNextTool',
            afterNextToolState: 'submitted',
            submittedText: 'Help me debug this',
          }),
        ]}
        isStreaming={true}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onInterruptNow={vi.fn()}
        onQueueForEndOfTurn={vi.fn()}
        onSendAfterNextTool={vi.fn()}
      />,
    );

    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'send immediately' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'send at end of turn' })).not.toBeInTheDocument();
  });

  test('shows both follow-up actions before the after-next-tool steer is submitted', () => {
    render(
      <QueuedMessagesDisplay
        pendingInputs={[
          makePendingInput({
            stage: 'afterNextTool',
            afterNextToolState: 'local',
          }),
        ]}
        isStreaming={true}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onInterruptNow={vi.fn()}
        onQueueForEndOfTurn={vi.fn()}
        onSendAfterNextTool={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'send immediately' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'send at end of turn' })).toBeInTheDocument();
  });
});
