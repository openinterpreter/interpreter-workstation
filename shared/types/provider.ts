/**
 * Provider types for LLM API configurations
 *
 * Providers are reusable API connection configurations.
 * Profiles reference providers by ID instead of containing inline API config.
 */

import { isVersionBelow, tryNormalizeVersion } from '../utils/version';

/**
 * Provider types supported by the app
 *
 * 'api' is the unified type for all API-key-based providers (OpenAI, Groq, OpenRouter, custom)
 * Use the `api.preset` field to select a known service, or leave it undefined for custom endpoints.
 *
 * 'agent' is the unified type for CLI agents (Claude Code, Codex). The modelId selects which agent.
 */
export type ProviderType =
  | 'hosted'        // Built-in hosted service
  | 'openai-oauth'  // Sign in with ChatGPT (OAuth)
  | 'api'           // API key providers (OpenAI, Groq, OpenRouter, custom)
  | 'local'         // Local runtime (Ollama or LM Studio)
  | 'agent'         // CLI agents (Claude Code, Codex) - modelId selects which
  | 'terminal';     // Terminal-based agents (Claude Code, Codex in PTY)

/**
 * Known API presets - these set default baseURL and format
 */
export type ApiPreset = 'anthropic' | 'openai' | 'groq' | 'openrouter' | 'deepseek';

/**
 * API format - determines which SDK/protocol to use
 */
export type ApiFormat = 'openai' | 'anthropic';

export interface SupportedResponsesApiBaseUrlOption {
  id: string;
  label: string;
  baseURL: string;
}

export const LOCAL_MODEL_PROVIDER_RUNTIMES = ['ollama', 'lmstudio'] as const;
export type LocalModelProviderRuntime = (typeof LOCAL_MODEL_PROVIDER_RUNTIMES)[number];

const LOCAL_RUNTIME_MODEL_ALIASES = [
  {
    ollama: 'qwen3.5:4b',
    lmstudio: 'qwen/qwen3.5-4b',
    aliases: ['qwen3.5-4b', 'unsloth/qwen3.5-4b'],
  },
  {
    ollama: 'qwen3.5:0.8b',
    lmstudio: 'qwen/qwen3.5-0.8b',
    aliases: ['qwen3.5-0.8b', 'unsloth/qwen3.5-0.8b'],
  },
  {
    ollama: 'qwen3.5:9b',
    lmstudio: 'qwen/qwen3.5-9b',
    aliases: ['qwen3.5-9b', 'unsloth/qwen3.5-9b'],
  },
] as const;

function normalizeModelId(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function localRuntimeModelAlias(modelId: string | undefined) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return undefined;

  return LOCAL_RUNTIME_MODEL_ALIASES.find((candidate) =>
    candidate.ollama.toLowerCase() === normalized
    || candidate.lmstudio.toLowerCase() === normalized
    || candidate.aliases.some((alias) => alias.toLowerCase() === normalized)
  );
}

export function resolveLocalRuntimeModelId(
  modelId: string | undefined,
  targetRuntime: LocalModelProviderRuntime,
): string {
  const trimmed = modelId?.trim() ?? '';
  const alias = localRuntimeModelAlias(trimmed);
  if (!alias) return trimmed;
  return targetRuntime === 'ollama' ? alias.ollama : alias.lmstudio;
}

export function localRuntimeModelIdsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeModelId(left);
  const normalizedRight = normalizeModelId(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const leftAlias = localRuntimeModelAlias(normalizedLeft);
  const rightAlias = localRuntimeModelAlias(normalizedRight);
  return Boolean(leftAlias && rightAlias && leftAlias === rightAlias);
}

function isGeneratedProviderHexSuffix(value: string): boolean {
  const parsed = Number.parseInt(value, 16);
  return Number.isInteger(parsed)
    && parsed >= 0
    && parsed <= 0xffffffff
    && parsed.toString(16) === value;
}

