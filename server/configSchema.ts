/**
 * Zod schema for validating AppConfig
 *
 * Used by settings tools to validate config changes before saving.
 */

import { z } from 'zod';
import { PRIMARY_COLOR_IDS } from '../shared/types/colors';
import { supportedLanguages } from '../shared/locales';
import { ONBOARDING_STATE_VERSION } from '../shared/types/onboardingState';

// Model provider - about API format/protocol, not service
const ModelProviderSchema = z.enum([
  'hosted',
  'openai-oauth',
  'api',
  'local',
  'agent',
  'terminal',
]);

// Provider type - simplified, with 'api' as unified type for API key providers
const ProviderTypeSchema = z.enum([
  'hosted',
  'openai-oauth',
  'api',         // Unified type for all API key providers (anthropic, openai, groq, openrouter, custom)
  'local',
  'agent',
  'terminal',
]);

// API preset (known services with default URLs)
const ApiPresetSchema = z.enum(['anthropic', 'openai', 'groq', 'openrouter', 'deepseek']);

// API format
const ApiFormatSchema = z.enum(['openai', 'anthropic']);
const WireApiSchema = z.enum(['responses', 'chat']);

// API config (for type: 'api' providers)
const ApiConfigSchema = z.object({
  preset: ApiPresetSchema.optional(),
  format: ApiFormatSchema.optional(),
  wireApi: WireApiSchema.optional(),
  useResponsesApi: z.boolean().optional(),
});

// Terminal config
const TerminalConfigSchema = z.object({
  id: z.string(),
  command: z.string(),
  icon: z.string().optional(),
  richInput: z.boolean().optional(),
  hideInput: z.boolean().optional(),
  inputMarker: z.string().optional(),
  titleMarker: z.string().optional(),
  helpDescription: z.string().optional(),
});

// Provider-specific config (union)
const ProviderConfigSchema = TerminalConfigSchema;

// Profile
const ProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  modelId: z.string(),
  isBuiltin: z.boolean(),
  providerId: z.string().optional(),
  provider: ModelProviderSchema,
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  apiFormat: ApiFormatSchema.optional(),
  wireApi: WireApiSchema.optional(),
  codexProfileId: z.string().optional(),
  providerConfig: ProviderConfigSchema.optional(),
  useResponsesApi: z.boolean().optional(),
  helpDescription: z.string().optional(),
  isAdvanced: z.boolean().optional(),
  isExperimental: z.boolean().optional(),
  disabledTools: z.array(z.string()).optional(),
  maxSteps: z.number().min(1).max(10000).optional(),
  maxSubagentDepth: z.number().min(1).max(20).optional(),
});

// Provider
const ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  api: ApiConfigSchema.optional(),  // For type: 'api'
  providerConfig: ProviderConfigSchema.optional(),  // Provider-specific config
  createdAt: z.number(),
  updatedAt: z.number(),
});

// Agent config
const AgentConfigSchema = z.object({
  selectedAuthMethod: z.string().optional(),
  apiKeys: z.record(z.string(), z.string()).optional(),
  authenticated: z.boolean().optional(),
  oauthEmail: z.string().optional(),
  lastAuthenticatedAt: z.number().optional(),
  googleCloudProject: z.string().optional(),
});

// MCP server config
// Supports both stdio (command-based) and HTTP (url-based) transports
const McpServerConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  // stdio transport
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // remote transports
  transport: z.enum(['stdio', 'http', 'sse', 'websocket']).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // common
  enabled: z.boolean().optional(),
  lastConnectedAt: z.number().optional(),
  lastConnectionFailure: z.object({
    error: z.string(),
    needsAuth: z.boolean().optional(),
    updatedAt: z.number(),
  }).optional(),
}).passthrough(); // Allow additional fields

// Recent folder
const RecentFolderSchema = z.object({
  path: z.string(),
  name: z.string(),
  lastOpened: z.number(),
});

