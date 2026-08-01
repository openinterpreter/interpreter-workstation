import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { getRuntimeSystemInfo, stt, voiceExtension } from '@/ipc';
import { Loader2 } from 'lucide-react';
import { trackSttBackendChanged, trackSettingChanged } from '@/utils/telemetry';
import { Input } from '../ui/input';
import { NativeSelect } from '../ui/NativeSelect';
import { Switch } from '../ui/switch';
import { SettingsGroup, SettingsRow } from './SettingsSection';
import { ExperimentalBadge } from '../onboarding/components/ExperimentalBadge';
import { Button } from '../ui/button';
import {
  DEFAULT_AMBIENT_END_PHRASES,
  DEFAULT_AMBIENT_TRIGGER_PHRASES,
  STT_BACKENDS,
  DEFAULT_STT_SETTINGS,
  STT_MAX_FAST_SENTENCE_TIMEOUT_MS,
  STT_MAX_PREVIEW_BEFORE_SEND_MS,
  STT_MAX_SILENCE_TIMEOUT_MS,
  STT_MIN_FAST_SENTENCE_TIMEOUT_MS,
  STT_MIN_PREVIEW_BEFORE_SEND_MS,
  STT_MIN_SILENCE_TIMEOUT_MS,
  getPrimaryAmbientPhrase,
  normalizeAmbientPhrases,
  type SttBackend,
  type SttSettings,
} from '../../../shared/types/stt';
import { isChineseLanguageCode } from '../../../shared/utils/sttTranscriptSanitizer';
import type { SttSetSettingsResponse, VoiceExtensionInstallProgressEvent } from '../../../electron/ipc/registry';

type NumericSttField = 'silenceTimeoutMs' | 'fastSentenceSilenceTimeoutMs' | 'previewBeforeSendMs';
type StringSttField =
  | 'sendCommand'
  | 'newChatCommand'
  | 'ambientPrimaryTriggerPhrase'
  | 'ambientTriggerAliases'
  | 'ambientPrimaryEndPhrase'
  | 'ambientEndAliases';

function requiresManagedSttInstall(platform: string, backend: SttBackend): boolean {
  return platform === 'win32' || backend === 'qwen';
}

function resolveManagedSttBackend(platform: string, backend: SttBackend): SttBackend {
  return platform === 'win32' ? 'moonshine' : backend;
}

function getSttBackendLabel(backend: SttBackend): string {
  return backend === 'moonshine' ? 'Moonshine STT model' : 'Qwen STT model';
}

function splitPhraseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
}

function joinAliasPhrases(phrases: readonly string[]): string {
  return phrases.join(', ');
}

function buildAmbientPhrases(primary: string, aliases: string, fallback: readonly string[]): string[] {
  return normalizeAmbientPhrases(
    [primary, ...splitPhraseList(aliases)],
    fallback,
  );
}

function toDraftValues(settings: SttSettings): Record<NumericSttField, string> & Record<StringSttField, string> {
  const ambientTriggerPhrases = normalizeAmbientPhrases(
    settings.ambientTriggerPhrases,
    DEFAULT_AMBIENT_TRIGGER_PHRASES,
  );
  const ambientEndPhrases = normalizeAmbientPhrases(
    settings.ambientEndPhrases,
    DEFAULT_AMBIENT_END_PHRASES,
  );

  return {
    silenceTimeoutMs: String(settings.silenceTimeoutMs),
    fastSentenceSilenceTimeoutMs: String(settings.fastSentenceSilenceTimeoutMs),
    previewBeforeSendMs: String(settings.previewBeforeSendMs),
    sendCommand: settings.sendCommand,
    newChatCommand: settings.newChatCommand,
    ambientPrimaryTriggerPhrase: getPrimaryAmbientPhrase(ambientTriggerPhrases, DEFAULT_AMBIENT_TRIGGER_PHRASES[0]),
    ambientTriggerAliases: joinAliasPhrases(ambientTriggerPhrases.slice(1)),
    ambientPrimaryEndPhrase: getPrimaryAmbientPhrase(ambientEndPhrases, DEFAULT_AMBIENT_END_PHRASES[0]),
    ambientEndAliases: joinAliasPhrases(ambientEndPhrases.slice(1)),
  };
}

