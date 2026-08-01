import { describe, expect, test } from 'bun:test';
import type { Profile } from '../../../shared/types/profile';
import { buildOverlayProfileOptions } from './profile-options';

function profile(id: string, provider: Profile['provider'] = 'api'): Profile {
  return {
    id,
    name: id,
    modelId: `${id}-model`,
    isBuiltin: false,
    provider,
  };
}

describe('buildOverlayProfileOptions', () => {
  test('uses the app default profile as the overlay default when available', () => {
    const result = buildOverlayProfileOptions(
      [profile('hosted-profile', 'hosted'), profile('custom-openrouter')],
      'custom-openrouter',
      null,
    );

    expect(result.defaultProfileId).toBe('custom-openrouter');
    expect(result.preferredProfileId).toBeNull();
    expect(result.profileOptions).toContainEqual(
      expect.objectContaining({
        id: 'custom-openrouter',
        isDefault: true,
        kind: 'agent',
      }),
    );
    expect(result.profileOptions.every((option) => option.kind === 'agent')).toBeTrue();
  });

  test('uses the first agent profile as the default when no app default profile is available', () => {
    const result = buildOverlayProfileOptions(
      [profile('hosted-profile', 'hosted')],
      'missing-profile',
      null,
    );

    expect(result.defaultProfileId).toBe('hosted-profile');
    expect(result.profileOptions[0]).toEqual(
      expect.objectContaining({
        id: 'hosted-profile',
        isDefault: true,
        kind: 'agent',
      }),
    );
  });

  test('returns no default when no agent profiles are available', () => {
    const result = buildOverlayProfileOptions([], 'missing-profile', null);

    expect(result.defaultProfileId).toBeNull();
    expect(result.profileOptions).toEqual([]);
  });

  test('does not let a hosted overlay preference override a non-hosted app default', () => {
    const result = buildOverlayProfileOptions(
      [profile('hosted-profile', 'hosted'), profile('custom-openrouter')],
      'custom-openrouter',
      'hosted-profile',
    );

    expect(result.defaultProfileId).toBe('custom-openrouter');
    expect(result.preferredProfileId).toBeNull();
  });

  test('keeps non-hosted overlay preferences available', () => {
    const result = buildOverlayProfileOptions(
      [profile('custom-openrouter'), profile('local-ollama', 'local')],
      'custom-openrouter',
      'local-ollama',
    );

    expect(result.defaultProfileId).toBe('custom-openrouter');
    expect(result.preferredProfileId).toBe('local-ollama');
  });
});
