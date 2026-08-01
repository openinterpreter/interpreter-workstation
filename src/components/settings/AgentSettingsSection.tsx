import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NativeSelect } from '../ui/NativeSelect';
import { Switch } from '../ui/switch';
import { SettingsRow } from './SettingsSection';
import { agentSettings, uiSettings } from '@/ipc';
import type { BooleanSettingChangedEvent } from '../../../shared/booleanSettings';
import { trackSettingChanged } from '../../utils/telemetry';

export function AgentSettingsSectionContent() {
  const { t } = useTranslation();
  const [maxSteps, setMaxSteps] = useState(1000);
  const [maxSubagentDepth, setMaxSubagentDepth] = useState(5);
  const [autoContinuationLimit, setAutoContinuationLimit] = useState(10);
  const [autoApproveLowRiskMediaCards, setAutoApproveLowRiskMediaCards] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSettings() {
      try {
        const [
          stepsResponse,
          depthResponse,
          autoContinuationLimitResponse,
          autoApproveLowRiskMediaCardsResponse,
        ] = await Promise.all([
          agentSettings.getMaxSteps(),
          agentSettings.getMaxSubagentDepth(),
          agentSettings.getAutoContinuationLimit(),
          uiSettings.getAutoApproveLowRiskMediaCards(),
        ]);
        setMaxSteps(stepsResponse.maxSteps);
        setMaxSubagentDepth(depthResponse.maxSubagentDepth);
        setAutoContinuationLimit(autoContinuationLimitResponse.autoContinuationLimit);
        setAutoApproveLowRiskMediaCards(autoApproveLowRiskMediaCardsResponse.enabled);
      } catch (error) {
        console.error('Failed to load agent settings:', error);
      } finally {
        setLoading(false);
      }
    }
    loadSettings();

    const unsubscribeAutoApproveLowRiskMediaCards = uiSettings.onAutoApproveLowRiskMediaCardsChanged?.(
      (event: BooleanSettingChangedEvent) => {
        setAutoApproveLowRiskMediaCards(event.enabled);
      },
    );

    return () => {
      unsubscribeAutoApproveLowRiskMediaCards?.();
    };
  }, []);

  async function handleMaxStepsChange(value: number) {
    setMaxSteps(value);
    try {
      await agentSettings.setMaxSteps(value);
    } catch (error) {
      console.error('Failed to save agent settings:', error);
    }
  }

  async function handleMaxSubagentDepthChange(value: number) {
    setMaxSubagentDepth(value);
    try {
      await agentSettings.setMaxSubagentDepth(value);
    } catch (error) {
      console.error('Failed to save agent settings:', error);
    }
  }

  async function handleAutoContinuationLimitChange(value: number) {
    setAutoContinuationLimit(value);
    try {
      await agentSettings.setAutoContinuationLimit(value);
    } catch (error) {
      console.error('Failed to save agent settings:', error);
    }
  }

  async function handleAutoApproveLowRiskMediaCardsChange(enabled: boolean) {
    const previous = autoApproveLowRiskMediaCards;
    setAutoApproveLowRiskMediaCards(enabled);
    try {
      const result = await uiSettings.setAutoApproveLowRiskMediaCards(enabled);
      if (!result.success) {
        setAutoApproveLowRiskMediaCards(previous);
        return;
      }
      trackSettingChanged({
        settingKey: 'autoApproveLowRiskMediaCards',
        tabId: 'general',
        sectionId: 'agent',
        valueType: 'boolean',
        oldValue: previous,
        newValue: enabled,
      });
    } catch (error) {
      console.error('Failed to save low-risk media approval setting:', error);
      setAutoApproveLowRiskMediaCards(previous);
    }
  }

  if (loading) {
    return <div className="text-ui-sm text-muted-foreground py-4">{t('common.loading')}</div>;
  }

  return (
    <>
      <SettingsRow
        label={t('settings.agent.maxToolStepsLabel')}
        description={t('settings.agent.maxToolStepsDescription')}
      >
        <NativeSelect
          value={maxSteps.toString()}
          onValueChange={(value) => handleMaxStepsChange(parseInt(value, 10))}
          items={[
            { label: '100', value: '100' },
            { label: '250', value: '250' },
            { label: '500', value: '500' },
            { label: '1,000', value: '1000' },
            { label: '2,000', value: '2000' },
            { label: '5,000', value: '5000' },
          ]}
          className="w-28"
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.agent.maxSubagentDepthLabel')}
        description={t('settings.agent.maxSubagentDepthDescription')}
      >
        <NativeSelect
          value={maxSubagentDepth.toString()}
          onValueChange={(value) => handleMaxSubagentDepthChange(parseInt(value, 10))}
          items={[
            { label: '1', value: '1' },
            { label: '2', value: '2' },
            { label: '3', value: '3' },
            { label: '5', value: '5' },
            { label: '10', value: '10' },
            { label: '15', value: '15' },
            { label: '20', value: '20' },
          ]}
          className="w-28"
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.agent.autoContinueLimitLabel')}
        description={t('settings.agent.autoContinueLimitDescription')}
      >
        <NativeSelect
          value={autoContinuationLimit.toString()}
          onValueChange={(value) => handleAutoContinuationLimitChange(parseInt(value, 10))}
          items={[
            { label: t('settings.agent.autoContinueOff'), value: '0' },
            { label: '1', value: '1' },
            { label: '3', value: '3' },
            { label: '5', value: '5' },
            { label: '10', value: '10' },
            { label: '15', value: '15' },
            { label: '20', value: '20' },
          ]}
          className="w-28"
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.agent.autoApproveLowRiskMediaCardsLabel')}
        description={t('settings.agent.autoApproveLowRiskMediaCardsDescription')}
      >
        <Switch
          checked={autoApproveLowRiskMediaCards}
          onCheckedChange={handleAutoApproveLowRiskMediaCardsChange}
        />
      </SettingsRow>
    </>
  );
}
