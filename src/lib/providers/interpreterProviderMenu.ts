/**
 * interpreterProviderMenu.ts
 *
 * Pure reconciliation layer between the Interpreter app-server provider list
 * (v2.InterpreterProvider[], fetched via providersIpc.listInterpreterProviders)
 * and the app-facing provider menu shown in onboarding and settings.
 *
 * The app-server (the OIX binary) is the source of truth for which providers
 * exist and their config state. This module:
 *   1. Classifies the few app-owned UI lanes. Every other runtime provider
 *      passes through as a generic OIX API provider.
 *   2. Merges app-special entries for the documented gaps the app-server does
 *      not yet cover (Interpreter-hosted service and CLI-agent harnesses). Those
 *      entries are flagged with `isDocumentedFallback` + a `fallbackReason`
 *      string and carry a synthetic id that is NEVER passed back to the
 *      app-server.
 *
 * Pure functions only: no React, no IPC, no side effects. UI integration
 * (icons, rendering, fetching) lives in
 * the onboarding/settings components that consume buildProviderMenuEntries().
 *
 * Provider id ground truth: oix codex-rs/model-provider-info provider_selection.rs
 * + bundled_provider_catalog.rs. Every runtime id referenced here is a real oix
 * provider id. The app-only ids 'builtin:*' and the synthetic '__app:*' ids used
 * for fallback entries are deliberately NOT runtime ids and must never be sent to
 * listInterpreterModels / listInterpreterProviders.
 */

import type { ApiPreset, ProviderType } from '../../../shared/types/provider';
import type { Profile } from '../../../shared/types/profile';
import type { v2 } from '../../../server/handlers/codex-generated-types/index';

/**
 * Display icon key for a provider menu entry. These are data-only string keys
 * (NOT JSX). The consuming UI maps them to the existing BrandIcons components.
 *
 * - Concrete brand icons that already exist in src/components/icons/BrandIcons:
 *   'openai' | 'anthropic' | 'groq' | 'openrouter' | 'deepseek' | 'claude'
 * - App concepts: 'interpreter' (hosted), 'server' (local runtime),
 *   'terminal' (CLI agent), 'custom' (generic API endpoint with no brand icon)
 */
export type ProviderIconKey =
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'openrouter'
  | 'deepseek'
  | 'claude'
  | 'interpreter'
  | 'server'
  | 'terminal'
  | 'custom';

/**
 * The custom-endpoint quick-add preset id in oix. Selecting it adds an
 * OpenAI-compatible custom provider (freeform base URL + model).
 */
export const OIX_CUSTOM_ENDPOINT_PROVIDER_ID = 'openinterpreter_add_compatible_provider';

/**
 * Synthetic ids for app-special documented-fallback entries. These are NEVER
 * valid runtime provider ids and must never be passed to the app-server. The
 * '__app:' prefix (distinct from the app's persisted 'builtin:' provider ids and
 * from any oix id) makes accidental misuse easy to grep for and assert against.
 */
export const APP_SPECIAL_PROVIDER_IDS = {
  HOSTED: '__app:hosted',
  AGENT: '__app:agent',
  CUSTOM: '__app:custom',
} as const;

/**
 * App-facing provider menu entry. Combines runtime provider metadata (carried
 * straight through from v2.InterpreterProvider) with the app's UI/config
 * semantics (appProviderType, appApiPreset, iconKey).
 */
export interface ProviderMenuEntry {
  /**
   * Exact v2.InterpreterProvider.id from the app-server for mapped entries, or a
   * synthetic APP_SPECIAL_PROVIDER_IDS value for documented-fallback entries.
   * Only send this to the app-server when `isDocumentedFallback` is false.
   */
  oixProviderId: string;

  /** App-facing provider type. */
  appProviderType: ProviderType;
  /** For appProviderType 'api' with a known service: which preset. */
  appApiPreset?: ApiPreset;
  /** For the custom OpenAI-compatible endpoint: the oix custom-endpoint id. */
  appCustomEndpointId?: string;