// Valid primary color options (from shared/types/colors.ts - single source of truth)
const PrimaryColorSchema = z.enum(PRIMARY_COLOR_IDS);
const LanguageSchema = z.enum(supportedLanguages);
const BrowserAccessPolicyModeSchema = z.enum(['ask', 'deny', 'all', 'allowList']);
const BrowserAccessRuleSchema = z.object({
  mode: BrowserAccessPolicyModeSchema,
  allowedPatterns: z.array(z.string()),
});
const BrowserAccessPermissionRulesSchema = z.object({
  read: BrowserAccessRuleSchema,
  write: BrowserAccessRuleSchema,
  action: BrowserAccessRuleSchema,
});
const BrowserAccessProfilePolicySchema = z.object({
  profileId: z.string(),
  permissions: BrowserAccessPermissionRulesSchema,
});
const BrowserAccessPolicySchema = z.object({
  permissions: BrowserAccessPermissionRulesSchema,
  profilePolicies: z.array(BrowserAccessProfilePolicySchema),
});
const CuaAccessPolicyModeSchema = z.enum(['ask', 'deny', 'all']);
const CuaAccessRuleSchema = z.object({
  mode: CuaAccessPolicyModeSchema,
});
const CuaAccessPermissionRulesSchema = z.object({
  inspect: CuaAccessRuleSchema,
  control: CuaAccessRuleSchema,
});
const CuaAccessAppPolicySchema = z.object({
  appId: z.string(),
  displayName: z.string(),
  permissions: CuaAccessPermissionRulesSchema,
});
const CuaAccessPolicySchema = z.object({
  permissions: CuaAccessPermissionRulesSchema,
  appPolicies: z.array(CuaAccessAppPolicySchema),
});
const ReadToolPromptInjectionGuardSchema = z.object({
  enabled: z.boolean(),
  modelProfileId: z.string().nullable(),
});
const InterpreterOverlaySettingsSchema = z.object({
  accountUserId: z.string().nullable(),
  enabled: z.boolean(),
  permissionSetupPending: z.boolean(),
  hotkey: z.string(),
  preferredWorkspacePath: z.string().nullable(),
  preferredNoWorkspace: z.boolean(),
  preferredProfileId: z.string().nullable(),
  advancedVoiceEnabled: z.boolean(),
  advancedVoiceWorkspacePath: z.string().nullable(),
  advancedVoiceModel: z.string(),
  hiddenAgentModel: z.string(),
  readToolPromptInjectionGuard: ReadToolPromptInjectionGuardSchema,
});

