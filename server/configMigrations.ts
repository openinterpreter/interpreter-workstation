import type { AppConfig } from './configStore';
import { isValidHostedModelId as isKnownHostedModelId } from '../shared/utils/modelIdValidation';
import { inferProfileIdFromEndpoint } from '../src/lib/codex/profile-options';

// NOTE(victor): these provider types were removed from the ProviderType union
// but can still exist in persisted configs from before v9.
const REMOVED_PROVIDER_TYPES = new Set(['acp', 'claude-oauth']);

const STALE_OPENAI_MODEL_MAP: Record<string, string> = {
  'gpt-5-mini': 'gpt-5.1-codex-mini',
  'GPT-5.3-Codex': 'gpt-5.3-codex',
};

const HOSTED_MODEL_REPAIR_MAP: Record<string, string> = {
  // OpenRouter-style IDs introduced by the broken network/model chain.
  'anthropic/claude-sonnet-4.6': 'claude-sonnet-4-5-20250929',
  'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'anthropic/claude-opus-4.6': 'claude-opus-4-6',
  'anthropic/claude-haiku-4.5': 'claude-haiku-4-5',
  'anthropic/claude-sonnet-4': 'claude-sonnet-4',
  'openai/gpt-4o': 'gpt-4o',
  'openai/gpt-4o-mini': 'gpt-4o-mini',
  // GPT defaults that should roll back to the main hosted default.
  'gpt-5.2': 'claude-sonnet-4-5-20250929',
  'gpt-5.1': 'claude-sonnet-4-5-20250929',
  'gpt-5': 'claude-sonnet-4-5-20250929',
  'gpt-5-mini': 'claude-sonnet-4-5-20250929',
  'gpt-5.2-codex': 'claude-sonnet-4-5-20250929',
  'gpt-5.1-codex': 'claude-sonnet-4-5-20250929',
  'gpt-5.1-codex-mini': 'claude-sonnet-4-5-20250929',
  'gpt-5-codex': 'claude-sonnet-4-5-20250929',
  'gpt-5-codex-mini': 'claude-sonnet-4-5-20250929',
  'openai/gpt-5.2': 'claude-sonnet-4-5-20250929',
  'openai/gpt-5.1': 'claude-sonnet-4-5-20250929',
  'openai/gpt-5': 'claude-sonnet-4-5-20250929',
  'openai/gpt-5-mini': 'claude-sonnet-4-5-20250929',
  'openai/gpt-5.1-codex': 'claude-sonnet-4-5-20250929',
  'openai/gpt-5.1-codex-mini': 'claude-sonnet-4-5-20250929',

  // Normalize legacy aliases to current main IDs.
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6': 'claude-sonnet-4-5-20250929',
  'claude-opus-4': 'claude-opus-4-6',
  'claude-opus-4-5': 'claude-opus-4-6',
};

const NON_HOSTED_ANTHROPIC_SUBMODEL_REPAIR_MAP: Record<string, string> = {
  'gpt-5.2': 'claude-sonnet-4-5-20250929',
  'openai/gpt-5.2': 'claude-sonnet-4-5-20250929',
  'gpt-5.2-codex': 'claude-sonnet-4-5-20250929',
  'gpt-5.1': 'claude-sonnet-4',
  'openai/gpt-5.1': 'claude-sonnet-4',
  'gpt-5-mini': 'claude-haiku-4-5',
  'openai/gpt-5-mini': 'claude-haiku-4-5',
  'gpt-5.1-codex-mini': 'claude-haiku-4-5',
  'openai/gpt-5.1-codex-mini': 'claude-haiku-4-5',
};

export const OPENROUTER_MODEL_REGEX = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(:[a-z]+)?$/;

export function isValidHostedModelId(modelId: string): boolean {
  return isKnownHostedModelId(modelId);
}

const DEFAULT_HOSTED_MAIN = 'interpreter-smart';
const DEFAULT_HOSTED_FAST = 'interpreter-fast';
const DEFAULT_HOSTED_VISION = 'interpreter-smart';

function getHostedAliasName(modelId: string): string | null {
  if (modelId === DEFAULT_HOSTED_MAIN) {
    return 'Interpreter Smart';
  }
  if (modelId === DEFAULT_HOSTED_FAST) {
    return 'Interpreter Fast';
  }
  return null;
}

function applyStaleOpenAIRepair(modelId: string): string {
  return STALE_OPENAI_MODEL_MAP[modelId] || modelId;
}

