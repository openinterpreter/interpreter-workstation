import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Check, Key, Server } from 'lucide-react';
import type { Profile } from '../../shared/types/profile';
import type { v2 } from '../../server/handlers/codex-generated-types/index';
import { OpenAIIcon, GroqIcon, OpenRouterIcon, ClaudeIcon, DeepSeekIcon } from './icons/BrandIcons';
import { InterpreterLogoMark } from './InterpreterLogoMark';
import type { AgentModelConfig, ModelConfig, ModelProvider, TerminalConfig } from '../../shared/types/model';
import {
  getProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  setFastProfile,
  resetProfile,
} from '../api';
import { ProfileProviderConfig } from './ProfileProviderConfig';
import { ProfileCardGrid } from './ProfileCardGrid';
import { useProfileStatuses } from '../hooks/useProfileStatuses';
import {
  useInterpreterHarnesses,
  useInterpreterProviders,
} from '../hooks/use-interpreter-models';
import {
  buildProviderMenuEntries,
  profileToOixProviderId,
  type ProviderMenuEntry,
} from '../lib/providers/interpreterProviderMenu';
import { providers as providersIpc } from '@/ipc';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { NativeSelect } from './ui/NativeSelect';
import { DetailListHeader, type BreadcrumbItem } from './ui/detail-list';
import { SettingsPane, SettingsSection, SettingsRow, SettingsSectionTitle } from './settings/SettingsSection';
import { MODEL_OPTIONS } from '../../shared/types/model';
import { ResponsesApiBaseUrlPicker } from './ResponsesApiBaseUrlPicker';
import {
  API_PROVIDER_MODEL_DEFAULTS,
  getDefaultOpenAIOAuthModelId,
  PROVIDER_MODEL_DEFAULTS,
} from '../../shared/types/modelDefaults';
import {
  BUILTIN_PROVIDER_IDS,
  getApiPresetBaseURL,
  getDefaultResponsesApiBaseURL,
  getUnsupportedResponsesApiBaseUrlMessage,
  type ApiPreset,
  type EnvApiKeysResult,
  type LmStudioStatus,
  type OllamaStatus,
} from '../../shared/types/provider';
import { validateProfileModelId } from '../../shared/utils/modelIdValidation';
import { getMissingProfileFields } from '../../shared/utils/profileValidation';
import {
  getDefaultLocalModelId,
  getDefaultHostedOverrideModelId,
  normalizeModelOverrideConfig,
  type ModelOverrideKind,
} from '../lib/profileManagerModelOverrides';
import {
  buildLocalModelOptions,
  DEFAULT_LOCAL_MODEL,
  getLocalDefaultBaseURL,
  inferLocalRuntime,
  LM_STUDIO_DEFAULT_MODEL_KEY,
  type LocalModelOption,
  type LocalRuntime,
} from '../utils/localModelOptions';
import { DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID } from '../../shared/utils/openAiResponsesTools';

// Providers that manage their own models internally — no model overrides UI
// Providers that fully manage their own models and tools internally — no model overrides UI.
// Note: 'agent' (Claude Code/Codex CLI) is NOT in this set because our builtin tools
// (read_image, subagents) are still passed to it and run on our server, so overrides apply.
const SELF_MANAGED_PROVIDERS = new Set<ModelProvider>(['terminal']);
const AUTOMATIC_HARNESS_VALUE = '__automatic_harness__';
const NATIVE_HARNESS_VALUE = '__native_harness__';

function AgentHarnessEditor({
  profile,
  onChange,
}: {
  profile: Profile;
  onChange: (harness: string | null | undefined) => void;
}) {
  const providerId = profileToOixProviderId(profile);
  const { data, loading, error } = useInterpreterHarnesses(
    providerId,
    profile.modelId,
  );

  if (!providerId) return null;

  const selectedValue = profile.harness === undefined
    ? AUTOMATIC_HARNESS_VALUE
    : profile.harness === null
      ? NATIVE_HARNESS_VALUE
      : profile.harness;
  const runtimeItems = (data ?? []).map((harness) => ({
    value: harness.id ?? NATIVE_HARNESS_VALUE,
    label: harness.label,
  }));
  const items = [
    { value: AUTOMATIC_HARNESS_VALUE, label: 'Automatic (recommended)' },
    ...runtimeItems,
  ];
  if (
    typeof profile.harness === 'string'
    && !items.some((item) => item.value === profile.harness)
  ) {
    items.push({ value: profile.harness, label: profile.harness });
  }
  const selectedRuntimeHarness = data?.find(
    (harness) => (harness.id ?? NATIVE_HARNESS_VALUE) === selectedValue,
  );

  return (
    <SettingsRow
      label="Agent harness"
      description={
        selectedRuntimeHarness?.description
        ?? 'Controls how OIX formats tools and messages for this model. Automatic follows OIX’s compatible recommended harness.'
      }
    >
      <div className="w-[320px] max-w-full space-y-1.5">
        <NativeSelect
          value={selectedValue}
          onValueChange={(value) => {
            if (value === AUTOMATIC_HARNESS_VALUE) {
              onChange(undefined);
            } else if (value === NATIVE_HARNESS_VALUE) {
              onChange(null);
            } else {
              onChange(value);
            }
          }}
          items={items}
          disabled={loading}
          className="w-full"
        />
        {loading && (
          <p className="text-ui-xs text-muted-foreground">Loading compatible harnesses…</p>
        )}
        {error && (
          <p className="text-ui-xs text-muted-foreground">
            Compatible harnesses could not be loaded. Automatic selection will still work.
          </p>
        )}
      </div>
    </SettingsRow>
  );
}

// ============================================================================
// Model override providers — only providers that can serve model responses
//
// These are app-only ProviderType lanes, NOT oix runtime provider ids, so the
// list stays static and is never sent to listInterpreterProviders. Each lane's
// MODEL list is already sourced where the app-server supports it:
//   - hosted -> useHostedModelCatalog (hosted model picker)
//   - api    -> useInterpreterModels(<endpoint>) / deepseek hook (ProfileProviderConfig)
//   - openai-oauth -> listOpenAIOAuthModels (app-server)
//   - local  -> app runtime detection (GAP-LOCAL-ENUM, see ProfileProviderConfig)
// Only the provider-LANE list here is app-side, because these UI lanes do not
// map 1:1 onto runtime provider ids.
// ============================================================================

const MODEL_OVERRIDE_PROVIDERS: { value: ModelProvider; label: string }[] = [
  { value: 'hosted', label: 'Hosted' },
  { value: 'local', label: 'Local (Ollama)' },
  { value: 'api', label: 'API' },
  { value: 'openai-oauth', label: 'OpenAI' },
];

// ========================================================================
// Presets for new profile creation
// ========================================================================

type PresetGroup = 'recommended' | 'subscription' | 'local' | 'terminal' | 'api';

interface PresetGroupConfig {
  id: PresetGroup;
  label: string;
  presets: ProfilePreset[];
}

