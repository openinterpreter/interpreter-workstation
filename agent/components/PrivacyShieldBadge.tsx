import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, ShieldAlert } from 'lucide-react';
import { workspaceScan } from '../../src/ipc';
import type { WorkspaceScanStatus } from '../../src/ipc';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../src/components/ui/tooltip';
import { cn } from '../../src/lib/utils';
import { needsRedactionForProvider } from '../../src/lib/pii/redaction';

export type ShieldState = 'hidden' | 'active' | 'error';

export function usePrivacyShieldState(modelProvider: string | null | undefined): ShieldState {
  const [status, setStatus] = useState<WorkspaceScanStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await workspaceScan.status();
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (!status || !modelProvider) return 'hidden';

  const needsRedaction = needsRedactionForProvider(modelProvider);
  if (!needsRedaction) return 'hidden';
  if (!status.xbergAvailable) return 'error';
  if (!status.redactionActive) return 'error';
  return 'active';
}

interface PrivacyShieldBadgeProps {
  modelProvider: string | null | undefined;
  className?: string;
}

export function PrivacyShieldBadge({ modelProvider, className }: PrivacyShieldBadgeProps) {
  const { t } = useTranslation();
  const state = usePrivacyShieldState(modelProvider);

  if (state === 'hidden') return null;

  if (state === 'active') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'flex items-center gap-1 rounded-full px-2 py-0.5 text-ui-xs font-medium',
              'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
              className,
            )}
          >
            <Shield className="size-3" />
            <span>{t('basemind.shield.active')}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('basemind.shield.tooltip', { provider: modelProvider })}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1 rounded-full px-2 py-0.5 text-ui-xs font-medium',
            'bg-amber-500/10 text-amber-600 dark:text-amber-400',
            className,
          )}
        >
          <ShieldAlert className="size-3" />
          <span>{t('basemind.shield.error')}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t('basemind.shield.errorTooltip', { provider: modelProvider })}
      </TooltipContent>
    </Tooltip>
  );
}
