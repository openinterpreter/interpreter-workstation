import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AgentDashboardTrack } from '../../apps/interpreter-overlay/renderer/AgentDashboardTrack';
import type { OverlayDashboardApproval, OverlayRunningAgent } from '../../apps/interpreter-overlay/shared/ipc';

const agent: OverlayRunningAgent = {
  agentId: 'agent-1',
  threadId: 'thread-1',
  windowSessionKey: 'window-1',
  workspacePath: '/workspace',
  label: 'Filling form',
  latestAction: 'Reading required fields',
  unreadCount: 2,
  updatedAt: '2026-06-21T10:00:00.000Z',
};

const approval: OverlayDashboardApproval = {
  id: 'approval-1',
  ownerAgentId: 'agent-1',
  ownerKind: 'normal-agent',
  ownerDisplayName: 'Filling form',
  ownerColor: '#38bdf8',
  title: 'Run command',
  detail: 'echo hello',
  isSimpleApproval: true,
  supportsSessionApproval: true,
  timestamp: 20,
};

const secondAgent: OverlayRunningAgent = {
  agentId: 'agent-2',
  threadId: 'thread-2',
  windowSessionKey: 'window-2',
  workspacePath: '/workspace',
  label: 'Email agent',
  latestAction: 'Drafting reply',
  unreadCount: 0,
  updatedAt: '2026-06-21T10:01:00.000Z',
};

const secondApproval: OverlayDashboardApproval = {
  id: 'approval-2',
  ownerAgentId: 'agent-2',
  ownerKind: 'normal-agent',
  ownerDisplayName: 'Email agent',
  ownerColor: '#f97316',
  title: 'Send email',
  detail: 'Send the drafted reply',
  isSimpleApproval: true,
  supportsSessionApproval: false,
  timestamp: 21,
};

describe('AgentDashboardTrack', () => {
  test('renders compact running agent state', () => {
    render(
      <AgentDashboardTrack
        agents={[agent]}
        onReveal={() => {}}
        onStop={() => {}}
        onSendMessage={() => {}}
      />,
    );

    expect(screen.getByRole('region', { name: 'Running agents' })).toBeTruthy();
    expect(screen.getByText('Filling form')).toBeTruthy();
    expect(screen.getByText('Reading required fields')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  test('sends reveal, stop, and follow-up message actions', () => {
    const reveal = vi.fn();
    const stop = vi.fn();
    const sendMessage = vi.fn();

    render(
      <AgentDashboardTrack
        agents={[agent]}
        onReveal={reveal}
        onStop={stop}
        onSendMessage={sendMessage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reveal Filling form' }));
    expect(reveal).toHaveBeenCalledWith('agent-1');

    fireEvent.click(screen.getByRole('button', { name: 'Stop Filling form' }));
    expect(stop).toHaveBeenCalledWith('agent-1');

    fireEvent.click(screen.getByRole('button', { name: 'Message Filling form' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Filling form' }), {
      target: { value: 'continue with the selected fields' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(sendMessage).toHaveBeenCalledWith('agent-1', 'continue with the selected fields');
  });

  test('renders all approval cards and routes simple approval actions', () => {
    const approve = vi.fn();
    const deny = vi.fn();

    render(
      <AgentDashboardTrack
        agents={[]}
        approvals={[approval]}
        onReveal={() => {}}
        onStop={() => {}}
        onSendMessage={() => {}}
        onApproveApproval={approve}
        onDenyApproval={deny}
      />,
    );

    expect(screen.getByLabelText('Pending approvals')).toBeTruthy();
    expect(screen.getByText('Filling form')).toBeTruthy();
    expect(screen.getByText('Run command')).toBeTruthy();
    expect(screen.getByText('echo hello')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(deny).toHaveBeenCalledWith('approval-1');

    fireEvent.click(screen.getByRole('button', { name: 'Approve session' }));
    expect(approve).toHaveBeenCalledWith('approval-1', true);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledWith('approval-1', false);
  });

  test('groups matching approval cards under a running agent', () => {
    const approve = vi.fn();
    const deny = vi.fn();

    render(
      <AgentDashboardTrack
        agents={[agent]}
        approvals={[approval]}
        onReveal={() => {}}
        onStop={() => {}}
        onSendMessage={() => {}}
        onApproveApproval={approve}
        onDenyApproval={deny}
      />,
    );

    const agentApprovals = screen.getByLabelText('Approvals for Filling form');
    expect(within(agentApprovals).getByText('Run command')).toBeTruthy();
    expect(within(agentApprovals).getByText('echo hello')).toBeTruthy();

    fireEvent.click(within(agentApprovals).getByRole('button', { name: 'Deny' }));
    expect(deny).toHaveBeenCalledWith('approval-1');

    fireEvent.click(within(agentApprovals).getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledWith('approval-1', false);
  });

  test('reveals the owner agent for non-simple approval cards', () => {
    const reveal = vi.fn();

    render(
      <AgentDashboardTrack
        agents={[agent]}
        approvals={[{
          ...approval,
          id: 'question-approval',
          isSimpleApproval: false,
          title: 'Pick account',
          detail: 'Choose the account to use',
        }]}
        onReveal={reveal}
        onStop={() => {}}
        onSendMessage={() => {}}
      />,
    );

    const agentApprovals = screen.getByLabelText('Approvals for Filling form');
    fireEvent.click(within(agentApprovals).getByRole('button', { name: 'Reveal' }));

    expect(reveal).toHaveBeenCalledWith('agent-1');
  });

  test('keeps multi-agent approval dropdowns scoped to their owning agent', () => {
    render(
      <AgentDashboardTrack
        agents={[agent, secondAgent]}
        approvals={[approval, secondApproval]}
        onReveal={() => {}}
        onStop={() => {}}
        onSendMessage={() => {}}
        onApproveApproval={() => {}}
        onDenyApproval={() => {}}
      />,
    );

    const allApprovals = screen.getByLabelText('Pending approvals');
    expect(within(allApprovals).getByText('Run command')).toBeTruthy();
    expect(within(allApprovals).getByText('Send email')).toBeTruthy();

    const firstAgentApprovals = screen.getByLabelText('Approvals for Filling form');
    expect(within(firstAgentApprovals).getByText('Run command')).toBeTruthy();
    expect(within(firstAgentApprovals).queryByText('Send email')).toBeNull();

    const secondAgentApprovals = screen.getByLabelText('Approvals for Email agent');
    expect(within(secondAgentApprovals).getByText('Send email')).toBeTruthy();
    expect(within(secondAgentApprovals).queryByText('Run command')).toBeNull();
  });
});