export const SettingsSnapshotSchema = z.object({
  backgroundOpacity: z.number().min(0).max(1),
  zoomFactor: z.number().min(0.5).max(3),
  theme: z.enum(['light', 'dark', 'system']),
  language: LanguageSchema,
  primaryColor: PrimaryColorSchema,
  maxSteps: z.number().min(1).max(10000),
  maxSubagentDepth: z.number().min(1).max(20),
  autoContinuationLimit: z.number().int().min(0).max(100),
  showHelpPanelPreview: z.boolean(),
  reviewMarkdownEdits: z.boolean(),
  launchAtLogin: z.boolean(),
  autoApproveLowRiskMediaCards: z.boolean(),
  telemetryEnabled: z.boolean(),
  allowAgentAddTools: z.boolean(),
  allowLocalMcpServers: z.boolean(),
  skillFolders: z.array(z.string()),
  allowModelSkillEditing: z.boolean(),
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshotSchema>;

const OnboardingStateSchema = z.object({
  version: z.literal(ONBOARDING_STATE_VERSION),
  completed: z.boolean(),
  completedStepIds: z.array(z.string()),
  interviewDraft: z.string(),
  interviewResult: z.object({
    summary: z.string(),
    modelPreferences: z.array(z.string()),
    workingPreferences: z.array(z.string()),
    customInstructionsDraft: z.string(),
    updatedAt: z.string(),
  }).nullable(),
  extensionDecisions: z.record(z.string(), z.enum(['undecided', 'install', 'skip'])),
  importedToolSummary: z.object({
    generatedAt: z.string().nullable(),
    sources: z.array(z.string()),
    summary: z.string(),
  }),
});

// Full AppConfig schema
export const AppConfigSchema = z.object({
  configVersion: z.number().int().min(0).optional(),
  defaultAgent: z.string().optional(),
  agents: z.record(z.string(), AgentConfigSchema),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  builtinToolsEnabled: z.record(z.string(), z.boolean()).optional(),
  profiles: z.array(ProfileSchema).optional(),
  defaultProfileId: z.string().nullable().optional(),
  fastProfileId: z.string().nullable().optional(),
  providers: z.record(z.string(), ProviderSchema).optional(),
  backgroundOpacity: z.number().min(0).max(1).optional(),
  zoomFactor: z.number().min(0.5).max(3).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  primaryColor: PrimaryColorSchema.optional(),
  lastWorkspace: z.string().nullable().optional(),
  recentFolders: z.array(RecentFolderSchema).optional(),
  authToken: z.string().optional(),
  refreshToken: z.string().optional(),
  maxSteps: z.number().min(1).max(10000).optional(), // Reasonable upper bound to prevent runaway agents
  maxSubagentDepth: z.number().min(1).max(20).optional(),
  autoContinuationLimit: z.number().int().min(0).max(100).optional(),
  customInstructions: z.string().max(12000).optional(),
  globalDisabledTools: z.array(z.string()).optional(),
  codexNetworkAccess: z.boolean().optional(),
  codexApprovalPolicy: z.enum(['never', 'on-failure', 'on-request', 'untrusted']).optional(),
  codexSandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  codexReadAccessMode: z.enum(['workspace-only', 'full-system']).optional(),
  codexMacosTempAccess: z.boolean().optional(),
  codexMacosScreenshotAccess: z.boolean().optional(),
  browserAccessPolicy: BrowserAccessPolicySchema.optional(),
  cuaAccessPolicy: CuaAccessPolicySchema.optional(),
  interpreterOverlay: InterpreterOverlaySettingsSchema.optional(),
  showHelpPanelPreview: z.boolean().optional(),
  reviewMarkdownEdits: z.boolean().optional(),
  launchAtLogin: z.boolean().optional(),
  autoApproveLowRiskMediaCards: z.boolean().optional(),
  whatsNewDismissed: z.boolean().optional(), // Whether the "What's new" video has been dismissed
  dismissedTopNoticeVersions: z.record(z.string(), z.string()).optional(),
  lastDismissedReleaseNotesVersion: z.union([z.number(), z.string()]).optional(),
  lastDismissedInterviewInviteVersion: z.string().optional(),
  dismissedAutomaticProfileIds: z.array(z.string()).optional(),
  appLaunchCount: z.number().int().min(0).optional(),
  lastMigrationVersion: z.number().int().min(0).optional(),
  lastMigrationBackupPath: z.string().optional(),
  lastMigrationUnsupportedProfiles: z.array(z.object({
    profileId: z.string(),
    profileName: z.string(),
    field: z.enum(['modelId', 'fastModel', 'visionModel']),
    previousModelId: z.string(),
  })).optional(),
  lastMigrationDeprecatedProfiles: z.array(z.object({
    profileId: z.string(),
    profileName: z.string(),
    provider: z.string(),
    reason: z.string(),
  })).optional(),
  userName: z.string().nullable().optional(), // User's display name (set during onboarding)
  telemetryEnabled: z.boolean().optional(),
  onboardingState: OnboardingStateSchema.optional(),
  claudeCodePath: z.string().optional(), // Custom path to Claude Code CLI binary
  codexPath: z.string().optional(), // Custom path to Codex CLI binary
  allowAgentAddTools: z.boolean().optional(),
  allowLocalMcpServers: z.boolean().optional(),
  skillFolders: z.array(z.string()).optional(), // Custom skill folder paths
  allowModelSkillEditing: z.boolean().optional(), // Allow model to write to skills folder
  language: z.string().optional(), // User's preferred UI language
}).passthrough(); // Allow additional fields for flexibility

/**
 * Validate an AppConfig object
 * Returns { success: true, data } or { success: false, error: string }
 */
export function validateConfig(config: unknown): { success: true; data: z.infer<typeof AppConfigSchema> } | { success: false; error: string } {
  const result = AppConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  // Format Zod errors nicely
  const errors = result.error.issues.map(issue => {
    const path = issue.path.join('.');
    return `${path}: ${issue.message}`;
  });
  return { success: false, error: errors.join('\n') };
}

export function validateSettingsSnapshot(config: unknown): { success: true; data: z.infer<typeof SettingsSnapshotSchema> } | { success: false; error: string } {
  const result = SettingsSnapshotSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.issues.map(issue => {
    const path = issue.path.join('.');
    return `${path}: ${issue.message}`;
  });
  return { success: false, error: errors.join('\n') };
}
