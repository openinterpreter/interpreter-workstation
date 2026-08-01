export type SettingsTabId =
  | 'general'
  | 'models'
  | 'permissions'
  | 'tools'
  | 'browser'
  | 'extensions'
  | 'textToSpeech'
  | 'sounds'
  | 'overlay'
  | 'inbox'
  | 'style';

export type SettingsSectionId =
  | 'preferences'
  | 'account'
  | 'plan'
  | 'privacy'
  | 'telemetry'
  | 'onboarding'
  | 'customInstructions'
  | 'models'
  | 'tools'
  | 'mcpPermissions'
  | 'runtimePermissions'
  | 'browser'
  | 'extensions'
  | 'speechToText'
  | 'textToSpeech'
  | 'sounds'
  | 'overlay'
  | 'style'
  | 'inbox';

export interface SettingsTabCatalogEntry {
  id: SettingsTabId;
  titleKey: string;
  defaultLabel: string;
  descriptionKey: string;
}

export interface SettingsSectionCatalogEntry {
  id: SettingsSectionId;
  tabId: SettingsTabId;
  defaultLabel: string;
}

export interface InterpreterConfigPathAlias {
  alias: string;
  raw: string;
}

export interface AgentSettingsPathCatalogEntry {
  path: string;
  defaultLabel: string;
  tabId: SettingsTabId;
  sectionId: SettingsSectionId;
  requiresApproval?: boolean;
  restartRequired?: boolean;
  note?: string;
}

export const SETTINGS_TABS: readonly SettingsTabCatalogEntry[] = [
  {
    id: 'general',
    titleKey: 'settings.tabs.general',
    defaultLabel: 'General',
    descriptionKey: 'help.settings.general.description',
  },
  {
    id: 'models',
    titleKey: 'settings.tabs.models',
    defaultLabel: 'Models',
    descriptionKey: 'help.settings.models.description',
  },
  {
    id: 'permissions',
    titleKey: 'settings.tabs.permissions',
    defaultLabel: 'Permissions',
    descriptionKey: 'help.settings.permissions.description',
  },
  {
    id: 'tools',
    titleKey: 'settings.tabs.tools',
    defaultLabel: 'Tools',
    descriptionKey: 'help.settings.tools.description',
  },
  {
    id: 'browser',
    titleKey: 'settings.tabs.browser',
    defaultLabel: 'Browser',
    descriptionKey: 'help.settings.browser.description',
  },
  {
    id: 'extensions',
    titleKey: 'settings.tabs.extensions',
    defaultLabel: 'Extensions',
    descriptionKey: 'help.settings.extensions.description',
  },
  {
    id: 'textToSpeech',
    titleKey: 'settings.tabs.voice',
    defaultLabel: 'Voice',
    descriptionKey: 'help.settings.voice.description',
  },
  {
    id: 'sounds',
    titleKey: 'settings.tabs.sounds',
    defaultLabel: 'Sounds',
    descriptionKey: 'help.settings.sounds.description',
  },
  {
    id: 'overlay',
    titleKey: 'settings.tabs.overlay',
    defaultLabel: 'Overlay',
    descriptionKey: 'help.settings.overlay.description',
  },
  {
    id: 'inbox',
    titleKey: 'settings.tabs.inbox',
    defaultLabel: 'Inbox',
    descriptionKey: 'help.settings.inbox.description',
  },
  {
    id: 'style',
    titleKey: 'settings.tabs.style',
    defaultLabel: 'Style',
    descriptionKey: 'help.settings.style.description',
  },
] as const;

export const SETTINGS_SECTIONS: readonly SettingsSectionCatalogEntry[] = [
  { id: 'preferences', tabId: 'general', defaultLabel: 'Preferences' },
  { id: 'account', tabId: 'general', defaultLabel: 'Account' },
  { id: 'plan', tabId: 'general', defaultLabel: 'Plan' },
  { id: 'privacy', tabId: 'general', defaultLabel: 'Privacy' },
  { id: 'telemetry', tabId: 'general', defaultLabel: 'Telemetry' },
  { id: 'onboarding', tabId: 'general', defaultLabel: 'Onboarding' },
  { id: 'customInstructions', tabId: 'general', defaultLabel: 'Custom Instructions' },
  { id: 'models', tabId: 'models', defaultLabel: 'Models' },
  { id: 'tools', tabId: 'tools', defaultLabel: 'Tools' },
  { id: 'mcpPermissions', tabId: 'permissions', defaultLabel: 'MCP Permissions' },
  { id: 'runtimePermissions', tabId: 'permissions', defaultLabel: 'Runtime Permissions' },
  { id: 'browser', tabId: 'browser', defaultLabel: 'Browser' },
  { id: 'extensions', tabId: 'extensions', defaultLabel: 'Extensions' },
  { id: 'speechToText', tabId: 'textToSpeech', defaultLabel: 'Speech to Text' },
  { id: 'textToSpeech', tabId: 'textToSpeech', defaultLabel: 'Text to Speech' },
  { id: 'sounds', tabId: 'sounds', defaultLabel: 'Sounds' },
  { id: 'overlay', tabId: 'overlay', defaultLabel: 'Overlay' },
  { id: 'style', tabId: 'style', defaultLabel: 'Style' },
  { id: 'inbox', tabId: 'inbox', defaultLabel: 'Inbox' },
] as const;

