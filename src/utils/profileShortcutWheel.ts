import type { Profile } from '../../shared/types/profile';

export type ProfileShortcutWheelPhase = 'idle' | 'active' | 'rewinding' | 'fading';

export interface ProfileShortcutWheelStateInput {
  profiles: Profile[];
  selectedProfileId?: string | null;
  fallbackLabel: string;
  index: number;
  phase: ProfileShortcutWheelPhase;
}

export interface ProfileShortcutWheelState {
  previewProfiles: Profile[];
  profileCount: number;
  selectedIndex: number;
  currentSlot: number;
  currentProfileLabel: string;
  visibleTriggerLabel: string;
  isShortcutOpaque: boolean;
  isShortcutLayoutVisible: boolean;
}

export const PROFILE_SHORTCUT_PREVIEW_COUNT = 9;

export function getProfileShortcutWheelState({
  profiles,
  selectedProfileId,
  fallbackLabel,
  index,
  phase,
}: ProfileShortcutWheelStateInput): ProfileShortcutWheelState {
  const previewProfiles = profiles.slice(0, PROFILE_SHORTCUT_PREVIEW_COUNT);
  const profileCount = previewProfiles.length;
  const selectedIndex = (() => {
    const foundIndex = previewProfiles.findIndex((profile) => profile.id === selectedProfileId);
    return foundIndex >= 0 ? foundIndex : 0;
  })();
  const currentSlot = profileCount > 0
    ? ((index % profileCount) + profileCount) % profileCount + 1
    : 1;
  const currentProfileLabel = profileCount > 0
    ? previewProfiles[currentSlot - 1]?.name ?? fallbackLabel
    : fallbackLabel;
  const isShortcutOpaque = (phase === 'active' || phase === 'rewinding') && profileCount > 0;
  const isShortcutLayoutVisible = phase !== 'idle' && profileCount > 0;

  return {
    previewProfiles,
    profileCount,
    selectedIndex,
    currentSlot,
    currentProfileLabel,
    visibleTriggerLabel: isShortcutLayoutVisible ? currentProfileLabel : fallbackLabel,
    isShortcutOpaque,
    isShortcutLayoutVisible,
  };
}
