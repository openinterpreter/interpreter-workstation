/**
 * Provider Handlers
 *
 * Business logic for provider management.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import * as providerStore from '../services/providerStore';
import type { v2 } from './codex-generated-types/index';
import { openRouterModelCatalog } from '../utils/openRouterModelCatalog';
import type {
  Provider,
  OAuthStatus,
  EnvApiKeysResult,
  ClaudeCodeStatus,
  ClaudeCodeLoginResult,
  CodexStatus,
  OllamaStatus,
  OllamaModelInfo,
  LmStudioStatus,
  LmStudioModelInfo,
  LocalModelToolUseSupport,
  LocalModelProviderRuntime,
  SupportedOpenAIOAuthModel,
  OpenRouterModelCatalogResult,
  EnvApiKeyType,
} from '../../shared/types/provider';
import { isReasoningEffort } from '../../shared/types/reasoning';
import {
  canSelectLocalModelForTools,
  getApiPresetBaseURL,
  getLocalModelProviderRuntime,
} from '../../shared/types/provider';
import type { ProfileSetupStatus } from '../../shared/types/profile';
import * as configStore from '../configStore';
import { getCodexService, getCodexClient } from '../utils/codexServiceBridge';
import { broadcastEvent } from './broadcast';
import {
  buildAutomaticClaudeCodeTerminalProfile,
  shouldEnsureAutomaticClaudeCodeTerminalProfile,
} from './automaticProfiles';

type OAuthProviderType = 'openai' | 'claude';
const OAUTH_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const pendingOAuthFlows = new Map<string, {
  providerType: OAuthProviderType;
  cleanup: () => void;
  timeoutId: NodeJS.Timeout;
  loginId?: string;
}>();
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';
const DEFAULT_OLLAMA_PULL_URL = 'http://localhost:11434/api/pull';
const DEFAULT_LM_STUDIO_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_LM_STUDIO_MODELS_URL = 'http://localhost:1234/api/v1/models';
const DEFAULT_LM_STUDIO_DOWNLOAD_URL = 'http://localhost:1234/api/v1/models/download';

type LocalRuntime = LocalModelProviderRuntime;
export type LocalModelToolUseUnknownReason = 'runtime-unreachable' | 'model-not-installed';
export interface LocalModelToolUseResult {
  runtime: LocalRuntime | null;
  support: LocalModelToolUseSupport;
  /** Set only when `support` is 'unknown' and the probe identified why. */
  unknownReason?: LocalModelToolUseUnknownReason;
}
type LocalRuntimeStatus = OllamaStatus | LmStudioStatus;
type LocalRuntimeModelInfo = OllamaModelInfo | LmStudioModelInfo;
let accountLoginSubscribed = false;
export const lastOAuthErrors = new Map<OAuthProviderType, string>();

function ensureAccountLoginSubscription() {
  if (accountLoginSubscribed) return;
  accountLoginSubscribed = true;
  const client = getCodexClient();

  client.onAuthInvalidated((reason) => {
    broadcastEvent('codex:auth-invalidated', { reason });
  });

  client.subscribe((notification) => {
    if (notification.method === 'account/login/completed') {
      const { loginId, success, error } = notification.params;
      if (!loginId) {
        return;
      }

      const pendingFlowId = findPendingOAuthFlowId('openai', loginId);
      if (!pendingFlowId) {
        return;
      }

      clearPendingOAuthFlow(pendingFlowId, { runCleanup: false });

      if (success) {
        lastOAuthErrors.delete('openai');
        return;
      }

      if (error) {
        lastOAuthErrors.set('openai', error);
      }
    }
  });
}

function clearPendingOAuthFlow(flowId: string, options?: { runCleanup?: boolean }): void {
  const pending = pendingOAuthFlows.get(flowId);
  if (!pending) return;

  clearTimeout(pending.timeoutId);
  pendingOAuthFlows.delete(flowId);

  if (options?.runCleanup === false) {
    return;
  }

  try {
    pending.cleanup();
  } catch (error) {
    console.warn(`[OAuth] Failed cleanup for flow ${flowId}:`, error);
  }
}

function clearPendingOAuthFlowsForProvider(providerType: OAuthProviderType): void {
  for (const [flowId, pending] of pendingOAuthFlows.entries()) {
    if (pending.providerType === providerType) {
      clearPendingOAuthFlow(flowId);
    }
  }
}

function findPendingOAuthFlowId(providerType: OAuthProviderType, loginId: string): string | undefined {
  for (const [flowId, pending] of pendingOAuthFlows.entries()) {
    if (pending.providerType === providerType && pending.loginId === loginId) {
      return flowId;
    }
  }

  return undefined;
}

