/**
 * McpSettingsSection - Controls whether the agent can install integrations
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsRow } from './SettingsSection';
import { mcpSettings } from '@/ipc';

export function McpSettingsSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const [allowAgentAddRemote, setAllowAgentAddRemote] = useState(true);
  const [allowAgentAddLocal, setAllowAgentAddLocal] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSettings() {
      try {
        const [remoteResult, localResult] = await Promise.all([
          mcpSettings.getAllowAgentAddTools(),
          mcpSettings.getAllowLocalMcpServers(),
        ]);
        setAllowAgentAddRemote(remoteResult.allowed);
        setAllowAgentAddLocal(localResult.allowed);
      } catch (error) {
        console.error('Failed to load MCP settings:', error);
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  const handleRemoteChange = async (checked: boolean) => {
    setAllowAgentAddRemote(checked);
    try {
      await mcpSettings.setAllowAgentAddTools(checked);
    } catch (error) {
      console.error('Failed to update setting:', error);
      setAllowAgentAddRemote(!checked);
    }
  };

  const handleLocalChange = async (checked: boolean) => {
    setAllowAgentAddLocal(checked);
    try {
      await mcpSettings.setAllowLocalMcpServers(checked);
    } catch (error) {
      console.error('Failed to update setting:', error);
      setAllowAgentAddLocal(!checked);
    }
  };

  if (loading) {
    return <div className="text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  return (
    <>
      <SettingsRow
        label={t('settings.tools.advanced.autoInstallLabel')}
        description={t('settings.tools.advanced.autoInstallDescription')}
      >
        <Switch
          size="sm"
          checked={allowAgentAddRemote}
          onCheckedChange={handleRemoteChange}
        />
      </SettingsRow>

      <SettingsRow
        label={t('settings.tools.advanced.localServersLabel')}
        description={t('settings.tools.advanced.localServersDescription')}
      >
        <Switch
          size="sm"
          checked={allowAgentAddLocal}
          onCheckedChange={handleLocalChange}
        />
      </SettingsRow>
    </>
  );
}
