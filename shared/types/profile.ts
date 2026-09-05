/**
 * Profile types for agent model configuration presets
 *
 * Profiles allow users to save and reuse model configurations.
 * Profiles are fully user-defined and can be created, edited, and deleted by users.
 */

import type { ModelProvider, TerminalConfig, AgentModelConfig, ModelConfig, ApiFormat, WireApi } from './model';
import type { ReasoningEffort } from './reasoning';
import { isDeepSeekApiBaseURL } from './provider';
/**
 * A saved model configuration profile
 *
 * Profiles are the central configuration unit containing:
  * - Provider reference (providerId) OR inline config (provider, apiKey, baseURL)
  * - Model settings (modelId)
 *
 * New profiles should use `providerId` to reference a Provider from the Providers section.
 * Legacy profiles may still have inline `provider`, `apiKey`, `baseURL` fields for backwards compatibility.
 */
export interface Profile {
  id: string;
  name: string;
  modelId: string;
  isBuiltin: boolean; // reserved for special locked profiles

  // NEW: Reference to a Provider by ID (preferred)
  // When set, provider settings are looked up from the Provider
  providerId?: string;

  // Inline provider configuration
  provider: ModelProvider;
  apiKey?: string;
  /** OIX-reported environment variable used by this provider at runtime. */
  environmentKey?: string;
  baseURL?: string;
  apiFormat?: ApiFormat; // API format for 'api' providers
  codexProfileId?: string; // Explicit codex runtime profile ID (e.g. 'ollama', 'lmstudio')
  /**
   * OIX agent harness override. Undefined means automatic/recommended; null
   * explicitly selects the native Codex harness.
   */
  harness?: string | null;
  wireApi?: WireApi; // OIX wire protocol. Defaults to Responses when omitted.
  // Provider-specific config (only one is set, determined by `provider` field)
  providerConfig?: TerminalConfig;
  // Legacy persisted state. Runtime routing uses wireApi/wire_api instead.
  useResponsesApi?: boolean;
  reasoningEffort?: ReasoningEffort;

  // Help description shown in help panel when hovering over profile
  helpDescription?: string;

  // Mark profiles to hide behind "show advanced" toggle
  // Basic profiles are isAdvanced: false (or undefined)
  // More complex setups are isAdvanced: true
  isAdvanced?: boolean;

  // Mark profiles as experimental (shown with badge in UI)
  // All non-default profiles should be marked isExperimental: true
  isExperimental?: boolean;

  // Vision model settings
  /** Optional separate model for vision tasks (read_image tool). Uses main model if not set. */
  visionModel?: ModelConfig;

  // Fast model settings
  /** Optional faster/cheaper model for subagents. When set, subagent tools default to this model.
   *  The main model (provider + modelId) acts as the "smart" model that subagents can escalate to. */
  fastModel?: ModelConfig;
}

/**
 * Default maximum subagent nesting depth
 */
export const DEFAULT_MAX_STEPS = 1000;
export const DEFAULT_MAX_SUBAGENT_DEPTH = 5;

/**
 * Type guard for terminal profiles
 * Returns true if profile is for a terminal-based agent (runs in PTY)
 */
export function isTerminalProfile(profile: Profile): profile is Profile & { provider: 'terminal'; providerConfig: TerminalConfig } {
  return profile.provider === 'terminal' && profile.providerConfig !== undefined;
}

/**
 * Get terminal agent ID from a terminal profile
 * Returns null if profile is not a terminal profile
 */
export function getTerminalAgentFromProfile(profile: Profile): string | null {
  if (!isTerminalProfile(profile)) return null;
  return profile.providerConfig.id;
}

/**
 * Helper to get terminal config from a profile
 * Returns the providerConfig cast as TerminalConfig, or undefined
 */
export function getTerminalConfig(profile: Profile): TerminalConfig | undefined {
  if (profile.provider === 'terminal' && profile.providerConfig) {
    return profile.providerConfig as TerminalConfig;
  }
  return undefined;
}

/**
 * Check if a profile uses providerId (new system) vs inline config (legacy)
 */
export function profileUsesProviderId(profile: Profile): boolean {
  return !!profile.providerId;
}

/**
 * Legacy builtin profile IDs.
 * Kept for compatibility with older references in UI/tests.
 */
export const BUILTIN_PROFILE_IDS = {
  SMART: 'builtin:smart',
  FAST: 'builtin:fast',
} as const;

/**
 * No built-in profiles are preloaded.
 * Onboarding creates explicit profiles in config after provider authentication.
 */
export const BUILTIN_PROFILES: Profile[] = [];

const BUILTIN_PROFILE_ID_SET = new Set<string>(BUILTIN_PROFILES.map(p => p.id));

/**
 * Get the default values for a built-in profile (for reset functionality)
 */
export function getBuiltinProfileDefaults(profileId: string): Profile | undefined {
  return BUILTIN_PROFILES.find(p => p.id === profileId);
}

/**
 * Default profile ID for new agents.
 * Null means onboarding has not selected one yet.
 */
export const DEFAULT_PROFILE_ID: string | null = null;

/**
 * Convert a Profile to an AgentModelConfig.
 * This is the SINGLE place where profile fields are mapped to modelConfig fields.
 * All code that needs a modelConfig from a profile MUST use this function.
 *
 * Note: permissions, disabledTools, maxSteps, maxSubagentDepth are now global settings,
 * not per-profile. They are applied separately when creating agents.
 */
