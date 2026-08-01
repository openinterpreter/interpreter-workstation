import { describe, expect, test } from 'bun:test';
import { isAgentTab, type Tab } from '../../shared/types/layout';
import type { AgentModelConfig } from '../../shared/types/model';
import type { Profile } from '../../shared/types/profile';
import { getDefaultModelConfig, profileToModelConfig } from '../../shared/types/profile';
import { syncAgentProfileTabs } from './syncAgentProfileTabs';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    modelId: 'interpreter-smart',
    isBuiltin: false,
    provider: 'hosted',
    ...overrides,
  };
}

function makeAgentTab(
  profile: Profile,
  overrides: {
    id?: string;
    label?: string;
    modelConfig?: AgentModelConfig;
  } = {},
): Tab {
  return {
    id: overrides.id ?? 'agent-1',
    type: 'agent',
    label: overrides.label ?? 'Agent',
    agent: {
      runtime: {
        modelConfig: overrides.modelConfig ?? profileToModelConfig(profile),
      },
      session: {},
    },
  };
}

function getAgentModelConfig(tab: Tab | undefined): AgentModelConfig | undefined {
  if (!tab || !isAgentTab(tab)) return undefined;
  return tab.agent.runtime.modelConfig;
}

describe('syncAgentProfileTabs', () => {
  test('refreshes an idle agent tab to the latest profile snapshot', () => {
    const originalProfile = makeProfile();
    const updatedProfile = makeProfile({
      modelId: 'gpt-5.4',
      provider: 'openai-oauth',
      useResponsesApi: true,
    });
    const tab = makeAgentTab(originalProfile);

    const result = syncAgentProfileTabs({
      tabs: { [tab.id]: tab },
      profiles: [updatedProfile],
      defaultProfileId: updatedProfile.id,
      pendingTabIds: new Set(),
      isAgentRunning: () => false,
    });

    expect(result.changed).toBe(true);
    expect(result.pendingTabIds.size).toBe(0);
    expect(getAgentModelConfig(result.tabs[tab.id])).toEqual(profileToModelConfig(updatedProfile));
  });

  test('queues a running agent tab instead of mutating it immediately', () => {
    const originalProfile = makeProfile();
    const updatedProfile = makeProfile({
      modelId: 'gpt-5.4',
      provider: 'openai-oauth',
    });
    const tab = makeAgentTab(originalProfile);

    const result = syncAgentProfileTabs({
      tabs: { [tab.id]: tab },
      profiles: [updatedProfile],
      defaultProfileId: updatedProfile.id,
      pendingTabIds: new Set(),
      isAgentRunning: () => true,
    });

    expect(result.changed).toBe(false);
    expect(result.pendingTabIds.has(tab.id)).toBe(true);
    expect(getAgentModelConfig(result.tabs[tab.id])).toEqual(profileToModelConfig(originalProfile));
  });

  test('applies a queued refresh once the agent stops running', () => {
    const originalProfile = makeProfile();
    const updatedProfile = makeProfile({
      modelId: 'gpt-5.4',
      provider: 'openai-oauth',
      providerId: 'provider-1',
    });
    const tab = makeAgentTab(originalProfile);

    const queued = syncAgentProfileTabs({
      tabs: { [tab.id]: tab },
      profiles: [updatedProfile],
      defaultProfileId: updatedProfile.id,
      pendingTabIds: new Set(),
      isAgentRunning: () => true,
    });

    const applied = syncAgentProfileTabs({
      tabs: queued.tabs,
      profiles: [updatedProfile],
      defaultProfileId: updatedProfile.id,
      pendingTabIds: queued.pendingTabIds,
      isAgentRunning: () => false,
    });

    expect(applied.changed).toBe(true);
    expect(applied.pendingTabIds.size).toBe(0);
    expect(getAgentModelConfig(applied.tabs[tab.id])).toEqual(profileToModelConfig(updatedProfile));
  });

  test('rebinds stale agent profile ids to the latest default profile when the old profile is gone', () => {
    const defaultProfile = makeProfile({
      id: 'profile-openai',
      modelId: 'gpt-5.4',
      provider: 'api',
      apiFormat: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      useResponsesApi: true,
    });
    const staleTab = makeAgentTab(defaultProfile, {
      modelConfig: {
        ...profileToModelConfig(defaultProfile),
        profileId: 'default',
      },
    });

    const result = syncAgentProfileTabs({
      tabs: { [staleTab.id]: staleTab },
      profiles: [defaultProfile],
      defaultProfileId: defaultProfile.id,
      pendingTabIds: new Set(),
      isAgentRunning: () => false,
    });

    expect(result.changed).toBe(true);
    expect(result.pendingTabIds.size).toBe(0);
    expect(getAgentModelConfig(result.tabs[staleTab.id])).toEqual(
      profileToModelConfig(defaultProfile),
    );
  });

  test('rebinds fallback agent tabs with no profile id to the latest default profile', () => {
    const defaultProfile = makeProfile({
      id: 'profile-openai',
      modelId: 'gpt-5.4',
      provider: 'api',
      apiFormat: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      useResponsesApi: true,
    });
    const fallbackTab: Tab = {
      id: 'agent-fallback',
      type: 'agent',
      label: 'Agent',
      agent: {
        runtime: {
          modelConfig: getDefaultModelConfig(),
        },
        session: {},
      },
    };

    const result = syncAgentProfileTabs({
      tabs: { [fallbackTab.id]: fallbackTab },
      profiles: [defaultProfile],
      defaultProfileId: defaultProfile.id,
      defaultReasoningEffort: 'high',
      pendingTabIds: new Set(),
      isAgentRunning: () => false,
    });

    expect(result.changed).toBe(true);
    expect(result.pendingTabIds.size).toBe(0);
    expect(getAgentModelConfig(result.tabs[fallbackTab.id])).toEqual(
      profileToModelConfig(defaultProfile, { reasoningEffort: 'high' }),
    );
  });

  test('preserves a chat-level reasoning override when the profile snapshot refreshes', () => {
    const originalProfile = makeProfile({
      reasoningEffort: 'medium',
    });
    const updatedProfile = makeProfile({
      name: 'Updated Profile 1',
      reasoningEffort: 'low',
    });
    const tab = makeAgentTab(originalProfile, {
      modelConfig: {
        ...profileToModelConfig(originalProfile),
        reasoningEffort: 'high',
      },
    });

    const result = syncAgentProfileTabs({
      tabs: { [tab.id]: tab },
      profiles: [updatedProfile],
      defaultProfileId: updatedProfile.id,
      pendingTabIds: new Set(),
      isAgentRunning: () => false,
    });

    expect(getAgentModelConfig(result.tabs[tab.id])).toEqual(
      profileToModelConfig(updatedProfile, { reasoningEffort: 'high' }),
    );
  });
});