export function getLocalModelProviderRuntime(
  modelProvider: string | null | undefined,
): LocalModelProviderRuntime | null {
  const normalized = modelProvider?.trim().toLowerCase();
  if (!normalized) return null;

  for (const runtime of LOCAL_MODEL_PROVIDER_RUNTIMES) {
    if (normalized === runtime) return runtime;

    const prefix = `${runtime}-`;
    if (
      normalized.startsWith(prefix)
      && isGeneratedProviderHexSuffix(normalized.slice(prefix.length))
    ) {
      return runtime;
    }
  }

  return null;
}

export const SUPPORTED_RESPONSES_API_BASE_URLS: readonly SupportedResponsesApiBaseUrlOption[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
  },
  // NOTE(victor): Ollama Cloud's /v1/responses endpoint is acceptable here
  // even if it is non-stateful. App-managed API profiles use the runtime's
  // HTTP Responses path, which sends full prompt history and does not require
  // previous_response_id. Do not infer WebSocket/stateful Responses support.
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    baseURL: 'https://ollama.com/v1',
  },
  // NOTE(victor): NVIDIA's hosted API catalog endpoint is intentionally omitted
  // here. As of 2026-05-13, live probes against integrate.api.nvidia.com return
  // 404 for /v1/responses; downloadable/self-hosted NIMs may expose /v1/responses
  // on their own deployment base URL.
  {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
  },
  {
    id: 'xai',
    label: 'xAI',
    baseURL: 'https://api.x.ai/v1',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseURL: 'https://api.fireworks.ai/inference/v1',
  },
] as const;

/**
 * API provider configuration
 * Used when type === 'api'
 */
export interface ApiConfig {
  /** Known service preset - sets default baseURL and format */
  preset?: ApiPreset;
  /** API format (openai or anthropic style). Inferred from preset if not set. */
  format?: ApiFormat;
  /** OIX wire protocol. Defaults to Responses when omitted. */
  wireApi?: 'responses' | 'chat';
  /** Legacy persisted state. Runtime routing uses wireApi/wire_api instead. */
  useResponsesApi?: boolean;
}

/**
 * Get default baseURL for an API preset
 */
export function getApiPresetBaseURL(preset: ApiPreset): string {
  switch (preset) {
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'groq':
      return 'https://api.groq.com/openai/v1';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'deepseek':
      return 'https://api.deepseek.com';
  }
}

/**
 * Get default API format for a preset
 */
export function getApiPresetFormat(preset: ApiPreset): ApiFormat {
  return preset === 'anthropic' ? 'anthropic' : 'openai';
}

/**
 * Get display name for an API preset
 */
export function getApiPresetDisplayName(preset: ApiPreset): string {
  switch (preset) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'groq':
      return 'Groq';
    case 'openrouter':
      return 'OpenRouter';
    case 'deepseek':
      return 'DeepSeek';
  }
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '');
}

export function findSupportedResponsesApiBaseUrlOption(
  baseURL: string | undefined,
): SupportedResponsesApiBaseUrlOption | undefined {
  if (!baseURL?.trim()) {
    return undefined;
  }

  const normalizedBaseURL = normalizeBaseURL(baseURL);
  return SUPPORTED_RESPONSES_API_BASE_URLS.find(
    (option) => normalizeBaseURL(option.baseURL) === normalizedBaseURL,
  );
}

export function isDeepSeekApiBaseURL(baseURL: string | undefined): boolean {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.hostname.trim().toLowerCase().replace(/\.+$/, '') === 'api.deepseek.com'
      && (pathname === '/' || pathname === '/v1');
  } catch {
    return false;
  }
}

export function getSupportedResponsesApiBaseUrlOption(
  id: string,
): SupportedResponsesApiBaseUrlOption | undefined {
  return SUPPORTED_RESPONSES_API_BASE_URLS.find((option) => option.id === id);
}

export function getDefaultResponsesApiBaseURL(): string {
  return getSupportedResponsesApiBaseUrlOption('openai')?.baseURL || 'https://api.openai.com/v1';
}

