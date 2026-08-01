import { ProfileManager } from '../ProfileManager';
import type { Profile } from '../../../shared/types/profile';

interface ProfilesSectionProps {
  onProfileUpdate?: (profile: Profile) => void;
  selectedProfileId?: string | null;
  listClassName?: string;
}

export function ProfilesSectionContent({
  onProfileUpdate,
  selectedProfileId,
  listClassName,
}: ProfilesSectionProps) {
  return (
    <div className="space-y-4">
      <ProfileManager
        compact={false}
        onProfileUpdate={onProfileUpdate}
        selectedProfileId={selectedProfileId ?? undefined}
        listClassName={listClassName}
      />
    </div>
  );
}
