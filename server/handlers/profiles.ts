/**
 * Profiles Handlers
 *
 * THE business logic for profile management.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import * as configStore from '../configStore';
import { broadcastEvent } from './broadcast';
import { getClaudeCodeStatus } from './providers';
import {
  buildAutomaticClaudeCodeTerminalProfile,
  rememberDismissedAutomaticProfile,
  shouldEnsureAutomaticClaudeCodeTerminalProfile,
} from './automaticProfiles';

// ============================================================================
// Profile Operations
// ============================================================================

let listProfilesInFlight: Promise<{
  profiles: any[];
  defaultProfileId: string | null;
  fastProfileId: string | null;
}> | null = null;

async function broadcastProfilesChanged(profileId: string | null): Promise<{
  defaultProfileId: string | null;
  fastProfileId: string | null;
}> {
  const defaultProfileId = await configStore.getDefaultProfileId();
  const fastProfileId = await configStore.getFastProfileId();

  broadcastEvent('profiles:changed', {
    defaultProfileId,
    fastProfileId,
    profileId,
  });

  return { defaultProfileId, fastProfileId };
}

async function ensureAutomaticClaudeCodeTerminalProfile(): Promise<void> {
  const config = await configStore.loadConfigWithModelState();

  if (!shouldEnsureAutomaticClaudeCodeTerminalProfile(config, true)) {
    return;
  }

  const claudeCodeStatus = await getClaudeCodeStatus().catch(() => ({ installed: false, loggedIn: false }));
  if (!shouldEnsureAutomaticClaudeCodeTerminalProfile(config, claudeCodeStatus.installed)) {
    return;
  }

  const autoProfile = buildAutomaticClaudeCodeTerminalProfile();
  config.profiles = [...(config.profiles ?? []), autoProfile];
  await configStore.saveConfig(config);
  await broadcastProfilesChanged(autoProfile.id);
}

async function listProfilesInternal(): Promise<{
  profiles: any[];
  defaultProfileId: string | null;
  fastProfileId: string | null;
}> {
  await ensureAutomaticClaudeCodeTerminalProfile();
  const profiles = await configStore.getAllProfiles();
  const defaultProfileId = await configStore.getDefaultProfileId();
  const fastProfileId = await configStore.getFastProfileId();
  return { profiles, defaultProfileId, fastProfileId };
}

export async function listProfiles(): Promise<{
  profiles: any[];
  defaultProfileId: string | null;
  fastProfileId: string | null;
}> {
  if (listProfilesInFlight) {
    return await listProfilesInFlight;
  }

  listProfilesInFlight = listProfilesInternal();
  try {
    return await listProfilesInFlight;
  } finally {
    listProfilesInFlight = null;
  }
}

export async function getProfile(profileId: string): Promise<any> {
  return await configStore.getProfile(profileId);
}

export async function createProfile(profile: any): Promise<{
  success: boolean;
  profile: any;
}> {
  await configStore.addProfile(profile);
  await broadcastProfilesChanged(profile.id);
  return { success: true, profile };
}

export async function updateProfile(
  profileId: string,
  updates: any
): Promise<{ success: boolean; profile: any }> {
  await configStore.updateProfile(profileId, updates);
  const updated = await configStore.getProfile(profileId);
  await broadcastProfilesChanged(profileId);
  return { success: true, profile: updated };
}

export async function deleteProfile(profileId: string): Promise<{ success: boolean }> {
  const config = await configStore.loadConfigWithModelState();
  const nextDismissedAutomaticProfileIds = rememberDismissedAutomaticProfile(
    profileId,
    config.dismissedAutomaticProfileIds,
  );
  if (nextDismissedAutomaticProfileIds !== config.dismissedAutomaticProfileIds) {
    config.dismissedAutomaticProfileIds = nextDismissedAutomaticProfileIds;
    await configStore.saveConfig(config);
  }

  await configStore.deleteProfile(profileId);
  const { defaultProfileId, fastProfileId } = await broadcastProfilesChanged(profileId);
  broadcastEvent('profiles:default-changed', { defaultProfileId, fastProfileId });

  return { success: true };
}

export async function setDefaultProfile(profileId: string): Promise<{
  success: boolean;
  defaultProfileId: string;
  fastProfileId: string | null;
}> {
  await configStore.setDefaultProfileId(profileId);
  const { defaultProfileId, fastProfileId } = await broadcastProfilesChanged(profileId);
  // Broadcast to sync all UI components
  broadcastEvent('profiles:default-changed', { defaultProfileId, fastProfileId });
  return { success: true, defaultProfileId: defaultProfileId!, fastProfileId };
}

export async function setFastProfile(profileId: string): Promise<{
  success: boolean;
  defaultProfileId: string | null;
  fastProfileId: string;
}> {
  await configStore.setFastProfileId(profileId);
  const { defaultProfileId, fastProfileId } = await broadcastProfilesChanged(profileId);
  broadcastEvent('profiles:default-changed', { defaultProfileId, fastProfileId: profileId });
  return { success: true, defaultProfileId, fastProfileId: fastProfileId! };
}

export async function resetProfile(profileId: string): Promise<{
  success: boolean;
  profile: any;
}> {
  const profile = await configStore.resetProfile(profileId);
  await broadcastProfilesChanged(profileId);
  return { success: true, profile };
}
