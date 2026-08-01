import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2 } from 'lucide-react';
import { Switch } from '../ui/switch';
import { SettingsRow } from './SettingsSection';
import { cn } from '@/lib/utils';
import {
  getSoundSettings,
  setSoundSettings,
  previewSound,
  SOUND_IDS,
  type SoundId,
} from '@/utils/sounds';
import { trackSettingChanged } from '../../utils/telemetry';

type SoundEvent = 'agentFinished' | 'agentNeedsAttention' | 'voiceSent' | 'ambientTriggerDetected';

function SoundPicker({
  value,
  onChange,
  disabled,
  labels,
}: {
  value: SoundId;
  onChange: (id: SoundId) => void;
  disabled?: boolean;
  labels: Record<SoundId, string>;
}) {
  return (
    <div className="flex items-center gap-1">
      {SOUND_IDS.map((id) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          onClick={() => onChange(id)}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-ui-xs font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            value === id
              ? 'bg-foreground text-background shadow-sm'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            disabled && 'pointer-events-none opacity-40',
          )}
        >
          {id !== 'none' && value === id && (
            <Volume2 className="size-3" />
          )}
          {labels[id]}
        </button>
      ))}
    </div>
  );
}

export function SoundsSectionContent() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(getSoundSettings);
  const soundLabels: Record<SoundId, string> = {
    none: t('settings.sounds.option.none'),
    knock: t('settings.sounds.option.knock'),
    chirp: t('settings.sounds.option.chirp'),
    bubble: t('settings.sounds.option.bubble'),
  };

  const update = (partial: Partial<ReturnType<typeof getSoundSettings>>) => {
    const next = { ...settings, ...partial };
    setSettings(next);
    setSoundSettings(partial);
    for (const [key, newValue] of Object.entries(partial)) {
      trackSettingChanged({
        settingKey: `sounds.${key}`, tabId: 'sounds', sectionId: 'sounds',
        valueType: typeof newValue === 'boolean' ? 'boolean' : 'enum',
        oldValue: (settings as unknown as Record<string, unknown>)[key],
        newValue,
      });
    }
  };

  const handleSoundChange = (key: SoundEvent, value: SoundId) => {
    update({ [key]: value });
    previewSound(value);
  };

  return (
    <div>
      <SettingsRow
        label={t('settings.sounds.enableLabel')}
        description={t('settings.sounds.enableDescription')}
      >
        <Switch
          size="sm"
          checked={settings.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.sounds.agentFinishedLabel')}
        description={t('settings.sounds.agentFinishedDescription')}
      >
        <SoundPicker
          value={settings.agentFinished}
          onChange={(v) => handleSoundChange('agentFinished', v)}
          disabled={!settings.enabled}
          labels={soundLabels}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.sounds.needsAttentionLabel')}
        description={t('settings.sounds.needsAttentionDescription')}
      >
        <SoundPicker
          value={settings.agentNeedsAttention}
          onChange={(v) => handleSoundChange('agentNeedsAttention', v)}
          disabled={!settings.enabled}
          labels={soundLabels}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.sounds.messageSentLabel')}
        description={t('settings.sounds.messageSentDescription')}
      >
        <SoundPicker
          value={settings.voiceSent}
          onChange={(v) => handleSoundChange('voiceSent', v)}
          disabled={!settings.enabled}
          labels={soundLabels}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.sounds.ambientTriggerLabel')}
        description={t('settings.sounds.ambientTriggerDescription')}
      >
        <SoundPicker
          value={settings.ambientTriggerDetected}
          onChange={(v) => handleSoundChange('ambientTriggerDetected', v)}
          disabled={!settings.enabled}
          labels={soundLabels}
        />
      </SettingsRow>
    </div>
  );
}