const API_PRESETS: Record<ApiPreset, { name: string; baseURL: string; apiFormat: 'openai' | 'anthropic'; defaultModelId?: string; wireApi?: 'responses' | 'chat' }> = {
  anthropic: { name: 'Anthropic API', baseURL: getApiPresetBaseURL('anthropic'), apiFormat: 'anthropic' },
  openai: { name: 'OpenAI API', baseURL: getApiPresetBaseURL('openai'), apiFormat: 'openai' },
  groq: { name: 'Groq API', baseURL: getApiPresetBaseURL('groq'), apiFormat: 'openai' },
  openrouter: { name: 'OpenRouter API', baseURL: getApiPresetBaseURL('openrouter'), apiFormat: 'openai' },
  deepseek: { name: 'DeepSeek API', baseURL: getApiPresetBaseURL('deepseek'), apiFormat: 'openai', defaultModelId: API_PROVIDER_MODEL_DEFAULTS.deepseek, wireApi: 'chat' },
};

interface ProfilePreset {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  group: PresetGroup;
  defaultName: string;
  provider: ModelProvider;
  providerId?: string;
  modelId?: string;
  codexProfileId?: Profile['codexProfileId'];
  apiPreset?: ApiPreset;
  apiFormat?: 'openai' | 'anthropic';
  baseURL?: string;
  providerConfig?: TerminalConfig;
  /** Exact OIX provider id. This is runtime data, never an app-side catalog id. */
  oixProviderId?: string;
  /** OIX-reported environment variable that already configures this provider. */
  environmentKey?: string;
  wireApi?: Profile['wireApi'];
}

// ========================================================================
// Preset scaffolding registry
//
// Each entry is the app-side config a preset writes into a new Profile (icon,
// title, group, defaults, providerConfig). buildVisibleProfilePresets() decides
// WHICH of these to show using the Interpreter app-server provider list; the
// scaffolding/branding here is preserved verbatim. Keys are stable preset ids
// used only to look up scaffolding (never sent to the app-server).
// ========================================================================
type PresetKey =
  | 'hosted'
  | 'openai-oauth'
  | 'local'
  | 'claude-code-terminal'
  | 'codex-terminal'
  | 'openai-api'
  | 'openrouter-api'
  | 'deepseek-api'
  | 'groq-api'
  | 'custom-api';

const PRESET_SCAFFOLDING: Record<PresetKey, ProfilePreset> = {
  hosted: {
    id: 'hosted',
    title: 'Interpreter Models',
    description: 'Access top models with no setup required.',
    icon: <InterpreterLogoMark fitSquare size={20} segmentClassName="bg-current" className="text-muted-foreground" />,
    group: 'recommended',
    defaultName: 'Smart',
    provider: 'hosted',
    providerId: BUILTIN_PROVIDER_IDS.HOSTED,
    modelId: PROVIDER_MODEL_DEFAULTS.hosted.main,
  },
  'openai-oauth': {
    id: 'openai-oauth',
    title: 'OpenAI (ChatGPT)',
    description: 'Use your ChatGPT subscription via OAuth.',
    icon: <OpenAIIcon className="size-5 text-muted-foreground" />,
    group: 'subscription',
    defaultName: 'OpenAI',
    provider: 'openai-oauth',
    providerId: BUILTIN_PROVIDER_IDS.OPENAI_OAUTH,
    modelId: '',
  },
  local: {
    id: 'local',
    title: 'Local (Ollama / LM Studio)',
    description: 'Run models locally with Ollama or LM Studio. Recommended: qwen3.5:4b.',
    icon: <Server className="size-5 text-muted-foreground" />,
    group: 'local',
    defaultName: 'Local',
    provider: 'local',
    providerId: BUILTIN_PROVIDER_IDS.LOCAL,
    modelId: DEFAULT_LOCAL_MODEL,
  },
  'claude-code-terminal': {
    id: 'claude-code-terminal',
    title: 'Claude Code (Terminal)',
    description: 'Reuse your installed Claude Code CLI in the embedded terminal.',
    icon: <ClaudeIcon className="size-5 text-muted-foreground" />,
    group: 'terminal',
    defaultName: 'Claude Code Terminal',
    provider: 'terminal',
    modelId: 'claude-code',
    providerConfig: {
      id: 'claude-code',
      command: 'claude',
      icon: 'claude',
      richInput: false,
      hideInput: true,
      inputMarker: '❯',
      titleMarker: '⏺',
      helpDescription: 'Open your installed Claude Code CLI in a terminal. The app launches the local claude command as-is.',
    } as TerminalConfig,
  },
  'codex-terminal': {
    id: 'codex-terminal',
    title: 'Codex (Terminal)',
    description: 'Reuse your installed Codex CLI in the embedded terminal.',
    icon: <OpenAIIcon className="size-5 text-muted-foreground" />,
    group: 'terminal',
    defaultName: 'Codex Terminal',
    provider: 'terminal',
    modelId: 'codex',
    providerConfig: {
      id: 'codex',
      command: 'codex',
      icon: 'openai',
      richInput: false,
      hideInput: true,
      inputMarker: '❯',
      titleMarker: '•',
      helpDescription: 'Open your installed Codex CLI in a terminal. The app launches the local codex command as-is.',
    } as TerminalConfig,
  },
  'openai-api': {
    id: 'openai-api',
    title: 'OpenAI API',
    description: 'Use your OpenAI API key.',
    icon: <OpenAIIcon className="size-5 text-muted-foreground" />,
    group: 'api',
    defaultName: 'OpenAI API',
    provider: 'api',
    apiPreset: 'openai',
  },
  // @deprecated -- Anthropic API preset hidden; all inference routes through codex.
  // The oix 'anthropic' provider IS returned by listInterpreterProviders, but we
  // deliberately have no 'anthropic-api' scaffolding key, so PRESET_KEY_BY_API_PRESET
  // drops it from the visible list (matching the prior hidden-preset behavior).
  'openrouter-api': {
    id: 'openrouter-api',
    title: 'OpenRouter',
    description: 'Route to many models via OpenRouter.',
    icon: <OpenRouterIcon className="size-5 text-muted-foreground" />,
    group: 'api',
    defaultName: 'OpenRouter',
    provider: 'api',
    apiPreset: 'openrouter',
  },
  'deepseek-api': {
    id: 'deepseek-api',
    title: 'DeepSeek',
    description: 'Use DeepSeek V4 via Chat Completions.',
    icon: <DeepSeekIcon className="size-5 text-muted-foreground" />,
    group: 'api',
    defaultName: 'DeepSeek V4 Flash',
    provider: 'api',
    apiPreset: 'deepseek',
  },
  'groq-api': {
    id: 'groq-api',
    title: 'Groq',
    description: 'Fast OpenAI-compatible API via Groq.',
    icon: <GroqIcon className="size-5 text-muted-foreground" />,
    group: 'api',
    defaultName: 'Groq',
    provider: 'api',
    apiPreset: 'groq',
  },
  'custom-api': {
    id: 'custom-api',
    title: 'Custom API',
    description: 'Use a supported Chat Completions or Responses API endpoint.',
    icon: <Key className="size-5 text-muted-foreground" />,
    group: 'api',
    defaultName: 'GPT-5.4 nano',
    provider: 'api',
    modelId: DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID,
    codexProfileId: 'custom',
    apiFormat: 'openai',
    baseURL: getDefaultResponsesApiBaseURL(),
  },
};

