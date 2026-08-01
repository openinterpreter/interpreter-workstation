import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCustomInstructions, setCustomInstructions } from '../../api';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { SettingsCard } from './SettingsSection';
import { trackSettingChanged } from '../../utils/telemetry';

export function CustomInstructionsSectionContent() {
  const { t } = useTranslation();
  const [customInstructions, setCustomInstructionsState] = useState('');
  const [savedInstructions, setSavedInstructions] = useState('');
  const [onboardingDraft, setOnboardingDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const editorCardStyle = {
    borderWidth: 'var(--border-width)',
    borderColor:
      'color-mix(in srgb, var(--oa-border, var(--border)) 48%, transparent)',
  } as const;

  useEffect(() => {
    async function loadCustomInstructions() {
      try {
        const response = await getCustomInstructions();
        setCustomInstructionsState(response.customInstructions);
        setSavedInstructions(response.customInstructions);
        setOnboardingDraft(response.onboardingCustomInstructionsDraft);
      } catch (error) {
        console.error('Failed to load custom instructions setting:', error);
      }

      setLoading(false);
    }

    void loadCustomInstructions();
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const response = await setCustomInstructions(customInstructions);
      setCustomInstructionsState(response.customInstructions);
      setSavedInstructions(response.customInstructions);
      trackSettingChanged({
        settingKey: 'customInstructions',
        tabId: 'general',
        sectionId: 'customInstructions',
        valueType: 'string',
        newValue: response.customInstructions.length,
      });
    } catch (error) {
      console.error('Failed to save custom instructions setting:', error);
    }

    setSaving(false);
  }

  if (loading) {
    return <div className="text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  const hasUnsavedChanges = customInstructions !== savedInstructions;
  const hasReviewableOnboardingDraft = onboardingDraft.length > 0 && onboardingDraft !== customInstructions;

  return (
    <div className="py-[18px]">
      <SettingsCard
        tone="muted"
        className="rounded-[16px] px-4 py-4 sm:px-5"
        style={editorCardStyle}
        data-help-title={t('settings.general.customInstructionsLabel')}
        data-help-description={t('settings.general.customInstructionsDescription')}
      >
        <div className="flex flex-col gap-4">
          {hasReviewableOnboardingDraft ? (
            <div
              className="flex flex-col gap-3 rounded-[8px] px-4 py-3"
              style={{
                border:
                  'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 48%, transparent)',
                background:
                  'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 52%, transparent)',
              }}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-ui-sm font-medium text-foreground">
                    {t('settings.general.customInstructionsDraftTitle')}
                  </div>
                  <p className="mt-1 max-w-[58ch] text-ui-sm text-muted-foreground text-pretty">
                    {t('settings.general.customInstructionsDraftDescription')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setCustomInstructionsState(onboardingDraft)}
                  className="shrink-0"
                >
                  {t('settings.general.customInstructionsUseDraft')}
                </Button>
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-[6px] bg-background px-3 py-2 text-ui-xs text-foreground">
                {onboardingDraft}
              </pre>
            </div>
          ) : null}
          <Textarea
            value={customInstructions}
            onChange={(event) => setCustomInstructionsState(event.target.value)}
            placeholder={t('settings.general.customInstructionsPlaceholder')}
            rows={8}
            className="min-h-[180px] w-full resize-y bg-[color-mix(in_srgb,var(--oa-bg-app,var(--background))_88%,var(--oa-bg-subtle,var(--muted))_12%)] px-4 py-3"
          />
          <div
            className="flex justify-end pt-3"
            style={{
              borderTop:
                'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 38%, transparent)',
            }}
          >
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!hasUnsavedChanges || saving}
            >
              {saving ? t('common.loading') : t('common.save')}
            </Button>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
