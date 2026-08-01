import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsRow } from './SettingsSection';
import { uiSettings } from '@/ipc';
import type { BooleanSettingChangedEvent } from '../../../shared/booleanSettings';
import { trackSettingChanged } from '../../utils/telemetry';

export function AppBehaviorSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSettings() {
      try {
        const launchAtLoginResponse = await uiSettings.getLaunchAtLogin();
        setLaunchAtLogin(launchAtLoginResponse.enabled);
      } catch (error) {
        console.error('Failed to load app behavior settings:', error);
      } finally {
        setLoading(false);
      }
    }

    loadSettings();

    const unsubscribeLaunchAtLogin = uiSettings.onLaunchAtLoginChanged?.((event: BooleanSettingChangedEvent) => {
      setLaunchAtLogin(event.enabled);
    });

    return () => {
      unsubscribeLaunchAtLogin?.();
    };
  }, []);

  async function handleLaunchAtLoginChange(enabled: boolean) {
    const previous = launchAtLogin;
    setLaunchAtLogin(enabled);
    try {
      const result = await uiSettings.setLaunchAtLogin(enabled);
      if (!result.success) setLaunchAtLogin(previous);
      else {
        trackSettingChanged({
          settingKey: 'launchAtLogin', tabId: 'general', sectionId: 'preferences',
          valueType: 'boolean', oldValue: previous, newValue: enabled,
        });
      }
    } catch (error) {
      console.error('Failed to save launch at login setting:', error);
      setLaunchAtLogin(previous);
    }
  }

  if (loading) {
    return <div className="text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  return (
    <>
      <SettingsRow
        label={t('settings.general.launchAtLoginLabel')}
        description={t('settings.general.launchAtLoginDescription')}
      >
        <Switch checked={launchAtLogin} onCheckedChange={handleLaunchAtLoginChange} />
      </SettingsRow>
    </>
  );
}