const VOICE_MODE_NOTE_KEYS = [
  {
    descriptionKey: 'settings.stt.modeNoteConversational',
    modeKey: 'settings.stt.voiceModeConversational',
  },
  {
    descriptionKey: 'settings.stt.modeNotePushToTalk',
    modeKey: 'settings.stt.voiceModePushToTalk',
  },
  {
    descriptionKey: 'settings.stt.modeNoteAmbient',
    modeKey: 'settings.stt.voiceModeAmbient',
  },
] as const;

export function VoiceModesOverviewCard() {
  const { t } = useTranslation();

  return (
    <section
      className="overflow-hidden rounded-[18px] bg-[color-mix(in_srgb,var(--oa-bg-app,var(--background))_95%,var(--oa-bg-subtle,var(--muted))_5%)] shadow-[0_12px_36px_-28px_var(--shadow-color)]"
      style={{
        borderWidth: 'var(--border-width)',
        borderStyle: 'solid',
        borderColor: 'color-mix(in srgb, var(--oa-border, var(--border)) 58%, transparent)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="text-ui-sm font-medium text-foreground">
            {t('settings.stt.modeNoteTitle')}
          </p>
          <p className="mt-1 text-ui-sm leading-6 text-muted-foreground text-pretty">
            {t('settings.stt.modeNoteDescription')}
          </p>
        </div>
        <ExperimentalBadge />
      </div>
      <div className="[border-top:var(--border-width)_solid_var(--border)] [&>*+*]:[border-top:var(--border-width)_solid_var(--border)]">
        {VOICE_MODE_NOTE_KEYS.map(({ descriptionKey, modeKey }) => (
          <div key={descriptionKey} className="px-5 py-4 sm:px-6">
            <p className="text-ui-sm leading-6 text-muted-foreground text-pretty">
              <Trans
                i18nKey={descriptionKey}
                values={{ mode: t(modeKey) }}
                components={{
                  strong: <span className="font-medium text-foreground" />,
                }}
              />
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SpeechToTextSectionContent() {
  "use no memo";

  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<SttSettings>(DEFAULT_STT_SETTINGS);
  const [draftValues, setDraftValues] = useState<Record<NumericSttField, string> & Record<StringSttField, string>>(toDraftValues(DEFAULT_STT_SETTINGS));
  const [sttModelInstalled, setSttModelInstalled] = useState(false);
  const [isCheckingSttModel, setIsCheckingSttModel] = useState(true);
  const [isInstallingSttModel, setIsInstallingSttModel] = useState(false);
  const [sttModelMessage, setSttModelMessage] = useState('');
  const platform = getRuntimeSystemInfo().platform;
  const isWindows = platform === 'win32';
  const effectiveSttBackend = resolveManagedSttBackend(platform, settings.backend);
  const sttModelLabel = getSttBackendLabel(effectiveSttBackend);
  const sttModelRequiresInstall = requiresManagedSttInstall(platform, effectiveSttBackend);
  const shouldShowStripChineseCharactersSetting = !isChineseLanguageCode(
    i18n.resolvedLanguage ?? i18n.language,
  );

  const refreshSttModelStatus = useCallback(async (backend: SttBackend) => {
    setIsCheckingSttModel(true);
    const effectiveBackend = resolveManagedSttBackend(platform, backend);
    const modelLabel = getSttBackendLabel(effectiveBackend);
    const requiresInstall = requiresManagedSttInstall(platform, effectiveBackend);
    if (!requiresInstall) {
      setSttModelInstalled(true);
      setSttModelMessage(`${modelLabel} is ready on this platform.`);
      setIsCheckingSttModel(false);
      return;
    }

    try {
      const result = await voiceExtension.checkInstalled({ backend: effectiveBackend });
      setSttModelInstalled(result.installed);
      setSttModelMessage(result.installed
        ? `${modelLabel} is installed.`
        : `Download ${modelLabel} to enable speech-to-text settings.`);
    } catch (error) {
      console.error('[STT] Failed to check STT model status:', error);
      setSttModelInstalled(false);
      setSttModelMessage(`Could not verify ${modelLabel} status.`);
    } finally {
      setIsCheckingSttModel(false);
    }
  }, [platform]);

  const applySettings = useCallback((nextSettings: SttSettings) => {
    setSettings(nextSettings);
    setDraftValues(toDraftValues(nextSettings));
  }, []);

  useEffect(() => {
    let canceled = false;

    void stt.getSettings()
      .then((response: { settings: SttSettings }) => {
        if (canceled) return;
        applySettings(response.settings);
      })
      .catch((error: unknown) => {
        console.error('[STT] Failed to load settings:', error);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });

    const unsubscribe = stt.onSettingsChanged((event: { settings: SttSettings }) => {
      applySettings(event.settings);
    });

    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [applySettings]);

  useEffect(() => {
    void refreshSttModelStatus(settings.backend);
    const unsubscribe = voiceExtension.onInstallProgress((event: VoiceExtensionInstallProgressEvent) => {
      if (!requiresManagedSttInstall(platform, settings.backend)) {
        return;
      }

      if (event.stage === 'error') {
        setIsInstallingSttModel(false);
        setSttModelInstalled(false);
        setSttModelMessage(event.error || 'STT model download failed.');
        return;
      }

      if (event.stage === 'complete') {
        setIsInstallingSttModel(false);
        setSttModelInstalled(true);
        setSttModelMessage('STT model installed.');
        void refreshSttModelStatus(settings.backend);
        return;
      }

      setIsInstallingSttModel(true);
      setSttModelMessage('Downloading STT model...');
    });

    return unsubscribe;
  }, [platform, refreshSttModelStatus, settings.backend]);

  const updateSettings = useCallback(async (partial: Partial<SttSettings>) => {
    const response = await stt.setSettings({ settings: partial }) as SttSetSettingsResponse;
    if (!response.success) {
      throw new Error(response.error || 'Failed to update STT settings');
    }

    for (const [key, newValue] of Object.entries(partial)) {
      const oldValue = (settings as unknown as Record<string, unknown>)[key];
      const valueType: 'boolean' | 'string' | 'number' | 'enum' | 'object' =
        typeof newValue === 'boolean' ? 'boolean'
          : typeof newValue === 'number' ? 'number'
            : typeof newValue === 'string' ? 'enum'
              : 'object';
      trackSettingChanged({
        settingKey: `stt.${key}`, tabId: 'textToSpeech', sectionId: 'speechToText',
        valueType, oldValue, newValue,
      });
    }

    applySettings(response.settings);
    return response.settings;
  }, [applySettings, settings]);

  const handleDraftChange = useCallback((field: NumericSttField | StringSttField, value: string) => {
    setDraftValues((previous) => ({ ...previous, [field]: value }));
  }, []);

  const commitField = useCallback(async (field: NumericSttField, min: number, max: number) => {
    const rawValue = draftValues[field].trim();
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed)) {
      setDraftValues((previous) => ({ ...previous, [field]: String(settings[field]) }));
      return;
    }

    const clamped = Math.max(min, Math.min(max, parsed));
    try {
      await updateSettings({ [field]: clamped } as Partial<SttSettings>);
    } catch (error) {
      console.error(`[STT] Failed to update ${field}:`, error);
      setDraftValues((previous) => ({ ...previous, [field]: String(settings[field]) }));
    }
  }, [draftValues, settings, updateSettings]);

  const commitStringField = useCallback(async (field: StringSttField) => {
    const value = draftValues[field].trim();
    if (
      field === 'ambientPrimaryTriggerPhrase'
      || field === 'ambientTriggerAliases'
      || field === 'ambientPrimaryEndPhrase'
      || field === 'ambientEndAliases'
    ) {
      return;
    }
    try {
      await updateSettings({ [field]: value } as Partial<SttSettings>);
    } catch (error) {
      console.error(`[STT] Failed to update ${field}:`, error);
      const fallbackValue = field === 'sendCommand' ? settings.sendCommand : settings.newChatCommand;
      setDraftValues((previous) => ({ ...previous, [field]: fallbackValue }));
    }
  }, [draftValues, settings, updateSettings]);

  const commitAmbientPhraseField = useCallback(async (kind: 'trigger' | 'end') => {
    const isTrigger = kind === 'trigger';
    const primaryField = isTrigger ? 'ambientPrimaryTriggerPhrase' : 'ambientPrimaryEndPhrase';
    const aliasesField = isTrigger ? 'ambientTriggerAliases' : 'ambientEndAliases';
    const settingsField = isTrigger ? 'ambientTriggerPhrases' : 'ambientEndPhrases';
    const fallback = isTrigger ? DEFAULT_AMBIENT_TRIGGER_PHRASES : DEFAULT_AMBIENT_END_PHRASES;

    try {
      await updateSettings({
        [settingsField]: buildAmbientPhrases(
          draftValues[primaryField],
          draftValues[aliasesField],
          fallback,
        ),
      } as Partial<SttSettings>);
    } catch (error) {
      console.error(`[STT] Failed to update ${settingsField}:`, error);
      setDraftValues((previous) => ({
        ...previous,
        ...toDraftValues(settings),
      }));
    }
  }, [draftValues, settings, updateSettings]);

  const bindEnterToCommit = useCallback((event: KeyboardEvent<HTMLInputElement>, runCommit: () => Promise<void>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void runCommit();
    (event.currentTarget as HTMLInputElement).blur();
  }, []);

  const handleBackendChange = useCallback(async (nextBackend: string) => {
    if (isWindows) return;
    if (!(STT_BACKENDS as readonly string[]).includes(nextBackend)) return;

    try {
      trackSttBackendChanged(nextBackend);
      await updateSettings({ backend: nextBackend as SttBackend });
    } catch (error) {
      console.error('[STT] Failed to update backend:', error);
    }
  }, [isWindows, updateSettings]);

  const handleStripChineseCharactersChange = useCallback(async (checked: boolean) => {
    try {
      await updateSettings({ stripChineseCharacters: checked });
    } catch (error) {
      console.error('[STT] Failed to update stripChineseCharacters:', error);
    }
  }, [updateSettings]);

  const handleInstallSttModel = useCallback(async () => {
    if (isInstallingSttModel) return;

    if (!sttModelRequiresInstall) {
      setSttModelInstalled(true);
      setSttModelMessage(`${sttModelLabel} is ready on this platform.`);
      return;
    }

    setIsInstallingSttModel(true);
    setSttModelMessage('Downloading STT model...');
    try {
      const result = await voiceExtension.install({ backend: effectiveSttBackend });
      if (!result.success) {
        setSttModelInstalled(false);
        setSttModelMessage(result.error || 'STT model download failed.');
        return;
      }
      setSttModelInstalled(true);
      setSttModelMessage('STT model installed.');
      await refreshSttModelStatus(effectiveSttBackend);
    } catch (error) {
      console.error('[STT] Failed to install STT model:', error);
      setSttModelInstalled(false);
      setSttModelMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsInstallingSttModel(false);
    }
  }, [
    effectiveSttBackend,
    isInstallingSttModel,
    refreshSttModelStatus,
    sttModelLabel,
    sttModelRequiresInstall,
  ]);
  const sttControlsDisabledClass = sttModelInstalled ? '' : 'pointer-events-none opacity-50';

  return (
    <>
      <SettingsGroup title="Model download">
        <SettingsRow
          label={sttModelLabel}
          description={sttModelInstalled
            ? 'Speech-to-text controls are enabled.'
            : 'Download at least one STT model to enable speech-to-text controls.'}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void handleInstallSttModel();
            }}
            disabled={!sttModelRequiresInstall || isCheckingSttModel || isInstallingSttModel}
          >
            {isInstallingSttModel || isCheckingSttModel ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {!sttModelRequiresInstall
              ? 'No download needed'
              : isInstallingSttModel
                ? 'Downloading...'
                : sttModelInstalled
                  ? 'Reinstall model'
                  : 'Download model'}
          </Button>
        </SettingsRow>
        <div className="pb-3 text-ui-xs text-muted-foreground">
          {isCheckingSttModel ? 'Checking model status...' : sttModelMessage}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t('settings.stt.groupGeneral')}
        description={t('settings.stt.groupGeneralDescription')}
      >
        <SettingsRow
          label={t('settings.stt.backendLabel')}
          description={isWindows ? t('settings.stt.backendWindowsLockedDescription') : t('settings.stt.backendDescription')}
        >
          <NativeSelect
            value={settings.backend}
            onValueChange={handleBackendChange}
            items={[
              { value: 'qwen', label: t('settings.stt.backendOptionQwen') },
              { value: 'moonshine', label: t('settings.stt.backendOptionMoonshine') },
            ]}
            disabled={loading || isWindows}
            className="w-40"
          />
        </SettingsRow>

        <div className={sttControlsDisabledClass}>
          {shouldShowStripChineseCharactersSetting ? (
            <SettingsRow
              label={t('settings.stt.stripChineseCharactersLabel')}
              description={t('settings.stt.stripChineseCharactersDescription')}
            >
              <Switch
                checked={settings.stripChineseCharacters}
                disabled={loading}
                onCheckedChange={handleStripChineseCharactersChange}
              />
            </SettingsRow>
          ) : null}

          <SettingsRow
            label={t('settings.stt.previewBeforeSendLabel')}
            description={t('settings.stt.previewBeforeSendDescription')}
          >
            <Input
              type="number"
              className="w-28 text-right"
              min={STT_MIN_PREVIEW_BEFORE_SEND_MS}
              max={STT_MAX_PREVIEW_BEFORE_SEND_MS}
              step={25}
              value={draftValues.previewBeforeSendMs}
              disabled={loading}
              onChange={(event) => handleDraftChange('previewBeforeSendMs', event.target.value)}
              onBlur={() => {
                void commitField('previewBeforeSendMs', STT_MIN_PREVIEW_BEFORE_SEND_MS, STT_MAX_PREVIEW_BEFORE_SEND_MS);
              }}
              onKeyDown={(event) => bindEnterToCommit(event, async () => {
                await commitField('previewBeforeSendMs', STT_MIN_PREVIEW_BEFORE_SEND_MS, STT_MAX_PREVIEW_BEFORE_SEND_MS);
              })}
            />
          </SettingsRow>
        </div>
      </SettingsGroup>

      <div className={sttControlsDisabledClass}>
        <SettingsGroup
          title={t('settings.stt.groupAutoSendTiming')}
          description={t('settings.stt.groupAutoSendTimingDescription')}
      >
        <SettingsRow
          label={t('settings.stt.silenceTimeoutLabel')}
          description={t('settings.stt.silenceTimeoutDescription')}
        >
          <Input
            type="number"
            className="w-28 text-right"
            min={STT_MIN_SILENCE_TIMEOUT_MS}
            max={STT_MAX_SILENCE_TIMEOUT_MS}
            step={50}
            value={draftValues.silenceTimeoutMs}
            disabled={loading}
            onChange={(event) => handleDraftChange('silenceTimeoutMs', event.target.value)}
            onBlur={() => {
              void commitField('silenceTimeoutMs', STT_MIN_SILENCE_TIMEOUT_MS, STT_MAX_SILENCE_TIMEOUT_MS);
            }}
            onKeyDown={(event) => bindEnterToCommit(event, async () => {
              await commitField('silenceTimeoutMs', STT_MIN_SILENCE_TIMEOUT_MS, STT_MAX_SILENCE_TIMEOUT_MS);
            })}
          />
        </SettingsRow>

          <SettingsRow
            label={t('settings.stt.fastSentenceSilenceTimeoutLabel')}
            description={t('settings.stt.fastSentenceSilenceTimeoutDescription')}
          >
            <Input
              type="number"
              className="w-28 text-right"
              min={STT_MIN_FAST_SENTENCE_TIMEOUT_MS}
              max={STT_MAX_FAST_SENTENCE_TIMEOUT_MS}
              step={50}
              value={draftValues.fastSentenceSilenceTimeoutMs}
              disabled={loading}
              onChange={(event) => handleDraftChange('fastSentenceSilenceTimeoutMs', event.target.value)}
              onBlur={() => {
                void commitField('fastSentenceSilenceTimeoutMs', STT_MIN_FAST_SENTENCE_TIMEOUT_MS, STT_MAX_FAST_SENTENCE_TIMEOUT_MS);
              }}
              onKeyDown={(event) => bindEnterToCommit(event, async () => {
                await commitField('fastSentenceSilenceTimeoutMs', STT_MIN_FAST_SENTENCE_TIMEOUT_MS, STT_MAX_FAST_SENTENCE_TIMEOUT_MS);
              })}
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup
          title={t('settings.stt.groupVoiceCommands')}
          description={t('settings.stt.groupVoiceCommandsDescription')}
      >
        <SettingsRow
          label={t('settings.stt.sendCommandLabel')}
          description={t('settings.stt.sendCommandDescription')}
        >
          <Input
            type="text"
            className="w-40"
            value={draftValues.sendCommand}
            disabled={loading}
            onChange={(event) => handleDraftChange('sendCommand', event.target.value)}
            onBlur={() => {
              void commitStringField('sendCommand');
            }}
            onKeyDown={(event) => bindEnterToCommit(event, async () => {
              await commitStringField('sendCommand');
            })}
          />
        </SettingsRow>

          <SettingsRow
            label={t('settings.stt.newChatCommandLabel')}
            description={t('settings.stt.newChatCommandDescription')}
          >
            <Input
              type="text"
              className="w-40"
              value={draftValues.newChatCommand}
              disabled={loading}
              onChange={(event) => handleDraftChange('newChatCommand', event.target.value)}
              onBlur={() => {
                void commitStringField('newChatCommand');
              }}
              onKeyDown={(event) => bindEnterToCommit(event, async () => {
                await commitStringField('newChatCommand');
              })}
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup
          title={t('settings.stt.groupAmbientPhrases')}
          description={t('settings.stt.groupAmbientPhrasesDescription')}
      >
        <SettingsRow
          label={t('settings.stt.ambientPrimaryTriggerPhraseLabel')}
          description={t('settings.stt.ambientPrimaryTriggerPhraseDescription')}
        >
          <Input
            type="text"
            className="w-40"
            value={draftValues.ambientPrimaryTriggerPhrase}
            disabled={loading}
            onChange={(event) => handleDraftChange('ambientPrimaryTriggerPhrase', event.target.value)}
            onBlur={() => {
              void commitAmbientPhraseField('trigger');
            }}
            onKeyDown={(event) => bindEnterToCommit(event, async () => {
              await commitAmbientPhraseField('trigger');
            })}
          />
        </SettingsRow>

          <SettingsRow
            label={t('settings.stt.ambientTriggerAliasesLabel')}
            description={t('settings.stt.ambientTriggerAliasesDescription')}
          >
            <Input
              type="text"
              className="w-72"
              value={draftValues.ambientTriggerAliases}
              disabled={loading}
              onChange={(event) => handleDraftChange('ambientTriggerAliases', event.target.value)}
              onBlur={() => {
                void commitAmbientPhraseField('trigger');
              }}
              onKeyDown={(event) => bindEnterToCommit(event, async () => {
                await commitAmbientPhraseField('trigger');
              })}
            />
          </SettingsRow>

          <SettingsRow
            label={t('settings.stt.ambientPrimaryEndPhraseLabel')}
            description={t('settings.stt.ambientPrimaryEndPhraseDescription')}
          >
            <Input
              type="text"
              className="w-40"
              value={draftValues.ambientPrimaryEndPhrase}
              disabled={loading}
              onChange={(event) => handleDraftChange('ambientPrimaryEndPhrase', event.target.value)}
              onBlur={() => {
                void commitAmbientPhraseField('end');
              }}
              onKeyDown={(event) => bindEnterToCommit(event, async () => {
                await commitAmbientPhraseField('end');
              })}
            />
          </SettingsRow>

          <SettingsRow
            label={t('settings.stt.ambientEndAliasesLabel')}
            description={t('settings.stt.ambientEndAliasesDescription')}
          >
            <Input
              type="text"
              className="w-72"
              value={draftValues.ambientEndAliases}
              disabled={loading}
              onChange={(event) => handleDraftChange('ambientEndAliases', event.target.value)}
              onBlur={() => {
                void commitAmbientPhraseField('end');
              }}
              onKeyDown={(event) => bindEnterToCommit(event, async () => {
                await commitAmbientPhraseField('end');
              })}
            />
          </SettingsRow>
        </SettingsGroup>
      </div>
    </>
  );
}
