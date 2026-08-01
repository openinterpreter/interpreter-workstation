import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Switch } from '../ui/switch';
import { SettingsCard, SettingsRow } from './SettingsSection';
import { telemetry as telemetryIpc, openExternal } from '@/ipc';
import { trackSettingChanged } from '../../utils/telemetry';

export function TelemetrySectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSettings() {
      try {
        const response = await telemetryIpc.get();
        // Default to false if not set
        setTelemetryEnabled(response.enabled ?? false);
      } catch (error) {
        console.error('Failed to load telemetry settings:', error);
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  async function handleTelemetryChange(enabled: boolean) {
    const oldValue = telemetryEnabled;
    setTelemetryEnabled(enabled);
    try {
      await telemetryIpc.set(enabled);
      // Only emit when flipping ON — if the user is turning telemetry OFF the
      // subsequent track() is a no-op anyway.
      trackSettingChanged({
        settingKey: 'telemetryEnabled', tabId: 'general', sectionId: 'telemetry',
        valueType: 'boolean', oldValue, newValue: enabled,
      });
    } catch (error) {
      console.error('Failed to save telemetry settings:', error);
      // Revert on error
      setTelemetryEnabled(!enabled);
    }
  }

  if (loading) {
    return <div className="py-3 text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  return (
    <>
      <SettingsRow
        label={t('settings.telemetry.shareAnalyticsLabel')}
        description={t('settings.telemetry.shareAnalyticsDescription')}
      >
        <Switch
          size="sm"
          checked={telemetryEnabled}
          onCheckedChange={handleTelemetryChange}
        />
      </SettingsRow>

      <div className="py-[18px]">
        <SettingsCard tone="muted" className="max-w-[520px] space-y-3">
          <p className="text-ui-sm leading-6 text-muted-foreground text-pretty">
            {t('settings.telemetry.summary')}
          </p>
          <p className="text-ui-sm leading-6 text-muted-foreground/80 text-pretty">
            {t('settings.telemetry.providerNote')}
          </p>
          <button
            type="button"
            onClick={() => openExternal('https://www.openinterpreter.com/legal/privacy')}
            className="inline-flex items-center gap-1.5 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('settings.telemetry.privacyPolicyLink')}
            <ExternalLink className="size-3" />
          </button>
        </SettingsCard>
      </div>
    </>
  );
}