  /** User-visible label. */
  displayName: string;
  /** Picker subtitle, straight from the runtime when available. */
  description?: string;
  /** Data-only icon key; the UI maps it to a BrandIcons component. */
  iconKey: ProviderIconKey;

  // Runtime config state (carried through from v2.InterpreterProvider).
  isCurrent: boolean;
  configured: boolean;
  isDefault: boolean;

  // Runtime protocol details (present for configured providers).
  baseUrl?: string;
  wireApi?: v2.InterpreterProvider['wireApi'];
  envKey?: string;

  /**
   * True for app-special entries that fill a documented app-server gap. When
   * true, oixProviderId is synthetic and must NOT be sent to the app-server.
   */
  isDocumentedFallback?: boolean;
  /** Human-readable explanation of the gap (set iff isDocumentedFallback). */
  fallbackReason?: string;
}

const API_PRESET_BY_OIX_PROVIDER_ID: Partial<Record<string, ApiPreset>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  groq: 'groq',
  deepseek: 'deepseek',
};

function iconKeyForOixProvider(providerId: string): ProviderIconKey {
  switch (providerId) {
    case 'openai':
    case 'openai::chatgpt':
    case 'openai_api_key':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'openrouter':
      return 'openrouter';
    case 'groq':
      return 'groq';
    case 'deepseek':
      return 'deepseek';
    case 'ollama':
    case 'lmstudio':
      return 'server';
    default:
      return 'custom';
  }
}

/**
 * Classify the small number of app-owned lanes. Every other provider remains an
 * OIX API provider and keeps its runtime id, name, URL, wire API, auth env key,
 * readiness, and model catalog. Workstation does not maintain an allowlist of
 * OIX providers.
 */
function classifyOixProvider(provider: v2.InterpreterProvider): {
  appProviderType: ProviderType;
  appApiPreset?: ApiPreset;
  appCustomEndpointId?: string;
  displayName: string;
  iconKey: ProviderIconKey;
} {
  if (provider.id === 'openai' || provider.id === 'openai::chatgpt') {
    return {
      appProviderType: 'openai-oauth',
      displayName: 'OpenAI (Sign in with ChatGPT)',
      iconKey: 'openai',
    };
  }

  if (provider.id === 'ollama' || provider.id === 'lmstudio') {
    return {
      appProviderType: 'local',
      displayName: provider.name,
      iconKey: 'server',
    };
  }

  if (provider.id === OIX_CUSTOM_ENDPOINT_PROVIDER_ID) {
    return {
      appProviderType: 'api',
      appCustomEndpointId: OIX_CUSTOM_ENDPOINT_PROVIDER_ID,
      displayName: provider.name || 'Custom endpoint',
      iconKey: 'custom',
    };
  }

  return {
    appProviderType: 'api',
    appApiPreset: API_PRESET_BY_OIX_PROVIDER_ID[provider.id],
    displayName: provider.name,
    iconKey: iconKeyForOixProvider(provider.id),
  };
}

/**
 * AUTHORITATIVE app ApiPreset -> oix provider id translation.
 *
 * The app's ApiPreset union ('anthropic' | 'openai' | 'groq' | 'openrouter' |
 * 'deepseek') is NOT identical to the oix provider id set. Only the OpenAI
 * Current OIX exposes one `openai` provider for both ChatGPT login and API-key
 * auth. Workstation renders those as two setup lanes, but both delegate model
 * discovery and runtime selection to that same provider id.
 *
 * Always route an ApiPreset through this before passing it to
 * listInterpreterModels / listInterpreterProviders so we never accidentally send
 * the exact runtime id selected by OIX.
 */
export const OPENAI_API_KEY_PROVIDER_ID = 'openai';

export function apiPresetToOixProviderId(preset: ApiPreset): string {
  return preset;
}

/**
 * Resolve a saved app profile to the provider id expected by
 * interpreter/harness/list. App-only Hosted and terminal/legacy-agent profiles
 * do not have an OIX provider lane and return undefined.
 */