function registerPendingOAuthFlow(
  flowId: string,
  providerType: OAuthProviderType,
  cleanup: () => void,
  loginId?: string,
): void {
  const timeoutId = setTimeout(() => {
    clearPendingOAuthFlow(flowId);
  }, OAUTH_FLOW_TIMEOUT_MS);

  pendingOAuthFlows.set(flowId, { providerType, cleanup, timeoutId, loginId });
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function stripLocalModelPublisher(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  return normalized.includes('/')
    ? normalized.slice(normalized.lastIndexOf('/') + 1)
    : normalized;
}

function matchesLocalModelId(left: string, right: string): boolean {
  const normalizedLeft = stripLocalModelPublisher(left);
  const normalizedRight = stripLocalModelPublisher(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

function getLocalModelMatchKey(modelId: string): string {
  return stripLocalModelPublisher(modelId);
}

function getLocalRuntimeModels(status: LocalRuntimeStatus): LocalRuntimeModelInfo[] | undefined {
  if ('ollamaModels' in status) {
    return status.ollamaModels;
  }
  if ('lmStudioModels' in status) {
    return status.lmStudioModels;
  }
  return undefined;
}

function buildOllamaManagementUrl(baseURL: string | undefined, endpoint: '/api/tags' | '/api/pull' | '/api/show' | '/api/version'): string {
  const candidate = baseURL?.trim() || DEFAULT_OLLAMA_BASE_URL;

  try {
    const parsed = new URL(candidate);
    let path = trimTrailingSlash(parsed.pathname || '');

    if (path === '/') {
      path = '';
    }

    if (path.endsWith('/v1')) {
      path = path.slice(0, -3);
    }

    parsed.pathname = `${path}${endpoint}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    if (endpoint === '/api/pull') return DEFAULT_OLLAMA_PULL_URL;
    // Derive the other management endpoints from the default tags URL.
    return DEFAULT_OLLAMA_TAGS_URL.replace('/api/tags', endpoint);
  }
}

export function buildLmStudioManagementUrl(baseURL: string | undefined, endpoint: '/api/v1/models' | '/api/v1/models/download'): string {
  const candidate = baseURL?.trim() || DEFAULT_LM_STUDIO_BASE_URL;

  try {
    const parsed = new URL(candidate);
    let path = trimTrailingSlash(parsed.pathname || '');

    if (path === '/') {
      path = '';
    }

    if (path.endsWith('/v1')) {
      path = path.slice(0, -3);
    }

    parsed.pathname = `${path}${endpoint}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return endpoint === '/api/v1/models' ? DEFAULT_LM_STUDIO_MODELS_URL : DEFAULT_LM_STUDIO_DOWNLOAD_URL;
  }
}

function buildLmStudioDownloadStatusUrl(baseURL: string | undefined, jobId: string): string {
  const downloadUrl = buildLmStudioManagementUrl(baseURL, '/api/v1/models/download');

  try {
    const parsed = new URL(downloadUrl);
    parsed.pathname = `${trimTrailingSlash(parsed.pathname)}/status/${encodeURIComponent(jobId)}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return `${DEFAULT_LM_STUDIO_DOWNLOAD_URL}/status/${encodeURIComponent(jobId)}`;
  }
}

export function inferLocalRuntimeFromBaseUrl(baseURL: string | undefined): LocalRuntime {
  const normalized = baseURL?.trim();

  if (!normalized) {
    return 'ollama';
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.port === '1234') {
      return 'lmstudio';
    }
  } catch {
    // Fall through to string checks.
  }

  if (normalized.includes(':1234') || normalized.toLowerCase().includes('lmstudio')) {
    return 'lmstudio';
  }

  return 'ollama';
}

// ============================================================================
// Provider CRUD Operations
// ============================================================================

export async function listProviders(): Promise<{
  providers: Provider[];
}> {
  const providers = await providerStore.listProviders();

  // Enrich OAuth providers with connection status
  const enrichedProviders = await Promise.all(
    providers.map(async (provider) => {
      if (provider.type === 'openai-oauth') {
        const service = getCodexService();
        const { account } = await service.getAccount();
        const status: OAuthStatus = account && account.type === 'chatgpt'
          ? { isConnected: true, email: account.email ?? undefined }
          : { isConnected: false };
        return { ...provider, _oauthStatus: status };
      }
      return provider;
    })
  );

  return { providers: enrichedProviders };
}

export async function getProvider(providerId: string): Promise<Provider | undefined> {
  return await providerStore.getProvider(providerId);
}

export async function createProvider(provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>): Promise<{
  success: boolean;
  provider: Provider;
}> {
  const id = providerStore.generateProviderId(provider.name);
  const now = Date.now();

  const newProvider: Provider = {
    ...provider,
    id,
    createdAt: now,
    updatedAt: now,
  };

  await providerStore.addProvider(newProvider);
  return { success: true, provider: newProvider };
}

export async function updateProvider(
  providerId: string,
  updates: Partial<Provider>
): Promise<{ success: boolean; provider: Provider | undefined }> {
  await providerStore.updateProvider(providerId, updates);
  const updated = await providerStore.getProvider(providerId);
  return { success: true, provider: updated };
}

export async function deleteProvider(providerId: string): Promise<{ success: boolean }> {
  await providerStore.deleteProvider(providerId);
  return { success: true };
}

export async function resetProvider(providerId: string): Promise<{
  success: boolean;
  provider: Provider;
}> {
  const provider = await providerStore.resetProvider(providerId);
  return { success: true, provider };
}

// ============================================================================
// OAuth Operations
// ============================================================================

export async function initiateOAuth(
  providerType: OAuthProviderType
): Promise<{
  authUrl: string;
  flowId: string;
}> {
  const flowId = `${providerType}-${Date.now()}`;
  clearPendingOAuthFlowsForProvider(providerType);

  if (providerType === 'openai') {
    lastOAuthErrors.delete('openai');
    const service = getCodexService();
    const { loginId, authUrl } = await service.loginWithChatGPT();
    const cleanup = () => { service.cancelLogin(loginId).catch(() => {}); };
    registerPendingOAuthFlow(flowId, providerType, cleanup, loginId);
    ensureAccountLoginSubscription();
    return { authUrl, flowId };
  }

  throw new Error(`Unknown OAuth provider type: ${providerType}`);
}

export async function completeOAuth(
  providerType: OAuthProviderType,
  _code: string,
  flowId: string
): Promise<{
  success: boolean;
  email?: string;
  error?: string;
}> {
  const pending = pendingOAuthFlows.get(flowId);
  if (!pending || pending.providerType !== providerType) {
    return { success: false, error: 'No pending OAuth flow for this provider. Please initiate again.' };
  }

  if (providerType === 'openai') {
    // OpenAI handles code exchange internally via callback server
    clearPendingOAuthFlow(flowId);
    return { success: false, error: 'OpenAI OAuth completes automatically via callback' };
  }

  return { success: false, error: `Unknown OAuth provider type: ${providerType}` };
}

export async function getOAuthStatus(
  providerType: OAuthProviderType
): Promise<OAuthStatus> {
  if (providerType === 'openai') {
    const error = lastOAuthErrors.get('openai');
    if (error) {
      lastOAuthErrors.delete('openai');
      return { isConnected: false, error };
    }
    const service = getCodexService();
    const { account } = await service.getAccount();
    if (account && account.type === 'chatgpt') {
      return { isConnected: true, email: account.email ?? undefined };
    }
    return { isConnected: false };
  }

  return { isConnected: false };
}

export async function listOpenAIOAuthModels(): Promise<{
  models: SupportedOpenAIOAuthModel[];
}> {
  const service = getCodexService();
  const { account } = await service.getAccount();
  if (!account || account.type !== 'chatgpt') {
    throw new Error('OpenAI OAuth account is not connected');
  }

  const models: SupportedOpenAIOAuthModel[] = [];
  const seenModelIds = new Set<string>();
  let cursor: string | null = null;

  do {
    const response = await service.listModels({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });

    for (const model of response.data) {
      const modelId = model.id.trim().toLowerCase();
      /*
       * Runtime contract: app-server `model/list` already applies account/auth
       * filtering and exposes picker visibility through `hidden`.
       *
       * Do not treat `availabilityNux`, `upgrade`, or `upgradeInfo` as exclusion
       * flags. They are metadata for announcement and migration UI, and the
       * runtime can attach them to selectable models. A live probe against the
       * bundled OIX `interpreter app-server` returned:
       *
       * - `gpt-5.5`: hidden=false, availabilityNux present, isDefault=true.
       * - `gpt-5.3-codex`: hidden=false, upgrade=gpt-5.4, upgradeInfo present.
       *
       * Filtering those metadata fields here would make the ChatGPT settings
       * dropdown incomplete even though app-server marked the models visible.
       * Keep only local shape-safety filters: blank ids, hidden rows, and
       * duplicate ids after normalization.
       */
      if (
        !modelId
        || model.hidden
        || seenModelIds.has(modelId)
      ) {
        continue;
      }

      seenModelIds.add(modelId);
      models.push({
        id: modelId,
        name: model.displayName.trim() || modelId,
        isDefault: model.isDefault,
        supportedReasoningEfforts: (model.supportedReasoningEfforts ?? [])
          .map((option) => option.reasoningEffort)
          .filter(isReasoningEffort),
        defaultReasoningEffort: isReasoningEffort(model.defaultReasoningEffort)
          ? model.defaultReasoningEffort
          : undefined,
      });
    }

    cursor = response.nextCursor;
  } while (cursor);

  if (models.length === 0) {
    throw new Error('OpenAI OAuth account has no supported models');
  }

  return { models };
}

export async function listOpenRouterModels(
  options?: { forceRefresh?: boolean },
): Promise<OpenRouterModelCatalogResult> {
  return openRouterModelCatalog.listModels(options);
}

/**
 * List the models DeepSeek exposes for a given API key via GET /models.
 * DeepSeek returns only ids (no display names), so each id doubles as its label.
 * Throws on auth/network failures so callers can keep the shipped defaults.
 */
export async function listDeepSeekModels(
  apiKey: string,
): Promise<{ models: Array<{ id: string; name: string }> }> {
  const token = apiKey?.trim();
  if (!token) {
    throw new Error('A DeepSeek API key is required to list models');
  }

  const base = getApiPresetBaseURL('deepseek');
  const url = new URL('models', base.endsWith('/') ? base : `${base}/`).href;
  const response = await fetch(url, {
    method: 'GET',
    headers: buildBearerHeaders(token),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek model list request failed: HTTP ${response.status}`);
  }

  const data = await response.json() as { data?: Array<{ id?: string }> };
  const models: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const entry of data.data ?? []) {
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: id });
  }

  if (models.length === 0) {
    throw new Error('DeepSeek model list response contained no models');
  }

  return { models };
}

/**
 * Map a runtime `Model` to the app's UI option shape, mirroring the mapping in
 * `listOpenAIOAuthModels`: model.id, model.displayName -> name (fallback to id),
 * isDefault, and the reasoning-effort metadata.
 */
function mapInterpreterModel(
  model: v2.Model,
): SupportedOpenAIOAuthModel {
  const id = model.id.trim();
  return {
    id,
    name: model.displayName.trim() || id,
    isDefault: model.isDefault,
    supportedReasoningEfforts: (model.supportedReasoningEfforts ?? [])
      .map((option) => option.reasoningEffort)
      .filter(isReasoningEffort),
    defaultReasoningEffort: isReasoningEffort(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : undefined,
  };
}

/**
 * List the providers known to the Interpreter runtime (configured plus, when
 * `includeUnconfigured`, bundled quick-add presets). Throws on runtime error so
 * callers can decide how to react.
 */
export async function listInterpreterProviders(
  includeUnconfigured?: boolean,
): Promise<{ providers: v2.InterpreterProvider[] }> {
  const service = getCodexService();
  const response = await service.listInterpreterProviders(
    includeUnconfigured == null ? {} : { includeUnconfigured },
  );
  return { providers: response.data };
}

export async function setInterpreterProvider(
  providerId: string,
  profile?: string,
): Promise<{ success: true }> {
  await getCodexService().setInterpreterProvider({
    providerId,
    ...(profile == null ? {} : { profile }),
  });
  return { success: true };
}

/**
 * List the models the Interpreter runtime exposes for a given provider via the
 * same fetch engine as the OpenAI OAuth model lane. Omitting `providerId` lists
 * the active provider's models. Throws on runtime error.
 */
export async function listInterpreterModels(
  providerId?: string,
  includeHidden?: boolean,
): Promise<{ models: SupportedOpenAIOAuthModel[] }> {
  const service = getCodexService();
  const response = await service.listInterpreterModels({
    ...(providerId == null ? {} : { modelProvider: providerId }),
    ...(includeHidden == null ? {} : { includeHidden }),
  });

  const models: SupportedOpenAIOAuthModel[] = [];
  const seenModelIds = new Set<string>();
  for (const model of response.data) {
    if (!includeHidden && model.hidden) continue;
    const mapped = mapInterpreterModel(model);
    if (!mapped.id || seenModelIds.has(mapped.id)) continue;
    seenModelIds.add(mapped.id);
    models.push(mapped);
  }

  return { models };
}

export async function setInterpreterModel(
  model: string,
  reasoningEffort?: v2.InterpreterModelSetParams["reasoningEffort"],
  profile?: string,
): Promise<{ success: true }> {
  await getCodexService().setInterpreterModel({
    model,
    ...(reasoningEffort == null ? {} : { reasoningEffort }),
    ...(profile == null ? {} : { profile }),
  });
  return { success: true };
}

/**
 * List the harness choices the Interpreter runtime reports for a provider (and
 * optional model). Plumb-only: pass the runtime data through unchanged. Throws
 * on runtime error.
 */
export async function listInterpreterHarnesses(
  providerId: string,
  model?: string,
): Promise<{ harnesses: v2.InterpreterHarness[] }> {
  const service = getCodexService();
  const response = await service.listInterpreterHarnesses({
    providerId,
    ...(model == null ? {} : { model }),
  });
  return { harnesses: response.data };
}

export async function setInterpreterHarness(
  harness?: string,
  profile?: string,
): Promise<{ success: true }> {
  await getCodexService().setInterpreterHarness({
    ...(harness == null ? {} : { harness }),
    ...(profile == null ? {} : { profile }),
  });
  return { success: true };
}

export async function disconnectOAuth(
  providerType: OAuthProviderType
): Promise<{ success: boolean }> {
  clearPendingOAuthFlowsForProvider(providerType);

  if (providerType === 'openai') {
    const service = getCodexService();
    await service.logout();
    return { success: true };
  }

  return { success: false };
}

// ============================================================================
// OAuth Token Access (for API requests)
// ============================================================================


// ============================================================================
// Local/Ollama Operations
// ============================================================================

export function isLikelyEmbeddingModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;

  return (
    normalized.includes('embedding') ||
    normalized.includes('embed') ||
    normalized.includes('nomic-embed') ||
    normalized.includes('mxbai-embed') ||
    normalized.includes('jina-embedding') ||
    normalized.includes('jina-embeddings') ||
    normalized.startsWith('bge-') ||
    normalized.includes('/bge-') ||
    normalized.startsWith('gte-') ||
    normalized.includes('/gte-') ||
    normalized.startsWith('e5-') ||
    normalized.includes('/e5-')
  );
}

