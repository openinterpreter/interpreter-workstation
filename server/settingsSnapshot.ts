import type { AppConfig } from './configStore';
import { supportedLanguages } from '../shared/locales';
import { DEFAULT_BACKGROUND_OPACITY } from '../shared/uiDefaults';
import {
  validateConfig,
  validateSettingsSnapshot,
  type SettingsSnapshot,
} from './configSchema';

export { DEFAULT_BACKGROUND_OPACITY } from '../shared/uiDefaults';

export const DEFAULT_MAX_STEPS = 1000;
export const DEFAULT_MAX_SUBAGENT_DEPTH = 5;
export const DEFAULT_AUTO_CONTINUATION_LIMIT = 10;

export function buildSettingsSnapshot(config: AppConfig): SettingsSnapshot {
  return {
    backgroundOpacity: config.backgroundOpacity ?? DEFAULT_BACKGROUND_OPACITY,
    zoomFactor: config.zoomFactor ?? 1,
    theme: config.theme ?? 'system',
    language:
      (config.language as SettingsSnapshot['language'] | undefined) ??
      supportedLanguages[0],
    primaryColor:
      (config.primaryColor as SettingsSnapshot['primaryColor'] | undefined) ??
      'gray',
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    maxSubagentDepth: config.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    autoContinuationLimit:
      config.autoContinuationLimit ?? DEFAULT_AUTO_CONTINUATION_LIMIT,
    showHelpPanelPreview: config.showHelpPanelPreview ?? false,
    reviewMarkdownEdits: config.reviewMarkdownEdits ?? true,
    launchAtLogin: config.launchAtLogin ?? false,
    autoApproveLowRiskMediaCards: config.autoApproveLowRiskMediaCards ?? false,
    telemetryEnabled: config.telemetryEnabled ?? false,
    allowAgentAddTools: config.allowAgentAddTools ?? true,
    allowLocalMcpServers: config.allowLocalMcpServers ?? false,
    skillFolders: [...(config.skillFolders ?? [])],
    allowModelSkillEditing: config.allowModelSkillEditing ?? true,
  };
}

export function applySettingsSnapshot(
  config: AppConfig,
  snapshot: SettingsSnapshot,
): AppConfig {
  return {
    ...config,
    backgroundOpacity: snapshot.backgroundOpacity,
    zoomFactor: snapshot.zoomFactor,
    theme: snapshot.theme,
    language: snapshot.language,
    primaryColor: snapshot.primaryColor,
    maxSteps: snapshot.maxSteps,
    maxSubagentDepth: snapshot.maxSubagentDepth,
    autoContinuationLimit: snapshot.autoContinuationLimit,
    showHelpPanelPreview: snapshot.showHelpPanelPreview,
    reviewMarkdownEdits: snapshot.reviewMarkdownEdits,
    launchAtLogin: snapshot.launchAtLogin,
    autoApproveLowRiskMediaCards: snapshot.autoApproveLowRiskMediaCards,
    telemetryEnabled: snapshot.telemetryEnabled,
    allowAgentAddTools: snapshot.allowAgentAddTools,
    allowLocalMcpServers: snapshot.allowLocalMcpServers,
    skillFolders: [...snapshot.skillFolders],
    allowModelSkillEditing: snapshot.allowModelSkillEditing,
  };
}

export function assertValidSettingsSnapshot(
  snapshot: SettingsSnapshot,
): SettingsSnapshot {
  const validatedSnapshot = validateSettingsSnapshot(snapshot);
  if (!validatedSnapshot.success) {
    throw new Error(`Invalid settings snapshot: ${validatedSnapshot.error}`);
  }
  return validatedSnapshot.data;
}

export function assertValidAppConfig(config: AppConfig): AppConfig {
  const validatedConfig = validateConfig(config);
  if (!validatedConfig.success) {
    throw new Error(`Invalid app config: ${validatedConfig.error}`);
  }
  return validatedConfig.data as AppConfig;
}
