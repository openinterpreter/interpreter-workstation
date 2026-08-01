import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NativeSelect } from '../ui/NativeSelect';
import { SettingsRow } from './SettingsSection';
import { locale as localeIpc } from '@/ipc';
import { languageNames, supportedLanguages } from '../../../shared/locales';
import type { LocaleGetResponse, LocaleChangedEvent } from '../../../electron/ipc/registry';
import { trackSettingChanged } from '../../utils/telemetry';

export function LanguageSectionContent() {
  const { t } = useTranslation();
  const [language, setLanguageState] = useState<string>('en');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    localeIpc.get().then((response: LocaleGetResponse) => {
      setLanguageState(response.language);
      setLoading(false);
    }).catch(() => setLoading(false));

    const unsubscribe = localeIpc.onChanged((event: LocaleChangedEvent) => {
      setLanguageState(event.language);
    });

    return unsubscribe;
  }, []);

  const handleChange = async (value: string) => {
    const oldValue = language;
    setLanguageState(value);
    await localeIpc.set(value);
    trackSettingChanged({
      settingKey: 'language', tabId: 'general', sectionId: 'preferences',
      valueType: 'enum', oldValue, newValue: value,
    });
  };

  if (loading) {
    return <div className="py-3 text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  const items = supportedLanguages.map(lng => ({
    label: languageNames[lng],
    value: lng,
  }));

  return (
    <SettingsRow
      label={t('settings.general.language')}
      description={t('settings.general.languageDescription')}
    >
      <NativeSelect
        value={language}
        onValueChange={handleChange}
        items={items}
        size="sm"
        className="w-[180px]"
      />
    </SettingsRow>
  );
}
