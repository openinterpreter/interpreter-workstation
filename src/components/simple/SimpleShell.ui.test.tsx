import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../agent/components/AgentThread', () => ({
  AgentThread: ({ agentId, codexThreadId, onCodexThreadIdAssigned }: {
    agentId: string;
    codexThreadId?: string;
    onCodexThreadIdAssigned: (agentId: string, threadId: string) => void;
  }) => <div>Thread {agentId} {codexThreadId ?? 'new'}
    <button type="button" onClick={() => onCodexThreadIdAssigned(agentId, 'oix-thread-42')}>Assign thread</button>
  </div>,
}));
vi.mock('../../../agent/components/ComposerArea', () => ({
  ComposerArea: ({ onAgentSend }: { onAgentSend: (text: string) => void }) =>
    <button type="button" onClick={() => onAgentSend('Hello')}>Send prompt</button>,
}));
vi.mock('../../../agent/contexts/AgentMetadataContext', () => ({
  AgentMetadataProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../../agent/contexts/AgentErrorContext', () => ({
  AgentErrorProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./useSimpleStoredProfile', () => ({ useSimpleStoredProfile: () => ({ status: 'ready', profileId: 'saved-profile', modelConfig: { profileId: 'saved-profile', model: 'test-model', provider: 'openai' }, availableProfiles: [{ id: 'saved-profile', name: 'Saved model' }], selecting: false, selectionError: null, selectProfile: vi.fn() }) }));
vi.mock('../../remote/workstationConnection', () => ({ isWorkstationReadOnly: () => false }));
vi.mock('@/ipc', () => ({ simplePrimaryThread: { onOverlaySubmit: () => () => {} } }));
vi.mock('../../utils/layoutHelpers', () => ({ createAgentCallerToken: () => 'token-for-test' }));
vi.mock('../settings/ExperienceSection', () => ({ ExperienceSectionContent: () => <div>Experience choices</div> }));
vi.mock('../settings/ProfilesSection', () => ({ ProfilesSectionContent: () => <div>Saved model editor</div> }));
vi.mock('./RemoteWorkstationsSection', () => ({ RemoteWorkstationsSection: () => <div>Remote connections</div> }));

import { SIMPLE_PRIMARY_AGENT_ID, SimpleShell, sendSimpleMessage } from './SimpleShell';

const props = {
  workspacePath: '/documents/Interpreter',
  initialThreadId: null,
  onBindThread: vi.fn(),
  onOpenSettings: vi.fn(),
  settingsOpen: false,
  onCloseSettings: vi.fn(),
  canvas: <button type="button">Generated interface action</button>,
};

describe('Simple shell', () => {
  test('shows a full-page interface and one collapsed persistent composer', async () => {
    const user = userEvent.setup();
    render(<SimpleShell {...props} />);
    expect(screen.getByRole('main', { name: 'Interface' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Generated interface action' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Expand conversation' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Expand conversation' }));
    expect(screen.getByRole('button', { name: 'Collapse conversation' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Generated interface action' }));
    expect(screen.getByRole('button', { name: 'Expand conversation' })).toBeVisible();
  });

  test('chat and generated UI messages route to the same primary agent and workspace', async () => {
    const onSend = vi.fn();
    const onState = (event: Event) => (event as CustomEvent).detail.callback({ isRunning: false });
    window.addEventListener('agent-runtime:send', onSend);
    window.addEventListener('agent-runtime:get-state', onState);
    const user = userEvent.setup();
    render(<SimpleShell {...props} />);
    await user.click(screen.getByRole('button', { name: 'Send prompt' }));
    sendSimpleMessage('Action selection', '/documents/Interpreter');
    expect(onSend).toHaveBeenCalledTimes(2);
    for (const [event] of onSend.mock.calls) {
      expect((event as CustomEvent).detail).toMatchObject({
        tabId: SIMPLE_PRIMARY_AGENT_ID,
        workspacePath: '/documents/Interpreter',
      });
    }
    window.removeEventListener('agent-runtime:send', onSend);
    window.removeEventListener('agent-runtime:get-state', onState);
  });

  test('interface actions fail visibly rather than disappearing when the runtime is absent', () => {
    expect(() => sendSimpleMessage('Choose option', '/documents/Interpreter')).toThrow('not ready');
  });

  test('binds assigned thread to durable backend and opens simple Settings', async () => {
    const user = userEvent.setup();
    const onBindThread = vi.fn();
    const onOpenSettings = vi.fn();
    const view = render(<SimpleShell {...props} onBindThread={onBindThread} onOpenSettings={onOpenSettings} />);
    await user.click(screen.getByRole('button', { name: 'Expand conversation' }));
    await user.click(screen.getByRole('button', { name: 'Assign thread' }));
    await waitFor(() => expect(onBindThread).toHaveBeenCalledWith('oix-thread-42'));
    expect(screen.getByText(`Thread ${SIMPLE_PRIMARY_AGENT_ID} oix-thread-42`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    view.rerender(<SimpleShell {...props} settingsOpen={true} />);
    expect(screen.getByText('Experience choices')).toBeVisible();
    expect(screen.getByText('Manage models')).toBeVisible();
    await user.click(screen.getByText('Manage models'));
    expect(await screen.findByText('Saved model editor')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Generated interface action' })).toBeInTheDocument();
  });

  test('failed thread binding stops composer and shows explicit recovery', async () => {
    const user = userEvent.setup();
    const onBindThread = vi.fn(async () => { throw new Error('Conflict'); });
    render(<SimpleShell {...props} onBindThread={onBindThread} />);
    await user.click(screen.getByRole('button', { name: 'Expand conversation' }));
    await user.click(screen.getByRole('button', { name: 'Assign thread' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload Interpreter to recover');
    expect(screen.queryByRole('button', { name: 'Send prompt' })).not.toBeInTheDocument();
  });
});