export function isLmStudioModelUsableForChat(modelId: string, type?: string): boolean {
  const normalizedType = type?.trim().toLowerCase();
  if (normalizedType && normalizedType !== 'llm') {
    return false;
  }
  return !isLikelyEmbeddingModelId(modelId);
}

function buildBearerHeaders(apiKey?: string): Record<string, string> {
  const token = apiKey?.trim();
  if (!token) return Object.create(null) as Record<string, string>;
  return { Authorization: `Bearer ${token}` };
}

interface OllamaTagEntry {
  name?: string;
  digest?: string;
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
}

interface OllamaShowResponse {
  capabilities?: string[];
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
}

// NOTE(victor): Cache /api/show results keyed by digest from /api/tags.
// Digest is content-addressed (changes when model binary changes), so no TTL needed.
// First getOllamaStatus call = 1 + 2N requests; subsequent calls = 1 request.
const ollamaCapabilityCache = new Map<string, string[]>();

const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_SHOW_PER_CALL_MS = 2000;
const OLLAMA_SHOW_BUDGET_MS = 8000;

type OllamaShowProbe =
  | { kind: 'ok'; body: OllamaShowResponse }
  | { kind: 'http-error'; status: number }
  | { kind: 'network-error' };

/*
 * Failed probes carry their cause: live Ollama answers /api/show with 404
 * ("model 'X' not found") when the model is not pulled, while a stopped
 * Ollama refuses the connection (fetch throws). Timeouts also land in
 * 'runtime-unreachable', which is the actionable approximation.
 */
type OllamaShowOutcome =
  | { kind: 'ok'; body: OllamaShowResponse }
  | { kind: 'model-not-installed' }
  | { kind: 'runtime-unreachable' }
  | { kind: 'indeterminate' };

async function probeOllamaShowBody(
  showUrl: string,
  body: { model: string } | { name: string },
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<OllamaShowProbe> {
  try {
    const response = await fetch(showUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { kind: 'http-error', status: response.status };
    return { kind: 'ok', body: await response.json() as OllamaShowResponse };
  } catch {
    return { kind: 'network-error' };
  }
}

async function probeOllamaShow(
  showUrl: string,
  modelName: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<OllamaShowOutcome> {
  const results = await Promise.all([
    probeOllamaShowBody(showUrl, { model: modelName }, headers, timeoutMs),
    probeOllamaShowBody(showUrl, { name: modelName }, headers, timeoutMs),
  ]);
  // NOTE(victor): This code path has used both `name` and `model` for
  // /api/show, and live Ollama accepts both shapes. Support logs only prove
  // we surfaced "does not support tools", so if either shape reports native
  // tool support, trust that positive signal instead of letting a weaker
  // successful response mask it.
  for (const result of results) {
    if (result.kind === 'ok' && Array.isArray(result.body.capabilities) && result.body.capabilities.includes('tools')) {
      return result;
    }
  }
  for (const result of results) {
    if (result.kind === 'ok') {
      return result;
    }
  }
  if (results.some((result) => result.kind === 'http-error' && result.status === 404)) {
    return { kind: 'model-not-installed' };
  }
  if (results.every((result) => result.kind === 'network-error')) {
    return { kind: 'runtime-unreachable' };
  }
  return { kind: 'indeterminate' };
}

function capabilitiesSupportTools(capabilities: string[] | undefined): Exclude<LocalModelToolUseSupport, 'unknown'> {
  return Array.isArray(capabilities) && capabilities.includes('tools')
    ? 'supported'
    : 'unsupported';
}

function getLmStudioToolUseSupport(entry: LmStudioModelEntry): LocalModelToolUseSupport {
  if (entry.capabilities?.trained_for_tool_use === true) {
    return 'supported';
  }
  if (entry.capabilities?.trained_for_tool_use === false) {
    return 'unsupported';
  }
  return 'unknown';
}

async function resolveOllamaModelToolUseSupport(
  baseURL: string | undefined,
  apiKey: string | undefined,
  modelId: string,
): Promise<Pick<LocalModelToolUseResult, 'support' | 'unknownReason'>> {
  const showUrl = buildOllamaManagementUrl(baseURL, '/api/show');
  const headers = buildBearerHeaders(apiKey);
  const outcome = await probeOllamaShow(showUrl, modelId.trim(), headers, OLLAMA_SHOW_PER_CALL_MS);
  switch (outcome.kind) {
    case 'ok':
      return {
        support: capabilitiesSupportTools(
          Array.isArray(outcome.body.capabilities) ? outcome.body.capabilities : undefined,
        ),
      };
    case 'model-not-installed':
      return { support: 'unknown', unknownReason: 'model-not-installed' };
    case 'runtime-unreachable':
      return { support: 'unknown', unknownReason: 'runtime-unreachable' };
    case 'indeterminate':
      return { support: 'unknown' };
  }
}

async function resolveLmStudioModelToolUseSupport(
  baseURL: string | undefined,
  apiKey: string | undefined,
  modelId: string,
): Promise<LocalModelToolUseSupport> {
  const modelsUrl = buildLmStudioManagementUrl(baseURL, '/api/v1/models');
  const token = apiKey?.trim() || 'lm-studio';

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return 'unknown';
    }

    const data = await response.json() as LmStudioModelsResponse;
    const sourceModels = Array.isArray(data.models)
      ? data.models
      : Array.isArray(data.data)
        ? data.data
        : [];

    const entry = sourceModels.find((candidate) => {
      const candidateModelId =
        typeof candidate.key === 'string' ? candidate.key.trim()
        : typeof candidate.id === 'string' ? candidate.id.trim()
        : typeof candidate.name === 'string' ? candidate.name.trim()
        : '';
      if (!candidateModelId) return false;
      return matchesLocalModelId(candidateModelId, modelId);
    });

    if (!entry) {
      return 'unknown';
    }

    return getLmStudioToolUseSupport(entry);
  } catch {
    return 'unknown';
  }
}

export async function resolveLocalModelToolUseSupport(options: {
  modelProvider: string | null | undefined;
  baseURL?: string;
  apiKey?: string;
  modelId: string;
}): Promise<LocalModelToolUseResult> {
  const runtime = getLocalModelProviderRuntime(options.modelProvider);
  if (!runtime) {
    return { runtime: null, support: 'unknown' };
  }

  const trimmedModelId = options.modelId.trim();
  if (!trimmedModelId) {
    return { runtime, support: 'unknown' };
  }

  if (runtime === 'ollama') {
    const { support, unknownReason } = await resolveOllamaModelToolUseSupport(
      options.baseURL,
      options.apiKey,
      trimmedModelId,
    );
    return unknownReason ? { runtime, support, unknownReason } : { runtime, support };
  }

  const support = await resolveLmStudioModelToolUseSupport(options.baseURL, options.apiKey, trimmedModelId);
  return { runtime, support };
}

const LOCAL_RUNTIME_LABELS: Record<LocalRuntime, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

/**
 * Maps a tool-use probe result to the user-facing turn error, or null when the
 * turn may proceed. The "is not running" wording is load-bearing: the renderer
 * (thread-error-display) classifies runtime-name + "not running" messages into
 * the dedicated "start your local runtime" error UI.
 */
export function formatLocalModelToolUseError(
  result: LocalModelToolUseResult,
  modelId: string,
): string | null {
  if (!result.runtime || result.support === 'supported') {
    return null;
  }
  const label = LOCAL_RUNTIME_LABELS[result.runtime];
  if (result.unknownReason === 'runtime-unreachable') {
    return `${label} is not running or not reachable. Start ${label} and try again.`;
  }
  if (result.unknownReason === 'model-not-installed') {
    return `${label} model "${modelId}" is not installed. Pull it with "ollama pull ${modelId}" or pick a different model in Settings, then start a new chat.`;
  }
  const reason = result.support === 'unsupported'
    ? 'does not support tools'
    : 'could not be verified for tool use';
  return `${label} model "${modelId}" ${reason}. Change the model in Settings and start a new chat.`;
}

export async function probeResponsesApiSupport(baseURL: string): Promise<{
  supported: boolean;
  reachable: boolean;
}> {
  try {
    const trimmed = baseURL.trim();
    const base = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    const url = new URL('responses', base).href;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // NOTE(victor): Verified with live probes on 2026-04-19 against
      // OpenRouter, OpenAI, Ollama, and LM Studio. A malformed payload like
      // { input: "probe" } hits auth/request-shape validation and returns
      // 400/401 on supported /responses endpoints. A fake model payload like
      // { model: "probe", input: "probe" } can trigger provider-specific
      // model lookup errors instead (for example Ollama returns 404 model not
      // found, and OpenRouter/Ollama issue #1012 showed model-specific errors
      // being misread as missing endpoint support). Do not change this probe
      // back to a fake-model request unless you re-verify those providers.
      body: JSON.stringify({ input: 'probe' }),
      signal: AbortSignal.timeout(5000),
    });
    return { supported: response.status !== 404, reachable: true };
  } catch {
    return { supported: true, reachable: false };
  }
}

