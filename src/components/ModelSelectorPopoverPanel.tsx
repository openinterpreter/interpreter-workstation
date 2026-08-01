import { useTranslation } from 'react-i18next';
import { ChevronRight, X } from 'lucide-react';
import type { Profile } from '../../shared/types/profile';
import { ProfileManager } from './ProfileManager';
import { Button } from './ui/button';

interface ModelSelectorPopoverPanelProps {
  selectedProfileId?: string;
  onProfileSelect: (profile: Profile, shouldClose: boolean) => void;
  onNavigateToSettings: () => void;
  compactActionLabel?: string;
  getCompactActionLabel?: (profile: Profile) => string | null;
  compactFooterLabel?: string;
  onClose?: () => void;
  closeButtonTestId?: string;
  children?: React.ReactNode;
}

export function ModelSelectorPopoverPanel({
  selectedProfileId,
  onProfileSelect,
  onNavigateToSettings,
  compactActionLabel,
  getCompactActionLabel,
  onClose,
  closeButtonTestId,
  children,
}: ModelSelectorPopoverPanelProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-2.5 pt-2.5">
      <div className="flex items-center justify-between gap-3 px-1.5 pb-2">
        <div className="min-w-0 flex-1 px-1">
          <h2 className="text-ui-base font-medium text-foreground">
            {t('settings.tabs.models')}
          </h2>
        </div>

        <div className="flex items-center gap-1">
          {onNavigateToSettings ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onNavigateToSettings}
              className="h-7 rounded-[8px] px-2 text-ui-sm text-muted-foreground shadow-none hover:text-foreground"
            >
              <span>{t('settings.profiles.card.settings')}</span>
              <ChevronRight className="size-3.5" />
            </Button>
          ) : null}
          <button
            type="button"
            data-testid={closeButtonTestId}
            className="inline-flex size-7 items-center justify-center rounded-[var(--oa-radius-sm)] text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.08]"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ProfileManager
          selectedProfileId={selectedProfileId}
          onProfileSelect={onProfileSelect}
          compact={true}
          compactActionLabel={compactActionLabel}
          getCompactActionLabel={getCompactActionLabel}
        />
      </div>
      {children}
    </div>
  );
}
