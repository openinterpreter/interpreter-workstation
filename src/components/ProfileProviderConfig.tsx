/**
 * ProfileProviderConfig - Inline provider configuration for profiles
 *
 * Users should always be able to pick a provider and specify a model.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Server, Terminal, Key, Download } from 'lucide-react';
import { Button } from './ui/button';
import { OpenAIIcon } from './icons/BrandIcons';
import { HostedModelPicker } from './HostedModelPicker';
import {
  CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID,
  ResponsesApiBaseUrlPicker,
} from './ResponsesApiBaseUrlPicker';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Switch } from './ui/switch';
import { Field, FieldGroup, FieldLabel, FieldDescription } from './ui/field';
import { buildProviderChange, type Profile } from '../../shared/types/profile';
import type { TerminalConfig } from '../../shared/types/model';
import { normalizeDisplayText } from '../utils/normalizeDisplayText';
import {
  classifyOpenAIOAuthModelListError,
  getOpenAIOAuthModelListErrorMessage,
} from '../lib/openaiOAuthErrors';
import {
  trackOAuthModelListFailed,
  trackOAuthSignInCompleted,
  trackOAuthSignInFailed,
  trackOAuthSignInStarted,
} from '../utils/telemetry';
import {
  getDefaultOpenAIOAuthModelId,
  PROVIDER_MODEL_DEFAULTS,
} from '../../shared/types/modelDefaults';
import { pullOllamaModel, downloadLmStudioModel } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { AuthSignIn } from './auth/AuthSignIn';
import { providers as providersIpc, openExternal } from '@/ipc';
import { cn } from '@/lib/utils';
import {
  AUTH_URL_COPIED_MESSAGE,
  AUTH_URL_OPEN_FAILED_MESSAGE,
  openAuthUrl,
} from '../utils/authUrl';
import {
  detectLocalModelServerUrl,
  findSupportedResponsesApiBaseUrlOption,
  getApiEndpointKind,
  getDefaultResponsesApiBaseURL,
  isDeepSeekApiBaseURL,
  isOllamaVersionBelowDeveloperRoleFloor,
  MIN_OLLAMA_DEVELOPER_ROLE_VERSION,
  type SupportedOpenAIOAuthModel,
  type OllamaStatus,
  type LmStudioStatus,
} from '../../shared/types/provider';
import { pickLocalModelId } from '../utils/localModelSelection';
import { PlanSectionContent } from './settings/PlanSection';
import { PROFILE_CUSTOM_MODEL_INPUT_ID, PROFILE_MODEL_SELECT_ID, PROFILE_PROVIDER_TAB_ID } from '../../shared/element-ids';
import { inferProfileIdFromEndpoint, isProfileId } from '../lib/codex/profile-options';
import { getCustomPreset } from '../lib/codex/profiles';
import type { WireApi } from '../../shared/types/model';
import {
  buildLocalModelOptions,
  DEFAULT_LOCAL_MODEL,
  getLocalDefaultBaseURL,
  inferLocalRuntime,
  localRuntimeModelIdsMatch,
  LM_STUDIO_DEFAULT_MODEL_KEY,
  resolveLocalRuntimeModelId,
  type LocalModelOption as ModelOption,
  type LocalRuntime,
} from '../utils/localModelOptions';
import {
  buildApiModelFieldConfig,
  normalizeApiModelOptions,
} from '../utils/apiProviderModelOptions';
import { ACTIVE_APP_BRAND } from '@/branding';
import { useHostedModelCatalog } from '../hooks/use-hosted-model-catalog';
import { useDeepSeekModelOptions } from '../hooks/use-deepseek-model-options';
import { useInterpreterModels } from '../hooks/use-interpreter-models';
import {
  apiPresetToOixProviderId,
  profileToOixProviderId,
} from '../lib/providers/interpreterProviderMenu';

// Base provider types
// 'agent' covers direct CLI providers (Claude Code, Codex)
type ProviderType = 'hosted' | 'local' | 'openai-oauth' | 'agent' | 'api' | 'terminal';

interface ProviderTab {
  id: ProviderType;
  label: string;
  icon: React.ReactNode;
  description: string;
}

const CUSTOM_MODEL_VALUE = '__custom_model__';
const DEFAULT_HOSTED_MODEL = PROVIDER_MODEL_DEFAULTS.hosted.main;
const DEFAULT_OPENAI_MODEL = '';
const DEFAULT_API_BASE_URL = getDefaultResponsesApiBaseURL();

// Provider config tabs.
//
// These are app-only ProviderType UI lanes, NOT oix runtime provider ids, so the
// tab list stays static (it is never passed to listInterpreterProviders). The
// settings PROVIDER LIST is driven by the app-server in the preset picker
// (ProfileManager.buildVisibleProfilePresets); this tab strip only configures an
// already-chosen lane. Each tab's MODEL list is sourced from the app-server where
// supported (hosted catalog, listOpenAIOAuthModels, useInterpreterModels for
// openai/groq), with the documented GAP-LOCAL-ENUM fallback for local runtimes
// (see localModelOptions below).
// ACP is intentionally hidden from creation UI.
const SELECTABLE_PROVIDER_TABS: ProviderTab[] = [
  {
    id: 'hosted',
    label: 'Hosted',
    icon: <ACTIVE_APP_BRAND.SymbolMark aria-hidden="true" className="size-4" />,
    description: 'Use our hosted AI service. Sign in with your account to access Claude, GPT, and other models without managing API keys.',
  },
  {
    id: 'openai-oauth',
    label: 'OpenAI',
    icon: <OpenAIIcon className="size-4" />,
    description: 'Connect your OpenAI account via OAuth. Use your existing ChatGPT subscription to access GPT models directly.',
  },
  {
    id: 'local',
    label: 'Local',
    icon: <Server className="size-4" />,
    description: 'Run models locally with Ollama or LM Studio. Keep your data private and work offline.',
  },
  {
    id: 'api',
    label: 'API',
    icon: <Key className="size-4" />,
    description: 'Connect using an API key from a supported Chat Completions or Responses API endpoint.',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: <Terminal className="size-4" />,
    description: 'Run a terminal-based coding agent like Claude Code or Interpreter in an embedded terminal with MCP tools.',
  },
  // Pre-launch hardening: hide legacy CLI Agent provider from new profile selection.
  // {
  //   id: 'agent',
  //   label: 'CLI Agent',
  //   icon: <Terminal className="size-4" />,
  //   description: 'Use Claude Code or Codex CLI as a backend provider.',
  // },
];

// Keep CLI Agent tab definition for existing profiles only.
const AGENT_TAB: ProviderTab = {
  id: 'agent',
  label: 'CLI Agent',
  icon: <Terminal className="size-4" />,
  description: 'Legacy CLI agent backend (edit existing only).',
};

const PROVIDER_TAB_BY_ID = Object.fromEntries(
  [...SELECTABLE_PROVIDER_TABS, AGENT_TAB].map((tab) => [tab.id, tab])
) as Record<ProviderType, ProviderTab>;

function getApiCodexProfileId(baseURL: string): string {
  return inferProfileIdFromEndpoint(baseURL.trim());
}

function getInitialApiBaseUrlSelectionId(profile: Profile): string {
  if (profile.provider === 'api' && profile.codexProfileId === 'custom') {
    return CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID;
  }

  return findSupportedResponsesApiBaseUrlOption(profile.provider === 'api' ? profile.baseURL : undefined)?.id
    ?? CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID;
}

type StatusTone = 'info' | 'success' | 'warning';

function StatusPanel({ tone = 'info', children }: { tone?: StatusTone; children: React.ReactNode }) {
  const toneClass =
    tone === 'success'
      ? 'border-emerald-500/46 text-foreground'
      : tone === 'warning'
        ? 'border-amber-500/46 text-foreground'
        : 'border-black/8 text-muted-foreground dark:border-white/10';

  return (
    <div className={cn('border-l-[1.5px] pl-3 pr-1 py-0.5 text-[12.5px] leading-5', toneClass)}>
      {children}
    </div>
  );
}

function ProviderPanel({
  tab: _tab,
  action,
  children,
}: {
  tab: ProviderTab;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      {action ? <div className="pt-0.5">{action}</div> : null}
      {children}
    </div>
  );
}

function getModelSelectValue(modelId: string | undefined, options: ModelOption[], allowCustomModel = true): string {
  if (modelId && options.some((option) => option.id === modelId)) {
    return modelId;
  }
  if (!allowCustomModel && modelId) return modelId;
  return CUSTOM_MODEL_VALUE;
}

function toOpenAiOAuthModelOptions(models: SupportedOpenAIOAuthModel[]): ModelOption[] {
  return normalizeApiModelOptions(models);
}

function getLocalRuntimeLabel(runtime: LocalRuntime): string {
  return runtime === 'lmstudio' ? 'LM Studio' : 'Ollama';
}

// The default wire API for a local runtime comes from its preset (Ollama and
// LM Studio both default to Chat Completions). The toggle overrides this.
function getLocalRuntimeDefaultWireApi(runtime: LocalRuntime): WireApi {
  return getCustomPreset(runtime)?.wireApi ?? 'chat';
}

function ModelSelector({
  label,
  description,
  modelId,
  options,
  onModelChange,
  customPlaceholder,
  allowCustomModel = true,
}: {
  label: string;
  description?: string;
  modelId?: string;
  options: ModelOption[];
  onModelChange: (value: string) => void;
  customPlaceholder?: string;
  allowCustomModel?: boolean;
}) {
  const { t } = useTranslation();
  const selectValue = getModelSelectValue(modelId, options, allowCustomModel);

  return (
    <FieldGroup className="gap-2">
      <Field>
        <FieldLabel>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
        <select
          data-testid={PROFILE_MODEL_SELECT_ID}
          className="w-full px-3 py-2 bg-background rounded-control text-ui-sm"
          style={{ border: 'var(--border-width) solid var(--border)' }}
          value={selectValue}
          onChange={(event) => {
            if (event.target.value === CUSTOM_MODEL_VALUE) {
              onModelChange('');
              return;
            }
            onModelChange(event.target.value);
          }}
        >
          {!allowCustomModel && modelId && !options.some((o) => o.id === modelId) && (
            <option key={modelId} value={modelId}>{modelId}</option>
          )}
          {options.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
          {allowCustomModel && (
            <option value={CUSTOM_MODEL_VALUE}>{t('settings.profiles.provider.customModelOption')}</option>
          )}
        </select>
      </Field>

      {allowCustomModel && selectValue === CUSTOM_MODEL_VALUE && (
        <Field>
          <FieldLabel>{t('settings.profiles.provider.customModelLabel')}</FieldLabel>
          <Input
            type="text"
            value={modelId || ''}
            onChange={(event) => onModelChange(event.target.value)}
            placeholder={customPlaceholder}
            data-testid={PROFILE_CUSTOM_MODEL_INPUT_ID}
          />
        </Field>
      )}
    </FieldGroup>
  );
}

/** Derive a display name from a raw model ID: replace slashes/dashes with spaces, title-case each word. */
function modelIdToDisplayName(id: string): string {
  return id
    .replace(/[/\-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

interface ProfileProviderConfigProps {
  profile: Profile;
  onChange: (updates: Partial<Profile>) => void;
}

export function ProfileProviderConfig({ profile, onChange }: ProfileProviderConfigProps) {
  "use no memo";

  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();

  const getCurrentType = (): ProviderType => {
    if (profile.provider === 'hosted' && !profile.apiKey && !profile.baseURL) return 'hosted';
    if (profile.provider === 'local') return 'local';
    if (profile.provider === 'openai-oauth') return 'openai-oauth';
    if (profile.provider === 'agent') return 'agent';
    if (profile.provider === 'terminal') return 'terminal';
    if (profile.provider === 'api') return 'api';
    if (profile.apiKey || profile.baseURL) return 'api';
    return 'hosted';
  };

  const [selectedType, setSelectedType] = useState<ProviderType>(getCurrentType);

  // API config state
  const [apiKey, setApiKey] = useState(profile.apiKey || '');
  const [apiBaseURL, setApiBaseURL] = useState(
    profile.provider === 'api' ? (profile.baseURL ?? DEFAULT_API_BASE_URL) : DEFAULT_API_BASE_URL,
  );
  const [apiBaseUrlSelectionId, setApiBaseUrlSelectionId] = useState(() => getInitialApiBaseUrlSelectionId(profile));
  const [apiUsesChatCompletions, setApiUsesChatCompletions] = useState(
    profile.provider === 'api' && profile.wireApi === 'chat',
  );
  const [localBaseURL, setLocalBaseURL] = useState(profile.provider === 'local' ? (profile.baseURL || '') : '');
  const [localApiKey, setLocalApiKey] = useState(
    profile.provider === 'local' ? (profile.apiKey || '') : ''
  );
  const [localRuntime, setLocalRuntime] = useState<LocalRuntime>(
    () => inferLocalRuntime(profile.provider === 'local' ? profile.baseURL : undefined)
  );
  const [localUsesChatCompletions, setLocalUsesChatCompletions] = useState<boolean>(() => {
    if (profile.provider === 'local' && profile.wireApi) {
      return profile.wireApi === 'chat';
    }
    const runtime = inferLocalRuntime(profile.provider === 'local' ? profile.baseURL : undefined);
    return getLocalRuntimeDefaultWireApi(runtime) === 'chat';
  });
  const apiFormat =
    profile.provider === 'api' && profile.apiFormat === 'anthropic'
      ? 'anthropic' as const
      : 'openai' as const;

  // Terminal config state
  const termConfig = profile.provider === 'terminal' ? profile.providerConfig as TerminalConfig | undefined : undefined;
  const [terminalCommand, setTerminalCommand] = useState(termConfig?.command || '');
  const [terminalRichInput, setTerminalRichInput] = useState(termConfig?.richInput ?? true);
  const [terminalHideInput, setTerminalHideInput] = useState(termConfig?.hideInput ?? true);
  const [terminalInputMarker, setTerminalInputMarker] = useState(termConfig?.inputMarker || '❯');
  const [terminalTitleMarker, setTerminalTitleMarker] = useState(termConfig?.titleMarker || '');

  // Ollama / LM Studio state
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [lmStudioStatus, setLmStudioStatus] = useState<LmStudioStatus | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaPulling, setOllamaPulling] = useState(false);
  const [ollamaPullStatus, setOllamaPullStatus] = useState<string | null>(null);
  const [ollamaPullError, setOllamaPullError] = useState<string | null>(null);
  const localStatusSeq = useRef(0);

  // Claude Code state
  const [claudeCodeStatus, setClaudeCodeStatus] = useState<{ installed: boolean; loggedIn: boolean; version?: string; error?: string } | null>(null);
  const [claudeCodeLoading, setClaudeCodeLoading] = useState(false);

  // Codex state
  const [codexStatus, setCodexStatus] = useState<{ installed: boolean; loggedIn: boolean; version?: string; error?: string } | null>(null);
  const [codexLoading, setCodexLoading] = useState(false);

  // Selected agent for 'agent' provider type
  const [selectedAgent, setSelectedAgent] = useState<'claude-code' | 'codex'>(
    profile.modelId === 'codex' ? 'codex' : 'claude-code'
  );

  // OpenAI OAuth state
  const [oauthStatus, setOauthStatus] = useState<{ isConnected: boolean; email?: string; accountId?: string } | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [openAiOAuthModels, setOpenAiOAuthModels] = useState<SupportedOpenAIOAuthModel[]>([]);
  const [openAiOAuthModelOptions, setOpenAiOAuthModelOptions] = useState<ModelOption[]>([]);
  const [, setHasLoadedOpenAiOAuthModels] = useState(false);

  const tabChangeRequestIdRef = useRef(0);

  const selectedTab = PROVIDER_TAB_BY_ID[selectedType];
  const visibleTabs = selectedTab && !SELECTABLE_PROVIDER_TABS.some((tab) => tab.id === selectedTab.id)
    ? [...SELECTABLE_PROVIDER_TABS, selectedTab]
    : SELECTABLE_PROVIDER_TABS;

  const openAiModelOptions = openAiOAuthModelOptions;
  const localRuntimeLabel = getLocalRuntimeLabel(localRuntime);
  const defaultLocalBaseURL = getLocalDefaultBaseURL(localRuntime);
  const localWireApi: WireApi = localUsesChatCompletions ? 'chat' : 'responses';
  const apiUsesCustomEndpoint = apiBaseUrlSelectionId === CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID;
  const apiUsesDeepSeekEndpoint = isDeepSeekApiBaseURL(apiBaseURL);
  const {
    options: deepSeekModelOptions,
    loading: deepSeekModelsLoading,
    error: deepSeekModelsError,
    refresh: refreshDeepSeekModels,
  } = useDeepSeekModelOptions(
    apiKey,
    selectedType === 'api' && apiUsesDeepSeekEndpoint,
  );
  const {
    catalog: hostedCatalog,
    loading: hostedCatalogLoading,
    error: hostedCatalogError,
    refresh: refreshHostedCatalog,
  } = useHostedModelCatalog();
  // Model discovery comes from OIX. Known endpoint presets retain their
  // specialized presentation, while generic OIX providers use the exact
  // `codexProfileId` saved on the profile.
  const apiEndpointKind = getApiEndpointKind(apiBaseURL);
  const apiProviderId =
    selectedType !== 'api'
      ? undefined
      : profileToOixProviderId({
          ...profile,
          provider: 'api',
          baseURL: apiBaseURL,
        })
        ?? (apiEndpointKind === 'openai' || apiEndpointKind === 'groq'
          ? apiPresetToOixProviderId(apiEndpointKind)
          : undefined);
  const {
    data: apiProviderModels,
    loading: apiProviderModelsLoading,
    error: apiProviderModelsError,
    refresh: refreshApiProviderModels,
  } = useInterpreterModels(apiProviderId);
  const apiModelField = useMemo(
    () => {
      const field = buildApiModelFieldConfig(
        apiUsesCustomEndpoint && !apiUsesDeepSeekEndpoint ? undefined : apiBaseURL,
        hostedCatalog?.models ?? [],
        apiProviderModels ?? [],
        apiProviderId,
      );
      if (apiUsesDeepSeekEndpoint && field.kind === 'select') {
        const defaultModelId = deepSeekModelOptions.some((option) => option.id === field.defaultModelId)
          ? field.defaultModelId
          : deepSeekModelOptions[0]?.id;
        return { ...field, options: deepSeekModelOptions, defaultModelId };
      }
      return field;
    },
    [apiBaseURL, apiProviderId, apiProviderModels, apiUsesCustomEndpoint, apiUsesDeepSeekEndpoint, deepSeekModelOptions, hostedCatalog],
  );
  const apiModelsLoading = apiUsesDeepSeekEndpoint ? deepSeekModelsLoading : apiProviderModelsLoading;
  const apiModelsError = apiUsesDeepSeekEndpoint ? deepSeekModelsError : apiProviderModelsError;
  const refreshApiModels = apiUsesDeepSeekEndpoint ? refreshDeepSeekModels : refreshApiProviderModels;
  const genericOixProviderId =
    apiUsesCustomEndpoint
    && profile.provider === 'api'
    && profile.codexProfileId
    && !isProfileId(profile.codexProfileId)
    && profile.codexProfileId !== 'custom'
    && profile.codexProfileId !== 'deepseek'
      ? profile.codexProfileId
      : undefined;
  const apiWireApi: WireApi = genericOixProviderId
    ? (profile.wireApi ?? (profile.apiFormat === 'anthropic' ? 'messages' : 'responses'))
    : apiUsesDeepSeekEndpoint || (apiUsesCustomEndpoint && apiUsesChatCompletions)
      ? 'chat'
      : 'responses';
  const apiCodexProfileId = genericOixProviderId
    ?? (apiUsesCustomEndpoint
      ? (apiUsesDeepSeekEndpoint ? 'deepseek' : 'custom')
      : getApiCodexProfileId(apiBaseURL));

  const refreshOpenAiOAuthModels = useCallback(async () => {
    const { models } = await providersIpc.listOpenAIOAuthModels();
    setOpenAiOAuthModels(models);
    setHasLoadedOpenAiOAuthModels(true);
    setOpenAiOAuthModelOptions(toOpenAiOAuthModelOptions(models));
    return models;
  }, []);

  const resolveOpenAiOAuthDefaultModel = useCallback(async () => {
    const { models } = await providersIpc.listOpenAIOAuthModels();
    setOpenAiOAuthModels(models);
    setHasLoadedOpenAiOAuthModels(true);
    setOpenAiOAuthModelOptions(toOpenAiOAuthModelOptions(models));
    return getDefaultOpenAIOAuthModelId(models);
  }, []);

  /*
   * GAP(app-server): Local runtime model enumeration (Ollama / LM Studio)
   *
   * listInterpreterProviders() lists the ollama / lmstudio providers (with
   * readiness), and that drives whether the Local preset card shows in settings.
   * But the app-server does NOT enumerate the INSTALLED local models or their
   * tool-use support for these runtimes.
   *
   * Fallback: probe getOllamaStatus() / getLmStudioStatus() (via refreshLocalStatus)
   * to discover installed models and build the selectable list with
   * buildLocalModelOptions(). This is an app-side runtime capability the app-server
   * does not yet expose; the per-runtime install/status panels below rely on the
   * same probe.
   *
   * Remove once the app-server lists installed local models (with tool-use
   * metadata) for a given runtime; then source this from
   * useInterpreterModels('ollama') / useInterpreterModels('lmstudio') instead.
   */
  const localModelOptions = useMemo<ModelOption[]>(() => {
    return buildLocalModelOptions(localRuntime, ollamaStatus, lmStudioStatus);
  }, [localRuntime, ollamaStatus?.models, ollamaStatus?.ollamaModels, lmStudioStatus?.lmStudioModels]);

  const syncOpenAiOAuthDefaultModel = useCallback((models: SupportedOpenAIOAuthModel[]) => {
    if (models.length === 0) {
      return;
    }

    const options = toOpenAiOAuthModelOptions(models);
    const currentModelId = profile.modelId?.trim();
    if (currentModelId && options.some((option) => option.id === currentModelId)) {
      return;
    }

    const defaultModelId = getDefaultOpenAIOAuthModelId(models);
    const defaultOption = options.find((option) => option.id === defaultModelId) ?? options[0];
    if (!defaultOption) {
      return;
    }

    onChange({
      modelId: defaultOption.id,
      name: defaultOption.name || modelIdToDisplayName(defaultOption.id),
    });
  }, [onChange, profile.modelId]);

  const installedLocalModels = ollamaStatus?.ollamaModels?.map((m) => m.id) || ollamaStatus?.models || [];
  const localModelInstalled = useMemo(() => {
    if (!profile.modelId) return false;
    if (installedLocalModels.includes(profile.modelId)) return true;

    if (localRuntime === 'lmstudio') {
      return installedLocalModels.some((modelId) =>
        localRuntimeModelIdsMatch(modelId, profile.modelId)
      );
    }

    return false;
  }, [installedLocalModels, localRuntime, profile.modelId]);

  const refreshLocalStatus = async (runtimeOverride?: LocalRuntime, baseURLOverride?: string) => {
    const runtime = runtimeOverride ?? localRuntime;
    const candidateBaseURL = baseURLOverride ?? localBaseURL;
    const effectiveBaseURL = candidateBaseURL.trim() || getLocalDefaultBaseURL(runtime);

    const seq = ++localStatusSeq.current;
    setOllamaLoading(true);
    setOllamaPullError(null);
    const effectiveApiKey = localApiKey.trim() || undefined;
    try {
      if (runtime === 'lmstudio') {
        const status = await providersIpc.getLmStudioStatus(effectiveBaseURL, effectiveApiKey);
        if (seq !== localStatusSeq.current) return;
        setOllamaStatus(status);
        setLmStudioStatus(status);
      } else {
        const status = await providersIpc.getOllamaStatus(effectiveBaseURL, effectiveApiKey);
        if (seq !== localStatusSeq.current) return;
        setOllamaStatus(status);
        setLmStudioStatus(null);
      }
    } catch {
      if (seq !== localStatusSeq.current) return;
      setOllamaStatus({ running: false });
      setLmStudioStatus(null);
    } finally {
      if (seq === localStatusSeq.current) {
        setOllamaLoading(false);
      }
    }
  };

  // Load status when tab changes
  useEffect(() => {
    if (selectedType === 'local') {
      void refreshLocalStatus();
    } else if (selectedType === 'agent') {
      setClaudeCodeLoading(true);
      setCodexLoading(true);
      providersIpc.getClaudeCodeStatus()
        .then((status) => setClaudeCodeStatus(status))
        .catch(() => setClaudeCodeStatus({ installed: false, loggedIn: false }))
        .finally(() => setClaudeCodeLoading(false));
      providersIpc.getCodexStatus()
        .then((status) => setCodexStatus(status))
        .catch(() => setCodexStatus({ installed: false, loggedIn: false }))
        .finally(() => setCodexLoading(false));
    } else if (selectedType === 'openai-oauth') {
      setOauthLoading(true);
      setOauthError(null);
      void (async () => {
        try {
          const status = await providersIpc.getOAuthStatus('openai');
          setOauthStatus(status);
          if (status.isConnected) {
            try {
              await refreshOpenAiOAuthModels();
            } catch (error) {
              trackOAuthModelListFailed({
                provider: 'openai',
                surface: 'settings',
                stage: 'tab_load',
                errorKind: classifyOpenAIOAuthModelListError(error),
                error,
              });
              setHasLoadedOpenAiOAuthModels(true);
              setOpenAiOAuthModels([]);
              setOpenAiOAuthModelOptions([]);
              setOauthError(
                getOpenAIOAuthModelListErrorMessage(error)
                ?? normalizeDisplayText(error instanceof Error ? error.message : String(error)),
              );
            }
          } else {
            setHasLoadedOpenAiOAuthModels(true);
            setOpenAiOAuthModels([]);
            setOpenAiOAuthModelOptions([]);
          }
        } catch {
          setOauthStatus({ isConnected: false });
          setHasLoadedOpenAiOAuthModels(true);
          setOpenAiOAuthModels([]);
          setOpenAiOAuthModelOptions([]);
        } finally {
          setOauthLoading(false);
        }
      })();
    }
  }, [refreshOpenAiOAuthModels, selectedType]);

  useEffect(() => {
    if (selectedType !== 'openai-oauth' || !oauthStatus?.isConnected || openAiOAuthModels.length === 0) {
      return;
    }

    syncOpenAiOAuthDefaultModel(openAiOAuthModels);
  }, [oauthStatus?.isConnected, openAiOAuthModels, selectedType, syncOpenAiOAuthDefaultModel]);

  const handleInstallLocalModel = async () => {
    if (!profile.modelId) {
      setOllamaPullError('Enter a model ID before installing.');
      return;
    }

    const runtimeLabel = getLocalRuntimeLabel(localRuntime);
    const effectiveBaseURL = localBaseURL.trim() || getLocalDefaultBaseURL(localRuntime);

    setOllamaPulling(true);
    setOllamaPullError(null);
    setOllamaPullStatus(`Installing ${profile.modelId} with ${runtimeLabel}...`);

    const result = localRuntime === 'lmstudio'
      ? await downloadLmStudioModel(
          profile.modelId.trim(),
          (progress) => {
            if (progress.error) {
              setOllamaPullError(normalizeDisplayText(progress.error));
              return;
            }

            if (progress.total && progress.completed) {
              const percent = Math.floor((progress.completed / progress.total) * 100);
              setOllamaPullStatus(`Downloading ${percent}%`);
              return;
            }

            if (typeof progress.progress === 'number' && typeof progress.maxProgress === 'number' && progress.maxProgress > 0) {
              const percent = Math.floor((progress.progress / progress.maxProgress) * 100);
              setOllamaPullStatus(`Downloading ${percent}%`);
              return;
            }

            if (progress.text) {
              setOllamaPullStatus(normalizeDisplayText(progress.text));
              return;
            }

            if (progress.status) {
              setOllamaPullStatus(normalizeDisplayText(progress.status));
            }
          },
          effectiveBaseURL
        )
      : await pullOllamaModel(
          profile.modelId,
          (progress) => {
            if (progress.error) {
              setOllamaPullError(normalizeDisplayText(progress.error));
              return;
            }

            if (progress.total && progress.completed) {
              const percent = Math.floor((progress.completed / progress.total) * 100);
              setOllamaPullStatus(`${progress.status || 'Downloading'} ${percent}%`);
              return;
            }

            if (progress.status) {
              setOllamaPullStatus(normalizeDisplayText(progress.status));
            }
          },
          effectiveBaseURL
        );

    if (!result.success) {
      setOllamaPullError(normalizeDisplayText(result.error) || 'Failed to install model.');
      setOllamaPullStatus(null);
      setOllamaPulling(false);
      return;
    }

    setOllamaPullStatus(`Installed ${profile.modelId}.`);
    await refreshLocalStatus(localRuntime, effectiveBaseURL);
    setOllamaPulling(false);
  };

  // Handle tab change - update profile with new provider type
  const handleTabChange = async (type: ProviderType) => {
    const requestId = ++tabChangeRequestIdRef.current;

    setSelectedType(type);

    switch (type) {
      case 'hosted':
        onChange(buildProviderChange({
          provider: 'hosted',
          providerId: 'builtin:hosted',
          modelId: DEFAULT_HOSTED_MODEL,
        }));
        break;
      case 'local':
        {
          const isLmStudio = localRuntime === 'lmstudio';
          const fallbackModelId = isLmStudio ? LM_STUDIO_DEFAULT_MODEL_KEY : DEFAULT_LOCAL_MODEL;
          const resolvedBaseURL = localBaseURL.trim() || getLocalDefaultBaseURL(localRuntime);
          const switchWireApi = getLocalRuntimeDefaultWireApi(localRuntime);
          setLocalUsesChatCompletions(switchWireApi === 'chat');
          let modelId: string = fallbackModelId;

          try {
            if (isLmStudio) {
              const status = await providersIpc.getLmStudioStatus(resolvedBaseURL);
              if (tabChangeRequestIdRef.current !== requestId) return;
              setOllamaStatus(status);
              setLmStudioStatus(status);
              modelId = pickLocalModelId(status.models, fallbackModelId);
            } else {
              const status = await providersIpc.getOllamaStatus(resolvedBaseURL);
              if (tabChangeRequestIdRef.current !== requestId) return;
              setOllamaStatus(status);
              setLmStudioStatus(null);
              modelId = pickLocalModelId(status.models, fallbackModelId);
            }
          } catch {
            if (tabChangeRequestIdRef.current !== requestId) {
              return;
            }
          }

          onChange(buildProviderChange({
            provider: 'local',
            providerId: 'builtin:local',
            modelId,
            codexProfileId: isLmStudio ? 'lmstudio' : 'ollama',
            baseURL: resolvedBaseURL,
            wireApi: switchWireApi,
            useResponsesApi: switchWireApi === 'responses',
          }));
        }
        break;
      case 'openai-oauth':
        try {
          const modelId = await resolveOpenAiOAuthDefaultModel();
          if (tabChangeRequestIdRef.current !== requestId) {
            return;
          }
          onChange(buildProviderChange({
            provider: 'openai-oauth' as any,
            providerId: 'builtin:openai-oauth',
            modelId,
          }));
          break;
        } catch {
          // Fall back to the static default if the OAuth account is not connected yet.
        }
        onChange(buildProviderChange({
          provider: 'openai-oauth' as any,
          providerId: 'builtin:openai-oauth',
          modelId: DEFAULT_OPENAI_MODEL,
        }));
        break;
      case 'agent':
        onChange(buildProviderChange({
          provider: 'agent',
          providerId: 'builtin:agent',
          modelId: selectedAgent,
        }));
        break;
      case 'api':
        onChange(buildProviderChange({
          provider: 'api',
          codexProfileId: apiCodexProfileId,
          modelId: '',
          baseURL: apiBaseURL,
          apiFormat,
          wireApi: apiWireApi,
          useResponsesApi: apiWireApi === 'responses',
        }));
        break;
      case 'terminal':
        onChange(buildProviderChange({
          provider: 'terminal',
          modelId: 'claude-code',
          providerConfig: {
            id: 'claude-code',
            command: terminalCommand || 'claude',
            icon: 'claude',
            richInput: terminalRichInput,
          } as TerminalConfig,
        }));
        break;
    }
  };

  const handleLocalRuntimeChange = (runtime: LocalRuntime) => {
    setLocalRuntime(runtime);
    setOllamaPullStatus(null);
    setOllamaPullError(null);

    const nextWireApi = getLocalRuntimeDefaultWireApi(runtime);
    setLocalUsesChatCompletions(nextWireApi === 'chat');

    const runtimeBaseURL = getLocalDefaultBaseURL(runtime);
    setLocalBaseURL(runtimeBaseURL);
    const nextDefaultModel = runtime === 'lmstudio' ? LM_STUDIO_DEFAULT_MODEL_KEY : DEFAULT_LOCAL_MODEL;
    const currentModelId = profile.modelId?.trim();
    const resolvedModelId = currentModelId
      ? resolveLocalRuntimeModelId(currentModelId, runtime)
      : nextDefaultModel;
    const shouldReplaceModel =
      !currentModelId ||
      resolvedModelId !== currentModelId;

    if (selectedType === 'local') {
      onChange({
        baseURL: runtimeBaseURL,
        codexProfileId: runtime === 'lmstudio' ? 'lmstudio' : 'ollama',
        wireApi: nextWireApi,
        useResponsesApi: nextWireApi === 'responses',
        ...(shouldReplaceModel ? { modelId: resolvedModelId } : {}),
      });
      void refreshLocalStatus(runtime, runtimeBaseURL);
    }
  };

  // Update API config
  useEffect(() => {
    if (selectedType === 'api') {
      onChange({
        apiKey,
        baseURL: apiBaseURL,
        apiFormat,
        codexProfileId: apiCodexProfileId,
        wireApi: apiWireApi,
        useResponsesApi: apiWireApi === 'responses',
      });
    }
  }, [apiKey, apiBaseURL, apiCodexProfileId, apiFormat, apiWireApi, selectedType]);

  useEffect(() => {
    setApiUsesChatCompletions(profile.provider === 'api' && profile.wireApi === 'chat');
  }, [profile.id, profile.provider, profile.wireApi]);

  useEffect(() => {
    if (selectedType === 'api' && apiUsesDeepSeekEndpoint) {
      setApiUsesChatCompletions(true);
    }
  }, [apiUsesDeepSeekEndpoint, selectedType]);

  useEffect(() => {
    if (selectedType !== 'api' || apiModelField.kind !== 'select' || profile.modelId?.trim()) {
      return;
    }

    const defaultApiModel = apiModelField.options.find((option) => option.id === apiModelField.defaultModelId)
      ?? apiModelField.options[0];
    if (!defaultApiModel) {
      return;
    }

    onChange({
      modelId: defaultApiModel.id,
      name: defaultApiModel.name,
    });
  }, [apiModelField, onChange, profile.modelId, selectedType]);

  // Update local provider base URL override
  useEffect(() => {
    if (selectedType === 'local') {
      const normalizedBaseURL = localBaseURL.trim() || getLocalDefaultBaseURL(localRuntime);
      onChange({
        baseURL: normalizedBaseURL,
        apiKey: localApiKey.trim() || undefined,
        wireApi: localWireApi,
        useResponsesApi: localWireApi === 'responses',
      });
    }
  }, [localApiKey, localBaseURL, localRuntime, localWireApi, selectedType]);

  // Update terminal config
  useEffect(() => {
    if (selectedType === 'terminal') {
      onChange({
        providerConfig: {
          id: profile.modelId || 'claude-code',
          command: terminalCommand,
          icon: profile.modelId === 'codex' ? 'openai' : 'claude',
          richInput: terminalRichInput,
          hideInput: terminalHideInput,
          inputMarker: terminalInputMarker || undefined,
          titleMarker: terminalTitleMarker || undefined,
        } as TerminalConfig,
      });
    }
  }, [profile.modelId, terminalCommand, terminalRichInput, terminalHideInput, terminalInputMarker, terminalTitleMarker, selectedType]);

  // OAuth handlers
  const handleOAuthConnect = async () => {
    setOauthError(null);
    try {
      const { authUrl, flowId } = await providersIpc.initiateOAuth('openai');
      trackOAuthSignInStarted({
        provider: 'openai',
        surface: 'settings',
        flowId,
      });
      const openResult = await openAuthUrl(authUrl);
      if (openResult.status === 'failed') {
        trackOAuthSignInFailed({
          provider: 'openai',
          surface: 'settings',
          flowId,
          error: openResult.openError,
          stage: 'open_browser',
        });
        setOauthError(AUTH_URL_OPEN_FAILED_MESSAGE);
        setOauthLoading(false);
        return;
      }
      setOauthError(openResult.status === 'copied' ? AUTH_URL_COPIED_MESSAGE : null);

      setOauthLoading(true);
      const pollInterval = setInterval(async () => {
        try {
          const status = await providersIpc.getOAuthStatus('openai');
          if (status.error) {
            clearInterval(pollInterval);
            setOauthLoading(false);
            trackOAuthSignInFailed({
              provider: 'openai',
              surface: 'settings',
              flowId,
              error: status.error,
              stage: 'poll',
            });
            setOauthError(status.error);
            return;
          }
          if (status.isConnected) {
            clearInterval(pollInterval);
            setOauthStatus(status);
            trackOAuthSignInCompleted({
              provider: 'openai',
              surface: 'settings',
              flowId,
              hasEmail: Boolean(status.email),
            });
            try {
              await refreshOpenAiOAuthModels();
              setOauthError(null);
            } catch (error) {
              trackOAuthModelListFailed({
                provider: 'openai',
                surface: 'settings',
                flowId,
                stage: 'after_signin',
                errorKind: classifyOpenAIOAuthModelListError(error),
                error,
              });
              setHasLoadedOpenAiOAuthModels(true);
              setOpenAiOAuthModels([]);
              setOpenAiOAuthModelOptions([]);
              setOauthError(
                getOpenAIOAuthModelListErrorMessage(error)
                ?? normalizeDisplayText(error instanceof Error ? error.message : String(error)),
              );
            }
            setOauthLoading(false);
          }
        } catch {
          // Keep polling
        }
      }, 2000);

      setTimeout(() => {
        clearInterval(pollInterval);
        trackOAuthSignInFailed({
          provider: 'openai',
          surface: 'settings',
          flowId,
          error: 'OAuth connection timed out after 5 minutes.',
          stage: 'timeout',
        });
        setOauthLoading(false);
      }, 5 * 60 * 1000);
    } catch (error) {
      console.error('Failed to initiate OAuth:', error);
      trackOAuthSignInFailed({
        provider: 'openai',
        surface: 'settings',
        error,
        stage: 'initiate',
      });
      setOauthLoading(false);
    }
  };

  const handleOAuthDisconnect = async () => {
    try {
      await providersIpc.disconnectOAuth('openai');
      setOauthStatus({ isConnected: false });
      setOpenAiOAuthModelOptions([]);
    } catch (error) {
      console.error('Failed to disconnect OAuth:', error);
    }
  };

  const handleClaudeLogin = async () => {
    try {
      setClaudeCodeLoading(true);
      await providersIpc.runClaudeLogin();
      const status = await providersIpc.getClaudeCodeStatus();
      setClaudeCodeStatus(status);
    } catch (error) {
      console.error('Failed to run claude login:', error);
    } finally {
      setClaudeCodeLoading(false);
    }
  };

  const providerLabelKeys: Record<ProviderType, string> = {
    hosted: 'settings.profiles.provider.hosted.label',
    'openai-oauth': 'settings.profiles.provider.openaiOauth.label',
    local: 'settings.profiles.provider.local.label',
    api: 'settings.profiles.provider.api.label',
    terminal: 'settings.profiles.provider.terminal.label',
    agent: 'settings.profiles.provider.agent.label',
  };

  const providerButtonClassName =
    'inline-flex h-9 items-center gap-2 rounded-[10px] border px-3 text-[13px] font-medium leading-none transition-[background-color,border-color,color] duration-150';

  const providerButtonStyle = (isActive: boolean) => ({
    borderWidth: 'var(--border-width)',
    borderColor: isActive
      ? 'color-mix(in srgb, var(--oa-border, var(--border)) 74%, transparent)'
      : 'transparent',
  });

  const providerContent = (() => {
    switch (selectedType) {
      case 'hosted':
        return (
          <ProviderPanel tab={PROVIDER_TAB_BY_ID.hosted}>
            <FieldGroup className="gap-3">
              <HostedModelPicker
                label={t('settings.profiles.provider.model.label')}
                description={t('settings.profiles.provider.hosted.modelDescription')}
                modelId={profile.modelId || DEFAULT_HOSTED_MODEL}
                catalog={hostedCatalog}
                loading={hostedCatalogLoading}
                error={hostedCatalogError}
                onModelChange={(modelId, name) => onChange({ modelId, ...(name ? { name } : {}) })}
                onRefresh={refreshHostedCatalog}
              />

              {isAuthenticated ? (
                <div className="rounded-control bg-muted/40 p-3">
                  <PlanSectionContent />
                </div>
              ) : (
                <AuthSignIn />
              )}
            </FieldGroup>
          </ProviderPanel>
        );
      case 'openai-oauth':
        return (
          <ProviderPanel tab={PROVIDER_TAB_BY_ID['openai-oauth']}>
            <FieldGroup className="gap-3">
              {oauthStatus?.isConnected ? (
                <div className="space-y-2">
                  <div
                    className="rounded-[16px] px-4 py-4 sm:px-5"
                    style={{
                      border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 52%, transparent)',
                      background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 44%, transparent)',
                    }}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-black/[0.035] text-foreground dark:bg-white/[0.07]">
                          <OpenAIIcon className="size-5" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-ui-sm font-medium text-foreground">
                            {t('settings.profiles.provider.openaiOauth.connectedAs', { email: oauthStatus.email || t('settings.profiles.provider.openaiOauth.connectedAsDefault') })}
                          </p>
                          <p className="mt-1 text-ui-sm leading-6 text-muted-foreground">
                            {t('settings.profiles.provider.openaiOauth.modelDescription')}
                          </p>
                        </div>
                      </div>
                      <Button variant="utility" size="sm" onClick={handleOAuthDisconnect} className="rounded-full">
                        {t('common.disconnect')}
                      </Button>
                    </div>
                  </div>

                  {oauthError ? (
                    <StatusPanel tone="warning">{oauthError}</StatusPanel>
                  ) : null}

                  {openAiModelOptions.length > 0 ? (
                    <ModelSelector
                      label={t('settings.profiles.provider.model.label')}
                      description={t('settings.profiles.provider.openaiOauth.modelDescription')}
                      modelId={profile.modelId}
                      options={openAiModelOptions}
                      onModelChange={(modelId) => onChange({ modelId, name: modelIdToDisplayName(modelId) })}
                      allowCustomModel={false}
                    />
                  ) : oauthLoading ? (
                    <StatusPanel tone="info">{t('settings.profiles.provider.openaiOauth.waitingAuth')}</StatusPanel>
                  ) : null}
                </div>
              ) : (
                <div
                  className="space-y-4 rounded-[18px] px-4 py-4 sm:px-5 sm:py-5"
                  style={{
                    border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 52%, transparent)',
                    background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 44%, transparent)',
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-black/[0.045] text-foreground dark:bg-white/[0.08]">
                      <OpenAIIcon className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-ui-base font-medium text-foreground">
                        {t('settings.profiles.provider.openaiOauth.connectButton')}
                      </p>
                      <p className="mt-1 text-ui-sm leading-6 text-muted-foreground">
                        {t('settings.profiles.provider.openaiOauth.connectPrompt')}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Button
                      variant="default"
                      size="lg"
                      onClick={handleOAuthConnect}
                      disabled={oauthLoading}
                      className="w-full rounded-full sm:w-auto sm:px-5"
                    >
                      <OpenAIIcon className="size-4" />
                      {t('settings.profiles.provider.openaiOauth.connectButton')}
                    </Button>

                    {oauthLoading ? (
                      <StatusPanel tone="info">{t('settings.profiles.provider.openaiOauth.waitingAuth')}</StatusPanel>
                    ) : null}

                    {oauthError ? (
                      <StatusPanel tone="warning">{oauthError}</StatusPanel>
                    ) : null}
                  </div>
                </div>
              )}
            </FieldGroup>
          </ProviderPanel>
        );
      case 'local':
        return (
          <ProviderPanel
            tab={PROVIDER_TAB_BY_ID.local}
            action={
              <Button variant="utility" size="sm" onClick={() => void refreshLocalStatus()} disabled={ollamaLoading || ollamaPulling}>
                {t('settings.profiles.provider.local.refresh')}
              </Button>
            }
          >
            <FieldGroup className="gap-3">
              <Field>
                <FieldLabel>{t('settings.profiles.provider.local.runtimeLabel')}</FieldLabel>
                <FieldDescription>{t('settings.profiles.provider.local.runtimeDescription')}</FieldDescription>
                <select
                  className="h-10 w-full rounded-control bg-transparent px-3 text-[13px]"
                  style={{ border: 'var(--border-width) solid var(--border)' }}
                  value={localRuntime}
                  onChange={(event) => handleLocalRuntimeChange(event.target.value as LocalRuntime)}
                >
                  <option value="ollama">{t('settings.profiles.provider.local.runtimeOllama')}</option>
                  <option value="lmstudio">{t('settings.profiles.provider.local.runtimeLmStudio')}</option>
                </select>
              </Field>

              {ollamaLoading ? (
                <StatusPanel tone="info">{t('settings.profiles.provider.local.checkingStatus', { runtime: localRuntimeLabel })}</StatusPanel>
              ) : ollamaStatus?.running ? (
                <StatusPanel tone="success">
                  {t('settings.profiles.provider.local.isRunning', { runtime: localRuntimeLabel })}
                  {ollamaStatus.version ? ` (v${ollamaStatus.version})` : ''}
                </StatusPanel>
              ) : (
                <StatusPanel tone="warning">{t('settings.profiles.provider.local.cannotVerify', { runtime: localRuntimeLabel })}</StatusPanel>
              )}

              {localRuntime === 'ollama' && ollamaStatus?.running && isOllamaVersionBelowDeveloperRoleFloor(ollamaStatus.version) && (
                <StatusPanel tone="warning">
                  {t('settings.profiles.provider.local.ollamaOutdated', {
                    version: ollamaStatus.version,
                    minVersion: MIN_OLLAMA_DEVELOPER_ROLE_VERSION,
                  })}
                </StatusPanel>
              )}

              <ModelSelector
                label={t('settings.profiles.provider.model.label')}
                description={
                  localRuntime === 'lmstudio'
                    ? t('settings.profiles.provider.local.lmStudioModelDescription')
                    : t('settings.profiles.provider.local.ollamaModelDescription')
                }
                modelId={profile.modelId}
                options={localModelOptions}
                onModelChange={(modelId) => onChange({ modelId, name: modelIdToDisplayName(modelId) })}
                customPlaceholder={localRuntime === 'lmstudio' ? LM_STUDIO_DEFAULT_MODEL_KEY : DEFAULT_LOCAL_MODEL}
                allowCustomModel
              />

              {localRuntime === 'lmstudio' && ollamaStatus?.running && lmStudioStatus?.totalChatModels !== undefined && lmStudioStatus.totalChatModels > 0 && localModelOptions.length === 0 && (
                <StatusPanel tone="warning">
                  {t('settings.profiles.provider.local.lmStudioNoToolModels', {
                    count: lmStudioStatus.totalChatModels,
                  })}
                </StatusPanel>
              )}

              {localRuntime === 'ollama' && ollamaStatus?.running && ollamaStatus?.totalChatModels !== undefined && ollamaStatus.totalChatModels > 0 && localModelOptions.length === 0 && (
                <StatusPanel tone="warning">
                  {t('settings.profiles.provider.local.ollamaNoToolModels', {
                    count: ollamaStatus.totalChatModels,
                  })}
                </StatusPanel>
              )}

              {localRuntime === 'ollama' && ollamaStatus?.running && ollamaStatus?.totalChatModels === 0 && (
                <StatusPanel tone="warning">
                  {t('settings.profiles.provider.local.ollamaNoModels')}
                </StatusPanel>
              )}

              {localRuntime === 'lmstudio' && ollamaStatus?.running && lmStudioStatus?.totalChatModels === 0 && (
                <StatusPanel tone="warning">
                  {t('settings.profiles.provider.local.lmStudioNoModels')}
                </StatusPanel>
              )}

              <Field>
                <FieldLabel>{t('settings.profiles.provider.local.baseUrlLabel')}</FieldLabel>
                <FieldDescription>{t('settings.profiles.provider.local.baseUrlDescription', { defaultUrl: defaultLocalBaseURL })}</FieldDescription>
                <Input
                  type="text"
                  value={localBaseURL}
                  onChange={(event) => setLocalBaseURL(event.target.value)}
                  placeholder={defaultLocalBaseURL}
                />
              </Field>

              <Field>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <FieldLabel htmlFor="local-chat-completions-toggle">
                      {t('settings.profiles.provider.local.chatCompletionsLabel')}
                    </FieldLabel>
                    <FieldDescription>
                      {t('settings.profiles.provider.local.chatCompletionsDescription')}
                    </FieldDescription>
                  </div>
                  <Switch
                    id="local-chat-completions-toggle"
                    checked={localUsesChatCompletions}
                    onCheckedChange={setLocalUsesChatCompletions}
                    aria-label={t('settings.profiles.provider.local.chatCompletionsLabel')}
                  />
                </div>
              </Field>

              <Field>
                <FieldLabel>{t('settings.profiles.provider.api.apiKeyLabel')}</FieldLabel>
                <FieldDescription>
                  {localRuntime === 'lmstudio'
                    ? 'Optional. Required if LM Studio server auth is enabled.'
                    : 'Optional. Required if Ollama is behind an authenticating reverse proxy.'}
                </FieldDescription>
                <Input
                  type="password"
                  value={localApiKey}
                  onChange={(event) => setLocalApiKey(event.target.value)}
                  placeholder={localRuntime === 'lmstudio' ? 'lm-studio' : ''}
                />
              </Field>

              {ollamaStatus?.running && profile.modelId && !localModelInstalled && (
                <div className="space-y-2">
                  <StatusPanel tone="warning">
                    {t('settings.profiles.provider.local.notInstalled', { modelId: profile.modelId })}
                  </StatusPanel>
                  <Button
                    variant="utility"
                    size="sm"
                    onClick={handleInstallLocalModel}
                    disabled={ollamaPulling}
                  >
                    <Download className="size-4" />
                    {ollamaPulling ? (localRuntime === 'lmstudio' ? t('settings.profiles.provider.local.downloading') : t('settings.profiles.provider.local.installing')) : t('settings.profiles.provider.local.installModel', { modelId: profile.modelId })}
                  </Button>
                </div>
              )}

              {ollamaStatus?.running && profile.modelId && localModelInstalled && (
                <StatusPanel tone="success">{t('settings.profiles.provider.local.isInstalled', { modelId: profile.modelId })}</StatusPanel>
              )}

              {ollamaPullStatus && (
                <StatusPanel tone="info">{ollamaPullStatus}</StatusPanel>
              )}

              {ollamaPullError && (
                <StatusPanel tone="warning">{ollamaPullError}</StatusPanel>
              )}
            </FieldGroup>
          </ProviderPanel>
        );
      case 'api':
        return (
          <ProviderPanel tab={PROVIDER_TAB_BY_ID.api}>
            <FieldGroup className="gap-5">
              <StatusPanel tone="info">
                {t('settings.profiles.provider.api.infoMessage')}
              </StatusPanel>

              <ResponsesApiBaseUrlPicker
                label={t('settings.profiles.provider.api.baseUrlLabel')}
                description={t('settings.profiles.provider.api.baseUrlDescription')}
                baseURL={apiBaseURL}
                selectedBaseURLId={apiBaseUrlSelectionId}
                onBaseURLChange={setApiBaseURL}
                onSelectedBaseURLIdChange={setApiBaseUrlSelectionId}
                required
              />

              {apiUsesCustomEndpoint && (
                <Field>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <FieldLabel htmlFor="api-chat-completions-toggle">
                        {t('settings.profiles.provider.api.chatCompletionsLabel')}
                      </FieldLabel>
                      <FieldDescription>
                        {t('settings.profiles.provider.api.chatCompletionsDescription')}
                      </FieldDescription>
                    </div>
                    <Switch
                      id="api-chat-completions-toggle"
                      checked={apiUsesChatCompletions}
                      onCheckedChange={setApiUsesChatCompletions}
                      aria-label={t('settings.profiles.provider.api.chatCompletionsLabel')}
                    />
                  </div>
                </Field>
              )}

              {(() => {
                const localKind = detectLocalModelServerUrl(apiBaseURL);
                if (!localKind) return null;
                return (
                  <StatusPanel tone="warning">
                    {t('settings.profiles.provider.api.localServerWarning')}
                    <div className="mt-2">
                      <Button
                        variant="utility"
                        size="sm"
                        onClick={() => {
                          const runtime: LocalRuntime = localKind === 'lmstudio' ? 'lmstudio' : 'ollama';
                          setLocalRuntime(runtime);
                          setLocalBaseURL(apiBaseURL);
                          setSelectedType('local');
                          onChange(buildProviderChange({
                            provider: 'local',
                            providerId: 'builtin:local',
                            modelId: runtime === 'lmstudio' ? LM_STUDIO_DEFAULT_MODEL_KEY : DEFAULT_LOCAL_MODEL,
                            codexProfileId: runtime === 'lmstudio' ? 'lmstudio' : 'ollama',
                            baseURL: apiBaseURL,
                          }));
                        }}
                      >
                        {t('settings.profiles.provider.api.switchToLocal')}
                      </Button>
                    </div>
                  </StatusPanel>
                );
              })()}

              <Field>
                <FieldLabel>{t('settings.profiles.provider.api.apiKeyLabel')}</FieldLabel>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={t('settings.profiles.provider.api.apiKeyPlaceholder')}
                  required={apiUsesCustomEndpoint}
                />
              </Field>

              {apiModelField.kind === 'select' && apiModelField.provider === 'openrouter' ? (
                <div className="mb-3">
                  <HostedModelPicker
                    label={t('settings.profiles.provider.api.modelIdLabel')}
                    description={apiModelField.description}
                    modelId={profile.modelId || undefined}
                    catalog={hostedCatalog}
                    loading={hostedCatalogLoading}
                    error={hostedCatalogError}
                    showRecommendedGrid={false}
                    hideInterpreterRecommended
                    defaultExpanded
                    showBrowseToggle={false}
                    onModelChange={(modelId, name) => onChange({ modelId, name: name || modelIdToDisplayName(modelId) })}
                    onRefresh={refreshHostedCatalog}
                  />
                </div>
              ) : apiModelField.kind === 'select' ? (
                <div className="space-y-2">
                  {apiModelsError ? (
                    <StatusPanel tone="warning">
                      <div className="flex items-center justify-between gap-2">
                        <span>{t('settings.profiles.editor.error', { error: apiModelsError })}</span>
                        <Button type="button" variant="utility" size="sm" onClick={refreshApiModels}>
                          {t('settings.profiles.editor.retry')}
                        </Button>
                      </div>
                    </StatusPanel>
                  ) : apiModelsLoading ? (
                    <StatusPanel tone="info">{t('common.loading')}</StatusPanel>
                  ) : null}
                  <ModelSelector
                    label={t('settings.profiles.provider.api.modelIdLabel')}
                    description={apiModelField.description}
                    modelId={profile.modelId}
                    options={apiModelField.options}
                    onModelChange={(modelId) => {
                      const option = apiModelField.options.find((entry) => entry.id === modelId);
                      onChange({ modelId, name: option?.name || modelIdToDisplayName(modelId) });
                    }}
                    allowCustomModel={false}
                  />
                </div>
              ) : (
                <Field>
                  <FieldLabel>{t('settings.profiles.provider.api.modelIdLabel')}</FieldLabel>
                  <FieldDescription>{apiModelField.description}</FieldDescription>
                  <Input
                    type="text"
                    value={profile.modelId || ''}
                    onChange={(event) => {
                      const id = event.target.value;
                      onChange({ modelId: id, name: modelIdToDisplayName(id) });
                    }}
                    placeholder={t('settings.profiles.provider.api.modelIdPlaceholder')}
                    required
                  />
                </Field>
              )}
            </FieldGroup>
          </ProviderPanel>
        );
      case 'agent':
        return (
          <ProviderPanel tab={PROVIDER_TAB_BY_ID.agent}>
            <FieldGroup className="gap-3">
              <div className="flex flex-wrap gap-2">
                {(['claude-code', 'codex'] as const).map((agentId) => {
                  const isActive = selectedAgent === agentId;
                  const label = agentId === 'claude-code'
                    ? t('settings.profiles.provider.agent.claudeCode')
                    : t('settings.profiles.provider.agent.codex');

                  return (
                    <button
                      key={agentId}
                      type="button"
                      onClick={() => {
                        setSelectedAgent(agentId);
                        onChange({ modelId: agentId });
                      }}
                      className={cn(
                        providerButtonClassName,
                        isActive
                          ? 'bg-black/[0.04] text-foreground dark:bg-white/[0.08]'
                          : 'bg-transparent text-muted-foreground hover:bg-black/[0.025] hover:text-foreground dark:hover:bg-white/[0.04]',
                      )}
                      style={providerButtonStyle(isActive)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {selectedAgent === 'claude-code' && (
                <FieldGroup className="gap-3">
                  {claudeCodeLoading ? (
                    <StatusPanel tone="info">{t('settings.profiles.provider.agent.checkingClaudeCode')}</StatusPanel>
                  ) : claudeCodeStatus?.installed ? (
                    claudeCodeStatus.loggedIn ? (
                      <StatusPanel tone="success">
                        {t('settings.profiles.provider.agent.claudeCodeInstalledLoggedIn')}
                        {claudeCodeStatus.version && <span className="ml-2 opacity-70">v{claudeCodeStatus.version}</span>}
                      </StatusPanel>
                    ) : (
                      <div className="space-y-2">
                        <StatusPanel tone="warning">{t('settings.profiles.provider.agent.claudeCodeInstalledNotLoggedIn')}</StatusPanel>
                        <Button variant="utility" size="sm" onClick={handleClaudeLogin}>
                          {t('settings.profiles.provider.agent.runClaudeLogin')}
                        </Button>
                      </div>
                    )
                  ) : (
                    <StatusPanel tone="info">
                      {t('settings.profiles.provider.agent.claudeCodeNotInstalled')}{' '}
                      <button onClick={() => openExternal('https://claude.ai/code')} className="underline underline-offset-2">
                        {t('settings.profiles.provider.agent.claudeCodeLink')}
                      </button>
                    </StatusPanel>
                  )}
                </FieldGroup>
              )}

              {selectedAgent === 'codex' && (
                <FieldGroup className="gap-3">
                  {codexLoading ? (
                    <StatusPanel tone="info">{t('settings.profiles.provider.agent.checkingCodex')}</StatusPanel>
                  ) : codexStatus?.installed ? (
                    codexStatus.loggedIn ? (
                      <StatusPanel tone="success">
                        {t('settings.profiles.provider.agent.codexInstalledLoggedIn')}
                        {codexStatus.version && <span className="ml-2 opacity-70">v{codexStatus.version}</span>}
                      </StatusPanel>
                    ) : (
                      <StatusPanel tone="warning">
                        {t('settings.profiles.provider.agent.codexInstalledNeedsAuth')}
                      </StatusPanel>
                    )
                  ) : (
                    <StatusPanel tone="info">
                      {t('settings.profiles.provider.agent.codexNotInstalled')}{' '}
                      <button onClick={() => openExternal('https://openinterpreter.com')} className="underline underline-offset-2">
                        {t('settings.profiles.provider.agent.codexLink')}
                      </button>
                    </StatusPanel>
                  )}
                </FieldGroup>
              )}
            </FieldGroup>
          </ProviderPanel>
        );
      case 'terminal':
        return (
          <ProviderPanel tab={PROVIDER_TAB_BY_ID.terminal}>
            <FieldGroup className="gap-3">
              <Field>
                <FieldLabel>{t('settings.profiles.provider.terminal.commandLabel')}</FieldLabel>
                <Input
                  type="text"
                  value={terminalCommand}
                  onChange={(event) => setTerminalCommand(event.target.value)}
                  placeholder={profile.modelId === 'codex' ? 'interpreter' : 'claude'}
                />
                <FieldDescription>{t('settings.profiles.provider.terminal.commandDescription')}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel>{t('settings.profiles.provider.terminal.titleMarkerLabel')}</FieldLabel>
                <Input
                  type="text"
                  value={terminalTitleMarker}
                  onChange={(event) => setTerminalTitleMarker(event.target.value)}
                  placeholder={profile.modelId === 'codex' ? '•' : '⏺'}
                />
                <FieldDescription>{t('settings.profiles.provider.terminal.titleMarkerDescription')}</FieldDescription>
              </Field>

              <Field>
                <div className="flex items-center justify-between gap-6">
                  <div>
                    <FieldLabel>{t('settings.profiles.provider.terminal.richInputLabel')}</FieldLabel>
                    <FieldDescription>{t('settings.profiles.provider.terminal.richInputDescription')}</FieldDescription>
                  </div>
                  <Switch
                    checked={terminalRichInput}
                    onCheckedChange={setTerminalRichInput}
                  />
                </div>
              </Field>

              {terminalRichInput && (
                <>
                  <Field>
                    <div className="flex items-center justify-between gap-6">
                      <div>
                        <FieldLabel>{t('settings.profiles.provider.terminal.hideInputLabel')}</FieldLabel>
                        <FieldDescription>{t('settings.profiles.provider.terminal.hideInputDescription')}</FieldDescription>
                      </div>
                      <Switch
                        checked={terminalHideInput}
                        onCheckedChange={setTerminalHideInput}
                      />
                    </div>
                  </Field>

                  {terminalHideInput && (
                    <Field>
                      <FieldLabel>{t('settings.profiles.provider.terminal.inputMarkerLabel')}</FieldLabel>
                      <Input
                        type="text"
                        value={terminalInputMarker}
                        onChange={(event) => setTerminalInputMarker(event.target.value)}
                        placeholder="❯"
                      />
                      <FieldDescription>{t('settings.profiles.provider.terminal.inputMarkerDescription')}</FieldDescription>
                    </Field>
                  )}
                </>
              )}
            </FieldGroup>
          </ProviderPanel>
        );
    }
  })();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Field>
          <FieldLabel>{t('settings.profiles.detail.providerSection')}</FieldLabel>
          <Select
            value={selectedType}
            onValueChange={(value) => {
              void handleTabChange(value as ProviderType);
            }}
          >
            <SelectTrigger className="w-full justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {visibleTabs.map((tab) => (
                <SelectItem key={tab.id} value={tab.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                      {tab.icon}
                    </span>
                    <span>{t(providerLabelKeys[tab.id])}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{selectedTab?.description}</FieldDescription>
        </Field>
      </div>

      <div data-testid={PROFILE_PROVIDER_TAB_ID(selectedType)}>
        {providerContent}
      </div>
    </div>
  );
}