// Maps an app ApiPreset (resolved by the foundation module's oix<->app mapping)
// to its scaffolding key. Presets we intentionally hide (e.g. 'anthropic') have
// no key here and are dropped from the visible list even when the runtime lists
// the provider.
const PRESET_KEY_BY_API_PRESET: Partial<Record<ApiPreset, PresetKey>> = {
  openai: 'openai-api',
  openrouter: 'openrouter-api',
  deepseek: 'deepseek-api',
  groq: 'groq-api',
};

/**
 * Build the visible profile preset list from the Interpreter app-server.
 *
 * The app-server (via buildProviderMenuEntries) is the source of truth for WHICH
 * providers are offered. Each runtime entry is mapped back to its app-side
 * scaffolding in PRESET_SCAFFOLDING; entries with no scaffolding key are dropped.
 * The documented app-server gaps (hosted, CLI-agent terminals, custom endpoint)
 * are merged in explicitly below. Ordering follows PROFILE_PRESET_ORDER so the
 * existing grouped layout, icons, and branding are preserved exactly.
 */
function buildVisibleProfilePresets(runtimeProviders: v2.InterpreterProvider[]): ProfilePreset[] {
  const entries = buildProviderMenuEntries(runtimeProviders);
  const keys = new Set<PresetKey>();
  const runtimeEntryByKey = new Map<PresetKey, ProviderMenuEntry>();
  const genericRuntimePresets: ProfilePreset[] = [];

  for (const entry of entries) {
    const key = presetKeyFromMenuEntry(entry);
    if (key) {
      keys.add(key);
      runtimeEntryByKey.set(key, entry);
    } else if (
      entry.appProviderType === 'api'
      && !entry.isDocumentedFallback
      && entry.baseUrl
    ) {
      genericRuntimePresets.push({
        id: `oix-api:${entry.oixProviderId}`,
        title: entry.displayName,
        description: entry.description || `Use ${entry.displayName} through OIX.`,
        icon: <Key className="size-5 text-muted-foreground" />,
        group: 'api',
        defaultName: entry.displayName,
        provider: 'api',
        modelId: '',
        codexProfileId: entry.oixProviderId,
        oixProviderId: entry.oixProviderId,
        baseURL: entry.baseUrl,
        apiFormat: entry.wireApi === 'messages' ? 'anthropic' : 'openai',
        environmentKey: entry.configured ? entry.envKey : undefined,
        wireApi: entry.wireApi === 'messages'
          ? 'messages'
          : entry.wireApi === 'chat'
            ? 'chat'
            : 'responses',
      });
    }
    if (!key) continue;
    // The single '__app:agent' fallback entry stands in for both CLI terminals;
    // expand it so Claude Code and Codex terminal presets render together.
    if (entry.appProviderType === 'agent') keys.add('codex-terminal');
  }

  /*
   * GAP(app-server): hosted Interpreter preset (interpreter-smart / interpreter-fast)
   *
   * The Interpreter-hosted provider and its models are NOT returned by
   * listInterpreterProviders() / listInterpreterModels(); they are an
   * account/auth-managed app service. buildProviderMenuEntries() surfaces this as
   * the synthetic '__app:hosted' fallback entry (appProviderType 'hosted'), which
   * presetKeyFromMenuEntry maps to the hardcoded 'hosted' scaffolding above.
   *
   * Fallback datum: PRESET_SCAFFOLDING.hosted here, plus the hosted model picker
   * (src/components/HostedModelPicker.tsx + src/hooks/use-hosted-model-catalog.ts)
   * for the model list. Remove this once the app-server enumerates the hosted
   * provider in listInterpreterProviders() and its models in listInterpreterModels().
   */

  /*
   * GAP(app-server): Claude Code / Codex CLI terminal presets
   *
   * CLI agents are HARNESSES (interpreter/harness/list), not providers, so they
   * never appear in listInterpreterProviders(). buildProviderMenuEntries()
   * synthesizes a single '__app:agent' fallback entry for the gap; in settings we
   * expand it into the two hardcoded terminal presets below so the user can launch
   * either installed CLI as-is.
   *
   * Fallback datum: PRESET_SCAFFOLDING['claude-code-terminal'] and
   * PRESET_SCAFFOLDING['codex-terminal'] here. Remove these once the app-server
   * bridges harnesses into the provider list (unlikely given their CLI nature).
   */

  /*
   * GAP(app-server): custom OpenAI-compatible endpoint preset
   *
   * The oix custom-endpoint quick-add ('openinterpreter_add_compatible_provider')
   * IS a runtime provider, but it has no enumerable model list (freeform model id
   * + base URL). presetKeyFromMenuEntry maps it to the 'custom-api' scaffolding so
   * the card stays visible whenever the runtime lists that preset; the model id is
   * a hardcoded default the user edits. No removal trigger: this is inherently a
   * freeform endpoint, not an app-server-enumerated provider.
   */

  const knownPresets = PROFILE_PRESET_ORDER
    .filter((key) => keys.has(key))
    .map((key) => {
      const preset = PRESET_SCAFFOLDING[key];
      const entry = runtimeEntryByKey.get(key);
      if (!entry || entry.isDocumentedFallback || key === 'custom-api' || key === 'local') {
        return preset;
      }
      return {
        ...preset,
        oixProviderId: entry.oixProviderId,
        baseURL: preset.baseURL ?? entry.baseUrl,
        environmentKey: entry.configured ? entry.envKey : undefined,
        wireApi: preset.wireApi
          ?? (entry.wireApi === 'messages' ? 'messages' : entry.wireApi),
      };
    });

  return [
    ...knownPresets,
    ...genericRuntimePresets.sort((a, b) => a.title.localeCompare(b.title)),
  ];
}

/**
 * Map a foundation-module provider menu entry back to its app-side preset
 * scaffolding key. Returns null for entries the settings preset list does not
 * render (e.g. bundled cloud catalog providers with no first-class preset).
 */
function presetKeyFromMenuEntry(entry: ProviderMenuEntry): PresetKey | null {
  switch (entry.appProviderType) {
    case 'hosted':
      // Documented GAP-HOSTED fallback entry ('__app:hosted').
      return 'hosted';
    case 'agent':
      // Documented GAP-AGENTS fallback entry ('__app:agent'); expanded into the
      // two terminal presets by buildVisibleProfilePresets via PROFILE_PRESET_ORDER.
      return 'claude-code-terminal';
    case 'openai-oauth':
      return 'openai-oauth';
    case 'local':
      // Both ollama and lmstudio map to the single merged Local preset card.
      return 'local';
    case 'api':
      if (entry.appCustomEndpointId) return 'custom-api';
      if (entry.appApiPreset) return PRESET_KEY_BY_API_PRESET[entry.appApiPreset] ?? null;
      // Bundled cloud catalog providers (no first-class preset) are not rendered
      // as settings preset cards; they remain reachable via the Custom API preset.
      return null;
    case 'terminal':
      return null;
  }
}

// Visible ordering of presets within their groups. Mirrors the previous static
// PROFILE_PRESETS order so the grouped layout is unchanged. The '__app:agent'
// fallback entry resolves to claude-code-terminal; codex-terminal is paired here
// so both terminal presets always render together when CLI agents are offered.
const PROFILE_PRESET_ORDER: PresetKey[] = [
  'hosted',
  'openai-oauth',
  'local',
  'claude-code-terminal',
  'codex-terminal',
  'openai-api',
  'openrouter-api',
  'deepseek-api',
  'groq-api',
  'custom-api',
];

