import { isAgentTab, type Tab } from '../../shared/types/layout';
import type { AgentModelConfig } from '../../shared/types/model';
import type { Profile } from '../../shared/types/profile';
import type { ReasoningEffort } from '../../shared/types/reasoning';
import {
  getDefaultModelConfig,
  modelConfigMatchesProfile,
  profileToModelConfig,
} from '../../shared/types/profile';

export interface SyncAgentProfileTabsArgs {
  tabs: Record<string, Tab>;
  profiles: Profile[];
  defaultProfileId: string | null;
  defaultReasoningEffort?: ReasoningEffort;
  pendingTabIds: ReadonlySet<string>;
  isAgentRunning: (tabId: string) => boolean;
}

export interface SyncAgentProfileTabsResult {
  tabs: Record<string, Tab>;
  pendingTabIds: Set<string>;
  changed: boolean;
}

function modelConfigSignature(modelConfig: AgentModelConfig | undefined): string {
  return JSON.stringify(modelConfig ?? null);
}

export function areAgentModelConfigsEqual(
  left: AgentModelConfig | undefined,
  right: AgentModelConfig | undefined
): boolean {
  return modelConfigSignature(left) === modelConfigSignature(right);
}

export function syncAgentProfileTabs({
  tabs,
  profiles,
  defaultProfileId,
  defaultReasoningEffort,
  pendingTabIds,
  isAgentRunning,
}: SyncAgentProfileTabsArgs): SyncAgentProfileTabsResult {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const defaultProfile =
    defaultProfileId !== null ? profilesById.get(defaultProfileId) ?? null : null;
  const fallbackModelConfig = getDefaultModelConfig();
  const tabIdsToCheck = new Set<string>(pendingTabIds);

  for (const tab of Object.values(tabs)) {
    if (!isAgentTab(tab)) continue;
    if (!tab.agent.runtime.modelConfig?.profileId) {
      if (defaultProfile && areAgentModelConfigsEqual(tab.agent.runtime.modelConfig, fallbackModelConfig)) {
        tabIdsToCheck.add(tab.id);
      }
      continue;
    }
    tabIdsToCheck.add(tab.id);
  }

  let nextTabs = tabs;
  let changed = false;
  const nextPendingTabIds = new Set<string>(pendingTabIds);

  for (const tabId of tabIdsToCheck) {
    const tab = nextTabs[tabId];
    if (!tab || !isAgentTab(tab)) {
      nextPendingTabIds.delete(tabId);
      continue;
    }

    const profileId = tab.agent.runtime.modelConfig?.profileId;
    if (!profileId) {
      if (!defaultProfile || !areAgentModelConfigsEqual(tab.agent.runtime.modelConfig, fallbackModelConfig)) {
        nextPendingTabIds.delete(tabId);
        continue;
      }

      const nextModelConfig = profileToModelConfig(defaultProfile, {
        reasoningEffort: defaultReasoningEffort,
      });
      if (isAgentRunning(tabId)) {
        nextPendingTabIds.add(tabId);
        continue;
      }

      nextTabs = {
        ...nextTabs,
        [tabId]: {
          ...tab,
          agent: {
            ...tab.agent,
            runtime: {
              ...tab.agent.runtime,
              modelConfig: nextModelConfig,
            },
          },
        },
      };
      nextPendingTabIds.delete(tabId);
      changed = true;
      continue;
    }

    const profile = profilesById.get(profileId);
    if (!profile) {
      if (!defaultProfile) {
        nextPendingTabIds.delete(tabId);
        continue;
      }

      const nextModelConfig = profileToModelConfig(defaultProfile, {
        reasoningEffort: defaultReasoningEffort,
      });
      if (areAgentModelConfigsEqual(tab.agent.runtime.modelConfig, nextModelConfig)) {
        nextPendingTabIds.delete(tabId);
        continue;
      }

      if (isAgentRunning(tabId)) {
        nextPendingTabIds.add(tabId);
        continue;
      }

      nextTabs = {
        ...nextTabs,
        [tabId]: {
          ...tab,
          agent: {
            ...tab.agent,
            runtime: {
              ...tab.agent.runtime,
              modelConfig: nextModelConfig,
            },
          },
        },
      };
      nextPendingTabIds.delete(tabId);
      changed = true;
      continue;
    }

    const nextModelConfig = profileToModelConfig(profile, {
      reasoningEffort: modelConfigMatchesProfile(tab.agent.runtime.modelConfig ?? getDefaultModelConfig(), profile)
        ? tab.agent.runtime.modelConfig?.reasoningEffort
        : undefined,
    });
    if (areAgentModelConfigsEqual(tab.agent.runtime.modelConfig, nextModelConfig)) {
      nextPendingTabIds.delete(tabId);
      continue;
    }

    if (isAgentRunning(tabId)) {
      nextPendingTabIds.add(tabId);
      continue;
    }

    nextTabs = {
      ...nextTabs,
      [tabId]: {
        ...tab,
        agent: {
          ...tab.agent,
          runtime: {
            ...tab.agent.runtime,
            modelConfig: nextModelConfig,
          },
        },
      },
    };
    nextPendingTabIds.delete(tabId);
    changed = true;
  }

  return {
    tabs: nextTabs,
    pendingTabIds: nextPendingTabIds,
    changed,
  };
}