const DEFAULT_UNSUPPORTED_RESPONSES_API_BASE_URL_MESSAGE =
  'This base URL does not support the OpenAI Responses API (/responses). Use Interpreter-hosted models or OpenRouter instead.';

const NVIDIA_UNSUPPORTED_RESPONSES_API_BASE_URL_MESSAGE =
  'NVIDIA\'s hosted integrate.api.nvidia.com endpoint does not expose the OpenAI Responses API (/responses). Use OpenRouter or another Responses-compatible endpoint instead.';

function isNvidiaIntegrateBaseURL(baseURL: string | undefined): boolean {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return (
      url.hostname === 'integrate.api.nvidia.com' &&
      (url.pathname === '/' || url.pathname === '/v1' || url.pathname === '/v1/')
    );
  } catch {
    return false;
  }
}

export function getUnsupportedResponsesApiBaseUrlMessage(baseURL: string | undefined): string {
  return isNvidiaIntegrateBaseURL(baseURL)
    ? NVIDIA_UNSUPPORTED_RESPONSES_API_BASE_URL_MESSAGE
    : DEFAULT_UNSUPPORTED_RESPONSES_API_BASE_URL_MESSAGE;
}

/**
 * Provider identity inferred from a base URL hostname.
 *
 * This is a looser match than {@link getApiEnvKeyTypeForBaseURL}: it keys off the
 * hostname alone (any path on a known host counts), and always resolves to a
 * concrete kind (`'custom'` for anything unrecognized) rather than `null`. Used
 * by the model-picker UI and the TOML store to decide which model list/default
 * applies to a base URL.
 */
export type ApiEndpointKind = 'openrouter' | 'openai' | 'groq' | 'deepseek' | 'custom';

export function getApiEndpointKind(baseURL: string | undefined): ApiEndpointKind {
  const normalizedBaseURL = baseURL?.trim();
  if (!normalizedBaseURL) {
    return 'custom';
  }

  let url: URL;
  try {
    url = new URL(normalizedBaseURL);
  } catch {
    return 'custom';
  }

  const hostname = url.hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (hostname === 'openrouter.ai') {
    return 'openrouter';
  }
  if (hostname === 'api.openai.com') {
    return 'openai';
  }
  if (hostname === 'api.groq.com') {
    return 'groq';
  }
  if (hostname === 'api.deepseek.com') {
    return 'deepseek';
  }

  return 'custom';
}

export type EnvApiKeyType = keyof EnvApiKeysResult;

export function getApiEnvKeyTypeForBaseURL(baseURL: string | undefined): EnvApiKeyType | null {
  if (isDeepSeekApiBaseURL(baseURL)) {
    return 'deepseek';
  }

  const supportedBaseURL = findSupportedResponsesApiBaseUrlOption(baseURL);
  switch (supportedBaseURL?.id) {
    case 'openai':
      return 'openai';
    case 'openrouter':
      return 'openrouter';
    case 'groq':
      return 'groq';
    default:
      return null;
  }
}

export type LocalModelServerKind = 'ollama' | 'lmstudio' | 'unknown';

