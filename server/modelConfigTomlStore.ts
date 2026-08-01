import type { JsonValue } from './handlers/codex-generated-types/serde_json/JsonValue';
import { isDeepStrictEqual } from 'node:util';
import type { Profile } from '../shared/types/profile';
import type { ModelConfig, TerminalConfig } from '../shared/types/model';
import { MODEL_OPTIONS } from '../shared/types/model';
import {
  getDefaultApiProviderModelId,
  getHostedOnboardingFastProfileId,
  getOnboardingModelPack,
  LOCAL_MODEL_DEFAULTS,
} from '../shared/types/modelDefaults';
import {
  BUILTIN_PROVIDERS,
  BUILTIN_PROVIDER_IDS,
  getApiEndpointKind,
  getApiEnvKeyTypeForBaseURL,
  getBuiltinProviderDefaults,
  isDeepSeekApiBaseURL,
  type Provider,
} from '../shared/types/provider';
import { isBuiltinProfile } from '../shared/types/profile';
import { isValidHostedModelId } from '../shared/utils/modelIdValidation';
import { inferProfileIdFromEndpoint } from '../src/lib/codex/profile-options';
import { getCodexClient } from './utils/codexServiceBridge';

const MODEL_CONFIG_SECTION_KEY = 'interpreter_app';
const MODEL_CONFIG_STORAGE_VERSION = 1;
const REMOVED_PROVIDER_TYPES = new Set(['acp', 'claude-oauth']);
let inMemoryModelConfigState: ModelConfigState | null = null;

export type ModelConfigState = {
  profiles: Profile[];
  providers: Record<string, Provider>;
  defaultProfileId: string | null;
  fastProfileId: string | null;
};

export interface LoadedModelConfigState {
  state: ModelConfigState;
  issues: string[];
  filePath: string | null;
  authCredentialsMissing: boolean;
}

const DEFAULT_OPENAI_API_MODEL = getDefaultApiProviderModelId('openai', MODEL_OPTIONS.openai);
const DEFAULT_GROQ_API_MODEL = getDefaultApiProviderModelId('groq', MODEL_OPTIONS.groq);
const DEFAULT_OPENROUTER_API_MODEL = getDefaultApiProviderModelId('openrouter', MODEL_OPTIONS.openrouter);

function createBuiltinProviderRecord(): Record<string, Provider> {
  return Object.fromEntries(BUILTIN_PROVIDERS.map((provider) => [provider.id, { ...provider }])) as Record<string, Provider>;
}

export function createDefaultModelConfigState(): ModelConfigState {
  return {
    profiles: [],
    providers: createBuiltinProviderRecord(),
    defaultProfileId: null,
    fastProfileId: null,
  };
}

