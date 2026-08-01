import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { AgentModelConfig } from '../../../shared/types/model';
import { profileToModelConfig, type Profile } from '../../../shared/types/profile';
import { SettingsPopover } from './SettingsPopover';

const regularProfile: Profile = {
  id: 'profile-regular',
  name: 'Reasoning Hosted',
  modelId: 'openai/gpt-5.4',
  isBuiltin: false,
  provider: 'hosted',
  providerId: 'builtin:hosted',
};

const terminalProfile: Profile = {
  id: 'profile-terminal',
  name: 'Claude Code Terminal',
  modelId: 'claude-code-terminal',
  isBuiltin: false,
  provider: 'terminal',
  providerConfig: {
    id: 'claude-code',
    command: 'claude',
  },
};

const apiMocks = vi.hoisted(() => ({
  getProfiles: vi.fn(async () => ({
    profiles: [regularProfile, terminalProfile],
    defaultProfileId: regularProfile.id,
    fastProfileId: null,
  })),
  setDefaultProfile: vi.fn(async () => ({
    success: true,
    defaultProfileId: regularProfile.id,
    fastProfileId: null,
  })),
}));

const ipcMocks = vi.hoisted(() => ({
  profiles: {
    onChanged: vi.fn(() => () => {}),
  },
  providers: {
    listOpenAIOAuthModels: vi.fn(async () => ({ models: [] })),
    listOpenRouterModels: vi.fn(async () => ({
      models: [
        {
          id: 'openai/gpt-5.4',
          name: 'GPT-5.4',
          provider: 'openai',
          description: 'Flagship reasoning model',
          contextLength: 400000,
          supportedReasoningEfforts: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium',
        },
      ],
      fetchedAt: Date.now(),
      stale: false,
    })),
  },
  workspace: {
    get: vi.fn(async () => ({ workspace: '/workspace' })),
  },
}));

const layoutMocks = vi.hoisted(() => ({
  openAgentTab: vi.fn(),
  openSettings: vi.fn(),
  updateTab: vi.fn(),
  updateTabModelConfig: vi.fn(),
}));

vi.mock('../../../src/api', () => apiMocks);
vi.mock('../../../src/ipc', () => ipcMocks);

vi.mock('../../../src/hooks/useLayout', () => ({
  useLayout: () => layoutMocks,
}));

vi.mock('../../../src/hooks/useInterpreterTokenUsage', () => ({
  useInterpreterTokenUsage: () => ({ percentRemaining: null }),
}));

vi.mock('../../../src/contexts/CommandOverlayContext', () => ({
  useCommandOverlay: () => ({ isCommandHeld: false }),
}));

vi.mock('../../../src/components/ProfileShortcutWheel', () => ({
  ProfileShortcutWheel: ({ fallbackLabel }: { fallbackLabel: string }) => <span>{fallbackLabel}</span>,
}));

vi.mock('../../../src/components/ReasoningEffortControl', () => ({
  ReasoningEffortControl: ({ onChange }: { onChange: (value: 'low' | 'medium' | 'high') => void }) => (
    <button type="button" onClick={() => onChange('high')}>
      Set reasoning high
    </button>
  ),
}));

vi.mock('../../../src/components/ModelSelectorPopoverPanel', () => ({
  ModelSelectorPopoverPanel: ({ onProfileSelect, children, getCompactActionLabel }: {
    onProfileSelect: (profile: Profile, shouldClose: boolean) => void;
    getCompactActionLabel?: (profile: Profile) => string | null;
    children?: ReactNode;
  }) => (
    <div>
      <div data-testid="profile-action-profile-regular">{getCompactActionLabel?.(regularProfile)}</div>
      <div data-testid="profile-action-profile-terminal">{getCompactActionLabel?.(terminalProfile)}</div>
      <button type="button" onClick={() => onProfileSelect(regularProfile, true)}>
        Pick regular profile
      </button>
      <button type="button" onClick={() => onProfileSelect(terminalProfile, true)}>
        Pick terminal profile
      </button>
      {children}
    </div>
  ),
}));

function renderPopover(
  modelConfig: AgentModelConfig,
  extraProps?: Partial<ComponentProps<typeof SettingsPopover>>,
) {
  render(
    <SettingsPopover
      agentId="agent-1"
      modelConfig={modelConfig}
      {...extraProps}
    />,
  );
}