function getModelOptionsForProvider(provider: ModelProvider): { id: string; name: string }[] {
  if (provider === 'api' || provider === 'local') return []; // handled separately
  const key = provider as keyof typeof MODEL_OPTIONS;
  return MODEL_OPTIONS[key] || [];
}

const CUSTOM_OVERRIDE_MODEL_VALUE = '__custom_override_model__';
type LocalRuntimeStatus =
  | { runtime: 'ollama'; status: OllamaStatus }
  | { runtime: 'lmstudio'; status: LmStudioStatus }
  | null;

function getOverrideModelSelectValue(
  modelId: string | undefined,
  options: LocalModelOption[],
  allowCustomModel: boolean,
): string {
  if (modelId && options.some((option) => option.id === modelId)) {
    return modelId;
  }
  if (!allowCustomModel && modelId) return modelId;
  return CUSTOM_OVERRIDE_MODEL_VALUE;
}

/** Compact editor for a ModelConfig (used for both fast model and vision model overrides) */
function ModelOverrideEditor({
  kind,
  label,
  description,
  value,
  onChange,
}: {
  kind: ModelOverrideKind;
  label: string;
  description: string;
  value: ModelConfig | undefined;
  onChange: (v: ModelConfig | undefined) => void;
}) {
  "use no memo";

  const { t } = useTranslation();
  const enabled = value !== undefined;
  const config = normalizeModelOverrideConfig(value, kind) || {
    provider: 'hosted' as ModelProvider,
    modelId: getDefaultHostedOverrideModelId(kind),
  };
  const providerOptions = MODEL_OVERRIDE_PROVIDERS;
  const [localStatus, setLocalStatus] = useState<LocalRuntimeStatus>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const isLocalProvider = config.provider === 'local';
  const isApiProvider = config.provider === 'api';
  const localRuntime = inferLocalRuntime(config.baseURL);
  const localBaseURL = config.baseURL?.trim() || getLocalDefaultBaseURL(localRuntime);
  const localApiKey = config.apiKey?.trim() || undefined;
  const ollamaStatus = localStatus?.runtime === 'ollama' ? localStatus.status : null;
  const lmStudioStatus = localStatus?.runtime === 'lmstudio' ? localStatus.status : null;

  const localModelOptions = buildLocalModelOptions(localRuntime, ollamaStatus, lmStudioStatus);
  const staticModelOptions = getModelOptionsForProvider(config.provider);
  const modelOptions = isLocalProvider ? localModelOptions : staticModelOptions;
  const allowCustomModel = true;
  const selectValue = getOverrideModelSelectValue(config.modelId, modelOptions, allowCustomModel);
  const selectItems = modelOptions;
  const showModelDropdown = !isApiProvider && selectItems.length > 0;
  const showApiFields = config.provider === 'api';

  useEffect(() => {
    if (!enabled || !isLocalProvider) {
      setLocalStatus(null);
      setLocalLoading(false);
      return;
    }

    let cancelled = false;

    const loadLocalStatus = async () => {
      setLocalLoading(true);
      try {
        if (localRuntime === 'lmstudio') {
          const status = await providersIpc.getLmStudioStatus(localBaseURL, localApiKey);
          if (cancelled) return;
          setLocalStatus({ runtime: 'lmstudio', status });
          return;
        }

        const status = await providersIpc.getOllamaStatus(localBaseURL, localApiKey);
        if (cancelled) return;
        setLocalStatus({ runtime: 'ollama', status });
      } catch {
        if (cancelled) return;
        setLocalStatus(
          localRuntime === 'lmstudio'
            ? { runtime: 'lmstudio', status: { running: false } }
            : { runtime: 'ollama', status: { running: false } },
        );
      } finally {
        if (!cancelled) {
          setLocalLoading(false);
        }
      }
    };

    void loadLocalStatus();
    return () => {
      cancelled = true;
    };
  }, [enabled, isLocalProvider, localApiKey, localBaseURL, localRuntime]);

  return (
    <div className="space-y-3">
      <SettingsRow label={label} description={description}>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => {
            if (checked) {
              onChange({ provider: 'hosted', modelId: getDefaultHostedOverrideModelId(kind) });
            } else {
              onChange(undefined);
            }
          }}
        />
      </SettingsRow>

      {enabled && (
        <div
          className="space-y-3 rounded-[14px] px-4 py-3"
          style={{
            background:
              "color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 56%, transparent)",
          }}
        >
          <SettingsRow label={t('settings.profiles.override.provider')}>
            <NativeSelect
              value={config.provider}
              onValueChange={(v) => {
                const newProvider = v as ModelProvider;
                const opts = getModelOptionsForProvider(newProvider);
                const nextConfig: ModelConfig = {
                  ...config,
                  provider: newProvider,
                  modelId: opts.length > 0 ? opts[0].id : '',
                  apiKey: undefined,
                  baseURL: undefined,
                  apiFormat: undefined,
                };

                if (newProvider === 'hosted') {
                  nextConfig.modelId = getDefaultHostedOverrideModelId(kind);
                } else if (newProvider === 'local') {
                  nextConfig.modelId = getDefaultLocalModelId('ollama');
                  nextConfig.baseURL = getLocalDefaultBaseURL('ollama');
                } else if (newProvider === 'api') {
                  nextConfig.modelId = '';
                  nextConfig.apiFormat = 'openai';
                  nextConfig.baseURL = getDefaultResponsesApiBaseURL();
                }

                onChange(nextConfig);
              }}
              items={providerOptions.map((p) => ({
                label: ({
                  hosted: t('settings.profiles.overrideProviders.hosted'),
                  local: t('settings.profiles.overrideProviders.local'),
                  api: t('settings.profiles.overrideProviders.api'),
                  'openai-oauth': t('settings.profiles.overrideProviders.openai'),
                } as Record<string, string>)[p.value] || p.label,
                value: p.value,
              }))}
              className="w-[160px]"
            />
          </SettingsRow>

          {isLocalProvider && (
            <SettingsRow
              label={t('settings.profiles.provider.local.runtimeLabel')}
              description={t('settings.profiles.provider.local.runtimeDescription')}
            >
              <NativeSelect
                value={localRuntime}
                onValueChange={(value) => {
                  const runtime = value as LocalRuntime;
                  const nextDefaultModel = getDefaultLocalModelId(runtime);
                  const shouldReplaceModel =
                    config.modelId === DEFAULT_LOCAL_MODEL
                    || config.modelId === LM_STUDIO_DEFAULT_MODEL_KEY;
                  onChange({
                    ...config,
                    baseURL: getLocalDefaultBaseURL(runtime),
                    ...(shouldReplaceModel ? { modelId: nextDefaultModel } : {}),
                  });
                }}
                items={[
                  { value: 'ollama', label: t('settings.profiles.provider.local.runtimeOllama') },
                  { value: 'lmstudio', label: t('settings.profiles.provider.local.runtimeLmStudio') },
                ]}
                className="w-[220px]"
              />
            </SettingsRow>
          )}

          {showModelDropdown ? (
            <SettingsRow label={t('settings.profiles.override.model')}>
              <NativeSelect
                value={selectValue}
                onValueChange={(v) => {
                  if (v === CUSTOM_OVERRIDE_MODEL_VALUE) {
                    onChange({ ...config, modelId: '' });
                    return;
                  }
                  onChange({ ...config, modelId: v });
                }}
                items={[
                  ...selectItems.map((m) => ({ label: m.name, value: m.id })),
                  ...(allowCustomModel
                    ? [{ label: t('settings.profiles.override.customOption'), value: CUSTOM_OVERRIDE_MODEL_VALUE }]
                    : []),
                ]}
                className="w-[220px]"
              />
            </SettingsRow>
          ) : (
            <SettingsRow label={t('settings.profiles.override.modelId')}>
              <Input
                value={config.modelId}
                onChange={(e) => onChange({ ...config, modelId: e.target.value })}
                placeholder={t('settings.profiles.override.modelIdPlaceholder')}
                className="w-[220px] h-8"
              />
            </SettingsRow>
          )}

          {showModelDropdown && allowCustomModel && selectValue === CUSTOM_OVERRIDE_MODEL_VALUE && (
            <SettingsRow label={t('settings.profiles.override.customModelId')}>
              <Input
                value={config.modelId || ''}
                onChange={(e) => onChange({ ...config, modelId: e.target.value })}
                placeholder={t('settings.profiles.override.customModelIdPlaceholder')}
                className="w-[220px] h-8"
                autoFocus
              />
            </SettingsRow>
          )}

          {isLocalProvider && (
            <>
              <SettingsRow
                label={t('settings.profiles.provider.local.baseUrlLabel')}
                description={t('settings.profiles.provider.local.baseUrlDescription', {
                  defaultUrl: getLocalDefaultBaseURL(localRuntime),
                })}
                align="start"
              >
                <Input
                  value={config.baseURL || ''}
                  onChange={(e) => onChange({ ...config, baseURL: e.target.value || undefined })}
                  placeholder={getLocalDefaultBaseURL(localRuntime)}
                  className="w-[220px] h-8"
                />
              </SettingsRow>

              <SettingsRow
                label={t('settings.profiles.provider.api.apiKeyLabel')}
                description={
                  localRuntime === 'lmstudio'
                    ? 'Optional. Required if LM Studio server auth is enabled.'
                    : 'Optional. Required if Ollama is behind an authenticating reverse proxy.'
                }
                align="start"
              >
                <Input
                  type="password"
                  value={config.apiKey || ''}
                  onChange={(e) => onChange({ ...config, apiKey: e.target.value || undefined })}
                  placeholder={localRuntime === 'lmstudio' ? 'lm-studio' : ''}
                  className="w-[220px] h-8"
                />
              </SettingsRow>
            </>
          )}

          {showApiFields && (
            <>
              {config.apiFormat === 'anthropic' ? (
                <SettingsRow label={t('settings.profiles.override.baseUrl')} align="start">
                  <Input
                    value={config.baseURL || ''}
                    onChange={(e) => onChange({ ...config, baseURL: e.target.value || undefined })}
                    placeholder={getApiPresetBaseURL('anthropic')}
                    className="w-[220px] h-8"
                  />
                </SettingsRow>
              ) : (
                <ResponsesApiBaseUrlPicker
                  label={t('settings.profiles.provider.api.baseUrlLabel')}
                  description={t('settings.profiles.provider.api.baseUrlDescription')}
                  baseURL={config.baseURL}
                  onBaseURLChange={(baseURL) => onChange({
                    ...config,
                    baseURL,
                    apiFormat: config.apiFormat ?? 'openai',
                  })}
                />
              )}
              <SettingsRow label={t('settings.profiles.override.apiKey')}>
                <Input
                  type="password"
                  value={config.apiKey || ''}
                  onChange={(e) => onChange({ ...config, apiKey: e.target.value || undefined })}
                  placeholder={t('settings.profiles.override.apiKeyPlaceholder')}
                  className="w-[220px] h-8"
                />
              </SettingsRow>
            </>
          )}

          {isLocalProvider && localLoading && (
            <p className="text-ui-xs text-muted-foreground">
              {t('settings.profiles.provider.local.checkingStatus', {
                runtime: localRuntime === 'lmstudio'
                  ? t('settings.profiles.provider.local.runtimeLmStudio')
                  : t('settings.profiles.provider.local.runtimeOllama'),
              })}
            </p>
          )}

          {isLocalProvider && !localLoading && selectItems.length === 0 && (
            <p className="text-ui-xs text-muted-foreground">
              {t('settings.profiles.provider.local.cannotVerify', {
                runtime: localRuntime === 'lmstudio'
                  ? t('settings.profiles.provider.local.runtimeLmStudio')
                  : t('settings.profiles.provider.local.runtimeOllama'),
              })}
            </p>
          )}

        </div>
      )}
    </div>
  );
}