export function createHostedFallbackModelConfigState(): ModelConfigState {
  const hostedPack = getOnboardingModelPack('hosted');
  return {
    profiles: hostedPack.profiles.map((profile) => ({
      ...profile,
      isBuiltin: false,
    })),
    providers: createBuiltinProviderRecord(),
    defaultProfileId: hostedPack.defaultProfileId,
    fastProfileId: getHostedOnboardingFastProfileId(hostedPack),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProfileRecord(value: unknown): value is Profile {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.modelId === 'string'
    && typeof value.provider === 'string'
    && typeof value.isBuiltin === 'boolean';
}

function isProviderRecord(value: unknown): value is Provider {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.type === 'string'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number';
}

function cloneModelConfigState(state: ModelConfigState): ModelConfigState {
  const providers = {} as Record<string, Provider>;
  for (const [id, provider] of Object.entries(state.providers)) {
    providers[id] = (provider && typeof provider === 'object'
      ? { ...provider }
      : provider) as Provider;
  }

  return {
    profiles: state.profiles.map((profile) => ({ ...profile })),
    providers,
    defaultProfileId: state.defaultProfileId,
    fastProfileId: state.fastProfileId,
  };
}

function createUsableInMemoryModelConfigState(state: ModelConfigState): ModelConfigState {
  const nextState = cloneModelConfigState(state);
  repairModelConfigState(nextState);

  if (nextState.profiles.length === 0) {
    return createHostedFallbackModelConfigState();
  }

  const profileIds = new Set(nextState.profiles.map((profile) => profile.id));
  if (!nextState.defaultProfileId || !profileIds.has(nextState.defaultProfileId)) {
    nextState.defaultProfileId = nextState.profiles[0]?.id ?? null;
  }

  if (!nextState.fastProfileId || !profileIds.has(nextState.fastProfileId)) {
    nextState.fastProfileId = nextState.profiles.find(
      (profile) => profile.id !== nextState.defaultProfileId,
    )?.id ?? nextState.defaultProfileId;
  }

  return nextState;
}

function setInMemoryModelConfigState(state: ModelConfigState | null): void {
  inMemoryModelConfigState = state ? createUsableInMemoryModelConfigState(state) : null;
}

export function clearInMemoryModelConfigState(): void {
  inMemoryModelConfigState = null;
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeHttpUrl(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]') {
    return true;
  }

  const parts = hostname.split('.');
  if (parts.length !== 4) {
    return false;
  }

  return Number(parts[0]) === 127 && parts.every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function detectLocalRuntime(baseURL: string | undefined): 'ollama' | 'lmstudio' | null {
  if (!baseURL) {
    return null;
  }

  try {
    const url = new URL(baseURL);
    if (!isLoopbackHost(url.hostname.toLowerCase().replace(/\.$/, ''))) {
      return null;
    }
    if (url.port === '1234') {
      return 'lmstudio';
    }
    if (url.port === '11434') {
      return 'ollama';
    }
  } catch {
    return null;
  }

  return null;
}

/*
 * NOTE(victor): Legacy local profiles from older config writes can store the
 * Ollama/LM Studio server root (`http://localhost:11434` or
 * `http://localhost:1234`) instead of the OpenAI-compatible `/v1` API root.
 * The runtime later appends `/responses`, so leaving those roots unchanged
 * produces `/responses` requests and 404s. Treat only empty/root paths as
 * repairable legacy values; custom paths are preserved as explicit user input.
 */
function normalizeLocalRuntimeBaseURL(baseURL: string | undefined): string | undefined {
  if (!baseURL) {
    return undefined;
  }

  try {
    const url = new URL(baseURL);
    if (url.pathname === '' || url.pathname === '/') {
      url.pathname = '/v1';
      return url.toString();
    }
  } catch {
    return baseURL;
  }

  return baseURL;
}

function repairApiModelId(modelId: string | undefined, baseURL: string): string | null {
  const trimmedModelId = trimToUndefined(modelId);
  // OIX is the model-catalog authority. Preserve every non-empty model id it
  // returns, including ids newer than Workstation's generated fallback catalog.
  if (trimmedModelId) {
    return trimmedModelId;
  }
  const endpointKind = getApiEndpointKind(baseURL);

  if (endpointKind === 'openai') {
    return DEFAULT_OPENAI_API_MODEL;
  }

  if (endpointKind === 'groq') {
    return DEFAULT_GROQ_API_MODEL;
  }

  if (endpointKind === 'openrouter') {
    return DEFAULT_OPENROUTER_API_MODEL;
  }

  if (endpointKind === 'deepseek') {
    return MODEL_OPTIONS.deepseek[0]?.id ?? null;
  }

  return null;
}

function isApiModelValid(modelId: string | undefined, baseURL: string): boolean {
  const trimmedModelId = trimToUndefined(modelId);
  if (!trimmedModelId) {
    return false;
  }
  return repairApiModelId(trimmedModelId, baseURL) === trimmedModelId;
}

function getRecoveryEnvironmentKey(baseURL: string | undefined): string | undefined {
  const key = (() => {
    switch (getApiEnvKeyTypeForBaseURL(baseURL)) {
      case 'openai':
        return 'OPENAI_API_KEY';
      case 'openrouter':
        return 'OPENROUTER_API_KEY';
      case 'groq':
        return 'GROQ_API_KEY';
      case 'deepseek':
        return 'DEEPSEEK_API_KEY';
      default:
        return undefined;
    }
  })();
  return key && trimToUndefined(process.env[key]) ? key : undefined;
}

function requiresApiKeyForRecovery(baseURL: string | undefined): boolean {
  return inferProfileIdFromEndpoint(baseURL ?? '') !== 'custom';
}

function isNestedModelValid(model: ModelConfig | undefined, providers: Record<string, Provider>): boolean {
  if (!model) {
    return true;
  }

  const referencedProvider = model.providerId ? providers[model.providerId] : undefined;
  const providerType = referencedProvider?.type ?? model.provider;

  switch (providerType) {
    case 'hosted': {
      const modelId = trimToUndefined(model.modelId);
      return Boolean(modelId && isValidHostedModelId(modelId));
    }
    case 'openai-oauth':
      return Boolean(trimToUndefined(model.modelId));
    case 'local': {
      const modelId = trimToUndefined(model.modelId);
      const baseURL = normalizeHttpUrl(model.baseURL ?? referencedProvider?.baseURL);
      if (!modelId || !baseURL) {
        return false;
      }

      return normalizeLocalRuntimeBaseURL(baseURL) === baseURL;
    }
    case 'api': {
      const baseURL = normalizeHttpUrl(model.baseURL ?? referencedProvider?.baseURL);
      const apiKey = trimToUndefined(model.apiKey ?? referencedProvider?.apiKey);
      const environmentKey = trimToUndefined(model.environmentKey);
      return Boolean(
        baseURL
        && isApiModelValid(model.modelId, baseURL)
        && (!requiresApiKeyForRecovery(baseURL) || apiKey || environmentKey)
      );
    }
    default:
      return false;
  }
}

function isProfileValid(profile: Profile, providers: Record<string, Provider>): boolean {
  const referencedProvider = profile.providerId ? providers[profile.providerId] : undefined;

  switch (profile.provider) {
    case 'hosted': {
      const modelId = trimToUndefined(profile.modelId);
      return Boolean(modelId && isValidHostedModelId(modelId));
    }
    case 'openai-oauth':
      return Boolean(trimToUndefined(profile.modelId));
    case 'local': {
      const modelId = trimToUndefined(profile.modelId);
      if (!modelId) {
        return false;
      }

      const baseURL = normalizeHttpUrl(profile.baseURL ?? referencedProvider?.baseURL);
      if (!baseURL) {
        return Boolean(profile.codexProfileId);
      }

      return normalizeLocalRuntimeBaseURL(baseURL) === baseURL;
    }
    case 'api': {
      const baseURL = normalizeHttpUrl(profile.baseURL ?? referencedProvider?.baseURL);
      const apiKey = trimToUndefined(profile.apiKey ?? referencedProvider?.apiKey);
      const environmentKey = trimToUndefined(profile.environmentKey);
      const hasValidDeepSeekRuntime = !isDeepSeekApiBaseURL(baseURL)
        || (profile.codexProfileId === 'deepseek' && profile.wireApi === 'chat' && profile.useResponsesApi === false);
      return Boolean(
        baseURL
        && isApiModelValid(profile.modelId, baseURL)
        && (!requiresApiKeyForRecovery(baseURL) || apiKey || environmentKey)
        && hasValidDeepSeekRuntime
      );
    }
    case 'agent':
      return profile.modelId === 'claude-code' || profile.modelId === 'codex';
    case 'terminal': {
      const terminalConfig = profile.providerConfig as TerminalConfig | undefined;
      return Boolean(trimToUndefined(terminalConfig?.command) && trimToUndefined(profile.modelId));
    }
    default:
      return false;
  }
}

function stripUndefinedDeep<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function repairNestedModel(
  model: ModelConfig | undefined,
  providers: Record<string, Provider>,
): ModelConfig | undefined {
  if (!model) {
    return undefined;
  }

  const referencedProvider = model.providerId ? providers[model.providerId] : undefined;
  const providerType = referencedProvider?.type ?? model.provider;

  switch (providerType) {
    case 'hosted': {
      const modelId = trimToUndefined(model.modelId);
      if (!modelId || !isValidHostedModelId(modelId)) {
        return undefined;
      }
      return {
        provider: 'hosted',
        providerId: BUILTIN_PROVIDER_IDS.HOSTED,
        modelId,
      };
    }
    case 'openai-oauth': {
      const modelId = trimToUndefined(model.modelId);
      if (!modelId) {
        return undefined;
      }
      return {
        provider: 'openai-oauth',
        providerId: BUILTIN_PROVIDER_IDS.OPENAI_OAUTH,
        modelId,
      };
    }
    case 'local': {
      const baseURL = normalizeLocalRuntimeBaseURL(
        normalizeHttpUrl(model.baseURL ?? referencedProvider?.baseURL),
      );
      const modelId = trimToUndefined(model.modelId);
      if (!baseURL || !modelId) {
        return undefined;
      }
      return {
        provider: 'local',
        providerId: BUILTIN_PROVIDER_IDS.LOCAL,
        modelId,
        baseURL,
        apiKey: trimToUndefined(model.apiKey ?? referencedProvider?.apiKey),
      };
    }
    case 'api': {
      const baseURL = normalizeHttpUrl(model.baseURL ?? referencedProvider?.baseURL);
      const apiKey = trimToUndefined(model.apiKey ?? referencedProvider?.apiKey);
      const environmentKey = trimToUndefined(model.environmentKey)
        ?? (!apiKey ? getRecoveryEnvironmentKey(baseURL) : undefined);
      if (!baseURL || (requiresApiKeyForRecovery(baseURL) && !apiKey && !environmentKey)) {
        return undefined;
      }

      const repairedModelId = repairApiModelId(model.modelId, baseURL);
      if (!repairedModelId) {
        return undefined;
      }

      return {
        provider: 'api',
        ...(referencedProvider ? { providerId: referencedProvider.id } : {}),
        modelId: repairedModelId,
        baseURL,
        apiKey,
        environmentKey,
        apiFormat: 'openai',
      };
    }
    default:
      return undefined;
  }
}

function repairTerminalProfile(profile: Profile, referencedProvider: Provider | undefined): Profile {
  const terminalId = profile.modelId?.trim() === 'codex' ? 'codex' : 'claude-code';
  const existingConfig = profile.providerConfig as TerminalConfig | undefined;
  const providerCommand = trimToUndefined(referencedProvider?.terminal?.command);
  const command = trimToUndefined(existingConfig?.command)
    ?? providerCommand
    ?? (terminalId === 'codex' ? 'codex' : 'claude');

  return {
    ...profile,
    provider: 'terminal',
    providerId: undefined,
    modelId: terminalId,
    apiKey: undefined,
    baseURL: undefined,
    apiFormat: undefined,
    codexProfileId: undefined,
    wireApi: undefined,
    useResponsesApi: undefined,
    providerConfig: {
      id: terminalId,
      command,
      icon: terminalId === 'codex' ? 'openai' : 'claude',
      richInput: existingConfig?.richInput ?? true,
      hideInput: existingConfig?.hideInput ?? true,
      inputMarker: trimToUndefined(existingConfig?.inputMarker),
      titleMarker: trimToUndefined(existingConfig?.titleMarker),
    },
  };
}

function repairProfile(profile: Profile, providers: Record<string, Provider>): Profile | null {
  const referencedProvider = profile.providerId ? providers[profile.providerId] : undefined;
  const providerType = referencedProvider?.type
    ?? ((profile.provider === 'hosted' && (trimToUndefined(profile.baseURL) || trimToUndefined(profile.apiKey)))
      ? 'api'
      : profile.provider);

  switch (providerType) {
    case 'hosted': {
      const modelId = trimToUndefined(profile.modelId);
      if (!modelId || !isValidHostedModelId(modelId)) {
        return null;
      }

      return {
        ...profile,
        provider: 'hosted',
        providerId: BUILTIN_PROVIDER_IDS.HOSTED,
        modelId,
        apiKey: undefined,
        baseURL: undefined,
        apiFormat: undefined,
        codexProfileId: undefined,
        providerConfig: undefined,
        wireApi: undefined,
        useResponsesApi: undefined,
      };
    }
    case 'openai-oauth': {
      const modelId = trimToUndefined(profile.modelId);
      if (!modelId) {
        return null;
      }
      return {
        ...profile,
        provider: 'openai-oauth',
        providerId: BUILTIN_PROVIDER_IDS.OPENAI_OAUTH,
        modelId,
        apiKey: undefined,
        baseURL: undefined,
        apiFormat: undefined,
        codexProfileId: undefined,
        providerConfig: undefined,
        wireApi: undefined,
        useResponsesApi: undefined,
      };
    }
    case 'local': {
      const candidateBaseURL = normalizeLocalRuntimeBaseURL(
        normalizeHttpUrl(profile.baseURL ?? referencedProvider?.baseURL),
      );
      const runtime = profile.codexProfileId === 'lmstudio' || detectLocalRuntime(candidateBaseURL) === 'lmstudio'
        ? 'lmstudio'
        : 'ollama';
      const baseURL = candidateBaseURL
        ?? (runtime === 'lmstudio' ? 'http://localhost:1234/v1' : 'http://localhost:11434/v1');

      return {
        ...profile,
        provider: 'local',
        providerId: BUILTIN_PROVIDER_IDS.LOCAL,
        modelId: trimToUndefined(profile.modelId) ?? LOCAL_MODEL_DEFAULTS[runtime],
        baseURL,
        apiKey: trimToUndefined(profile.apiKey ?? referencedProvider?.apiKey),
        apiFormat: undefined,
        codexProfileId: runtime,
        providerConfig: undefined,
        // Preserve an explicit local wireApi override; absence means the runtime
        // applies the preset default (Ollama chat, LM Studio chat).
        wireApi: profile.wireApi,
        useResponsesApi: profile.useResponsesApi,
      };
    }
    case 'api': {
      const baseURL = normalizeHttpUrl(profile.baseURL ?? referencedProvider?.baseURL);
      const apiKey = trimToUndefined(profile.apiKey ?? referencedProvider?.apiKey);
      const environmentKey = trimToUndefined(profile.environmentKey)
        ?? (!apiKey ? getRecoveryEnvironmentKey(baseURL) : undefined);
      if (!baseURL) {
        return null;
      }
      if (requiresApiKeyForRecovery(baseURL) && !apiKey && !environmentKey) {
        return null;
      }

      const repairedModelId = repairApiModelId(profile.modelId, baseURL);
      if (!repairedModelId) {
        return null;
      }

      const codexProfileId = inferProfileIdFromEndpoint(baseURL);

      return {
        ...profile,
        provider: 'api',
        ...(referencedProvider ? { providerId: referencedProvider.id } : { providerId: undefined }),
        modelId: repairedModelId,
        baseURL,
        apiKey,
        environmentKey,
        apiFormat: 'openai',
        codexProfileId,
        providerConfig: undefined,
        wireApi: profile.wireApi === 'chat' || codexProfileId === 'deepseek' ? 'chat' : 'responses',
        useResponsesApi: codexProfileId !== 'deepseek',
      };
    }
    case 'agent': {
      return {
        ...profile,
        provider: 'agent',
        providerId: BUILTIN_PROVIDER_IDS.AGENT,
        modelId: profile.modelId?.trim() === 'codex' ? 'codex' : 'claude-code',
        apiKey: undefined,
        baseURL: undefined,
        apiFormat: undefined,
        codexProfileId: undefined,
        providerConfig: undefined,
        wireApi: undefined,
        useResponsesApi: undefined,
      };
    }
    case 'terminal':
      return repairTerminalProfile(profile, referencedProvider);
    default:
      return null;
  }
}

export function hasLegacyModelConfigFields(config: {
  profiles?: Profile[];
  providers?: Record<string, Provider>;
  defaultProfileId?: string;
  fastProfileId?: string;
}): boolean {
  return config.profiles !== undefined
    || config.providers !== undefined
    || config.defaultProfileId !== undefined
    || config.fastProfileId !== undefined;
}

export function extractModelConfigState(config: {
  profiles?: Profile[];
  providers?: Record<string, Provider>;
  defaultProfileId?: string;
  fastProfileId?: string;
}): ModelConfigState {
  const providers = {} as Record<string, Provider>;
  for (const [id, provider] of Object.entries(config.providers ?? createBuiltinProviderRecord())) {
    providers[id] = (provider && typeof provider === 'object'
      ? { ...provider }
      : provider) as Provider;
  }

  return {
    profiles: (config.profiles ?? []).map((profile) => ({ ...profile })),
    providers,
    defaultProfileId: config.defaultProfileId ?? null,
    fastProfileId: config.fastProfileId ?? null,
  };
}

export function stripLegacyModelConfigFields<T extends {
  profiles?: Profile[];
  providers?: Record<string, Provider>;
  defaultProfileId?: string;
  fastProfileId?: string;
}>(config: T): T {
  const next = { ...config };
  delete next.profiles;
  delete next.providers;
  delete next.defaultProfileId;
  delete next.fastProfileId;
  return next;
}

export function mergeModelConfigState<T extends Record<string, unknown>>(
  config: T,
  state: ModelConfigState,
): T & {
  profiles: Profile[];
  providers: Record<string, Provider>;
  defaultProfileId?: string;
  fastProfileId?: string;
} {
  return {
    ...stripLegacyModelConfigFields(config),
    profiles: state.profiles,
    providers: state.providers,
    ...(state.defaultProfileId ? { defaultProfileId: state.defaultProfileId } : {}),
    ...(state.fastProfileId ? { fastProfileId: state.fastProfileId } : {}),
  };
}

export function repairModelConfigState(state: ModelConfigState, issues?: string[]): boolean {
  const addIssue = (message: string): void => {
    if (issues) {
      issues.push(message);
    }
  };

  let modified = false;

  if (!Array.isArray(state.profiles)) {
    state.profiles = [];
    modified = true;
    addIssue('Cleared a malformed profile list.');
  }

  if (!isRecord(state.providers)) {
    state.providers = {};
    modified = true;
    addIssue('Cleared a malformed provider store.');
  }

  for (let i = 0; i < state.profiles.length; i++) {
    const profile = state.profiles[i];
    const shouldBeBuiltin = isBuiltinProfile(profile.id);
    if (profile.isBuiltin !== shouldBeBuiltin) {
      state.profiles[i] = { ...profile, isBuiltin: shouldBeBuiltin };
      modified = true;
      addIssue(`Normalized the builtin flag for profile "${profile.name}".`);
    }
  }

  for (let i = 0; i < state.profiles.length; i++) {
    const profile = state.profiles[i];
    if (!isBuiltinProfile(profile.id)) {
      const { permissions, disabledTools, maxSteps, maxSubagentDepth, ...cleanProfile } = profile as Profile & Record<string, unknown>;
      if (
        permissions !== undefined
        || disabledTools !== undefined
        || maxSteps !== undefined
        || maxSubagentDepth !== undefined
      ) {
        state.profiles[i] = cleanProfile as Profile;
        modified = true;
        addIssue(`Removed legacy per-profile settings from profile "${profile.name}".`);
      }
    }
  }

  for (const [providerId, provider] of Object.entries(state.providers)) {
    if (!provider || typeof provider !== 'object') {
      delete state.providers[providerId];
      modified = true;
      addIssue(`Removed malformed provider "${providerId}".`);
      continue;
    }

    const providerType = (provider as { type?: unknown }).type;
    if (typeof providerType === 'string' && REMOVED_PROVIDER_TYPES.has(providerType)) {
      delete state.providers[providerId];
      modified = true;
      addIssue(`Removed unsupported provider "${providerId}".`);
    }
  }

  for (const builtin of BUILTIN_PROVIDERS) {
    if (!state.providers[builtin.id] || !isDeepStrictEqual(state.providers[builtin.id], builtin)) {
      state.providers[builtin.id] = { ...builtin };
      modified = true;
      addIssue(`Restored builtin provider "${builtin.id}".`);
    }
  }

  if (
    state.defaultProfileId
    && !state.profiles.some((profile) => profile.id === state.defaultProfileId)
  ) {
    state.defaultProfileId = null;
    modified = true;
    addIssue('Cleared an invalid default profile selection.');
  }

  if (
    state.fastProfileId
    && !state.profiles.some((profile) => profile.id === state.fastProfileId)
  ) {
    state.fastProfileId = null;
    modified = true;
    addIssue('Cleared an invalid fast profile selection.');
  }

  return modified;
}

export function recoverLoadedModelConfigState(state: ModelConfigState, issues: string[]): boolean {
  const addIssue = (message: string): void => {
    issues.push(message);
  };

  let modified = false;

  const repairedProfiles: Profile[] = [];
  for (const profile of state.profiles) {
    const baseProfile = isProfileValid(profile, state.providers)
      ? profile
      : repairProfile(profile, state.providers);
    if (!baseProfile) {
      modified = true;
      addIssue(`Removed profile "${profile.name}" because it could not be repaired from the saved configuration.`);
      continue;
    }

    let nextProfile: Profile = baseProfile;

    const repairedVisionModel = isNestedModelValid(nextProfile.visionModel, state.providers)
      ? nextProfile.visionModel
      : repairNestedModel(nextProfile.visionModel, state.providers);
    const repairedFastModel = isNestedModelValid(nextProfile.fastModel, state.providers)
      ? nextProfile.fastModel
      : repairNestedModel(nextProfile.fastModel, state.providers);
    if (JSON.stringify(repairedVisionModel) !== JSON.stringify(nextProfile.visionModel)) {
      nextProfile = { ...nextProfile, visionModel: repairedVisionModel };
    }
    if (JSON.stringify(repairedFastModel) !== JSON.stringify(nextProfile.fastModel)) {
      nextProfile = { ...nextProfile, fastModel: repairedFastModel };
    }

    const sanitizedOriginalProfile = stripUndefinedDeep(profile);
    const sanitizedNextProfile = stripUndefinedDeep(nextProfile);
    if (JSON.stringify(sanitizedNextProfile) !== JSON.stringify(sanitizedOriginalProfile)) {
      modified = true;
      addIssue(`Repaired profile "${profile.name}" from the saved configuration.`);
      repairedProfiles.push(sanitizedNextProfile);
      continue;
    }

    repairedProfiles.push(profile);
  }
  state.profiles = repairedProfiles;

  if (state.defaultProfileId && !state.profiles.some((profile) => profile.id === state.defaultProfileId)) {
    state.defaultProfileId = null;
    modified = true;
  }

  if (state.fastProfileId && !state.profiles.some((profile) => profile.id === state.fastProfileId)) {
    state.fastProfileId = null;
    modified = true;
  }

  if (state.profiles.length === 0 && issues.length > 0) {
    const fallbackState = createHostedFallbackModelConfigState();
    state.profiles = fallbackState.profiles;
    state.defaultProfileId = fallbackState.defaultProfileId;
    state.fastProfileId = fallbackState.fastProfileId;
    modified = true;
    addIssue('Restored Interpreter hosted fallback profiles so the app remains usable.');
    return modified;
  }

  if (!state.defaultProfileId && (modified || issues.some((issue) => issue.includes('default profile selection')))) {
    state.defaultProfileId = state.profiles[0]?.id ?? null;
    modified = true;
    addIssue('Restored the default profile selection.');
  }

  if (!state.fastProfileId && (modified || issues.some((issue) => issue.includes('fast profile selection')))) {
    const preferredFastProfile = state.profiles.find((profile) => {
      const haystack = `${profile.id} ${profile.name}`.toLowerCase();
      return haystack.includes('fast');
    });
    state.fastProfileId = preferredFastProfile?.id ?? state.defaultProfileId;
    modified = true;
    addIssue('Restored the fast profile selection.');
  }

  return modified;
}

function parseModelConfigState(section: unknown, issues?: string[]): ModelConfigState {
  const state = createDefaultModelConfigState();
  if (!isRecord(section)) {
    return state;
  }

  if (Array.isArray(section.profiles)) {
    const validProfiles = section.profiles.filter(isProfileRecord).map((profile) => ({ ...profile }));
    if (validProfiles.length !== section.profiles.length && issues) {
      issues.push('Removed malformed profile entries from the saved configuration.');
    }
    state.profiles = validProfiles;
  } else if (section.profiles !== undefined && issues) {
    issues.push('Cleared a malformed profile list from the saved configuration.');
  }

  if (isRecord(section.providers)) {
    const providers: Record<string, Provider> = {};
    let invalidProvidersRemoved = false;
    for (const [id, provider] of Object.entries(section.providers)) {
      if (isProviderRecord(provider)) {
        providers[id] = { ...provider };
      } else {
        invalidProvidersRemoved = true;
      }
    }
    if (invalidProvidersRemoved && issues) {
      issues.push('Removed malformed provider entries from the saved configuration.');
    }
    state.providers = providers;
  } else if (section.providers !== undefined && issues) {
    issues.push('Cleared a malformed provider store from the saved configuration.');
  }

  if (typeof section.default_profile_id === 'string') {
    state.defaultProfileId = section.default_profile_id;
  } else if (section.default_profile_id !== undefined && issues) {
    issues.push('Cleared a malformed default profile selection from the saved configuration.');
  }

  if (typeof section.fast_profile_id === 'string') {
    state.fastProfileId = section.fast_profile_id;
  } else if (section.fast_profile_id !== undefined && issues) {
    issues.push('Cleared a malformed fast profile selection from the saved configuration.');
  }

  repairModelConfigState(state, issues);
  return state;
}

function toTomlSection(state: ModelConfigState): Record<string, JsonValue> {
  const section: Record<string, JsonValue> = {
    storage_version: MODEL_CONFIG_STORAGE_VERSION,
    profiles: state.profiles as unknown as JsonValue,
    providers: state.providers as unknown as JsonValue,
  };

  if (state.defaultProfileId) {
    section.default_profile_id = state.defaultProfileId;
  }

  if (state.fastProfileId) {
    section.fast_profile_id = state.fastProfileId;
  }

  return section;
}

export async function loadModelConfigState(): Promise<ModelConfigState> {
  return (await loadModelConfigStateWithIssues()).state;
}

export async function loadModelConfigStateWithIssues(): Promise<LoadedModelConfigState> {
  if (inMemoryModelConfigState) {
    return {
      state: cloneModelConfigState(inMemoryModelConfigState),
      issues: [],
      filePath: null,
      authCredentialsMissing: false,
    };
  }

  const response = await getCodexClient().configRead({ includeLayers: true });
  const userLayer = response.layers?.find((layer) => layer.name.type === 'user');
  const root = isRecord(userLayer?.config) ? userLayer.config : {};
  const issues: string[] = [];
  const state = parseModelConfigState(root[MODEL_CONFIG_SECTION_KEY], issues);
  recoverLoadedModelConfigState(state, issues);
  const authCredentialsMissing = root.cli_auth_credentials_store !== 'file'
    || root.mcp_oauth_credentials_store !== 'file';
  return {
    state,
    issues,
    filePath: userLayer?.name.type === 'user' ? userLayer.name.file : null,
    authCredentialsMissing,
  };
}

// NOTE(victor): On Windows, config.toml writes go through the Codex Rust
// app-server which uses atomic rename (tempfile::persist). Antivirus, search
// indexers, or concurrent reads can hold brief file handles that cause the
// rename to fail with EBUSY/EACCES. Retry with backoff matches the pattern
// used by sindresorhus/conf (via stubborn-fs: 200ms interval, 7.5s timeout)
// and Git's mingw_rename (retry on ERROR_ACCESS_DENIED).
const CONFIG_WRITE_MAX_RETRIES = 3;
const CONFIG_WRITE_RETRY_BASE_MS = 150;

const AUTH_FILE_CREDENTIALS_EDITS = [
  { keyPath: 'cli_auth_credentials_store', value: 'file' as JsonValue, mergeStrategy: 'upsert' as const },
  { keyPath: 'mcp_oauth_credentials_store', value: 'file' as JsonValue, mergeStrategy: 'upsert' as const },
];

export async function saveModelConfigState(state: ModelConfigState): Promise<void> {
  const nextState = cloneModelConfigState(state);
  repairModelConfigState(nextState);
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt <= CONFIG_WRITE_MAX_RETRIES; attempt++) {
      try {
        await getCodexClient().configBatchWrite({
          edits: [
            {
              keyPath: MODEL_CONFIG_SECTION_KEY,
              value: toTomlSection(nextState),
              mergeStrategy: 'replace',
            },
            ...AUTH_FILE_CREDENTIALS_EDITS,
          ],
        });
        clearInMemoryModelConfigState();
        return;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : '';
        const isTransientPersistError = msg.includes('failed to persist');
        if (!isTransientPersistError || attempt === CONFIG_WRITE_MAX_RETRIES) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, CONFIG_WRITE_RETRY_BASE_MS * (2 ** attempt)));
      }
    }
    throw lastError;
  } catch (error) {
    setInMemoryModelConfigState(nextState);
    throw error;
  }
}

export function getBuiltinProvider(providerId: string): Provider | undefined {
  return getBuiltinProviderDefaults(providerId);
}