describe('SettingsPopover', () => {
  test('shows the profile selector trigger and toggles the popover open and closed', async () => {
    const user = userEvent.setup();

    renderPopover({
      provider: 'hosted',
      modelId: 'interpreter-fast',
      profileId: regularProfile.id,
    });

    const trigger = screen.getByTestId('agent-settings-button');
    expect(trigger).toBeVisible();

    await user.click(trigger);
    expect(await screen.findByTestId('settings-popover')).toBeVisible();
    expect(screen.getByTestId('settings-popover-close-button')).toBeVisible();

    await user.click(screen.getByTestId('settings-popover-close-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('settings-popover')).not.toBeInTheDocument();
    });
  });

  test('selecting a regular profile updates the agent model config and default profile', async () => {
    const user = userEvent.setup();
    renderPopover({
      provider: 'hosted',
      modelId: 'interpreter-fast',
      profileId: 'profile-old',
    });

    await user.click(screen.getByTestId('agent-settings-button'));
    await user.click(await screen.findByRole('button', { name: 'Pick regular profile' }));

    await waitFor(() => {
      expect(layoutMocks.updateTabModelConfig).toHaveBeenCalledWith('agent-1', {
        ...profileToModelConfig(regularProfile),
        reasoningEffort: 'medium',
      });
      expect(apiMocks.setDefaultProfile).toHaveBeenCalledWith(regularProfile.id);
    });
  });

  test('selecting a terminal profile replaces the empty editor tab with a terminal tab using the workspace cwd', async () => {
    const user = userEvent.setup();
    layoutMocks.openAgentTab.mockClear();
    layoutMocks.updateTab.mockClear();
    renderPopover({
      provider: 'hosted',
      modelId: 'interpreter-fast',
      profileId: 'profile-old',
    });

    await user.click(screen.getByTestId('agent-settings-button'));
    await user.click(await screen.findByRole('button', { name: 'Pick terminal profile' }));

    await waitFor(() => {
      expect(layoutMocks.updateTab).toHaveBeenCalledWith('agent-1', expect.any(Function));
    });

    expect(layoutMocks.openAgentTab).not.toHaveBeenCalled();

    const updateTabCallback = layoutMocks.updateTab.mock.calls[0]?.[1];
    expect(updateTabCallback).toBeTypeOf('function');
    expect(updateTabCallback()).toMatchObject({
      id: 'agent-1',
      type: 'terminal',
      label: 'Claude Code Terminal',
      terminalAgent: 'claude-code',
      modelConfig: profileToModelConfig(terminalProfile),
      cwd: '/workspace',
    });
    expect(updateTabCallback().agentTabId).toMatch(/^terminal-/);
  });

  test('opening a different provider during an active conversation creates a fresh tab and marks it as New Chat', async () => {
    const user = userEvent.setup();
    layoutMocks.openAgentTab.mockClear();
    layoutMocks.updateTabModelConfig.mockClear();

    renderPopover(
      {
        provider: 'api',
        modelId: 'gpt-5.4',
        profileId: 'profile-openai-api',
        apiFormat: 'openai',
        apiKey: 'sk-test',
        baseURL: 'https://api.openai.com/v1',
        codexProfileId: 'openai-api',
      },
      {
        messageCount: 3,
        hasCodexThread: true,
        workspacePath: '/workspace/current',
      },
    );

    await user.click(screen.getByTestId('agent-settings-button'));

    await screen.findByTestId('settings-popover');
    expect(screen.getByTestId('profile-action-profile-regular')).toHaveTextContent('New Chat');

    await user.click(screen.getByRole('button', { name: 'Pick regular profile' }));

    await waitFor(() => {
      expect(layoutMocks.openAgentTab).toHaveBeenCalledTimes(1);
      expect(layoutMocks.updateTabModelConfig).not.toHaveBeenCalled();
      expect(apiMocks.setDefaultProfile).toHaveBeenCalledWith(regularProfile.id);
    });

    const [nextAgentId, nextLabel, nextOptions, nextPaneId] =
      layoutMocks.openAgentTab.mock.calls[0] ?? [];
    expect(nextAgentId).toEqual(expect.any(String));
    expect(nextLabel).toBe(regularProfile.name);
    expect(nextOptions).toEqual({
      modelConfig: {
        ...profileToModelConfig(regularProfile),
        reasoningEffort: 'medium',
      },
      workspacePath: '/workspace/current',
    });
    expect(nextPaneId).toBeUndefined();
  });

  test('same-provider changes stay in the current tab during an active conversation', async () => {
    const user = userEvent.setup();
    layoutMocks.openAgentTab.mockClear();
    layoutMocks.updateTabModelConfig.mockClear();

    renderPopover(
      {
        provider: 'hosted',
        modelId: 'interpreter-fast',
        profileId: 'profile-old',
      },
      {
        messageCount: 3,
        hasCodexThread: true,
      },
    );

    await user.click(screen.getByTestId('agent-settings-button'));
    expect(screen.getByTestId('profile-action-profile-regular')).toBeEmptyDOMElement();

    await user.click(screen.getByRole('button', { name: 'Pick regular profile' }));

    await waitFor(() => {
      expect(layoutMocks.updateTabModelConfig).toHaveBeenCalledWith('agent-1', {
        ...profileToModelConfig(regularProfile),
        reasoningEffort: 'medium',
      });
      expect(layoutMocks.openAgentTab).not.toHaveBeenCalled();
    });
  });

  test('updates the reasoning effort from the inline reasoning control', async () => {
    const user = userEvent.setup();
    renderPopover({
      ...profileToModelConfig(regularProfile),
      reasoningEffort: 'medium',
    });

    await user.click(screen.getByTestId('agent-settings-button'));
    await screen.findByRole('button', { name: 'Set reasoning high' });
    layoutMocks.updateTabModelConfig.mockClear();

    await user.click(screen.getByRole('button', { name: 'Set reasoning high' }));

    expect(layoutMocks.updateTabModelConfig).toHaveBeenCalledWith('agent-1', {
      ...profileToModelConfig(regularProfile),
      reasoningEffort: 'high',
    });
  });
});
