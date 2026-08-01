import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Square, Download, LoaderCircle } from 'lucide-react';
import { tts, userName } from '@/ipc';
import { trackTtsModelChanged, trackTtsVoiceChanged, trackSettingChanged } from '@/utils/telemetry';
import { Switch } from '../ui/switch';
import { NativeSelect } from '../ui/NativeSelect';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Slider } from '../ui/slider';
import { SettingsRow } from './SettingsSection';
import {
  DEFAULT_TTS_MODEL_ID,
  getDefaultTtsModelForFamily,
  TTS_MODEL_FAMILIES,
  TTS_MODELS,
  TTS_PROVIDERS,
  type TtsModelFamily,
  type TtsModelId,
  type TtsModelSize,
  type TtsProvider,
  type TtsSettings,
} from '../../../shared/types/tts';
import type {
  TtsInstallModelResponse,
  TtsInstallProgressEvent,
  TtsModelStatus,
  TtsSetSettingsResponse,
  TtsVoiceOption,
} from '../../../electron/ipc/registry';

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const;
const DEFAULT_TTS_TEST_TEXT = 'Hello, welcome to Interpreter!';

function buildDefaultTestText(name: string | null | undefined): string {
  const normalizedName = name?.trim();
  if (!normalizedName) {
    return DEFAULT_TTS_TEST_TEXT;
  }
  return `Hello ${normalizedName}, welcome to Interpreter!`;
}

function getSizeLabel(size: TtsModelSize): string {
  if (size === 'nano') return 'Nano';
  if (size === 'mini') return 'Mini';
  if (size === 'medium') return 'Medium';
  return 'Large';
}

function getFamilyLabel(family: TtsModelFamily): string {
  if (family === 'kitten') return 'Kitten';
  if (family === 'kokoro') return 'Kokoro';
  return 'Piper (VITS)';
}

function formatPitchSemitones(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const prefix = rounded > 0 ? '+' : '';
  return `${prefix}${rounded.toFixed(1)} st`;
}

function sanitizePitchSemitones(value: number | null | undefined): number {
  const numericValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(-5, Math.min(5, Math.round(numericValue * 10) / 10));
}