export const SETTINGS_SECTION_TO_TAB: Record<string, SettingsTabId> = Object.fromEntries(
  SETTINGS_SECTIONS.map((section) => [section.id, section.tabId]),
) as Record<string, SettingsTabId>;

export const INTERPRETER_CONFIG_PATH_ALIASES: readonly InterpreterConfigPathAlias[] = [
  { alias: 'agentAccess.network', raw: 'codexNetworkAccess' },
  { alias: 'agentAccess.sandboxMode', raw: 'codexSandboxMode' },
  { alias: 'agentAccess.readScope', raw: 'codexReadAccessMode' },
  { alias: 'agentAccess.approvalPolicy', raw: 'codexApprovalPolicy' },
  { alias: 'agentAccess.macosTempAccess', raw: 'codexMacosTempAccess' },
  { alias: 'agentAccess.macosScreenshotAccess', raw: 'codexMacosScreenshotAccess' },
  { alias: 'agentAccess.sandboxNetwork', raw: 'sandboxNetworkAccess' },
  { alias: 'cliPaths.interpreter', raw: 'codexPath' },
  { alias: 'cliPaths.claudeCode', raw: 'claudeCodePath' },
  { alias: 'onboarding', raw: 'onboardingState' },
] as const;

export const INTERPRETER_CONFIG_ALIAS_ROOTS = Array.from(
  new Set(INTERPRETER_CONFIG_PATH_ALIASES.map((entry) => entry.alias.split('.')[0] ?? entry.alias)),
);

export const AGENT_SETTINGS_PATHS: readonly AgentSettingsPathCatalogEntry[] = [
  {
    path: 'language',
    defaultLabel: 'Language',
    tabId: 'general',
    sectionId: 'preferences',
  },
  {
    path: 'telemetryEnabled',
    defaultLabel: 'Telemetry',
    tabId: 'general',
    sectionId: 'telemetry',
    requiresApproval: true,
  },
  {
    path: 'customInstructions',
    defaultLabel: 'Custom instructions',
    tabId: 'general',
    sectionId: 'customInstructions',
  },
  {
    path: 'onboarding.completed',
    defaultLabel: 'Onboarding completed',
    tabId: 'general',
    sectionId: 'onboarding',
  },
  {
    path: 'onboarding.completedStepIds',
    defaultLabel: 'Completed onboarding steps',
    tabId: 'general',
    sectionId: 'onboarding',
  },
  {
    path: 'onboarding.interviewResult',
    defaultLabel: 'Onboarding interview result',
    tabId: 'general',
    sectionId: 'onboarding',
  },
  {
    path: 'onboarding.importedToolSummary',
    defaultLabel: 'Imported tool summary',
    tabId: 'general',
    sectionId: 'onboarding',
  },
  {
    path: 'globalDisabledTools',
    defaultLabel: 'Blocked tools',
    tabId: 'tools',
    sectionId: 'tools',
    requiresApproval: true,
  },
  {
    path: 'builtinToolsEnabled',
    defaultLabel: 'Built-in tools',
    tabId: 'tools',
    sectionId: 'tools',
    requiresApproval: true,
  },
  {
    path: 'allowAgentAddTools',
    defaultLabel: 'Allow agents to add tools',
    tabId: 'permissions',
    sectionId: 'mcpPermissions',
    requiresApproval: true,
  },
  {
    path: 'allowLocalMcpServers',
    defaultLabel: 'Allow local servers',
    tabId: 'permissions',
    sectionId: 'mcpPermissions',
    requiresApproval: true,
  },
  {
    path: 'agentAccess.network',
    defaultLabel: 'Network',
    tabId: 'permissions',
    sectionId: 'runtimePermissions',
    requiresApproval: true,
    restartRequired: true,
  },
  {
    path: 'agentAccess.sandboxMode',
    defaultLabel: 'Sandbox mode',
    tabId: 'permissions',
    sectionId: 'runtimePermissions',
    requiresApproval: true,
    restartRequired: true,
  },
  {
    path: 'agentAccess.readScope',
    defaultLabel: 'Read scope',
    tabId: 'permissions',
    sectionId: 'runtimePermissions',
    requiresApproval: true,
    restartRequired: true,
  },
  {
    path: 'agentAccess.approvalPolicy',
    defaultLabel: 'Approval policy',
    tabId: 'permissions',
    sectionId: 'runtimePermissions',
    requiresApproval: true,
  },
  {
    path: 'agentAccess.macosTempAccess',
    defaultLabel: 'Temporary files',
    tabId: 'permissions',
    sectionId: 'runtimePermissions',
    requiresApproval: true,
    restartRequired: true,
    note: 'macOS only',
  },
  {
    path: 'theme',
    defaultLabel: 'Theme',
    tabId: 'style',
    sectionId: 'style',
  },
  {
    path: 'primaryColor',
    defaultLabel: 'Accent color',
    tabId: 'style',
    sectionId: 'style',
  },
  {
    path: 'backgroundOpacity',
    defaultLabel: 'Window opacity',
    tabId: 'style',
    sectionId: 'style',
  },
  {
    path: 'zoomFactor',
    defaultLabel: 'Interface zoom',
    tabId: 'style',
    sectionId: 'style',
  },
] as const;
