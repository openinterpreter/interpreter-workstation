import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { openExternal, voiceExtension } from '@/ipc';
import type { VoiceExtensionInstallProgressEvent } from '../../../electron/ipc/registry';
import { SettingsPane, SettingsSection } from './SettingsSection';

const OFFICE_EDITORS_SOURCE_URL = 'https://github.com/openinterpreter/oo-editors';

interface BuiltInExtensionCard {
  nameKey: string;
  statusKey: string;
  tone?: 'default' | 'muted';
}

type VoiceInstallState = 'checking' | 'not-installed' | 'installing' | 'installed' | 'failed';

const BUILT_IN_EXTENSIONS: BuiltInExtensionCard[] = [
  {
    nameKey: 'settings.extensions.pdfEditor',
    statusKey: 'settings.extensions.statusBuiltIn',
  },
  {
    nameKey: 'settings.extensions.markdownEditor',
    statusKey: 'settings.extensions.statusBuiltIn',
  },
  {
    nameKey: 'settings.extensions.videoEditor',
    statusKey: 'settings.extensions.statusBuiltIn',
  },
  {
    nameKey: 'settings.extensions.3dEditors',
    statusKey: 'settings.extensions.statusComingSoon',
    tone: 'muted',
  },
];

export function ExtensionsSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const [voiceInstallState, setVoiceInstallState] = useState<VoiceInstallState>('checking');
  const [voiceInstallPath, setVoiceInstallPath] = useState<string | null>(null);
  const [voiceInstallMessage, setVoiceInstallMessage] = useState('');

  const refreshVoiceInstallState = useCallback(async () => {
    try {
      const result = await voiceExtension.checkInstalled();
      setVoiceInstallPath(result.installPath || null);
      if (result.installed) {
        setVoiceInstallState('installed');
        setVoiceInstallMessage(t('settings.extensions.voiceModels.statusInstalled'));
      } else {
        setVoiceInstallState('not-installed');
        setVoiceInstallMessage(result.error || t('settings.extensions.voiceModels.statusNotInstalled'));
      }
    } catch (error) {
      setVoiceInstallState('failed');
      setVoiceInstallMessage(error instanceof Error ? error.message : t('settings.extensions.voiceModels.installFailed'));
    }
  }, [t]);

  useEffect(() => {
    void refreshVoiceInstallState();
  }, [refreshVoiceInstallState]);

  useEffect(() => {
    const unsubscribe = voiceExtension.onInstallProgress((event: VoiceExtensionInstallProgressEvent) => {
      switch (event.stage) {
        case 'complete':
          setVoiceInstallState('installed');
          setVoiceInstallMessage(t('settings.extensions.voiceModels.installComplete'));
          if (event.message) {
            setVoiceInstallPath(event.message);
          }
          void refreshVoiceInstallState();
          return;
        case 'error':
          setVoiceInstallState('failed');
          setVoiceInstallMessage(event.error || t('settings.extensions.voiceModels.installFailed'));
          return;
        default:
          setVoiceInstallState('installing');
          setVoiceInstallMessage(t(`settings.extensions.voiceModels.installStage.${event.stage}`));
      }
    });

    return unsubscribe;
  }, [refreshVoiceInstallState, t]);

  const handleVoiceInstall = useCallback(async () => {
    setVoiceInstallState('installing');
    setVoiceInstallMessage(t('settings.extensions.voiceModels.installStage.preparing'));

    try {
      const result = await voiceExtension.install();
      if (!result.success) {
        setVoiceInstallState('failed');
        setVoiceInstallMessage(result.error || t('settings.extensions.voiceModels.installFailed'));
        return;
      }

      setVoiceInstallState('installed');
      setVoiceInstallMessage(t('settings.extensions.voiceModels.installComplete'));
      await refreshVoiceInstallState();
    } catch (error) {
      setVoiceInstallState('failed');
      setVoiceInstallMessage(error instanceof Error ? error.message : t('settings.extensions.voiceModels.installFailed'));
    }
  }, [refreshVoiceInstallState, t]);

  const voiceActionLabel = useMemo(() => {
    if (voiceInstallState === 'installing') return t('settings.extensions.voiceModels.actionInstalling');
    if (voiceInstallState === 'installed') return t('settings.extensions.voiceModels.actionReinstall');
    if (voiceInstallState === 'failed') return t('settings.extensions.voiceModels.actionRetry');
    return t('settings.extensions.voiceModels.actionInstall');
  }, [t, voiceInstallState]);

  const voiceStatusClass = voiceInstallState === 'failed' ? 'text-status-error' : 'text-muted-foreground';

  return (
    <SettingsPane>
      <SettingsSection title={t('settings.extensions.officeEditors.title')}>
        <div className="py-[18px]">
          <p className="max-w-2xl text-ui-sm leading-6 text-muted-foreground text-pretty">
            {t('settings.extensions.officeEditors.description')}
            {' '}
            <button
              type="button"
              onClick={() => void openExternal(OFFICE_EDITORS_SOURCE_URL)}
              className="inline-flex items-center text-ui-sm text-foreground/80 transition-colors hover:text-foreground"
            >
              {t('settings.extensions.officeEditors.viewSource')} &#8599;
            </button>
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.extensions.voiceModels.title')}>
        <div className="py-[18px]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <p className="text-ui-sm text-muted-foreground">{t('settings.extensions.voiceModels.description')}</p>
              <p className={`text-ui-xs break-words ${voiceStatusClass}`}>
                {voiceInstallState === 'checking'
                  ? t('settings.extensions.voiceModels.statusChecking')
                  : voiceInstallMessage}
              </p>
              {voiceInstallPath && (
                <p className="text-ui-xs text-muted-foreground break-all">
                  {t('settings.extensions.voiceModels.installPath', { path: voiceInstallPath })}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                void handleVoiceInstall();
              }}
              disabled={voiceInstallState === 'checking' || voiceInstallState === 'installing'}
              className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-ui-sm text-foreground hover:bg-hover transition-colors disabled:opacity-60"
              style={{ border: 'var(--border-width) solid var(--border)' }}
            >
              {voiceInstallState === 'installing' && <Loader2 className="size-3.5 animate-spin" />}
              {voiceActionLabel}
            </button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.extensions.availableSection')}>
        {BUILT_IN_EXTENSIONS.map((extension) => (
          <div
            key={extension.nameKey}
            className={`flex items-center justify-between gap-3 py-[18px] ${extension.tone === 'muted' ? 'opacity-55' : ''}`}
          >
            <h4 className="text-ui-sm font-medium leading-6 text-foreground">{t(extension.nameKey)}</h4>
            <span className="text-ui-xs text-muted-foreground">{t(extension.statusKey)}</span>
          </div>
        ))}
      </SettingsSection>
    </SettingsPane>
  );
}