export function TextToSpeechSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<TtsSettings | null>(null);
  const [models, setModels] = useState<TtsModelStatus[]>([]);
  const [voices, setVoices] = useState<TtsVoiceOption[]>([]);
  const [installingModelId, setInstallingModelId] = useState<TtsModelId | null>(null);
  const [installMessage, setInstallMessage] = useState<string>('');
  const [installPercent, setInstallPercent] = useState<number | null>(null);
  const [testText, setTestText] = useState(DEFAULT_TTS_TEST_TEXT);
  const [isTestingVoice, setIsTestingVoice] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [pitchSemitones, setPitchSemitones] = useState(0);

  const selectedModelStatus = useMemo(
    () => settings ? models.find((model) => model.id === settings.modelId) : undefined,
    [models, settings],
  );

  const selectedModelDefinition = useMemo(
    () => settings ? TTS_MODELS.find((model) => model.id === settings.modelId) : undefined,
    [settings],
  );

  const selectedModelFamily = useMemo<TtsModelFamily>(
    () => selectedModelDefinition?.family ?? TTS_MODELS.find((model) => model.id === DEFAULT_TTS_MODEL_ID)?.family ?? 'vits',
    [selectedModelDefinition],
  );

  const familyModels = useMemo(
    () => TTS_MODELS.filter((model) => model.family === selectedModelFamily),
    [selectedModelFamily],
  );

  const familySizes = useMemo<TtsModelSize[]>(
    () => Array.from(new Set(familyModels.map((model) => model.size))),
    [familyModels],
  );

  const selectedModelSize = useMemo<TtsModelSize>(
    () => selectedModelDefinition?.size ?? TTS_MODELS.find((model) => model.id === DEFAULT_TTS_MODEL_ID)?.size ?? 'medium',
    [selectedModelDefinition],
  );

  const loadVoices = useCallback(async (modelId?: TtsModelId) => {
    if (!settings && !modelId) return;

    try {
      const voicesResponse = await tts.getVoices({ modelId: modelId ?? settings!.modelId });
      setVoices(voicesResponse.voices);
    } catch (error) {
      console.error('[TTS] Failed to load voices:', error);
      setVoices([]);
    }
  }, [settings]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResponse, modelsResponse] = await Promise.all([
        tts.getSettings(),
        tts.listModels(),
      ]);

      setSettings(settingsResponse.settings);
      setPitchSemitones(sanitizePitchSemitones(settingsResponse.settings.pitch));
      setModels(modelsResponse.models);

      const voicesResponse = await tts.getVoices({ modelId: settingsResponse.settings.modelId });
      setVoices(voicesResponse.voices);
    } catch (error) {
      console.error('[TTS] Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    let canceled = false;

    void userName.get()
      .then(({ userName: currentUserName }: { userName: string | null }) => {
        if (canceled) return;
        setTestText((previous) => {
          if (previous !== DEFAULT_TTS_TEST_TEXT) {
            return previous;
          }
          return buildDefaultTestText(currentUserName);
        });
      })
      .catch((error: unknown) => {
        console.error('[TTS] Failed to load user name for test text:', error);
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    const offSettingsChanged = tts.onSettingsChanged((event: { settings: TtsSettings }) => {
      setSettings(event.settings);
      setPitchSemitones(sanitizePitchSemitones(event.settings.pitch));
    });

    const offInstallProgress = tts.onInstallProgress((event: TtsInstallProgressEvent) => {
      setInstallingModelId(event.modelId);

      if (event.stage === 'downloading' && event.totalBytes && event.totalBytes > 0 && event.bytesDownloaded !== undefined) {
        const percent = Math.max(0, Math.min(100, Math.round((event.bytesDownloaded / event.totalBytes) * 100)));
        setInstallPercent(percent);
      }

      if (event.stage === 'complete') {
        setInstallMessage(t('settings.tts.installComplete'));
        setInstallPercent(100);
        setInstallingModelId(null);
        void loadData();
        return;
      }

      if (event.stage === 'error') {
        setInstallMessage(event.error || t('settings.tts.installFailed'));
        setInstallingModelId(null);
        return;
      }

      setInstallMessage(event.message || t(`settings.tts.installStage.${event.stage}`));
    });

    return () => {
      offSettingsChanged();
      offInstallProgress();
    };
  }, [loadData, t]);

  useEffect(() => {
    const handlePlaybackState = (event: Event) => {
      const detail = (event as CustomEvent<{ isSpeaking: boolean }>).detail;
      setIsSpeaking(detail?.isSpeaking ?? false);
    };

    window.addEventListener('assistant-tts:playback-state', handlePlaybackState);
    return () => window.removeEventListener('assistant-tts:playback-state', handlePlaybackState);
  }, []);

  const handleStopVoice = useCallback(() => {
    window.dispatchEvent(new Event('assistant-tts:stop'));
    setIsSpeaking(false);
  }, []);

  const updateSettings = useCallback(async (partial: Partial<TtsSettings>) => {
    if (!settings) return;

    const response = await tts.setSettings({ settings: partial }) as TtsSetSettingsResponse;
    if (!response.success) {
      throw new Error(response.error || 'Failed to update TTS settings');
    }

    for (const [key, newValue] of Object.entries(partial)) {
      const oldValue = (settings as unknown as Record<string, unknown>)[key];
      const valueType: 'boolean' | 'string' | 'number' | 'enum' | 'object' =
        typeof newValue === 'boolean' ? 'boolean'
          : typeof newValue === 'number' ? 'number'
            : typeof newValue === 'string' ? 'enum'
              : 'object';
      trackSettingChanged({
        settingKey: `tts.${key}`, tabId: 'textToSpeech', sectionId: 'textToSpeech',
        valueType, oldValue, newValue,
      });
    }

    setSettings(response.settings);
    setPitchSemitones(sanitizePitchSemitones(response.settings.pitch));
    return response.settings;
  }, [settings]);

  const handleReadAssistantMessagesChange = useCallback(async (readAssistantMessages: boolean) => {
    try {
      await updateSettings({ readAssistantMessages });
    } catch (error) {
      console.error('[TTS] Failed to update assistant auto-read state:', error);
    }
  }, [updateSettings]);

  const handleFamilyChange = useCallback(async (family: string) => {
    if (!settings) return;
    if (!(TTS_MODEL_FAMILIES as readonly string[]).includes(family)) return;

    const nextFamily = family as TtsModelFamily;
    const currentSize = TTS_MODELS.find((model) => model.id === settings.modelId)?.size;

    const nextModel = TTS_MODELS.find(
      (model) => model.family === nextFamily && model.size === currentSize,
    ) ?? getDefaultTtsModelForFamily(nextFamily);

    if (!nextModel) return;

    try {
      const nextSettings = await updateSettings({ modelId: nextModel.id, voiceId: 0 });
      if (nextSettings) {
        await loadVoices(nextSettings.modelId);
      }
      trackTtsModelChanged({ family: nextFamily, modelId: nextModel.id, size: nextModel.size });
    } catch (error) {
      console.error('[TTS] Failed to update model family:', error);
    }
  }, [loadVoices, settings, updateSettings]);

  const handleModelChange = useCallback(async (modelId: string) => {
    const nextModel = TTS_MODELS.find((model) => model.id === modelId);
    if (!nextModel) return;

    try {
      const nextSettings = await updateSettings({ modelId: nextModel.id, voiceId: 0 });
      if (nextSettings) {
        await loadVoices(nextSettings.modelId);
      }
      trackTtsModelChanged({ modelId: nextModel.id, family: nextModel.family, size: nextModel.size });
    } catch (error) {
      console.error('[TTS] Failed to update model:', error);
    }
  }, [loadVoices, updateSettings]);

  const handleSizeChange = useCallback(async (size: string) => {
    if (!settings) return;
    if (size !== 'nano' && size !== 'mini' && size !== 'medium' && size !== 'large') return;

    const currentFamily = TTS_MODELS.find((model) => model.id === settings.modelId)?.family;
    if (!currentFamily) return;

    const nextModel = TTS_MODELS.find(
      (model) => model.family === currentFamily && model.size === size,
    );
    if (!nextModel) return;

    try {
      const nextSettings = await updateSettings({ modelId: nextModel.id, voiceId: 0 });
      if (nextSettings) {
        await loadVoices(nextSettings.modelId);
      }
    } catch (error) {
      console.error('[TTS] Failed to update model size:', error);
    }
  }, [loadVoices, settings, updateSettings]);

  const handleVoiceChange = useCallback(async (voiceId: string) => {
    const parsed = Number.parseInt(voiceId, 10);
    if (!Number.isInteger(parsed)) return;

    try {
      await updateSettings({ voiceId: parsed });
      trackTtsVoiceChanged(parsed);
    } catch (error) {
      console.error('[TTS] Failed to update voice:', error);
    }
  }, [updateSettings]);

  const handleProviderChange = useCallback(async (provider: string) => {
    if (!(TTS_PROVIDERS as readonly string[]).includes(provider)) return;

    try {
      const nextSettings = await updateSettings({ provider: provider as TtsProvider });
      if (nextSettings) {
        await loadVoices(nextSettings.modelId);
      }
    } catch (error) {
      console.error('[TTS] Failed to update provider:', error);
    }
  }, [loadVoices, updateSettings]);

  const handleSpeedChange = useCallback(async (speed: string) => {
    const parsed = Number.parseFloat(speed);
    if (!Number.isFinite(parsed) || parsed <= 0) return;

    try {
      await updateSettings({ speed: parsed });
    } catch (error) {
      console.error('[TTS] Failed to update speed:', error);
    }
  }, [updateSettings]);

  const handleAutotuneChange = useCallback(async (autotuneEnabled: boolean) => {
    try {
      await updateSettings({ autotuneEnabled });
    } catch (error) {
      console.error('[TTS] Failed to update autotune:', error);
    }
  }, [updateSettings]);

  const handlePitchCommit = useCallback(async (values: number[]) => {
    const next = values[0];
    if (!Number.isFinite(next)) return;
    const clampedSemitones = Math.max(-5, Math.min(5, Math.round(next * 10) / 10));

    try {
      await updateSettings({ pitch: clampedSemitones });
    } catch (error) {
      console.error('[TTS] Failed to update pitch:', error);
      setPitchSemitones(sanitizePitchSemitones(settings?.pitch));
    }
  }, [settings, updateSettings]);

  const handleInstallModel = useCallback(async () => {
    if (!settings) return;

    try {
      setInstallMessage('');
      setInstallPercent(null);
      setInstallingModelId(settings.modelId);
      const result = await tts.installModel({ modelId: settings.modelId }) as TtsInstallModelResponse;

      if (!result.success) {
        setInstallMessage(result.error || t('settings.tts.installFailed'));
        setInstallingModelId(null);
        return;
      }

      await loadData();
      setInstallMessage(t('settings.tts.installComplete'));
      setInstallingModelId(null);
    } catch (error) {
      console.error('[TTS] Failed to install model:', error);
      setInstallMessage(error instanceof Error ? error.message : String(error));
      setInstallingModelId(null);
    }
  }, [loadData, settings, t]);

  const handleTestVoice = useCallback(async () => {
    if (!settings) return;
    if (!testText.trim()) return;

    try {
      setIsTestingVoice(true);
      const result = await tts.speak({
        text: testText,
        play: true,
      });

      if (!result.success) {
        setInstallMessage(result.error || t('settings.tts.testFailed'));
      }
    } catch (error) {
      console.error('[TTS] Test voice failed:', error);
      setInstallMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTestingVoice(false);
    }
  }, [settings, t, testText]);

  if (loading || !settings) {
    return <div className="text-ui-sm text-muted-foreground py-2">{t('common.loading')}</div>;
  }

  const isInstallingCurrentModel = installingModelId === settings.modelId;
  const modelIsInstalled = Boolean(selectedModelStatus?.installed);
  const safePitchSemitones = sanitizePitchSemitones(pitchSemitones);

  return (
    <div>
      <SettingsRow
        label={t('settings.tts.engineLabel')}
        description={t('settings.tts.engineDescription')}
      >
        <NativeSelect
          value={selectedModelFamily}
          onValueChange={handleFamilyChange}
          items={TTS_MODEL_FAMILIES.map((family) => ({ label: getFamilyLabel(family), value: family }))}
          className="w-40"
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.tts.modelLabel')}
        description={selectedModelDefinition?.description || t('settings.tts.modelDescription')}
      >
        <NativeSelect
          value={settings.modelId}
          onValueChange={handleModelChange}
          items={familyModels.map((model) => ({ label: model.label, value: model.id }))}
          className="w-[280px]"
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.tts.modelSizeLabel')}
        description={t('settings.tts.modelSizeDescription')}
      >
        <NativeSelect
          value={selectedModelSize}
          onValueChange={handleSizeChange}
          items={familySizes.map((size) => ({ label: getSizeLabel(size), value: size }))}
          className="w-32"
          disabled={familySizes.length <= 1}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.tts.installLabel')}
        description={selectedModelStatus?.installPath || t('settings.tts.installDescription')}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleInstallModel()}
          disabled={isInstallingCurrentModel}
        >
          {isInstallingCurrentModel ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          {modelIsInstalled
            ? t('settings.tts.reinstallModel')
            : t('settings.tts.downloadModel')}
        </Button>
      </SettingsRow>

      <div className="pb-3 text-ui-xs text-muted-foreground">
        {modelIsInstalled
          ? 'TTS controls are enabled.'
          : 'Download the selected TTS model to enable text-to-speech controls.'}
      </div>

      {(installMessage || installPercent !== null) && (
        <div className="text-ui-xs text-muted-foreground py-2">
          {installMessage}
          {installPercent !== null ? ` (${installPercent}%)` : ''}
        </div>
      )}

      <div className={modelIsInstalled ? '' : 'pointer-events-none opacity-50'}>
      <SettingsRow
        label={t('settings.tts.readAssistantMessagesLabel')}
        description={t('settings.tts.readAssistantMessagesDescription')}
      >
        <Switch
          checked={settings.readAssistantMessages}
          onCheckedChange={handleReadAssistantMessagesChange}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.tts.voiceLabel')}
        description={modelIsInstalled ? t('settings.tts.voiceDescription') : t('settings.tts.voiceInstallHint')}
      >
        <NativeSelect
          value={String(settings.voiceId)}
          onValueChange={handleVoiceChange}
          items={voices.length > 0
            ? voices.map((voice) => ({ label: voice.label, value: String(voice.id) }))
            : [{ label: t('settings.tts.voiceUnavailable'), value: '0' }]
          }
          className="w-36"
          disabled={!modelIsInstalled || voices.length === 0}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.tts.backendLabel')}
        description={t('settings.tts.backendDescription')}
      >
        <NativeSelect
          value={settings.provider}
          onValueChange={handleProviderChange}
          items={TTS_PROVIDERS.map((provider) => ({ label: provider, value: provider }))}
          className="w-32"
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.tts.speedLabel')}
        description={t('settings.tts.speedDescription')}
      >
        <NativeSelect
          value={String(settings.speed)}
          onValueChange={handleSpeedChange}
          items={SPEED_OPTIONS.map((speed) => ({ label: `${speed}x`, value: String(speed) }))}
          className="w-24"
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.tts.pitchLabel')}
        description={t('settings.tts.pitchDescription')}
      >
        <div className="flex items-center gap-3">
          <Slider
            min={-5}
            max={5}
            step={0.1}
            value={[safePitchSemitones]}
            onValueChange={(values) => {
              const next = values[0];
              if (!Number.isFinite(next)) return;
              setPitchSemitones(sanitizePitchSemitones(next));
            }}
            onValueCommit={handlePitchCommit}
            className="w-40"
            aria-label={t('settings.tts.pitchLabel')}
          />
          <span className="text-ui-sm text-muted-foreground w-16 text-right">
            {formatPitchSemitones(safePitchSemitones)}
          </span>
        </div>
      </SettingsRow>

      <SettingsRow
        label={t('settings.tts.autotuneLabel')}
        description={t('settings.tts.autotuneDescription')}
      >
        <Switch
          checked={settings.autotuneEnabled}
          onCheckedChange={handleAutotuneChange}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.tts.testLabel')}
        description={t('settings.tts.testDescription')}
        className="items-center"
      >
        <div className="flex items-center gap-2 w-[420px]">
          <Input
            value={testText}
            onChange={(event) => setTestText(event.target.value)}
            placeholder={t('settings.tts.testPlaceholder')}
          />
          {isSpeaking ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleStopVoice}
            >
              <Square className="size-3.5" />
              {t('settings.tts.stopTest')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleTestVoice()}
              disabled={isTestingVoice || !modelIsInstalled || !testText.trim()}
            >
              {isTestingVoice ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {t('settings.tts.playTest')}
            </Button>
          )}
        </div>
      </SettingsRow>
      </div>
    </div>
  );
}
