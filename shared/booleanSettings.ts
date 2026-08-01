import type { AppConfig } from '../server/configStore';

export const BOOLEAN_UI_SETTINGS = {
  showHelpPanelPreview: { default: false },
  reviewMarkdownEdits:  { default: true },
  launchAtLogin:        { default: false },
  autoApproveLowRiskMediaCards: { default: false },
} as const satisfies Record<string, { default: boolean }>;

export type BooleanUISettingId = keyof typeof BOOLEAN_UI_SETTINGS;

export type BooleanUISettingKey = {
  [K in BooleanUISettingId]: K extends keyof AppConfig ? K : never;
}[BooleanUISettingId];

export interface BooleanSettingGetResponse {
  enabled: boolean;
}

export interface BooleanSettingSetResult {
  success: boolean;
  error?: string;
}

export interface BooleanSettingChangedEvent {
  enabled: boolean;
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}

export function booleanSettingChannels(id: BooleanUISettingId) {
  const kebab = camelToKebab(id);
  return {
    get: `ui-settings:get-${kebab}`,
    set: `ui-settings:set-${kebab}`,
    changed: `uiSettings:${kebab}-changed`,
  } as const;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function booleanSettingMethodNames(id: BooleanUISettingId) {
  const pascal = capitalize(id);
  return {
    get: `get${pascal}` as const,
    set: `set${pascal}` as const,
    onChanged: `on${pascal}Changed` as const,
  };
}

export const BOOLEAN_UI_SETTING_IDS = Object.keys(BOOLEAN_UI_SETTINGS) as BooleanUISettingId[];