function applyHostedRepair(modelId: string, fallbackModelId: string): string {
  const repairedModelId = HOSTED_MODEL_REPAIR_MAP[modelId] || modelId;
  if (isValidHostedModelId(repairedModelId)) {
    return repairedModelId;
  }
  return fallbackModelId;
}

function applyAnthropicApiSubmodelRepair(modelId: string): string {
  return NON_HOSTED_ANTHROPIC_SUBMODEL_REPAIR_MAP[modelId] || modelId;
}

export const CURRENT_CONFIG_VERSION = 11;

export function migrateConfig(config: AppConfig): boolean {
  const fromVersion = config.configVersion ?? 0;
  if (fromVersion >= CURRENT_CONFIG_VERSION) return false;

  const unsupportedHostedProfiles: NonNullable<AppConfig['lastMigrationUnsupportedProfiles']> = [];

  // v0 -> v1: Fix stale OpenAI model IDs from initial onboarding defaults
  if (fromVersion < 1) {
    for (const profile of config.profiles ?? []) {
      profile.modelId = applyStaleOpenAIRepair(profile.modelId);
      if (profile.fastModel?.modelId) {
        profile.fastModel.modelId = applyStaleOpenAIRepair(profile.fastModel.modelId);
      }
      if (profile.visionModel?.modelId) {
        profile.visionModel.modelId = applyStaleOpenAIRepair(profile.visionModel.modelId);
      }
    }
  }

  // v1 -> v7: Roll back broken hosted model migrations to main-compatible IDs/defaults.
  if (fromVersion < 7) {
    for (const profile of config.profiles ?? []) {
      if (profile.provider === 'hosted') {
        const repairedModelId = applyHostedRepair(profile.modelId, DEFAULT_HOSTED_MAIN);
        if (repairedModelId !== profile.modelId) {
          profile.modelId = repairedModelId;
          profile.name = getHostedAliasName(repairedModelId) ?? profile.name;
        }

        if (profile.fastModel?.provider === 'hosted' && profile.fastModel.modelId) {
          profile.fastModel.modelId = applyHostedRepair(profile.fastModel.modelId, DEFAULT_HOSTED_FAST);
        }

        if (profile.visionModel?.provider === 'hosted' && profile.visionModel.modelId) {
          profile.visionModel.modelId = applyHostedRepair(profile.visionModel.modelId, DEFAULT_HOSTED_VISION);
        }
      }

      if (
        profile.fastModel?.provider === 'api'
        && profile.fastModel.apiFormat === 'anthropic'
        && profile.fastModel.modelId
      ) {
        profile.fastModel.modelId = applyAnthropicApiSubmodelRepair(profile.fastModel.modelId);
      }

      if (
        profile.visionModel?.provider === 'api'
        && profile.visionModel.apiFormat === 'anthropic'
        && profile.visionModel.modelId
      ) {
        profile.visionModel.modelId = applyAnthropicApiSubmodelRepair(profile.visionModel.modelId);
      }
    }
  }

  // v7 -> v8: retained for version continuity.
  // Local model tool support is resolved live from the provider now.
  if (fromVersion < 8) {
    // no-op
  }

  // v8 -> v9: Deprecate individual hosted model IDs in favor of interpreter-smart / interpreter-fast.
  // Also backfill missing baseURL and codexProfileId on local onboarding profiles,
  // remove deprecated provider types (ACP, Claude OAuth), flag Anthropic API format,
  // and migrate known API presets to Responses API.
  if (fromVersion < 9) {
    const deprecatedProfiles: NonNullable<AppConfig['lastMigrationDeprecatedProfiles']> = [];

    for (const profile of config.profiles ?? []) {
      if (profile.provider === 'hosted') {
        if (!isValidHostedModelId(profile.modelId)) {
          unsupportedHostedProfiles.push({
            profileId: profile.id,
            profileName: profile.name,
            field: 'modelId',
            previousModelId: profile.modelId,
          });
          // NOTE(victor): convention-based heuristic -- "fast" in profile.id
          // covers auto:hosted-fast, onboarding:interpreter-fast, builtin:fast.
          profile.modelId = profile.id.includes('fast') ? DEFAULT_HOSTED_FAST : DEFAULT_HOSTED_MAIN;
        }

        if (profile.fastModel?.provider === 'hosted' && !isValidHostedModelId(profile.fastModel.modelId)) {
          unsupportedHostedProfiles.push({
            profileId: profile.id,
            profileName: profile.name,
            field: 'fastModel',
            previousModelId: profile.fastModel.modelId,
          });
          profile.fastModel.modelId = DEFAULT_HOSTED_FAST;
        }

        if (profile.visionModel?.provider === 'hosted' && !isValidHostedModelId(profile.visionModel.modelId)) {
          unsupportedHostedProfiles.push({
            profileId: profile.id,
            profileName: profile.name,
            field: 'visionModel',
            previousModelId: profile.visionModel.modelId,
          });
          profile.visionModel.modelId = DEFAULT_HOSTED_VISION;
        }
      }

      if (profile.provider === 'local') {
        if (!profile.baseURL) {
          profile.baseURL = profile.id?.startsWith('onboarding:lmstudio-')
            ? 'http://localhost:1234/v1'
            : 'http://localhost:11434/v1';
        }

        if (!profile.codexProfileId) {
          profile.codexProfileId = profile.id?.startsWith('onboarding:lmstudio-')
            ? 'lmstudio'
            : 'ollama';
        }
      }

      // Flag Anthropic API format as deprecated (removed below with ACP/claude-oauth)
      if (profile.provider === 'api' && profile.apiFormat === 'anthropic') {
        deprecatedProfiles.push({
          profileId: profile.id,
          profileName: profile.name,
          provider: 'api',
          reason: 'Anthropic API format is no longer supported; all inference routes through Codex as OpenAI-compatible',
        });
      }

      // Legacy marker retained for existing configs. Runtime routing now uses
      // wireApi/wire_api, and absence of wireApi still means Responses.
      if (profile.provider === 'api' && profile.apiFormat !== 'anthropic') {
        // Legacy conditional gating kept for reference:
        // const providerConfig = profile.providerId ? config.providers?.[profile.providerId] : undefined;
        // const preset = providerConfig?.api?.preset;
        // if (preset && RESPONSES_API_PRESETS.has(preset)) {
        //   profile.useResponsesApi = true;
        // } else if (!preset && profile.baseURL && isKnownResponsesApiBaseURL(profile.baseURL)) {
        //   profile.useResponsesApi = true;
        // }
        profile.useResponsesApi = true;
      }

      // Record deprecated provider types (removed below)
      if (REMOVED_PROVIDER_TYPES.has(profile.provider as string)) {
        deprecatedProfiles.push({
          profileId: profile.id,
          profileName: profile.name,
          provider: profile.provider as string,
          reason: `${profile.provider} provider type is no longer supported`,
        });
      }
    }

    // Remove deprecated provider types and Anthropic API format profiles
    const beforeRemoval = config.profiles?.length ?? 0;
    if (config.profiles) {
      config.profiles = config.profiles.filter(
        (p) =>
          !REMOVED_PROVIDER_TYPES.has(p.provider as string)
          && !(p.provider === 'api' && p.apiFormat === 'anthropic'),
      );
    }
    if (
      beforeRemoval !== (config.profiles?.length ?? 0)
      && config.defaultProfileId
      && !config.profiles?.some((p) => p.id === config.defaultProfileId)
    ) {
      config.defaultProfileId = config.profiles?.[0]?.id ?? undefined;
    }

    // Clean up stale provider entries for removed provider types
    if (config.providers) {
      for (const [key, prov] of Object.entries(config.providers)) {
        if (REMOVED_PROVIDER_TYPES.has(prov.type)) {
          delete config.providers[key];
        }
      }
    }

    config.lastMigrationDeprecatedProfiles = deprecatedProfiles;
  }

  // v9 -> v10: Normalize legacy OpenAI model IDs that were persisted with stale casing.
  if (fromVersion < 10) {
    for (const profile of config.profiles ?? []) {
      profile.modelId = applyStaleOpenAIRepair(profile.modelId);

      if (profile.fastModel?.modelId) {
        profile.fastModel.modelId = applyStaleOpenAIRepair(profile.fastModel.modelId);
      }

      if (profile.visionModel?.modelId) {
        profile.visionModel.modelId = applyStaleOpenAIRepair(profile.visionModel.modelId);
      }
    }
  }

  // v10 -> v11: Canonicalize Responses API profiles to explicit Codex runtime preset IDs.
  if (fromVersion < 11) {
    for (const profile of config.profiles ?? []) {
      if (profile.provider !== 'api') {
        continue;
      }

      const endpoint = profile.baseURL?.trim();
      if (!endpoint) {
        continue;
      }

      if (profile.codexProfileId && profile.codexProfileId !== 'custom') {
        continue;
      }

      profile.codexProfileId = inferProfileIdFromEndpoint(endpoint);
    }
  }

  config.lastMigrationVersion = CURRENT_CONFIG_VERSION;
  config.lastMigrationUnsupportedProfiles = unsupportedHostedProfiles;

  config.configVersion = CURRENT_CONFIG_VERSION;
  return true;
}