export function profileToOixProviderId(profile: Profile): string | undefined {
  if (profile.provider === 'openai-oauth') return 'openai';
  if (profile.provider === 'hosted' || profile.provider === 'terminal' || profile.provider === 'agent') {
    return undefined;
  }
  if (profile.provider === 'local') {
    return profile.codexProfileId === 'lmstudio' ? 'lmstudio' : 'ollama';
  }

  switch (profile.codexProfileId) {
    case 'openai-api':
      return OPENAI_API_KEY_PROVIDER_ID;
    case 'custom':
      return OIX_CUSTOM_ENDPOINT_PROVIDER_ID;
    case 'interpreter':
    case 'default':
    case undefined:
      return undefined;
    default:
      return profile.codexProfileId;
  }
}

/**
 * Map a single runtime v2.InterpreterProvider to a ProviderMenuEntry.
 */
function mapOixProviderToMenuEntry(
  provider: v2.InterpreterProvider,
): ProviderMenuEntry {
  const mapping = classifyOixProvider(provider);

  return {
    oixProviderId: provider.id,
    appProviderType: mapping.appProviderType,
    appApiPreset: mapping.appApiPreset,
    appCustomEndpointId: mapping.appCustomEndpointId,
    displayName: mapping.displayName ?? provider.name,
    description: provider.description,
    iconKey: mapping.iconKey,
    isCurrent: provider.isCurrent,
    configured: provider.configured,
    isDefault: provider.isDefault,
    baseUrl: provider.baseUrl,
    wireApi: provider.wireApi,
    envKey: provider.envKey,
  };
}

/*
 * GAP(app-server): documented-fallback provider-menu entries.
 *
 * The app-server's listInterpreterProviders() does NOT enumerate two surfaces
 * the app provider menu must still offer. We synthesize app-only entries for
 * them here, flagged with isDocumentedFallback + fallbackReason, and carrying a
 * synthetic '__app:' id that must never be passed back to the app-server.
 *
 * GAP-HOSTED: Interpreter-hosted service.
 *   - What the app-server does NOT provide: the Interpreter-hosted provider and
 *     its models (interpreter-smart / interpreter-fast) are not returned by
 *     listInterpreterProviders() and not enumerated by listInterpreterModels().
 *   - Fallback datum lives in: shared/types/provider.ts (BUILTIN_PROVIDER_IDS
 *     .HOSTED / BUILTIN_PROVIDERS hosted entry) and the hosted model picker
 *     (src/hooks/use-hosted-model-catalog.ts + src/components/HostedModelPicker
 *     .tsx) for the hosted model list.
 *   - How to remove: once the app-server returns the Interpreter-hosted provider
 *     from listInterpreterProviders() and its models from listInterpreterModels(),
 *     delete the HOSTED entry from buildAppSpecialProviderEntries() and let the
 *     mapped entry flow through OIX_TO_APP_PROVIDER_MAPPING instead.
 *
 * GAP-AGENTS: CLI-agent harnesses (Claude Code, Codex CLI).
 *   - What the app-server does NOT provide: CLI agents are HARNESSES
 *     (interpreter/harness/list), not providers; they never appear in
 *     listInterpreterProviders().
 *   - Fallback datum lives in: shared/types/provider.ts (BUILTIN_PROVIDER_IDS
 *     .AGENT / BUILTIN_PROVIDERS agent entry; ProviderType 'agent' | 'terminal')
 *     and the app's existing CLI-agent config/detection logic.
 *   - How to remove: once the app-server bridges harnesses into the provider
 *     list (or the provider menu reads interpreter/harness/list directly),
 *     delete the AGENT entry from buildAppSpecialProviderEntries().
 *
 * Both gaps are tracked here as the canonical gap inventory for the provider
 * menu reconciliation; keep this block in sync with the fallback datum sites.
 */
