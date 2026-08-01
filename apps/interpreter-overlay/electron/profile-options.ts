import type { Profile } from '../../../shared/types/profile';
import type { OverlayProfileOption } from '../shared/ipc.js';

export function buildOverlayProfileOptions(
  profiles: Profile[],
  defaultProfileId: string | null,
  preferredProfileId: string | null,
): {
  defaultProfileId: string | null;
  preferredProfileId: string | null;
  profileOptions: OverlayProfileOption[];
} {
  const defaultProfile = defaultProfileId
    ? profiles.find((profile) => profile.id === defaultProfileId) ?? null
    : null;
  const preferredProfile = preferredProfileId
    ? profiles.find((profile) => profile.id === preferredProfileId) ?? null
    : null;
  const ignoreHostedPreferredProfile =
    defaultProfile !== null
    && defaultProfile.provider !== 'hosted'
    && preferredProfile?.provider === 'hosted';
  const effectivePreferredProfileId =
    preferredProfile && !ignoreHostedPreferredProfile
      ? preferredProfile.id
      : null;

  return {
    defaultProfileId: defaultProfile?.id ?? profiles[0]?.id ?? null,
    preferredProfileId: effectivePreferredProfileId,
    profileOptions: profiles.map((profile) => ({
      id: profile.id,
      label: profile.name,
      description: profile.helpDescription,
      isDefault: profile.id === (defaultProfile?.id ?? profiles[0]?.id ?? null),
      kind: 'agent' as const,
    })),
  };
}