function ProfilePresetPicker({
  envApiKeys,
  runtimeProviders,
  providersLoading,
  providersError,
  onRefresh,
  onSelect,
  onBack,
  isLoading,
}: {
  envApiKeys: EnvApiKeysResult | null;
  // Provider list from the Interpreter app-server; drives which presets show.
  runtimeProviders: v2.InterpreterProvider[] | null;
  providersLoading: boolean;
  providersError: string | null;
  onRefresh: () => void;
  onSelect: (preset: ProfilePreset) => void;
  onBack: () => void;
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  const breadcrumbs: BreadcrumbItem[] = [
    { label: t('settings.profiles.presetPicker.breadcrumbModels'), onClick: onBack },
    { label: t('settings.profiles.presetPicker.breadcrumbNew') },
  ];

  // The preset menu is built from the app-server provider list. While it loads or
  // if it fails, surface a state (no blank menu, no silent hardcoded fallback).
  if (providersError) {
    return (
      <div className="space-y-5">
        <DetailListHeader title={t('settings.profiles.presetPicker.title')} onBack={onBack} breadcrumbs={breadcrumbs} />
        <div className="flex flex-col items-start gap-3">
          <p className="text-ui-sm text-destructive">
            {t('settings.profiles.presetPicker.failedProviders')}
          </p>
          <Button type="button" variant="utility" size="sm" onClick={onRefresh}>
            {t('common.tryAgain')}
          </Button>
        </div>
      </div>
    );
  }

  if (providersLoading || !runtimeProviders) {
    return (
      <div className="space-y-5">
        <DetailListHeader title={t('settings.profiles.presetPicker.title')} onBack={onBack} breadcrumbs={breadcrumbs} />
        <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('common.loading')}
        </div>
      </div>
    );
  }

  const visiblePresets = buildVisibleProfilePresets(runtimeProviders);
  const allGroups: PresetGroupConfig[] = [
    { id: 'recommended', label: t('settings.profiles.presetPicker.groupRecommended'), presets: visiblePresets.filter(p => p.group === 'recommended') },
    { id: 'subscription', label: t('settings.profiles.presetPicker.groupSubscriptions'), presets: visiblePresets.filter(p => p.group === 'subscription') },
    { id: 'local', label: t('settings.profiles.presetPicker.groupLocal'), presets: visiblePresets.filter(p => p.group === 'local') },
    { id: 'api', label: t('settings.profiles.presetPicker.groupApi'), presets: visiblePresets.filter(p => p.group === 'api') },
    { id: 'terminal', label: t('settings.profiles.presetPicker.groupTerminal'), presets: visiblePresets.filter(p => p.group === 'terminal') },
  ];
  const groupedPresets = allGroups.filter(g => g.presets.length > 0);

  if (groupedPresets.length === 0) {
    return (
      <div className="space-y-5">
        <DetailListHeader title={t('settings.profiles.presetPicker.title')} onBack={onBack} breadcrumbs={breadcrumbs} />
        <p className="text-ui-sm text-muted-foreground">
          {t('settings.profiles.presetPicker.noProvidersAvailable')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <DetailListHeader title={t('settings.profiles.presetPicker.title')} onBack={onBack} breadcrumbs={breadcrumbs} />

      <div className="max-w-[36rem] space-y-1">
        <div className="text-ui-sm font-medium text-foreground">
          {t('settings.profiles.presetPicker.choosePreset')}
        </div>
        <div className="text-ui-sm leading-6 text-muted-foreground">
          {t('settings.profiles.presetPicker.choosePresetDescription')}
        </div>
      </div>

      <div className="space-y-5">
        {groupedPresets.map(group => (
          <div key={group.id} className="space-y-2">
            <SettingsSectionTitle>{group.label}</SettingsSectionTitle>
            <div className="space-y-0">
              {group.presets.map(preset => {
                const envKey = preset.apiPreset ? envApiKeys?.[preset.apiPreset] : null;
                const hasEnvKey = !!envKey?.found;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onSelect(preset)}
                    disabled={isLoading}
                    className="group flex w-full items-start justify-between gap-4 rounded-[10px] border-b px-2 py-3 text-left transition-[background-color,color] duration-150 hover:bg-black/[0.025] dark:hover:bg-white/[0.035]"
                    style={{ borderColor: 'color-mix(in srgb, var(--oa-border, var(--border)) 44%, transparent)' }}
                  >
                    <div className="min-w-0 flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-black/[0.025] text-muted-foreground dark:bg-white/[0.04]">
                        {preset.icon}
                      </div>
                      <div className="min-w-0">
                        <div className="text-ui-sm font-medium text-foreground">
                          {preset.title}
                        </div>
                        <div className="mt-1 text-ui-sm leading-5 text-muted-foreground">
                          {preset.description}
                        </div>
                        {preset.apiPreset && (
                          <div className="mt-1.5 text-ui-xs text-muted-foreground/80">
                            {hasEnvKey
                              ? t('settings.profiles.presetPicker.usingKey', { masked: envKey?.masked })
                              : envApiKeys
                                ? t('settings.profiles.presetPicker.needsApiKey')
                                : t('settings.profiles.presetPicker.checkingForKey')}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2 pt-0.5">
                      {hasEnvKey && (
                        <span className="text-ui-xs text-[var(--oa-text-faint)]">
                          {t('settings.profiles.presetPicker.keyDetected')}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// ProfileDetailView — extracted as top-level component to keep stable identity
// ============================================================================

interface ProfileDetailViewProps {
  profile: Profile;
  envApiKeys: EnvApiKeysResult | null;
  onBack: () => void;
  onSave: (profile: Profile) => Promise<Profile | null>;
  onReset: (profileId: string) => void;
  onDelete: (profileId: string) => void;
  confirmingReset: string | null;
  confirmingDelete: string | null;
  isSaving: boolean;
  saved: boolean;
  /** Onboarding mode - shows simplified UI with "Set as default & continue" */
  onboardingMode?: boolean;
  /** Called when user wants to set this profile as default and continue (onboarding mode) */
  onSetDefaultAndContinue?: (profile: Profile) => void;
}

function ProfileDetailView({
  profile,
  envApiKeys,
  onBack,
  onSave,
  onReset,
  onDelete,
  confirmingReset,
  confirmingDelete,
  isSaving,
  saved,
  onboardingMode = false,
  onSetDefaultAndContinue,
}: ProfileDetailViewProps) {
  "use no memo";

  const { t } = useTranslation();
  const isNew = profile.id.startsWith('new:');
  const isBuiltin = profile.isBuiltin;

  const [formData, setFormData] = useState<Profile>(profile);

  const breadcrumbs: BreadcrumbItem[] = [
    { label: t('settings.profiles.detail.breadcrumbModels'), onClick: onBack },
    { label: isNew ? t('settings.profiles.detail.newModel') : profile.name },
  ];

  const handleProviderChange = useCallback((updates: Partial<Profile>) => {
    setFormData(prev => ({ ...prev, ...updates }));
  }, []);

  const [probeError, setProbeError] = useState<string | null>(null);
  const [isProbing, setIsProbing] = useState(false);

  const modelIdError = validateProfileModelId(formData.provider, formData.modelId);
  const missingFields = getMissingProfileFields(formData, envApiKeys);
  const cannotSave = missingFields.length > 0 || !!modelIdError || isSaving || isProbing || saved;

  const handleSaveWithProbe = useCallback(async (data: Profile): Promise<Profile | null> => {
    setProbeError(null);
    const usesResponsesApi = data.wireApi === 'responses'
      || (!data.wireApi && data.apiFormat !== 'anthropic');
    if (data.provider === 'api' && usesResponsesApi && data.baseURL?.trim()) {
      setIsProbing(true);
      try {
        const result = await providersIpc.probeResponsesApiSupport(data.baseURL);
        if (result.reachable && !result.supported) {
          setProbeError(getUnsupportedResponsesApiBaseUrlMessage(data.baseURL));
          return null;
        }
      } finally {
        setIsProbing(false);
      }
    }
    return onSave(data);
  }, [onSave]);

  return (
    <div className="space-y-5">
      <DetailListHeader title={isNew ? t('settings.profiles.detail.newModel') : profile.name} onBack={onBack} breadcrumbs={breadcrumbs} />

      <SettingsPane>
        {!isBuiltin && (
          <SettingsSection variant="plain" title={t('settings.profiles.detail.modelNameSection')}>
            <Input
              id="profile-name"
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder={t('settings.profiles.detail.modelNamePlaceholder')}
              autoFocus={isNew}
              required
            />
          </SettingsSection>
        )}

        <SettingsSection variant="plain" title={t('settings.profiles.detail.providerSection')}>
          <ProfileProviderConfig
            profile={formData}
            onChange={handleProviderChange}
          />
          <AgentHarnessEditor
            profile={formData}
            onChange={(harness) => setFormData((prev) => ({ ...prev, harness }))}
          />
        </SettingsSection>

        {/* Model overrides only apply to providers where we control the model routing.
            Self-managed providers (terminal) handle their own models. */}
        {!SELF_MANAGED_PROVIDERS.has(formData.provider) && (
          <SettingsSection variant="plain" title={t('settings.profiles.detail.modelOverridesSection')}>
            <div className="space-y-5">
              <ModelOverrideEditor
                kind="vision"
                label={t('settings.profiles.detail.visionModelLabel')}
                description={t('settings.profiles.detail.visionModelDescription')}
                value={formData.visionModel}
                onChange={(v) => setFormData(prev => ({ ...prev, visionModel: v }))}
              />
            </div>
          </SettingsSection>
        )}
      </SettingsPane>

      {/* Onboarding mode: simplified buttons */}
      {onboardingMode ? (
        <div className="flex items-center gap-2 pt-2">
          <Button
            type="button"
            onClick={async () => {
              const savedProfile = await handleSaveWithProbe(formData);
              if (savedProfile && onSetDefaultAndContinue) {
                onSetDefaultAndContinue(savedProfile);
              }
            }}
            disabled={cannotSave}
            size="sm"
          >
            {saved ? <Check className="size-4" /> : isSaving ? t('settings.profiles.detail.saving') : 'Save and continue'}
          </Button>
          <Button
            type="button"
            onClick={onBack}
            variant="outline"
            size="sm"
            disabled={isSaving || saved}
          >
            {t('common.back')}
          </Button>
          {modelIdError && (
            <p className="w-full text-ui-xs text-destructive">{modelIdError}</p>
          )}
          {probeError && (
            <p className="w-full text-ui-xs text-destructive">{probeError}</p>
          )}
        </div>
      ) : (
        /* Normal settings mode buttons */
        <div
          className="flex flex-wrap items-center gap-2 border-t pt-4"
          style={{ borderColor: 'color-mix(in srgb, var(--oa-border, var(--border)) 44%, transparent)' }}
        >
          <Button
            type="button"
            onClick={async () => {
              await handleSaveWithProbe(formData);
            }}
            disabled={cannotSave}
            size="sm"
          >
            {saved ? <Check className="size-4" /> : isSaving ? t('settings.profiles.detail.saving') : isNew ? t('settings.profiles.detail.createModel') : t('settings.profiles.detail.saveChanges')}
          </Button>
          <Button
            type="button"
            onClick={onBack}
            variant="utility"
            size="sm"
            disabled={isSaving || saved}
          >
            {t('common.cancel')}
          </Button>
          {!isNew && isBuiltin && (
            <Button
              type="button"
              onClick={() => onReset(profile.id)}
              variant="utility"
              size="sm"
              disabled={isSaving || saved}
            >
              <RotateCcw className="size-3" />
              {confirmingReset === profile.id ? t('settings.profiles.detail.confirmReset') : t('settings.profiles.detail.resetToDefault')}
            </Button>
          )}
          {!isNew && !isBuiltin && (
            <Button
              type="button"
              onClick={() => onDelete(profile.id)}
              variant="utility"
              size="sm"
              className="text-destructive hover:text-destructive hover:bg-destructive/8"
            >
              {confirmingDelete === profile.id ? t('settings.profiles.detail.clickToConfirm') : t('common.delete')}
            </Button>
          )}
          {modelIdError && (
            <p className="w-full text-ui-xs text-destructive">{modelIdError}</p>
          )}
          {probeError && (
            <p className="w-full text-ui-xs text-destructive">{probeError}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ProfileManager
// ============================================================================

interface ProfileManagerProps {
  selectedProfileId?: string;
  onProfileSelect?: (profile: Profile, shouldClose: boolean) => void;
  onProfileUpdate?: (profile: Profile) => void;
  compact?: boolean;
  compactActionLabel?: string;
  getCompactActionLabel?: (profile: Profile) => string | null;
  compactFooterLabel?: string;
  listClassName?: string;
  currentModelConfig?: AgentModelConfig;
  onNavigateToSettings?: () => void;
  /** Onboarding mode - shows "Set as default & continue" and calls onSetDefaultAndContinue when done */
  onboardingMode?: boolean;
  /** Start directly in the new profile flow */
  startInNewProfile?: boolean;
  /** Called when user saves a profile and wants to continue (onboarding mode only) */
  onSetDefaultAndContinue?: (profile: Profile) => void;
}

export function ProfileManager({ selectedProfileId: _selectedProfileId, onProfileSelect, onProfileUpdate, compact: _compact = false, compactActionLabel, getCompactActionLabel, compactFooterLabel, listClassName, currentModelConfig: _currentModelConfig, onNavigateToSettings, onboardingMode = false, startInNewProfile = false, onSetDefaultAndContinue }: ProfileManagerProps) {
  "use no memo";

  const { t } = useTranslation();
  const { statuses, loading: statusesLoading } = useProfileStatuses();
  // The preset picker's visible provider set is sourced from the Interpreter
  // app-server. includeUnconfigured=true so bundled quick-add presets are listed
  // before the user pastes a key. buildVisibleProfilePresets() applies the
  // oix<->app mapping and ordering.
  const {
    data: runtimeProviders,
    loading: providersLoading,
    error: providersError,
    refresh: refreshProviders,
  } = useInterpreterProviders(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [fastProfileId, setFastProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newProfileDraft, setNewProfileDraft] = useState<Profile | null>(null);
  const [presetLoading, setPresetLoading] = useState(false);
  const [envApiKeys, setEnvApiKeys] = useState<EnvApiKeysResult | null>(null);
  const [startApplied, setStartApplied] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  // When selectedProfileId prop changes, open that profile's detail view
  useEffect(() => {
    if (_selectedProfileId) {
      setSelectedId(_selectedProfileId);
    }
  }, [_selectedProfileId]);

  useEffect(() => {
    if (startInNewProfile && !startApplied) {
      setIsAddingNew(true);
      setNewProfileDraft(null);
      setStartApplied(true);
    }
  }, [startInNewProfile, startApplied]);

  useEffect(() => {
    if (envApiKeys) return;
    providersIpc.getEnvApiKeys()
      .then((result) => setEnvApiKeys(result))
      .catch(() => setEnvApiKeys(null));
  }, [envApiKeys]);

  const startNewProfile = useCallback(() => {
    setIsAddingNew(true);
    setNewProfileDraft(null);
  }, []);

  const buildProfileFromPreset = useCallback(async (preset: ProfilePreset): Promise<Profile> => {
    const baseProfile: Profile = {
      id: 'new:temp',
      name: preset.defaultName,
      providerId: preset.providerId,
      provider: preset.provider,
      modelId: preset.modelId || '',
      isBuiltin: false,
      apiKey: undefined,
      environmentKey: preset.environmentKey,
      baseURL: preset.baseURL,
      codexProfileId: preset.codexProfileId,
      apiFormat: preset.apiFormat,
      providerConfig: preset.providerConfig,
      wireApi: preset.wireApi,
    };

    if (preset.oixProviderId) {
      baseProfile.codexProfileId = preset.oixProviderId;
    }

    if (preset.apiPreset) {
      const apiDefaults = API_PRESETS[preset.apiPreset];
      baseProfile.provider = 'api';
      baseProfile.apiFormat = apiDefaults.apiFormat;
      baseProfile.baseURL = apiDefaults.baseURL;
      baseProfile.modelId = apiDefaults.defaultModelId ?? '';
      baseProfile.wireApi = apiDefaults.wireApi ?? 'responses';
      baseProfile.useResponsesApi = baseProfile.wireApi === 'responses';
      if (preset.apiPreset === 'deepseek') {
        baseProfile.codexProfileId = 'deepseek';
      }
      try {
        const result = await providersIpc.getEnvApiKey(preset.apiPreset);
        if (result?.key) {
          baseProfile.apiKey = result.key;
        }
      } catch {
        // Ignore missing env keys - user can enter manually
      }
    }

    if (preset.provider === 'openai-oauth') {
      /*
       * GAP(app-server): OpenAI OAuth default model resolution
       *
       * The OpenAI ChatGPT sign-in lane (oix provider 'openai') IS listed by
       * listInterpreterProviders, but its models are account-dependent and are
       * fetched separately via listOpenAIOAuthModels (app-server), not from the
       * provider entry. We resolve the default model id here at preset-select time.
       * This is by design (per-account models); no removal trigger.
       */
      try {
        const { models } = await providersIpc.listOpenAIOAuthModels();
        baseProfile.modelId = getDefaultOpenAIOAuthModelId(models);
      } catch {
        // Ignore disconnected/unavailable OAuth model lists and keep the fallback default.
      }
    }

    return baseProfile;
  }, []);

  const handlePresetSelect = useCallback(async (preset: ProfilePreset) => {
    setPresetLoading(true);
    try {
      const draft = await buildProfileFromPreset(preset);
      setNewProfileDraft(draft);
    } finally {
      setPresetLoading(false);
    }
  }, [buildProfileFromPreset]);

  async function loadData() {
    try {
      setLoading(true);
      const profileData = await getProfiles();
      setProfiles(profileData.profiles);
      setFastProfileId(profileData.fastProfileId);
    } catch (e) {
      console.error('[ProfileManager] Failed to load data:', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(profileId: string) {
    if (confirmingDelete === profileId) {
      try {
        await deleteProfile(profileId);
        setSelectedId(null);
        setConfirmingDelete(null);
        await loadData();
      } catch (e) {
        console.error('[ProfileManager] Failed to delete:', e);
      }
    } else {
      setConfirmingDelete(profileId);
      setTimeout(() => setConfirmingDelete(null), 3000);
    }
  }

  async function handleFastProfileChange(profileId: string) {
    try {
      const response = await setFastProfile(profileId);
      setFastProfileId(response.fastProfileId);
    } catch (e) {
      console.error('[ProfileManager] Failed to set fast profile:', e);
    }
  }

  async function handleReset(profileId: string) {
    if (confirmingReset === profileId) {
      try {
        await resetProfile(profileId);
        await loadData();
        setConfirmingReset(null);
      } catch (e) {
        console.error('[ProfileManager] Failed to reset:', e);
      }
    } else {
      setConfirmingReset(profileId);
      setTimeout(() => setConfirmingReset(null), 3000);
    }
  }

  const handleSaveProfile = async (updatedProfile: Profile): Promise<Profile | null> => {
    setIsSaving(true);
    try {
      const normalizedProfile: Profile = {
        ...updatedProfile,
        apiKey: updatedProfile.apiKey?.trim() || undefined,
      };
      let savedProfile: Profile | null = null;
      if (normalizedProfile.id.startsWith('new:')) {
        let modelId = normalizedProfile.modelId;
        if (normalizedProfile.provider === 'terminal') {
          const termCfg = normalizedProfile.providerConfig as TerminalConfig | undefined;
          modelId = termCfg?.id || 'custom-terminal';
        }

        const newProfile: Profile = {
          ...normalizedProfile,
          id: `custom:${Date.now()}`,
          modelId,
        };
        const result = await createProfile(newProfile);
        savedProfile = result.profile || newProfile;
      } else {
        const result = await updateProfile(normalizedProfile.id, normalizedProfile);
        savedProfile = result.profile || normalizedProfile;
        if (onProfileUpdate) {
          onProfileUpdate(normalizedProfile);
        }
      }

      setSaved(true);
      setTimeout(async () => {
        await loadData();
        setSelectedId(null);
        setIsAddingNew(false);
        setNewProfileDraft(null);
        setSaved(false);
      }, 300);
      return savedProfile;
    } catch (e) {
      console.error('[ProfileManager] Failed to save profile:', e);
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return <div className="text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  // When onProfileSelect is provided (popover context), clicking a card
  // should directly select the profile — no detail view navigation.
  const isPopoverMode = !!onProfileSelect;

  const selectedProfile = selectedId ? profiles.find(p => p.id === selectedId) : null;

  if (newProfileDraft) {
    return (
      <ProfileDetailView
        key="new"
        profile={newProfileDraft}
        envApiKeys={envApiKeys}
        onBack={() => setNewProfileDraft(null)}
        onSave={handleSaveProfile}
        onReset={handleReset}
        onDelete={handleDelete}
        confirmingReset={confirmingReset}
        confirmingDelete={confirmingDelete}
        isSaving={isSaving}
        saved={saved}
        onboardingMode={onboardingMode}
        onSetDefaultAndContinue={onSetDefaultAndContinue}
      />
    );
  }

  if (isAddingNew) {
    return (
      <ProfilePresetPicker
        envApiKeys={envApiKeys}
        runtimeProviders={runtimeProviders}
        providersLoading={providersLoading}
        providersError={providersError}
        onRefresh={refreshProviders}
        onSelect={handlePresetSelect}
        onBack={() => setIsAddingNew(false)}
        isLoading={presetLoading}
      />
    );
  }

  if (selectedProfile && !isPopoverMode) {
    return (
      <ProfileDetailView
        key={selectedProfile.id}
        profile={selectedProfile}
        envApiKeys={envApiKeys}
        onBack={() => setSelectedId(null)}
        onSave={handleSaveProfile}
        onReset={handleReset}
        onDelete={handleDelete}
        confirmingReset={confirmingReset}
        confirmingDelete={confirmingDelete}
        isSaving={isSaving}
        saved={saved}
        onboardingMode={onboardingMode}
        onSetDefaultAndContinue={onSetDefaultAndContinue}
      />
    );
  }

  if (isPopoverMode) {
    return (
      <ProfileCardGrid
        mode="settings"
        profiles={profiles}
        statuses={statuses}
        statusesLoading={statusesLoading}
        compact={true}
        compactActionLabel={compactActionLabel}
        getCompactActionLabel={getCompactActionLabel}
        compactFooterLabel={compactFooterLabel}
        selectedProfileId={_selectedProfileId}
        onCardClick={(profile) => {
          onProfileSelect(profile, true);
        }}
        onOpenSettings={onNavigateToSettings}
      />
    );
  }

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t('settings.models.availableSection')}
        description={t('settings.models.apiKeyLocationHint')}
        className={listClassName}
        contentClassName="px-0 py-0 sm:px-0"
      >
        <ProfileCardGrid
          mode="settings"
          profiles={profiles}
          statuses={statuses}
          statusesLoading={statusesLoading}
          compact={false}
          compactActionLabel={compactActionLabel}
          selectedProfileId={undefined}
          onCardClick={(profile) => {
            setSelectedId(profile.id);
          }}
          onDeleteProfile={handleDelete}
          confirmingDeleteProfileId={confirmingDelete}
          onAddCustom={onNavigateToSettings ? undefined : startNewProfile}
          onOpenSettings={onNavigateToSettings}
        />
      </SettingsSection>

      {!isPopoverMode && !onboardingMode && profiles.length > 0 && (
        <SettingsSection title={t('settings.models.fastProfileSection')}>
          <SettingsRow
            label={t('settings.models.fastProfileLabel')}
            description={t('settings.models.fastProfileDescription')}
          >
            <NativeSelect
              value={fastProfileId ?? ''}
              onValueChange={handleFastProfileChange}
              items={profiles.map((profile) => ({
                label: profile.name,
                value: profile.id,
              }))}
              className="w-[320px] max-w-full"
            />
          </SettingsRow>
        </SettingsSection>
      )}
    </div>
  );
}