// Query Ollama's `/api/version` endpoint. Returns the version string (e.g.
// "0.13.4") or undefined when the server is unreachable or omits it. Cheap
// (no model load), so it runs alongside the `/api/tags` status probe.
async function fetchOllamaVersion(
  baseURL: string | undefined,
  headers: Record<string, string>,
): Promise<string | undefined> {
  const versionUrl = buildOllamaManagementUrl(baseURL, '/api/version');
  try {
    const response = await fetch(versionUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(OLLAMA_SHOW_PER_CALL_MS),
    });
    if (!response.ok) return undefined;
    const data = await response.json() as { version?: unknown };
    const version = typeof data.version === 'string' ? data.version.trim() : '';
    return version || undefined;
  } catch {
    return undefined;
  }
}

// Lightweight standalone version probe for callers that only need the version
// (e.g. enriching a turn-error message), without the full model/capability scan.
export async function getOllamaVersion(baseURL?: string, apiKey?: string): Promise<string | undefined> {
  return fetchOllamaVersion(baseURL, buildBearerHeaders(apiKey));
}

export async function getOllamaStatus(baseURL?: string, apiKey?: string): Promise<OllamaStatus> {
  const statusUrl = buildOllamaManagementUrl(baseURL, '/api/tags');
  const showUrl = buildOllamaManagementUrl(baseURL, '/api/show');
  const headers = buildBearerHeaders(apiKey);
  const versionPromise = fetchOllamaVersion(baseURL, headers);

  try {
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { running: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json() as { models?: OllamaTagEntry[] };

    const chatEntries: Array<{ name: string; digest: string; entry: OllamaTagEntry }> = [];
    const seen = new Set<string>();
    for (const entry of data.models || []) {
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name || seen.has(name)) continue;
      if (isLikelyEmbeddingModelId(name)) continue;
      seen.add(name);
      const digest = typeof entry.digest === 'string' ? entry.digest.trim() : '';
      chatEntries.push({ name, digest, entry });
    }

    const totalChatModels = chatEntries.length;

    // Identify cache misses by digest -- only probe models we haven't seen before
    const cacheMisses: Array<{ name: string; digest: string; index: number }> = [];
    for (let i = 0; i < chatEntries.length; i++) {
      const { digest } = chatEntries[i];
      if (!digest || !ollamaCapabilityCache.has(digest)) {
        cacheMisses.push({ name: chatEntries[i].name, digest, index: i });
      }
    }

    // Probe cache misses with bounded concurrency and overall deadline
    if (cacheMisses.length > 0) {
      const deadline = Date.now() + OLLAMA_SHOW_BUDGET_MS;

      async function probeOne(miss: { name: string; digest: string }): Promise<void> {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const outcome = await probeOllamaShow(
          showUrl, miss.name, headers, Math.min(OLLAMA_SHOW_PER_CALL_MS, remaining),
        );
        if (miss.digest && outcome.kind === 'ok') {
          const capabilities = Array.isArray(outcome.body.capabilities) ? outcome.body.capabilities : [];
          ollamaCapabilityCache.set(miss.digest, capabilities);
        }
      }

      for (let i = 0; i < cacheMisses.length && Date.now() < deadline; i += OLLAMA_SHOW_CONCURRENCY) {
        const batch = cacheMisses.slice(i, i + OLLAMA_SHOW_CONCURRENCY);
        await Promise.allSettled(batch.map((miss) => probeOne(miss)));
      }
    }

    const ollamaModels: OllamaModelInfo[] = chatEntries.map(({ name, digest, entry }) => {
      const capabilities = (digest && ollamaCapabilityCache.get(digest)) || [];
      const toolUseSupport = capabilitiesSupportTools(capabilities);
      const paramsString = entry.details?.parameter_size || undefined;
      return { id: name, displayName: name, paramsString, toolUseSupport };
    });

    const models = ollamaModels.filter((model) => canSelectLocalModelForTools(model.toolUseSupport)).map((model) => model.id);

    return { running: true, version: await versionPromise, models, ollamaModels, totalChatModels };
  } catch (error) {
    return { running: false, error: String(error) };
  }
}

interface LmStudioModelEntry {
  type?: string;
  key?: string;
  id?: string;
  name?: string;
  display_name?: string;
  params_string?: string;
  capabilities?: { trained_for_tool_use?: boolean };
}

interface LmStudioModelsResponse {
  models?: LmStudioModelEntry[];
  data?: LmStudioModelEntry[];
}

function extractLmStudioResponseModels(data: LmStudioModelsResponse): LmStudioModelEntry[] {
  if (Array.isArray(data.models)) {
    return data.models;
  }
  if (Array.isArray(data.data)) {
    return data.data;
  }
  return [];
}

function extractLmStudioModelId(entry: LmStudioModelEntry): string {
  if (typeof entry.key === 'string' && entry.key.trim()) {
    return entry.key.trim();
  }
  if (typeof entry.id === 'string' && entry.id.trim()) {
    return entry.id.trim();
  }
  if (typeof entry.name === 'string' && entry.name.trim()) {
    return entry.name.trim();
  }
  return '';
}

function extractLmStudioDisplayName(entry: LmStudioModelEntry, modelId: string): string {
  if (typeof entry.display_name === 'string' && entry.display_name.trim()) {
    return entry.display_name.trim();
  }
  if (typeof entry.name === 'string' && entry.name.trim()) {
    return entry.name.trim();
  }
  return modelId;
}

export function buildLmStudioInferenceUrl(baseURL: string | undefined): string {
  const candidate = baseURL?.trim() || DEFAULT_LM_STUDIO_BASE_URL;

  try {
    const parsed = new URL(candidate);
    let path = trimTrailingSlash(parsed.pathname || '');

    if (path === '/') {
      path = '';
    }

    // Ensure the path ends with /v1 so we can append /models
    if (!path.endsWith('/v1')) {
      path = `${path}/v1`;
    }

    parsed.pathname = `${path}/models`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return `${DEFAULT_LM_STUDIO_BASE_URL}/models`;
  }
}

export async function getLmStudioStatus(baseURL?: string, apiKey?: string): Promise<LmStudioStatus> {
  const managementUrl = buildLmStudioManagementUrl(baseURL, '/api/v1/models');
  const inferenceUrl = buildLmStudioInferenceUrl(baseURL);
  const token = apiKey?.trim() || 'lm-studio';
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const [managementResult, inferenceResult] = await Promise.allSettled([
      fetch(managementUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      }),
      fetch(inferenceUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(3000),
      }),
    ]);

    let managementReachable = false;
    let inferenceReachable = false;
    const errors: string[] = [];

    const loadModels = async (
      result: PromiseSettledResult<Response>,
      label: 'management' | 'inference',
    ): Promise<LmStudioModelEntry[]> => {
      if (result.status === 'rejected') {
        errors.push(`${label}: ${String(result.reason)}`);
        return [];
      }

      if (!result.value.ok) {
        errors.push(`${label}: HTTP ${result.value.status}`);
        return [];
      }

      if (label === 'management') {
        managementReachable = true;
      } else {
        inferenceReachable = true;
      }

      try {
        const data = await result.value.json() as LmStudioModelsResponse;
        return extractLmStudioResponseModels(data);
      } catch (error) {
        errors.push(`${label}: ${String(error)}`);
        return [];
      }
    };

    const [managementModels, inferenceModels] = await Promise.all([
      loadModels(managementResult, 'management'),
      loadModels(inferenceResult, 'inference'),
    ]);

    if (!managementReachable && !inferenceReachable) {
      return { running: false, error: errors.join('; ') || 'LM Studio not reachable' };
    }

    const mergedModels = new Map<string, LmStudioModelInfo>();

    const mergeEntries = (entries: LmStudioModelEntry[], preferMetadata: boolean): void => {
      for (const entry of entries) {
        const modelId = extractLmStudioModelId(entry);
        if (!modelId) continue;
        const modelKey = getLocalModelMatchKey(modelId);

        const modelType = typeof entry.type === 'string' ? entry.type : undefined;
        if (!isLmStudioModelUsableForChat(modelId, modelType)) continue;

        const displayName = extractLmStudioDisplayName(entry, modelId);
        const paramsString = typeof entry.params_string === 'string' && entry.params_string.trim()
          ? entry.params_string.trim()
          : undefined;
        const toolUseSupport = getLmStudioToolUseSupport(entry);
        const existing = mergedModels.get(modelKey);

        if (!existing) {
          mergedModels.set(modelKey, {
            id: modelId,
            displayName,
            paramsString,
            toolUseSupport,
          });
          continue;
        }

        const nextToolUseSupport = toolUseSupport === 'unknown'
          ? existing.toolUseSupport
          : preferMetadata || existing.toolUseSupport === 'unknown'
            ? toolUseSupport
            : existing.toolUseSupport;

        mergedModels.set(modelKey, {
          id: existing.id,
          displayName: existing.displayName === existing.id ? displayName : existing.displayName,
          paramsString: existing.paramsString || paramsString,
          toolUseSupport: nextToolUseSupport,
        });
      }
    };

    mergeEntries(inferenceModels, false);
    mergeEntries(managementModels, true);

    const lmStudioModels = Array.from(mergedModels.values());
    const totalChatModels = lmStudioModels.length;
    const models = lmStudioModels.filter((model) => canSelectLocalModelForTools(model.toolUseSupport)).map((model) => model.id);

    return {
      running: true,
      models,
      lmStudioModels,
      totalChatModels,
      inferenceAvailable: inferenceReachable,
    };
  } catch (error) {
    return { running: false, error: String(error) };
  }
}

