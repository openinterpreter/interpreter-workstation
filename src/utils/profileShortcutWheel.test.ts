import { describe, expect, test } from 'bun:test';

import type { Profile } from '../../shared/types/profile';
import { getProfileShortcutWheelState } from './profileShortcutWheel';

function makeProfiles(count: number): Profile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `profile-${index + 1}`,
    name: `Profile ${index + 1}`,
    provider: 'hosted',
    providerId: 'builtin:hosted',
    modelId: `model-${index + 1}`,
    isBuiltin: false,
  }));
}

describe('getProfileShortcutWheelState', () => {
  test('keeps the resting trigger label on the actual selected profile when selection is outside first 9 preview slots', () => {
    const profiles = makeProfiles(16);

    const state = getProfileShortcutWheelState({
      profiles,
      selectedProfileId: 'profile-16',
      fallbackLabel: 'Profile 16',
      index: 9,
      phase: 'idle',
    });

    expect(state.profileCount).toBe(9);
    expect(state.currentProfileLabel).toBe('Profile 1');
    expect(state.visibleTriggerLabel).toBe('Profile 16');
    expect(state.visibleTriggerLabel).not.toBe(state.currentProfileLabel);
  });

  test('uses the preview row label only while the shortcut wheel is visible', () => {
    const profiles = makeProfiles(16);

    const state = getProfileShortcutWheelState({
      profiles,
      selectedProfileId: 'profile-16',
      fallbackLabel: 'Profile 16',
      index: 9,
      phase: 'active',
    });

    expect(state.currentProfileLabel).toBe('Profile 1');
    expect(state.visibleTriggerLabel).toBe('Profile 1');
  });

  test('shows the selected label normally when the selected profile is inside the first 9 preview slots', () => {
    const profiles = makeProfiles(9);

    const state = getProfileShortcutWheelState({
      profiles,
      selectedProfileId: 'profile-4',
      fallbackLabel: 'Profile 4',
      index: 12,
      phase: 'idle',
    });

    expect(state.visibleTriggerLabel).toBe('Profile 4');
  });
});
