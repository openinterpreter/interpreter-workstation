import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { User } from '@supabase/supabase-js';
import { SettingsActionButton } from '../settings/SettingsSection';

interface AccountInfoProps {
  user: User;
  onSignOut: () => Promise<void>;
}

function AvatarWithFallback({
  avatarUrl,
  displayName
}: {
  avatarUrl?: string;
  displayName: string;
}) {
  const [imageError, setImageError] = useState(false);

  // Get first letter for fallback
  const firstLetter = displayName.charAt(0).toUpperCase();

  // Show fallback if no URL or image failed to load
  if (!avatarUrl || imageError) {
    return (
      <div
        className="size-8 rounded-full flex items-center justify-center shrink-0"
        style={{
          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 44%, transparent)',
          background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 82%, transparent)',
        }}
      >
        <span className="text-ui-sm font-medium text-foreground">
          {firstLetter}
        </span>
      </div>
    );
  }

  return (
    <img
      src={avatarUrl}
      alt="Avatar"
      className="size-8 rounded-full shrink-0"
      style={{ border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 44%, transparent)' }}
      onError={() => setImageError(true)}
    />
  );
}

export function AccountInfo({ user, onSignOut }: AccountInfoProps) {
  const handleSignOut = async () => {
    try {
      await onSignOut();
    } catch (error) {
      console.error('[AccountInfo] Sign out error:', error);
    }
  };

  // Get user display info
  const avatarUrl = user.user_metadata?.avatar_url;
  const fullName = user.user_metadata?.full_name || user.user_metadata?.name;
  const displayName = fullName || user.email?.split('@')[0] || 'User';
  const email = user.email;

  return (
    <div className="flex items-center gap-3">
      {/* Avatar with fallback */}
      <AvatarWithFallback avatarUrl={avatarUrl} displayName={displayName} />

      {/* User info */}
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-ui-sm text-foreground truncate">{displayName}</span>
        {email && (
          <span className="text-ui-xs text-muted-foreground truncate">{email}</span>
        )}
      </div>

      {/* Sign out button */}
      <SettingsActionButton
        onClick={handleSignOut}
        icon={LogOut}
        className="shrink-0"
      >
        Sign out
      </SettingsActionButton>
    </div>
  );
}