// ============================================================================
// Environment API Key Detection
// ============================================================================

// EnvApiKey, EnvApiKeysResult imported from shared/types/provider

/**
 * Mask an API key for display (first 4 + ... + last 4 chars)
 */
function maskApiKey(key: string): string {
  if (key.length <= 12) {
    return key.slice(0, 4) + '...';
  }
  return key.slice(0, 4) + '...' + key.slice(-4);
}

/**
 * Detect API keys from environment variables
 * Returns masked versions for security
 */
export function getEnvApiKeys(): EnvApiKeysResult {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  return {
    openai: {
      found: !!openaiKey && openaiKey.length > 0,
      masked: openaiKey ? maskApiKey(openaiKey) : undefined,
    },
    anthropic: {
      found: !!anthropicKey && anthropicKey.length > 0,
      masked: anthropicKey ? maskApiKey(anthropicKey) : undefined,
    },
    openrouter: {
      found: !!openrouterKey && openrouterKey.length > 0,
      masked: openrouterKey ? maskApiKey(openrouterKey) : undefined,
    },
    groq: {
      found: !!groqKey && groqKey.length > 0,
      masked: groqKey ? maskApiKey(groqKey) : undefined,
    },
    deepseek: {
      found: !!deepseekKey && deepseekKey.length > 0,
      masked: deepseekKey ? maskApiKey(deepseekKey) : undefined,
    },
  };
}

/**
 * Get an API key from environment by type
 * Returns the full key (for use when creating profiles)
 */
export function getEnvApiKey(type: EnvApiKeyType): string | null {
  switch (type) {
    case 'openai':
      return process.env.OPENAI_API_KEY || null;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY || null;
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY || null;
    case 'groq':
      return process.env.GROQ_API_KEY || null;
    case 'deepseek':
      return process.env.DEEPSEEK_API_KEY || null;
    default:
      return null;
  }
}

// ============================================================================
// Ollama Model Pull
// ============================================================================

export interface OllamaPullProgress {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  done?: boolean;
  error?: string;
  code?: string;
}

export interface LMStudioDownloadProgress {
  status?: string;
  total?: number;
  completed?: number;
  progress?: number;
  maxProgress?: number;
  text?: string;
  jobId?: string;
  done?: boolean;
  error?: string;
  code?: string;
}

/**
 * Pull (download) an Ollama model.
 * Returns an async generator that yields progress events.
 */
