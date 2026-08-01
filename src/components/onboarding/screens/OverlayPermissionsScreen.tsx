import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Monitor, MousePointer2, RefreshCw, Settings } from 'lucide-react';

import { overlaySettings } from '../../../ipc';
import { Button } from '../../ui/button';
import { OnboardingHeading, OnboardingScreenShell, OnboardingSection } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

type OverlayScreenRecordingStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

interface OverlayPermissionStatus {
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
  screenRecordingStatus: OverlayScreenRecordingStatus;
}

type PermissionAction = 'accessibility' | 'screen-recording' | 'refresh';
type PermissionRequest = Exclude<PermissionAction, 'refresh'>;

interface OverlayPermissionsScreenProps {
  onNext: () => void;
}

interface PermissionOperationResult {
  status: OverlayPermissionStatus | null;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readPermissionStatus(): Promise<PermissionOperationResult> {
  try {
    const response = await overlaySettings.getPermissionStatus();
    return { status: response.status, error: null };
  } catch (error) {
    return { status: null, error: errorMessage(error) };
  }
}

async function requestOverlayPermission(
  permission: PermissionRequest,
  permissionStillNeededMessage: string,
): Promise<PermissionOperationResult> {
  let status: OverlayPermissionStatus | null = null;
  try {
    const response = permission === 'accessibility'
      ? await overlaySettings.requestAccessibilityPermission()
      : await overlaySettings.requestScreenRecordingPermission();
    status = response.status;

    if (permission === 'accessibility' && !response.status.accessibilityGranted) {
      await overlaySettings.openAccessibilitySettings();
    }
    if (permission === 'screen-recording' && !response.status.screenRecordingGranted) {
      await overlaySettings.openScreenRecordingSettings();
    }

    return {
      status,
      error: response.success ? null : response.error ?? permissionStillNeededMessage,
    };
  } catch (error) {
    return { status, error: errorMessage(error) };
  }
}

function getScreenRecordingStatusLabel(
  status: OverlayScreenRecordingStatus | undefined,
  t: (key: string) => string,
): string {
  switch (status) {
    case 'granted':
      return t('onboarding.overlayPermissions.statusGranted');
    case 'denied':
      return t('onboarding.overlayPermissions.statusDenied');
    case 'restricted':
      return t('onboarding.overlayPermissions.statusRestricted');
    case 'not-determined':
      return t('onboarding.overlayPermissions.statusNotRequested');
    default:
      return t('onboarding.overlayPermissions.statusUnknown');
  }
}

function PermissionRow({
  icon,
  title,
  description,
  statusText,
  granted,
  actionLabel,
  activeLabel,
  active,
  disabled,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  statusText: string;
  granted: boolean;
  actionLabel: string;
  activeLabel: string;
  active: boolean;
  disabled: boolean;
  onAction: () => void;
}) {
  return (
    <OnboardingSection tone="muted" padding="md">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-4">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
            style={{
              border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border) 58%, transparent)',
              backgroundColor: 'color-mix(in srgb, var(--oa-bg-app) 70%, var(--oa-bg-subtle) 30%)',
            }}
          >
            {icon}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              {granted ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-[var(--oa-text-faint)]" aria-hidden="true" />
              ) : null}
              <h2 className="text-ui-base font-medium leading-5 text-[var(--oa-text-strong)]">
                {title}
              </h2>
            </div>
            <p className="text-ui-sm leading-6 text-[var(--oa-text-muted)]">
              {description}
            </p>
            <p className="text-ui-xs leading-5 text-[var(--oa-text-faint)]">
              {statusText}
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant={granted ? 'secondary' : 'default'}
          size="sm"
          disabled={disabled || granted}
          onClick={onAction}
          className="shrink-0"
        >
          <Settings className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          {active ? activeLabel : actionLabel}
        </Button>
      </div>
    </OnboardingSection>
  );
}

export function OverlayPermissionsScreen({ onNext }: OverlayPermissionsScreenProps) {
  const { t } = useTranslation();
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const [status, setStatus] = useState<OverlayPermissionStatus | null>(null);
  const [activeAction, setActiveAction] = useState<PermissionAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setActiveAction('refresh');
    setError(null);
    const result = await readPermissionStatus();
    if (result.status) setStatus(result.status);
    setError(result.error);
    setActiveAction(null);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const requestPermission = useCallback(async (permission: PermissionRequest) => {
    setActiveAction(permission);
    setError(null);
    const result = await requestOverlayPermission(
      permission,
      t('onboarding.overlayPermissions.permissionStillNeeded'),
    );
    if (result.status) setStatus(result.status);
    setError(result.error);
    setActiveAction(null);
  }, [t]);

  const handleContinue = useCallback(() => {
    onNext();
  }, [onNext]);

  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueLabel: t('onboarding.overlayPermissions.continue'),
      continueAction: handleContinue,
    });
  }, [handleContinue, setFooterConfig, t]);

  const accessibilityStatus = status?.accessibilityGranted
    ? t('onboarding.overlayPermissions.statusGranted')
    : t('onboarding.overlayPermissions.statusNotGranted');
  const screenRecordingStatus = status?.screenRecordingGranted
    ? t('onboarding.overlayPermissions.statusGranted')
    : getScreenRecordingStatusLabel(status?.screenRecordingStatus, t);

  return (
    <OnboardingScreenShell size="medium" align="top">
      <div className="space-y-5">
        <OnboardingHeading
          title={t('onboarding.overlayPermissions.title')}
          description={t('onboarding.overlayPermissions.description')}
          align="left"
        />

        <div className="grid gap-3">
          <PermissionRow
            icon={<MousePointer2 className="h-4 w-4 text-[var(--oa-text-muted)]" aria-hidden="true" />}
            title={t('onboarding.overlayPermissions.accessibilityTitle')}
            description={t('onboarding.overlayPermissions.accessibilityDescription')}
            statusText={accessibilityStatus}
            granted={Boolean(status?.accessibilityGranted)}
            actionLabel={t('onboarding.overlayPermissions.accessibilityAction')}
            activeLabel={t('onboarding.overlayPermissions.opening')}
            active={activeAction === 'accessibility'}
            disabled={activeAction !== null}
            onAction={() => void requestPermission('accessibility')}
          />

          <PermissionRow
            icon={<Monitor className="h-4 w-4 text-[var(--oa-text-muted)]" aria-hidden="true" />}
            title={t('onboarding.overlayPermissions.screenRecordingTitle')}
            description={t('onboarding.overlayPermissions.screenRecordingDescription')}
            statusText={screenRecordingStatus}
            granted={Boolean(status?.screenRecordingGranted)}
            actionLabel={t('onboarding.overlayPermissions.screenRecordingAction')}
            activeLabel={t('onboarding.overlayPermissions.opening')}
            active={activeAction === 'screen-recording'}
            disabled={activeAction !== null}
            onAction={() => void requestPermission('screen-recording')}
          />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {error ? (
            <p className="text-ui-sm leading-6 text-[var(--oa-text-muted)]">
              {error}
            </p>
          ) : (
            <p className="text-ui-sm leading-6 text-[var(--oa-text-muted)]">
              {t('onboarding.overlayPermissions.canContinue')}
            </p>
          )}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={activeAction !== null}
            onClick={() => void refreshStatus()}
            className="shrink-0"
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            {activeAction === 'refresh'
              ? t('onboarding.overlayPermissions.checking')
              : t('onboarding.overlayPermissions.checkAgain')}
          </Button>
        </div>
      </div>
    </OnboardingScreenShell>
  );
}
