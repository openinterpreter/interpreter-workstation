import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NativeSelect } from '../ui/NativeSelect';
import { Switch } from '../ui/switch';
import { SettingsRow } from './SettingsSection';
import { checkpoint } from '@/ipc';
import type { CheckpointSettingsChangedEvent } from '../../../electron/ipc/registry';

export function CheckpointsSectionContent() {
  const { t } = useTranslation();
  const [checkpointEnabled, setCheckpointEnabled] = useState(true);
  const [checkpointRetentionDays, setCheckpointRetentionDays] = useState(7);
  const [checkpointRequireApproval, setCheckpointRequireApproval] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadCheckpointSettings() {
      try {
        const response = await checkpoint.getSettings();
        setCheckpointEnabled(response.settings.enabled);
        setCheckpointRetentionDays(response.settings.retentionDays);
        setCheckpointRequireApproval(response.settings.requireApprovalForLargeFiles);
      } catch (error) {
        console.error('Failed to load checkpoint settings:', error);
      } finally {
        setLoading(false);
      }
    }
    loadCheckpointSettings();

    const unsubscribe = checkpoint.onSettingsChanged((event: CheckpointSettingsChangedEvent) => {
      setCheckpointEnabled(event.settings.enabled);
      setCheckpointRetentionDays(event.settings.retentionDays);
      setCheckpointRequireApproval(event.settings.requireApprovalForLargeFiles);
    });

    return unsubscribe;
  }, []);

  async function handleCheckpointEnabledChange(enabled: boolean) {
    setCheckpointEnabled(enabled);
    try {
      await checkpoint.setSettings({ enabled });
    } catch (error) {
      console.error('Failed to save checkpoint settings:', error);
    }
  }

  async function handleCheckpointRetentionChange(days: number) {
    setCheckpointRetentionDays(days);
    try {
      await checkpoint.setSettings({ retentionDays: days });
    } catch (error) {
      console.error('Failed to save checkpoint settings:', error);
    }
  }

  async function handleCheckpointRequireApprovalChange(requireApproval: boolean) {
    setCheckpointRequireApproval(requireApproval);
    try {
      await checkpoint.setSettings({ requireApprovalForLargeFiles: requireApproval });
    } catch (error) {
      console.error('Failed to save checkpoint settings:', error);
    }
  }

  if (loading) {
    return <div className="text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  return (
    <>
      <SettingsRow label={t('settings.checkpoints.enableLabel')} description={t('settings.checkpoints.enableDescription')}>
        <Switch
          checked={checkpointEnabled}
          onCheckedChange={handleCheckpointEnabledChange}
        />
      </SettingsRow>

      <SettingsRow label={t('settings.checkpoints.autoDeleteLabel')} description={t('settings.checkpoints.autoDeleteDescription')}>
        <NativeSelect
          value={checkpointRetentionDays.toString()}
          onValueChange={(value) => handleCheckpointRetentionChange(parseInt(value, 10))}
          items={[
            { label: t('settings.checkpoints.retention1day'), value: '1' },
            { label: t('settings.checkpoints.retention3days'), value: '3' },
            { label: t('settings.checkpoints.retention7days'), value: '7' },
            { label: t('settings.checkpoints.retention14days'), value: '14' },
            { label: t('settings.checkpoints.retention30days'), value: '30' },
          ]}
          className="w-28"
        />
      </SettingsRow>

      <SettingsRow label={t('settings.checkpoints.largeFileApprovalLabel')} description={t('settings.checkpoints.largeFileApprovalDescription')}>
        <Switch
          checked={checkpointRequireApproval}
          onCheckedChange={handleCheckpointRequireApprovalChange}
        />
      </SettingsRow>
    </>
  );
}