export async function* pullOllamaModel(model: string, baseURL?: string, apiKey?: string): AsyncGenerator<OllamaPullProgress> {
  const statusUrl = buildOllamaManagementUrl(baseURL, '/api/tags');
  const pullUrl = buildOllamaManagementUrl(baseURL, '/api/pull');
  const headers = buildBearerHeaders(apiKey);

  // Check if Ollama is running first
  const statusCheck = await fetch(statusUrl, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);

  if (!statusCheck || !statusCheck.ok) {
    yield {
      error: 'Ollama is not running. Please install and start Ollama first.',
      code: 'OLLAMA_NOT_RUNNING',
    };
    return;
  }

  // Start the pull request to Ollama
  const pullResponse = await fetch(pullUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model, stream: true }),
  });

  if (!pullResponse.ok) {
    const errorData = await pullResponse.json().catch(() => ({})) as { error?: string };
    yield {
      error: errorData.error || `HTTP ${pullResponse.status}`,
      code: 'PULL_FAILED',
    };
    return;
  }

  const reader = pullResponse.body?.getReader();
  if (!reader) {
    yield { error: 'No response body', code: 'NO_BODY' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);

          if (data.error) {
            yield { error: data.error, code: 'MODEL_ERROR' };
            continue;
          }

          yield {
            status: data.status,
            digest: data.digest,
            total: data.total,
            completed: data.completed,
          };

          if (data.status === 'success') {
            yield { done: true, status: 'success' };
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer);
        if (data.status === 'success') {
          yield { done: true, status: 'success' };
        }
      } catch {
        // Ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface LmStudioDownloadResponse {
  job_id?: string;
  status?: string;
  downloaded_bytes?: number;
  total_size_bytes?: number;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

/**
 * Download a model through LM Studio.
 * Returns an async generator that yields progress events.
 */
export async function* downloadLmStudioModel(model: string, baseURL?: string): AsyncGenerator<LMStudioDownloadProgress> {
  const normalizedModel = model.trim();

  if (!normalizedModel) {
    yield { error: 'Model is required.', code: 'MODEL_REQUIRED' };
    return;
  }

  const modelsUrl = buildLmStudioManagementUrl(baseURL, '/api/v1/models');
  const downloadUrl = buildLmStudioManagementUrl(baseURL, '/api/v1/models/download');

  // Check if LM Studio is running first
  const statusCheck = await fetch(modelsUrl, {
    method: 'GET',
    headers: { Authorization: 'Bearer lm-studio' },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);

  if (!statusCheck || !statusCheck.ok) {
    yield {
      error: 'LM Studio is not running. Start LM Studio and enable the local server first.',
      code: 'LM_STUDIO_NOT_RUNNING',
    };
    return;
  }

  const startResponse = await fetch(downloadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lm-studio' },
    body: JSON.stringify({ model: normalizedModel }),
    signal: AbortSignal.timeout(10000),
  });

  if (!startResponse.ok) {
    const errorData = await startResponse.json().catch(() => ({})) as { error?: string };
    yield {
      error: errorData.error || `HTTP ${startResponse.status}`,
      code: 'DOWNLOAD_FAILED',
    };
    return;
  }

  const startData = await startResponse.json().catch(() => ({})) as LmStudioDownloadResponse;
  const jobId = startData.job_id;

  if (!jobId) {
    yield {
      error: 'LM Studio did not return a download job id.',
      code: 'MISSING_JOB_ID',
    };
    return;
  }

  yield {
    jobId,
    status: startData.status,
    completed: typeof startData.downloaded_bytes === 'number' ? startData.downloaded_bytes : undefined,
    total: typeof startData.total_size_bytes === 'number' ? startData.total_size_bytes : undefined,
  };

  const maxPolls = 1800; // 30 minutes at 1s intervals
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const statusUrl = buildLmStudioDownloadStatusUrl(baseURL, jobId);
    const statusResponse = await fetch(statusUrl, {
      method: 'GET',
      headers: { Authorization: 'Bearer lm-studio' },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);

    if (!statusResponse || !statusResponse.ok) {
      yield {
        jobId,
        error: 'Failed to read LM Studio download status.',
        code: 'DOWNLOAD_STATUS_FAILED',
      };
      return;
    }

    const statusPayload = await statusResponse.json().catch(() => ({})) as LmStudioDownloadResponse;

    yield {
      jobId,
      status: statusPayload.status,
      completed: typeof statusPayload.downloaded_bytes === 'number' ? statusPayload.downloaded_bytes : undefined,
      total: typeof statusPayload.total_size_bytes === 'number' ? statusPayload.total_size_bytes : undefined,
    };

    if (statusPayload.status === 'completed') {
      yield { jobId, done: true, status: 'success' };
      return;
    }

    if (statusPayload.status === 'failed') {
      yield {
        jobId,
        error: statusPayload.error || 'LM Studio failed to download this model.',
        code: 'MODEL_ERROR',
      };
      return;
    }
  }

  yield {
    jobId,
    error: 'Timed out waiting for LM Studio download to finish.',
    code: 'DOWNLOAD_TIMEOUT',
  };
}

// ============================================================================
// Claude Code Operations
// ============================================================================

import { exec, execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Store for active login processes
const activeProcesses = new Map<string, ChildProcess>();

// Cache resolved path to avoid repeated lookups
// TTL ensures fresh installs/uninstalls are detected without restart
const CACHE_TTL_MS = 30_000; // 30 seconds
let cachedClaudePath: string | null | undefined = undefined;
let claudePathCachedAt = 0;

/**
 * Common locations where Claude Code CLI might be installed
 */
function getCommonClaudePaths(): string[] {
  const homeDir = os.homedir();

  if (process.platform === 'win32') {
    return [
      // Native installer (claude.ai/install.ps1 / winget)
      path.join(homeDir, '.local', 'bin', 'claude.exe'),
      // Legacy installer location
      path.join(homeDir, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      // npm global
      path.join(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      path.join(homeDir, 'AppData', 'Roaming', 'npm', 'claude.ps1'),
      // pnpm global
      path.join(homeDir, 'AppData', 'Local', 'pnpm', 'claude.cmd'),
      // Yarn global
      path.join(homeDir, 'AppData', 'Local', 'Yarn', '.bin', 'claude.cmd'),
      // bun global
      path.join(homeDir, '.bun', 'bin', 'claude.exe'),
      // Volta
      path.join(homeDir, '.volta', 'bin', 'claude.exe'),
      // mise shims
      path.join(homeDir, 'AppData', 'Local', 'mise', 'shims', 'claude.exe'),
      path.join(homeDir, 'AppData', 'Local', 'mise', 'shims', 'claude.cmd'),
      // System-wide install
      'C:\\Program Files\\Claude\\claude.exe',
      'C:\\Program Files (x86)\\Claude\\claude.exe',
    ];
  }

  return [
    // Native installer (claude.ai/install.sh) — primary location
    path.join(homeDir, '.claude', 'bin', 'claude'),
    // Native installer — secondary location
    path.join(homeDir, '.local', 'bin', 'claude'),
    // Homebrew (Apple Silicon)
    '/opt/homebrew/bin/claude',
    // Homebrew (Intel) / system npm default prefix
    '/usr/local/bin/claude',
    // npm global (various locations)
    path.join(homeDir, '.npm-global', 'bin', 'claude'),
    path.join(homeDir, '.npm', 'bin', 'claude'),
    // bun global
    path.join(homeDir, '.bun', 'bin', 'claude'),
    // Volta
    path.join(homeDir, '.volta', 'bin', 'claude'),
    // pnpm global (macOS)
    path.join(homeDir, 'Library', 'pnpm', 'claude'),
    // pnpm global (Linux / XDG)
    path.join(homeDir, '.local', 'share', 'pnpm', 'claude'),
    // Yarn global
    path.join(homeDir, '.yarn', 'bin', 'claude'),
    // asdf shim
    path.join(homeDir, '.asdf', 'shims', 'claude'),
    // mise shim
    path.join(homeDir, '.local', 'share', 'mise', 'shims', 'claude'),
    // proto shim
    path.join(homeDir, '.proto', 'shims', 'claude'),
    path.join(homeDir, '.proto', 'bin', 'claude'),
    // Nix profile
    path.join(homeDir, '.nix-profile', 'bin', 'claude'),
    // Linuxbrew
    '/home/linuxbrew/.linuxbrew/bin/claude',
    // Linux standard
    '/usr/bin/claude',
  ];
}

/**
 * Resolve the path to the Claude Code CLI binary.
 *
 * Priority:
 * 1. User-configured path (from config)
 * 2. Check common installation locations
 * 3. Try PATH (works if fix-path has run in Electron main)
 *
 * Returns null if not found.
 */
export async function resolveClaudePath(): Promise<string | null> {
  const now = Date.now();
  const cacheExpired = (now - claudePathCachedAt) > CACHE_TTL_MS;

  if (cachedClaudePath !== undefined && !cacheExpired) {
    // Revalidate that a cached positive result still exists on disk
    if (cachedClaudePath !== null && !fs.existsSync(cachedClaudePath)) {
      cachedClaudePath = undefined; // Binary was removed, re-resolve
    } else {
      return cachedClaudePath;
    }
  }

  function cacheAndReturn(result: string | null): string | null {
    cachedClaudePath = result;
    claudePathCachedAt = Date.now();
    return result;
  }

  // 1. Check user-configured path first
  try {
    const config = await configStore.loadConfig();
    const customPath = config.claudeCodePath;
    if (customPath && typeof customPath === 'string') {
      if (fs.existsSync(customPath)) {
        return cacheAndReturn(customPath);
      }
    }
  } catch {
    // Ignore config errors
  }

  // 2. Check common installation locations
  for (const claudePath of getCommonClaudePaths()) {
    if (fs.existsSync(claudePath)) {
      return cacheAndReturn(claudePath);
    }
  }

  // 3. Search PATH directly (no shell commands)
  const pathEnv = process.env.PATH || process.env.Path || '';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const exeNames = process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd', 'claude.bat']
    : ['claude'];

  for (const dir of pathEnv.split(pathSep)) {
    if (!dir) continue;
    for (const exe of exeNames) {
      const candidate = path.join(dir, exe);
      if (fs.existsSync(candidate)) {
        return cacheAndReturn(candidate);
      }
    }
  }

  return cacheAndReturn(null);
}

/**
 * Clear the cached claude path (e.g., after user changes config)
 */
export function clearClaudePathCache(): void {
  cachedClaudePath = undefined;
}

// ClaudeCodeStatus imported from shared/types/provider

/**
 * Check if Claude Code CLI is installed and if the user is logged in
 * Auth check uses macOS Keychain directly for instant response
 */
export async function getClaudeCodeStatus(): Promise<ClaudeCodeStatus> {
  // Find claude binary
  const claudePath = await resolveClaudePath();

  if (!claudePath) {
    return {
      installed: false,
      loggedIn: false,
    };
  }

  // Check version to confirm it works
  let version: string | undefined;
  try {
    const { stdout } = await execFileAsync(claudePath, ['--version'], {
      timeout: 5000,
      encoding: 'utf-8',
    });
    version = stdout.trim();
  } catch {
    // Binary exists but doesn't work
    return {
      installed: false,
      loggedIn: false,
      error: `Found claude at ${claudePath} but it failed to run`,
    };
  }

  let loggedIn = false;
  try {
    if (process.platform === 'darwin') {
      await execAsync('security find-generic-password -s "Claude Code-credentials"', {
        timeout: 2000,
        encoding: 'utf-8',
      });
      loggedIn = true;
    } else {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (fs.existsSync(credentialsPath)) {
        const stats = fs.statSync(credentialsPath);
        loggedIn = stats.size > 2;
      }
    }
  } catch {
    loggedIn = false;
  }

  return {
    installed: true,
    loggedIn,
    version,
    path: claudePath,
  };
}

// ClaudeCodeLoginResult imported from shared/types/provider

/**
 * Run claude login command
 * Note: This opens an interactive browser flow, so we just spawn the process
 */
export async function runClaudeLogin(): Promise<ClaudeCodeLoginResult> {
  const claudePath = await resolveClaudePath();

  if (!claudePath) {
    return {
      success: false,
      error: 'Claude Code CLI not found. Please install it first.',
    };
  }

  return new Promise((resolve) => {
    // Kill any existing login process
    const existingProcess = activeProcesses.get('login');
    if (existingProcess) {
      existingProcess.kill();
      activeProcesses.delete('login');
    }

    // Run: claude login (using resolved path)
    const loginProcess = spawn(claudePath, ['login'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeProcesses.set('login', loginProcess);

    let stdout = '';
    let stderr = '';

    loginProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    loginProcess.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    loginProcess.on('close', (code) => {
      activeProcesses.delete('login');

      if (code === 0) {
        resolve({
          success: true,
          output: stdout,
        });
      } else {
        resolve({
          success: false,
          error: stderr || `Login failed with code ${code}`,
          output: stdout,
        });
      }
    });

    loginProcess.on('error', (error) => {
      activeProcesses.delete('login');
      resolve({
        success: false,
        error: error.message,
      });
    });

    // Timeout after 5 minutes (login is interactive)
    setTimeout(() => {
      if (activeProcesses.has('login')) {
        loginProcess.kill();
        activeProcesses.delete('login');
        resolve({
          success: false,
          error: 'Login timed out after 5 minutes',
        });
      }
    }, 5 * 60 * 1000);
  });
}

/**
 * Set custom Claude Code path and clear cache
 */
export async function setClaudeCodePath(customPath: string | null): Promise<{ success: boolean; error?: string }> {
  try {
    // Validate path if provided
    if (customPath && !fs.existsSync(customPath)) {
      return { success: false, error: `Path does not exist: ${customPath}` };
    }

    // Update config
    const config = await configStore.loadConfig();
    if (customPath) {
      config.claudeCodePath = customPath;
    } else {
      delete config.claudeCodePath;
    }
    await configStore.saveConfig(config);

    // Clear cache so next lookup uses new path
    clearClaudePathCache();

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Codex CLI (OpenAI) Status Functions
// ============================================================================

// Cache resolved path to avoid repeated lookups
let cachedCodexPath: string | null | undefined = undefined;
let codexPathCachedAt = 0;

// Cache resolved GitHub CLI path
let cachedGitHubCliPath: string | null | undefined = undefined;
let gitHubCliPathCachedAt = 0;

function getCommonGitHubCliPaths(): string[] {
  const homeDir = os.homedir();

  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
      path.join(homeDir, 'AppData', 'Local', 'Programs', 'GitHub CLI', 'gh.exe'),
      path.join(homeDir, 'AppData', 'Roaming', 'npm', 'gh.cmd'),
      path.join(homeDir, 'AppData', 'Roaming', 'npm', 'gh.ps1'),
    ];
  }

  return [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    path.join(homeDir, '.local', 'bin', 'gh'),
    path.join(homeDir, '.nix-profile', 'bin', 'gh'),
  ];
}

export async function resolveGitHubCliPath(): Promise<string | null> {
  const now = Date.now();
  const cacheExpired = (now - gitHubCliPathCachedAt) > CACHE_TTL_MS;

  if (cachedGitHubCliPath !== undefined && !cacheExpired) {
    if (cachedGitHubCliPath !== null && !fs.existsSync(cachedGitHubCliPath)) {
      cachedGitHubCliPath = undefined;
    } else {
      return cachedGitHubCliPath;
    }
  }

  function cacheAndReturn(result: string | null): string | null {
    cachedGitHubCliPath = result;
    gitHubCliPathCachedAt = Date.now();
    return result;
  }

  for (const ghPath of getCommonGitHubCliPaths()) {
    if (fs.existsSync(ghPath)) {
      return cacheAndReturn(ghPath);
    }
  }

  const pathEnv = process.env.PATH || process.env.Path || '';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const exeNames = process.platform === 'win32'
    ? ['gh.exe', 'gh.cmd', 'gh.bat']
    : ['gh'];

  for (const dir of pathEnv.split(pathSep)) {
    if (!dir) continue;
    for (const exe of exeNames) {
      const candidate = path.join(dir, exe);
      if (fs.existsSync(candidate)) {
        return cacheAndReturn(candidate);
      }
    }
  }

  return cacheAndReturn(null);
}

type GitHubAuthSource = 'gh-cli' | 'env';

export function getGitHubMcpAuthSetupErrorMessage(installed: boolean): string {
  const setupStep = 'Run "gh auth login" in a terminal, or set GH_TOKEN/GITHUB_TOKEN before starting Interpreter.';
  if (installed) {
    return `GitHub CLI is installed but not authenticated. ${setupStep}`;
  }
  return `GitHub CLI is not installed or not authenticated. ${setupStep}`;
}

interface GitHubCliAuthInternal {
  installed: boolean;
  loggedIn: boolean;
  token: string | null;
  source?: GitHubAuthSource;
  path?: string;
  error?: string;
}

export interface GitHubCliAuthStatus {
  installed: boolean;
  loggedIn: boolean;
  source?: GitHubAuthSource;
  path?: string;
  error?: string;
}

async function resolveGitHubCliAuth(): Promise<GitHubCliAuthInternal> {
  const envToken = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  const ghPath = await resolveGitHubCliPath();

  if (!ghPath) {
    if (envToken) {
      return {
        installed: false,
        loggedIn: true,
        token: envToken || null,
        source: 'env',
      };
    }
    return {
      installed: false,
      loggedIn: false,
      token: null,
      error: getGitHubMcpAuthSetupErrorMessage(false),
    };
  }

  try {
    const { stdout } = await execFileAsync(ghPath, ['auth', 'token'], {
      timeout: 4000,
      encoding: 'utf-8',
      env: process.env,
    });
    const token = (stdout || '').trim();
    if (token) {
      return {
        installed: true,
        loggedIn: true,
        token,
        source: 'gh-cli',
        path: ghPath,
      };
    }
  } catch {
    // fall through to env token fallback
  }

  if (envToken) {
    return {
      installed: true,
      loggedIn: true,
      token: envToken || null,
      source: 'env',
      path: ghPath,
    };
  }

  return {
    installed: true,
    loggedIn: false,
    token: null,
    path: ghPath,
    error: getGitHubMcpAuthSetupErrorMessage(true),
  };
}

export async function getGitHubCliAuth(): Promise<GitHubCliAuthStatus> {
  const { token: _token, ...status } = await resolveGitHubCliAuth();
  return status;
}

export async function addGitHubMcpServerFromCliAuth(): Promise<GitHubCliAuthStatus & {
  success: boolean;
  serverId?: string;
}> {
  const auth = await resolveGitHubCliAuth();
  const { token, ...status } = auth;

  if (!auth.loggedIn || !token) {
    return {
      success: false,
      ...status,
      error: auth.error ?? getGitHubMcpAuthSetupErrorMessage(auth.installed),
    };
  }

  try {
    const { addToolServer } = await import('./toolServers');
    const { serverId } = await addToolServer({
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      name: 'GitHub',
      enabled: true,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return {
      success: true,
      serverId,
      ...status,
    };
  } catch (error: any) {
    const message = error?.message || 'Failed to add GitHub MCP server';
    if (typeof message === 'string' && message.toLowerCase().includes('already exists')) {
      try {
        const { updateToolServer } = await import('./toolServers');
        await updateToolServer('github', {
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          enabled: true,
        });
        return {
          success: true,
          serverId: 'github',
          ...status,
        };
      } catch (updateError: any) {
        return {
          success: false,
          ...status,
          error: updateError?.message || 'Failed to update existing GitHub MCP server',
        };
      }
    }

    return {
      success: false,
      ...status,
      error: message,
    };
  }
}

/**
 * Common locations where Codex CLI might be installed
 */
function getCommonCodexPaths(): string[] {
  const homeDir = os.homedir();

  if (process.platform === 'win32') {
    return [
      // npm global
      path.join(homeDir, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
      path.join(homeDir, 'AppData', 'Roaming', 'npm', 'codex.ps1'),
      // pnpm global
      path.join(homeDir, 'AppData', 'Local', 'pnpm', 'codex.cmd'),
      // Yarn global
      path.join(homeDir, 'AppData', 'Local', 'Yarn', '.bin', 'codex.cmd'),
      // bun global
      path.join(homeDir, '.bun', 'bin', 'codex.exe'),
      // Volta
      path.join(homeDir, '.volta', 'bin', 'codex.exe'),
      path.join(homeDir, 'AppData', 'Local', 'Volta', 'bin', 'codex.exe'),
      // mise shims
      path.join(homeDir, 'AppData', 'Local', 'mise', 'shims', 'codex.exe'),
      path.join(homeDir, 'AppData', 'Local', 'mise', 'shims', 'codex.cmd'),
    ];
  }

  return [
    // Standard install location
    path.join(homeDir, '.local', 'bin', 'codex'),
    // Homebrew (Apple Silicon)
    '/opt/homebrew/bin/codex',
    // Homebrew (Intel) / system npm default prefix
    '/usr/local/bin/codex',
    // npm global (various locations)
    path.join(homeDir, '.npm-global', 'bin', 'codex'),
    path.join(homeDir, '.npm', 'bin', 'codex'),
    // bun global
    path.join(homeDir, '.bun', 'bin', 'codex'),
    // Volta
    path.join(homeDir, '.volta', 'bin', 'codex'),
    // pnpm global (macOS)
    path.join(homeDir, 'Library', 'pnpm', 'codex'),
    // pnpm global (Linux / XDG)
    path.join(homeDir, '.local', 'share', 'pnpm', 'codex'),
    // Yarn global
    path.join(homeDir, '.yarn', 'bin', 'codex'),
    // asdf shim
    path.join(homeDir, '.asdf', 'shims', 'codex'),
    // mise shim
    path.join(homeDir, '.local', 'share', 'mise', 'shims', 'codex'),
    // proto shim
    path.join(homeDir, '.proto', 'shims', 'codex'),
    path.join(homeDir, '.proto', 'bin', 'codex'),
    // Linuxbrew
    '/home/linuxbrew/.linuxbrew/bin/codex',
    // Linux standard
    '/usr/bin/codex',
  ];
}

/**
 * Resolve the path to the codex binary
 * Checks in order:
 * 1. User-configured path from config
 * 2. Common installation locations
 * 3. Try PATH (works if fix-path has run in Electron main)
 *
 * Returns null if not found.
 */
export async function resolveCodexPath(): Promise<string | null> {
  const now = Date.now();
  const cacheExpired = (now - codexPathCachedAt) > CACHE_TTL_MS;

  if (cachedCodexPath !== undefined && !cacheExpired) {
    // Revalidate that a cached positive result still exists on disk
    if (cachedCodexPath !== null && !fs.existsSync(cachedCodexPath)) {
      cachedCodexPath = undefined; // Binary was removed, re-resolve
    } else {
      return cachedCodexPath;
    }
  }

  function cacheAndReturn(result: string | null): string | null {
    cachedCodexPath = result;
    codexPathCachedAt = Date.now();
    return result;
  }

  // 1. Check user-configured path first
  try {
    const config = await configStore.loadConfig();
    const customPath = config.codexPath;
    if (customPath && typeof customPath === 'string') {
      if (fs.existsSync(customPath)) {
        return cacheAndReturn(customPath);
      }
    }
  } catch {
    // Ignore config errors
  }

  // 2. Check common installation locations
  for (const codexPath of getCommonCodexPaths()) {
    if (fs.existsSync(codexPath)) {
      return cacheAndReturn(codexPath);
    }
  }

  // 3. Search PATH directly (no shell commands)
  const pathEnv = process.env.PATH || process.env.Path || '';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const exeNames = process.platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat']
    : ['codex'];

  for (const dir of pathEnv.split(pathSep)) {
    if (!dir) continue;
    for (const exe of exeNames) {
      const candidate = path.join(dir, exe);
      if (fs.existsSync(candidate)) {
        return cacheAndReturn(candidate);
      }
    }
  }

  return cacheAndReturn(null);
}

/**
 * Clear the cached codex path (e.g., after user changes config)
 */
export function clearCodexPathCache(): void {
  cachedCodexPath = undefined;
}

/**
 * Set custom Codex path and clear cache
 */
export async function setCodexPath(customPath: string | null): Promise<{ success: boolean; error?: string }> {
  try {
    // Validate path if provided
    if (customPath && !fs.existsSync(customPath)) {
      return { success: false, error: `Path does not exist: ${customPath}` };
    }

    // Update config
    const config = await configStore.loadConfig();
    if (customPath) {
      config.codexPath = customPath;
    } else {
      delete config.codexPath;
    }
    await configStore.saveConfig(config);

    // Clear cache so next lookup uses new path
    clearCodexPathCache();

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Clear all binary path caches and re-resolve.
 * Used by the "rescan" button in settings to detect newly installed binaries.
 */
export async function rescanBinaryPaths(): Promise<{
  claude: { found: boolean; path?: string };
  codex: { found: boolean; path?: string };
}> {
  clearClaudePathCache();
  clearCodexPathCache();
  const [claudePath, codexPath] = await Promise.all([
    resolveClaudePath(),
    resolveCodexPath(),
  ]);
  return {
    claude: { found: !!claudePath, path: claudePath ?? undefined },
    codex: { found: !!codexPath, path: codexPath ?? undefined },
  };
}

// CodexStatus imported from shared/types/provider

/**
 * Check if Codex CLI is installed and if the user is logged in
 * Auth check uses OpenAI token file for instant response
 */
export async function getCodexStatus(): Promise<CodexStatus> {
  // Find codex binary
  const codexPath = await resolveCodexPath();

  if (!codexPath) {
    return {
      installed: false,
      loggedIn: false,
    };
  }

  // Check version to confirm it works
  let version: string | undefined;
  try {
    const { stdout } = await execFileAsync(codexPath, ['--version'], {
      timeout: 5000,
      encoding: 'utf-8',
    });
    version = stdout.trim();
  } catch {
    // Binary exists but doesn't work
    return {
      installed: false,
      loggedIn: false,
      error: `Found codex at ${codexPath} but it failed to run`,
    };
  }

  // Check auth by looking for Codex credentials
  // Codex supports:
  // 1. OPENAI_API_KEY env var
  // 2. OAuth via `codex auth` stored in:
  //    - ~/.codex/auth.json (file-based storage)
  //    - macOS Keychain under "Codex Auth" service (keyring storage)
  let loggedIn = false;

  // Check environment variable first
  if (process.env.OPENAI_API_KEY) {
    loggedIn = true;
  }

  // Check file-based OAuth token storage (~/.codex/auth.json)
  if (!loggedIn) {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    if (fs.existsSync(authPath)) {
      try {
        const content = fs.readFileSync(authPath, 'utf-8');
        const authData = JSON.parse(content);
        // Check if there's an access token
        if (authData.access_token || authData.accessToken) {
          loggedIn = true;
        }
      } catch {
        // File exists but couldn't read or parse
      }
    }
  }

  // Check macOS Keychain for OAuth (keyring storage)
  if (!loggedIn && process.platform === 'darwin') {
    try {
      await execAsync('security find-generic-password -s "Codex Auth"', {
        timeout: 2000,
        encoding: 'utf-8',
      });
      // If command succeeds, credentials exist = logged in
      loggedIn = true;
    } catch {
      // Credentials not found in keychain
    }
  }

  return {
    installed: true,
    loggedIn,
    version,
    path: codexPath,
  };
}

/**
 * Get setup statuses for all profiles in a single round-trip.
 * Runs all detection in parallel for speed.
 */
export async function getAllProfileStatuses(isAuthenticated?: boolean): Promise<Record<string, ProfileSetupStatus>> {
  const config = await configStore.loadConfigWithModelState();
  let profiles = config.profiles ?? [];
  const localConfigs = Array.from(
    new Map(
      profiles
        .filter((profile) => profile.provider === 'local')
        .map((profile) => {
          const baseURL = (profile.baseURL || '').trim();
          const apiKey = (profile.apiKey || '').trim();
          return [`${baseURL}\n${apiKey}`, { baseURL, apiKey }] as const;
        })
    ).values()
  );

  // Run all provider checks in parallel
  const [claudeCodeResult, codexResult, oauthResult, envKeys] = await Promise.all([
    getClaudeCodeStatus().catch(() => ({ installed: false, loggedIn: false })),
    getCodexStatus().catch(() => ({ installed: false, loggedIn: false })),
    getOAuthStatus('openai').catch((): OAuthStatus => ({ isConnected: false })),
    Promise.resolve(getEnvApiKeys()),
  ]);

  if (shouldEnsureAutomaticClaudeCodeTerminalProfile(config, claudeCodeResult.installed)) {
    profiles = [...profiles, buildAutomaticClaudeCodeTerminalProfile()];
  }

  const localStatusByConfig = new Map<string, LocalRuntimeStatus>();
  await Promise.all(
    localConfigs.map(async ({ baseURL, apiKey }) => {
      const runtime = inferLocalRuntimeFromBaseUrl(baseURL || undefined);
      const status = runtime === 'lmstudio'
        ? await getLmStudioStatus(baseURL || undefined, apiKey || undefined).catch(() => ({ running: false } as LmStudioStatus))
        : await getOllamaStatus(baseURL || undefined, apiKey || undefined).catch(() => ({ running: false } as OllamaStatus));
      localStatusByConfig.set(`${baseURL}\n${apiKey}`, status);
    })
  );

  const statuses: Record<string, ProfileSetupStatus> = {};

  for (const profile of profiles) {
    const id = profile.id;
    let ready = false;
    let detail = 'Not configured';
    let badge: string | undefined;

    switch (profile.provider) {
      case 'local': {
        if (!profile.modelId) {
          detail = 'Select a local model';
          break;
        }

        ready = true;

        const localBaseUrlKey = (profile.baseURL || '').trim();
        const localApiKey = (profile.apiKey || '').trim();
        const runtimeResult = localStatusByConfig.get(`${localBaseUrlKey}\n${localApiKey}`);

        if (!runtimeResult?.running) {
          detail = 'Runtime check unavailable (will still try)';
          badge = 'Check';
          break;
        }

        const matchingLocalModel = getLocalRuntimeModels(runtimeResult)?.find((model) =>
          matchesLocalModelId(model.id, profile.modelId)
        );

        if (matchingLocalModel) {
          detail = 'Model detected';
          badge = 'Ready';
        } else {
          detail = `${profile.modelId} not detected (will still try)`;
          badge = 'Install';
        }
        break;
      }

      case 'terminal': {
        // Check based on the terminal agent type
        const tc = profile.providerConfig as import('../../shared/types/model').TerminalConfig | undefined;
        const agentId = tc?.id;
        if (agentId === 'claude-code' || tc?.command === 'claude') {
          if (claudeCodeResult.installed && claudeCodeResult.loggedIn) {
            ready = true;
            detail = 'Installed & logged in';
            badge = 'Ready';
          } else if (claudeCodeResult.installed) {
            detail = 'Installed, not logged in';
            badge = 'Installed';
          } else {
            detail = 'Not installed';
          }
        } else if (agentId === 'codex' || tc?.command === 'codex') {
          if (codexResult.installed && codexResult.loggedIn) {
            ready = true;
            detail = 'Installed & authenticated';
            badge = 'Ready';
          } else if (codexResult.installed) {
            detail = 'Installed, needs auth';
            badge = 'Installed';
          } else {
            detail = 'Not installed';
          }
        } else {
          // Custom terminal command - assume ready
          ready = true;
          detail = 'Custom terminal agent';
          badge = 'Custom';
        }
        break;
      }

      case 'agent': {
        // CLI agent (claude-code or codex terminal integration)
        if (profile.modelId === 'codex') {
          if (codexResult.installed && codexResult.loggedIn) {
            ready = true;
            detail = 'Codex installed & authenticated';
            badge = 'Ready';
          } else if (codexResult.installed) {
            detail = 'Codex installed, needs auth';
            badge = 'Installed';
          } else {
            detail = 'Codex not installed';
          }
        } else {
          if (claudeCodeResult.installed && claudeCodeResult.loggedIn) {
            ready = true;
            detail = 'Claude Code installed & logged in';
            badge = 'Ready';
          } else if (claudeCodeResult.installed) {
            detail = 'Claude Code installed, not logged in';
            badge = 'Installed';
          } else {
            detail = 'Claude Code not installed';
          }
        }
        break;
      }

      case 'hosted':
        if (isAuthenticated) {
          ready = true;
          detail = 'Interpreter-managed model, signed in';
          badge = 'Ready';
        } else {
          ready = false;
          detail = 'Interpreter-managed model, sign in required';
          badge = 'Available';
        }
        break;

      case 'openai-oauth':
        if (oauthResult.isConnected) {
          ready = true;
          detail = `Connected${oauthResult.email ? ` as ${oauthResult.email}` : ''}`;
          badge = 'Connected';
        } else {
          ready = false;
          detail = 'Sign in with OpenAI';
          badge = 'Available';
        }
        break;

      case 'api': {
        // Check if any env keys match
        const hasKey = profile.apiKey ||
          (profile.baseURL?.includes('openai') && envKeys.openai.found) ||
          (profile.baseURL?.includes('anthropic') && envKeys.anthropic.found) ||
          (profile.baseURL?.includes('openrouter') && envKeys.openrouter.found) ||
          (profile.baseURL?.includes('groq') && envKeys.groq.found);
        if (hasKey) {
          ready = true;
          detail = 'API key configured';
          badge = 'Ready';
        } else {
          detail = 'API key required';
        }
        break;
      }

      default:
        detail = 'Unknown provider';
        break;
    }

    statuses[id] = { profileId: id, ready, detail, badge };
  }

  return statuses;
}
