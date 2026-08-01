import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsRow } from './SettingsSection';
import { uiSettings } from '@/ipc';
import type { BooleanSettingChangedEvent } from '../../../shared/booleanSettings';
import { trackSettingChanged } from '../../utils/telemetry';

export function EditorSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const [reviewMarkdownEdits, setReviewMarkdownEditsState] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSetting() {
      try {
        const response = await uiSettings.getReviewMarkdownEdits();
        setReviewMarkdownEditsState(response.enabled);
      } catch (error) {
        console.error('Failed to load review markdown edits setting:', error);
      } finally {
        setLoading(false);
      }
    }
    loadSetting();

    const unsubscribe = uiSettings.onReviewMarkdownEditsChanged?.((event: BooleanSettingChangedEvent) => {
      setReviewMarkdownEditsState(event.enabled);
    });

    return unsubscribe;
  }, []);

  async function handleChange(enabled: boolean) {
    const previous = reviewMarkdownEdits;
    setReviewMarkdownEditsState(enabled);
    try {
      await uiSettings.setReviewMarkdownEdits(enabled);
      trackSettingChanged({
        settingKey: 'reviewMarkdownEdits', tabId: 'general', sectionId: 'preferences',
        valueType: 'boolean', oldValue: previous, newValue: enabled,
      });
    } catch (error) {
      console.error('Failed to save review markdown edits setting:', error);
    }
  }

  if (loading) {
    return <div className="text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  return (
    <SettingsRow label={t('settings.editor.reviewAgentEditsLabel')} description={t('settings.editor.reviewAgentEditsDescription')}>
      <Switch
        checked={reviewMarkdownEdits}
        onCheckedChange={handleChange}
      />
    </SettingsRow>
  );
}
