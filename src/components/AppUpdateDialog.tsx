import { useEffect, useState } from 'react';
import { appUpdate } from '@/ipc';
import { X } from 'lucide-react';
import { InterpreterLogoMark } from '@/components/InterpreterLogoMark';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/button';
import { useLowerLeftNotice } from '@/contexts/LowerLeftNoticesContext';
import { APP_UPDATE_INSTALL_HINT_DELAY_MS, getAppUpdateInstallHintKey, getAppUpdateSubtitleKey } from '@/utils/appUpdateInstallHint';
import { trackUpdatePrompted, trackUpdateAccepted } from '@/utils/telemetry';
import { isDiskSpaceFullErrorMessage } from '../../shared/diskSpace';
import type { AppUpdateErrorEvent, AppUpdateReadyEvent } from '../../electron/ipc/registry';

let isAppUpdateDismissedForSession = false;

export function shouldSuppressAppUpdateForSession(): boolean {
  return isAppUpdateDismissedForSession;
}

export function dismissAppUpdateForSession(): void {
  isAppUpdateDismissedForSession = true;
}

export function resetAppUpdateDismissalForTests(): void {
  isAppUpdateDismissedForSession = false;
}

export function AppUpdateDialog() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [version, setVersion] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [didInstallHintDelayExpire, setDidInstallHintDelayExpire] = useState(false);

  useEffect(() => {
    const unsubscribeReady = appUpdate.onReady((event: AppUpdateReadyEvent) => {
      if (shouldSuppressAppUpdateForSession()) {
        return;
      }
      setVersion(event.version);
      setIsInstalling(false);
      setErrorMessage(null);
      setDidInstallHintDelayExpire(false);
      trackUpdatePrompted({ version: event.version, surface: 'dialog' });
    });

    const unsubscribeChecking = appUpdate.onChecking(() => {
      showToast(t('appUpdate.checking'), 'info', 2200);
    });

    const unsubscribeUpToDate = appUpdate.onUpToDate(() => {
      showToast(t('appUpdate.upToDate'), 'success', 4000);
    });

    const unsubscribeError = appUpdate.onError((event: AppUpdateErrorEvent) => {
      const rawMessage = event.message?.trim();
      let message = t('appUpdate.checkFailed');
      if (rawMessage) {
        message = isDiskSpaceFullErrorMessage(rawMessage)
          ? t('errors.diskSpaceFull')
          : `${t('appUpdate.checkFailed')} ${rawMessage}`;
      }
      showToast(message, 'error', 4500);
    });

    return () => {
      unsubscribeReady();
      unsubscribeChecking();
      unsubscribeUpToDate();
      unsubscribeError();
    };
  }, [showToast, t]);

  useEffect(() => {
    if (!isInstalling) {
      setDidInstallHintDelayExpire(false);
      return;
    }

    setDidInstallHintDelayExpire(false);
    const timeoutId = window.setTimeout(() => {
      setDidInstallHintDelayExpire(true);
    }, APP_UPDATE_INSTALL_HINT_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isInstalling]);

  const handleDismiss = () => {
    if (version) {
      trackUpdateAccepted({ version, action: 'dismissed' });
    }
    dismissAppUpdateForSession();
    setVersion(null);
    setIsInstalling(false);
    setErrorMessage(null);
    setDidInstallHintDelayExpire(false);
  };

  const handleInstall = async () => {
    if (version) {
      trackUpdateAccepted({ version, action: 'install_now' });
    }
    setIsInstalling(true);
    setErrorMessage(null);
    try {
      const response = await appUpdate.install();
      if (!response.success) {
        setIsInstalling(false);
        setErrorMessage(t('appUpdate.errorInstallFailed'));
        setDidInstallHintDelayExpire(false);
      }
    } catch {
      setIsInstalling(false);
      setErrorMessage(t('appUpdate.errorUnexpected'));
      setDidInstallHintDelayExpire(false);
    }
  };

  const installHintKey = getAppUpdateInstallHintKey({
    isInstalling,
    didDelayExpire: didInstallHintDelayExpire,
  });
  const subtitleKey = getAppUpdateSubtitleKey({
    isInstalling,
    didDelayExpire: didInstallHintDelayExpire,
  });
  const installHintMessage = installHintKey ? t(installHintKey) : null;

  const content = version ? (
    <div className="w-full max-w-[20rem] transition-all duration-300 ease-out animate-in fade-in slide-in-from-bottom-2">
      <div
        className="w-full overflow-hidden rounded-[16px] backdrop-blur-[10px]"
        style={{
          border:
            'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 82%, transparent)',
          background:
            'color-mix(in srgb, var(--oa-bg-app, var(--popover)) 96%, var(--oa-bg-subtle, var(--muted)) 4%)',
          boxShadow:
            '0 24px 56px -30px rgba(0, 0, 0, 0.24), 0 12px 24px -18px rgba(0, 0, 0, 0.16)',
        }}
      >
        <div className="flex items-start gap-3 px-3.5 py-3.5">
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-[12px]"
            style={{
              background:
                'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 84%, transparent)',
            }}
          >
            <InterpreterLogoMark fitSquare size={16} segmentClassName="bg-foreground" />
          </div>

          <div className="min-w-0 flex-1">
            <span className="block text-ui-sm font-medium text-[var(--oa-text-strong, var(--foreground))]">
              {t('appUpdate.title')}
            </span>
            <span className="mt-0.5 block text-ui-xs leading-4 text-muted-foreground">
              {t(subtitleKey)}
            </span>
            {errorMessage && (
              <span className="mt-1 block text-ui-xs leading-4 text-status-error">{errorMessage}</span>
            )}
            {installHintMessage && (
              <span className="mt-1 block text-ui-xs leading-4 text-muted-foreground">{installHintMessage}</span>
            )}
            <div className="mt-3 flex items-center gap-2">
              <Button
                onClick={handleDismiss}
                disabled={isInstalling}
                variant="ghost"
                size="sm"
                className="h-8 px-2.5 text-ui-sm text-muted-foreground"
              >
                {t('appUpdate.later')}
              </Button>
              <Button
                onClick={handleInstall}
                disabled={isInstalling}
                variant="default"
                size="sm"
                className="h-8 px-3"
              >
                {isInstalling ? t('appUpdate.restarting') : t('appUpdate.restart')}
              </Button>
            </div>
          </div>

          <Button
            onClick={handleDismiss}
            disabled={isInstalling}
            variant="ghost"
            size="icon-xs"
            className="mt-0.5 shrink-0 text-muted-foreground/60 hover:text-foreground"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  useLowerLeftNotice('app-update', content);

  return null;
}