const CLEARABLE_PROVIDER_FIELDS: Partial<Profile> = {
  codexProfileId: undefined,
  harness: undefined,
  apiKey: undefined,
  environmentKey: undefined,
  baseURL: undefined,
  apiFormat: undefined,
  wireApi: undefined,
  providerId: undefined,
  providerConfig: undefined,
  reasoningEffort: undefined,
};

export function buildProviderChange(overrides: Partial<Profile>): Partial<Profile> {
  return { ...CLEARABLE_PROVIDER_FIELDS, ...overrides };
}

export function profileToModelConfig(
  profile: Profile,
  options?: { reasoningEffort?: ReasoningEffort },
): AgentModelConfig {
  const isDeepSeekApiProfile = profile.provider === 'api'
    && (profile.codexProfileId === 'deepseek' || isDeepSeekApiBaseURL(profile.baseURL));

  return {
    profileId: profile.id,
    providerId: profile.providerId,
    provider: profile.provider,
    modelId: profile.modelId,
    apiKey: profile.apiKey,
    ...(profile.environmentKey ? { environmentKey: profile.environmentKey } : {}),
    baseURL: profile.baseURL,
    apiFormat: profile.apiFormat,
    codexProfileId: profile.codexProfileId,
    harness: profile.harness,
    wireApi: profile.provider === 'api'
      ? (isDeepSeekApiProfile ? 'chat' : profile.wireApi ?? 'responses')
      : profile.provider === 'local'
        // Local profiles carry their own wireApi override; absence means the
        // preset default (Ollama chat, LM Studio chat) is applied downstream.
        ? profile.wireApi
        : 'responses',
    providerConfig: profile.providerConfig,
    useResponsesApi: isDeepSeekApiProfile ? false : profile.useResponsesApi ?? true,
    reasoningEffort: options?.reasoningEffort,
    visionModel: profile.visionModel,
    fastModel: profile.fastModel,
  };
}

/**
 * Default model configuration for new agents
 * Used only as a last-resort fallback while profile data is loading.
 */
export function getDefaultModelConfig(): AgentModelConfig {
  return {
    provider: 'hosted',
    modelId: 'interpreter-smart',
  };
}

/**
 * Get all profiles (no implicit builtins)
 */
export function mergeProfiles(customProfiles: Profile[]): Profile[] {
  return [...customProfiles];
}

/**
 * Check if a profile is built-in
 */
export function isBuiltinProfile(profileId: string): boolean {
  return BUILTIN_PROFILE_ID_SET.has(profileId);
}

/**
 * Find a profile by ID from a list
 */
export function findProfile(profiles: Profile[], profileId: string): Profile | undefined {
  return profiles.find(p => p.id === profileId);
}

/**
 * Compare a modelConfig against a profile to check if they match exactly.
 * Returns true if the modelConfig settings match the profile.
 *
 * Note: permissions and disabledTools are now global settings, not compared here.
 */
export function modelConfigMatchesProfile(
  modelConfig: {
    provider: ModelProvider;
    modelId: string;
    apiKey?: string;
    baseURL?: string;
    providerConfig?: TerminalConfig;
  },
  profile: Profile
): boolean {
  // Provider and modelId must match
  if (modelConfig.provider !== profile.provider) return false;
  if (modelConfig.modelId !== profile.modelId) return false;

  // API key and baseURL (normalize undefined vs missing)
  if ((modelConfig.apiKey || '') !== (profile.apiKey || '')) return false;
  if ((modelConfig.baseURL || '') !== (profile.baseURL || '')) return false;

  // providerConfig comparison (deep compare via JSON)
  const configPC = JSON.stringify(modelConfig.providerConfig || null);
  const profilePC = JSON.stringify(profile.providerConfig || null);
  if (configPC !== profilePC) return false;

  return true;
}

/**
 * Find a profile that matches the given modelConfig.
 *
 * Resolution order:
 * 1. profileId exact match (fast path)
 * 2. Field-by-field comparison (provider + modelId + apiKey + baseURL + providerConfig)
 * 3. First profile with the same provider (handles stale modelIds after config migrations)
 *
 * Returns undefined only when no profile shares the same provider.
 */
export function findMatchingProfile(
  profiles: Profile[],
  modelConfig: {
    profileId?: string;
    provider: ModelProvider;
    modelId: string;
    apiKey?: string;
    baseURL?: string;
    providerConfig?: TerminalConfig;
  }
): Profile | undefined {
  // Fast path: if profileId is set, look it up directly
  if (modelConfig.profileId) {
    const profileById = profiles.find(p => p.id === modelConfig.profileId);
    if (profileById) return profileById;
  }

  // Fallback: field-by-field comparison for configs without profileId
  const exactMatch = profiles.find(p => modelConfigMatchesProfile(modelConfig, p));
  if (exactMatch) return exactMatch;

  // Last resort: match by provider alone (stale modelId from persisted layout or migration)
  return profiles.find(p => p.provider === modelConfig.provider);
}

/**
 * Profile setup status - reports readiness of each profile
 */
export interface ProfileSetupStatus {
  profileId: string;
  ready: boolean;       // Can be used right now?
  detail: string;       // "Installed & logged in", "Not running", etc.
  badge?: string;       // Short: "Ready", "Installed", "Running"
}

/**
 * Storage format for profiles in ~/.openinterpreter/config.toml
 * We store all profiles explicitly.
 */
export interface ProfilesConfig {
  profiles: Profile[];
  defaultProfileId: string | null;
  fastProfileId: string | null;
}

/**
 * Default profiles config for new users
 * New users start with zero profiles and no default selection.
 */
export function getDefaultProfilesConfig(): ProfilesConfig {
  return {
    profiles: [],
    defaultProfileId: DEFAULT_PROFILE_ID,
    fastProfileId: null,
  };
}