export function detectLocalModelServerUrl(input: string | undefined): LocalModelServerKind | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!isLoopbackHost(hostname)) return null;

  if (url.port === '11434') return 'ollama';
  if (url.port === '1234') return 'lmstudio';
  return 'unknown';
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]') {
    return true;
  }
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  return Number.isInteger(first) && first === 127 && parts.every(p => {
    const n = Number(p);
    return p.length > 0 && Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/**
 * Terminal provider configuration
 * Used when type === 'terminal'
 */
export interface TerminalProviderConfig {
  /** Command to run (e.g., 'claude', 'codex') */
  command: string;
  /** Icon to display ('claude' | 'openai') */
  icon?: 'claude' | 'openai';
  /** Whether to show rich text composer above terminal */
  richInput?: boolean;
}

/**
 * A configured LLM provider
 */
export interface Provider {
  id: string;
  name: string;
  type: ProviderType;

  // API key (for type: 'api')
  apiKey?: string;
  // Base URL override (for type: 'api' or 'local')
  baseURL?: string;

  // API provider config (for type: 'api')
  api?: ApiConfig;

  // Terminal provider settings (for type: 'terminal')
  terminal?: TerminalProviderConfig;

  // Metadata
  createdAt: number;
  updatedAt: number;
}

/**
 * OAuth connection status (queried at runtime, not stored in Provider)
 */
export interface OAuthStatus {
  isConnected: boolean;
  email?: string;
  accountId?: string;  // OpenAI only - extracted from JWT
  error?: string;
}

/**
 * Supported OpenAI OAuth model returned by the Codex-backed ChatGPT account lane.
 */
export interface SupportedOpenAIOAuthModel {
  id: string;
  name: string;
  isDefault: boolean;
  supportedReasoningEfforts?: import('./reasoning').ReasoningEffort[];
  defaultReasoningEffort?: import('./reasoning').ReasoningEffort;
}

export type LocalModelToolUseSupport = 'supported' | 'unsupported' | 'unknown';

export function canSelectLocalModelForTools(support: LocalModelToolUseSupport): boolean {
  return support === 'supported';
}

export interface OpenRouterModel {
  id: string;
  name: string;
  provider: string;
  description?: string;
  contextLength?: number;
  supportedReasoningEfforts?: import('./reasoning').ReasoningEffort[];
  defaultReasoningEffort?: import('./reasoning').ReasoningEffort;
}

export interface OpenRouterModelCatalogResult {
  models: OpenRouterModel[];
  fetchedAt: number;
  stale: boolean;
}

/**
 * Environment API key detection result
 */
export interface EnvApiKey {
  found: boolean;
  masked?: string; // First 4 + ... + last 4 chars
}

/**
 * All environment API keys
 */
export interface EnvApiKeysResult {
  openai: EnvApiKey;
  anthropic: EnvApiKey;
  openrouter: EnvApiKey;
  groq: EnvApiKey;
  deepseek: EnvApiKey;
}

/**
 * Claude Code CLI status
 */
export interface ClaudeCodeStatus {
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  path?: string;
  error?: string;
}

/**
 * Claude Code login result
 */
export interface ClaudeCodeLoginResult {
  success: boolean;
  error?: string;
  output?: string;
}

/**
 * Codex CLI status
 */
export interface CodexStatus {
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  path?: string;
  error?: string;
}

/**
 * Ollama model info (mirrors LmStudioModelInfo for frontend consistency)
 */
export interface OllamaModelInfo {
  id: string;
  displayName: string;
  paramsString?: string;
  toolUseSupport: Exclude<LocalModelToolUseSupport, 'unknown'>;
}

/**
 * Ollama status
 */
export interface OllamaStatus {
  running: boolean;
  /** Server version reported by Ollama's `/api/version` endpoint, e.g. "0.13.4". */
  version?: string;
  models?: string[];
  ollamaModels?: OllamaModelInfo[];
  totalChatModels?: number;
  error?: string;
}

// Ollama added the `developer` role (via its `/v1/responses` support, PR
// ollama/ollama#13351) in v0.13.3, and fixed multi-turn tool-call assembly in
// v0.13.4 (#13434). 0.13.4 is the first version with both the developer role
// and correct tool calling, and matches the runtime floor in codex-rs/ollama
// (min_responses_version).
export const MIN_OLLAMA_DEVELOPER_ROLE_VERSION = '0.13.4';

/**
 * True when a detected Ollama version is older than the minimum that supports
 * the developer role and reliable tool calling. Empty, unparseable, or dev
 * builds (`0.0.0`) return false so we never warn on those (mirrors
 * codex-rs/ollama `supports_responses`, which treats 0.0.0 as supported).
 */
export function isOllamaVersionBelowDeveloperRoleFloor(
  version: string | null | undefined,
): boolean {
  const normalized = tryNormalizeVersion(version);
  if (!normalized || normalized === '0.0.0') return false;
  return isVersionBelow(normalized, MIN_OLLAMA_DEVELOPER_ROLE_VERSION);
}

export interface LmStudioModelInfo {
  id: string;
  displayName: string;
  paramsString?: string;
  toolUseSupport: LocalModelToolUseSupport;
}

export interface LmStudioStatus {
  running: boolean;
  models?: string[];
  lmStudioModels?: LmStudioModelInfo[];
  totalChatModels?: number;
  inferenceAvailable?: boolean;
  error?: string;
}

/**
 * Built-in provider IDs
 *
 * These are the base provider types. Profiles configure these with specific settings.
 * For example, a "Codex Terminal" profile uses the terminal provider with command='codex'.
 */
export const BUILTIN_PROVIDER_IDS = {
  HOSTED: 'builtin:hosted',
  LOCAL: 'builtin:local',
  AGENT: 'builtin:agent',
  OPENAI_OAUTH: 'builtin:openai-oauth',
} as const;

/**
 * Built-in providers - always available, cannot be deleted
 *
 * These are the base provider types. Profiles use these as building blocks
 * and add their own configuration (e.g., terminal profiles set command/richInput).
 */
export const BUILTIN_PROVIDERS: Provider[] = [
  {
    id: BUILTIN_PROVIDER_IDS.HOSTED,
    name: 'Hosted',
    type: 'hosted',
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: BUILTIN_PROVIDER_IDS.LOCAL,
    name: 'Local (Ollama / LM Studio)',
    type: 'local',
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: BUILTIN_PROVIDER_IDS.OPENAI_OAUTH,
    name: 'OpenAI (OAuth)',
    type: 'openai-oauth',
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: BUILTIN_PROVIDER_IDS.AGENT,
    name: 'CLI Agent',
    type: 'agent',
    createdAt: 0,
    updatedAt: 0,
  },
];

/**
 * Check if a provider ID is built-in
 */
export function isBuiltinProvider(providerId: string): boolean {
  return providerId.startsWith('builtin:');
}

/**
 * Get the default values for a built-in provider
 */
export function getBuiltinProviderDefaults(providerId: string): Provider | undefined {
  return BUILTIN_PROVIDERS.find(p => p.id === providerId);
}

/**
 * Get display name for a provider type
 */
export function getProviderTypeDisplayName(type: ProviderType, api?: ApiConfig): string {
  switch (type) {
    case 'hosted':
      return 'Hosted';
    case 'openai-oauth':
      return 'OpenAI (Sign in with ChatGPT)';
    case 'api':
      if (api?.preset) {
        return getApiPresetDisplayName(api.preset);
      }
      return 'Custom API';
    case 'local':
      return 'Local (Ollama / LM Studio)';
    case 'agent':
      return 'CLI Agent';
    case 'terminal':
      return 'Terminal Agent';
    default:
      return type;
  }
}

/**
 * Check if a provider type requires OAuth
 */
export function isOAuthProviderType(type: ProviderType): boolean {
  return type === 'openai-oauth';
}

/**
 * Check if a provider type requires an API key
 */
export function isApiKeyProviderType(type: ProviderType): boolean {
  return type === 'api';
}

/**
 * Get the API format for a provider
 * Returns the explicit format, or infers from preset, or defaults to 'openai'
 */
export function getProviderApiFormat(provider: Provider): ApiFormat {
  if (provider.type !== 'api') {
    return 'openai'; // Non-API providers default to openai format
  }
  if (provider.api?.format) {
    return provider.api.format;
  }
  if (provider.api?.preset) {
    return getApiPresetFormat(provider.api.preset);
  }
  return 'openai'; // Default for custom API
}

/**
 * Get the base URL for a provider
 * Returns explicit baseURL, or preset default, or undefined
 */
export function getProviderBaseURL(provider: Provider): string | undefined {
  if (provider.baseURL) {
    return provider.baseURL;
  }
  if (provider.type === 'api' && provider.api?.preset) {
    return getApiPresetBaseURL(provider.api.preset);
  }
  if (provider.type === 'local') {
    return 'http://localhost:11434/v1';
  }
  return undefined;
}