function buildAppSpecialProviderEntries(): ProviderMenuEntry[] {
  return [
    {
      oixProviderId: APP_SPECIAL_PROVIDER_IDS.HOSTED,
      appProviderType: 'hosted',
      displayName: 'Hosted',
      description: 'Use the Interpreter-hosted AI service.',
      iconKey: 'interpreter',
      // Placeholder runtime state: the real hosted readiness/config is resolved
      // by the app's hosted account/session logic, not the app-server list.
      isCurrent: false,
      configured: true,
      isDefault: false,
      isDocumentedFallback: true,
      fallbackReason:
        'GAP-HOSTED: Interpreter-hosted provider and its models '
        + '(interpreter-smart / interpreter-fast) are not returned by '
        + 'listInterpreterProviders() / listInterpreterModels(). App-only entry; '
        + 'remove once the app-server enumerates the hosted provider.',
    },
    {
      oixProviderId: APP_SPECIAL_PROVIDER_IDS.AGENT,
      appProviderType: 'agent',
      displayName: 'CLI Agent',
      description: 'Use a CLI coding agent (Claude Code or Codex CLI).',
      iconKey: 'terminal',
      // Placeholder runtime state: real install/login state comes from the app's
      // CLI-agent detection (ClaudeCodeStatus / CodexStatus), not the list call.
      isCurrent: false,
      configured: false,
      isDefault: false,
      isDocumentedFallback: true,
      fallbackReason:
        'GAP-AGENTS: CLI agents are harnesses (interpreter/harness/list), not '
        + 'providers, so they never appear in listInterpreterProviders(). '
        + 'App-only entry; remove once the app-server bridges harnesses into the '
        + 'provider list.',
    },
    {
      oixProviderId: APP_SPECIAL_PROVIDER_IDS.CUSTOM,
      appProviderType: 'api',
      appCustomEndpointId: OIX_CUSTOM_ENDPOINT_PROVIDER_ID,
      displayName: 'Custom endpoint',
      description: 'Use a custom Chat Completions, Responses, or Messages endpoint.',
      iconKey: 'custom',
      isCurrent: false,
      configured: true,
      isDefault: false,
      isDocumentedFallback: true,
      fallbackReason:
        'GAP-CUSTOM: OIX 0.0.34 no longer enumerates a custom-endpoint quick-add '
        + 'provider. Workstation keeps its existing app-managed custom provider '
        + 'configuration while delegating the resulting runtime to OIX.',
    },
  ];
}

/**
 * Stable sort comparator for provider menu entries.
 *
 * Order, preserving the app's existing menu semantics:
 *   1. default provider first, then the current provider,
 *   2. configured providers before unconfigured,
 *   3. then alphabetically by display name.
 *
 * The app-server already applies a readiness sort to its own list; this keeps a
 * deterministic order once the app-special entries are merged in.
 */
function sortProviderMenuEntries(a: ProviderMenuEntry, b: ProviderMenuEntry): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
  if (a.configured !== b.configured) return a.configured ? -1 : 1;
  return a.displayName.localeCompare(b.displayName);
}

/**
 * Build the app-facing provider menu from the app-server provider list.
 *
 * @param runtimeProviders - v2.InterpreterProvider[] from
 *   providersIpc.listInterpreterProviders(includeUnconfigured?). The documented
 *   fallback hosted + CLI-agent entries are merged in.
 * @returns ProviderMenuEntry[] sorted with sortProviderMenuEntries.
 */
export function buildProviderMenuEntries(
  runtimeProviders: v2.InterpreterProvider[],
): ProviderMenuEntry[] {
  const mapped = runtimeProviders.flatMap((provider) => {
    const entry = mapOixProviderToMenuEntry(provider);
    if (provider.id !== 'openai') return [entry];

    // OIX intentionally owns one OpenAI provider. Workstation presents its two
    // auth experiences separately without inventing a second runtime provider.
    return [
      entry,
      {
        ...entry,
        appProviderType: 'api' as const,
        appApiPreset: 'openai' as const,
        displayName: 'OpenAI API',
      },
    ];
  });

  return [...mapped, ...buildAppSpecialProviderEntries()].sort(sortProviderMenuEntries);
}

/**
 * True when an id is an app-special synthetic id (a documented-fallback entry's
 * oixProviderId). Use this to guard against sending a synthetic id to the
 * app-server (listInterpreterModels / listInterpreterProviders).
 */
export function isAppSpecialProviderId(id: string): boolean {
  return id.startsWith('__app:');
}
