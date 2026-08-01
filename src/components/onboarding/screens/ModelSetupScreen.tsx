/**
 * ModelSetupScreen
 *
 * Pack-first onboarding model setup:
 * - Recommended packs always visible (Interpreter + OpenAI)
 * - Auto-detected packs shown in a dedicated section
 * - Advanced providers expands to additional pack cards (packs only)
 * - One separate "Add custom model" escape hatch
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Key,
  Loader2,
  Plus,
  X,
} from 'lucide-react';
import { useOnboarding } from '../OnboardingContext';
import { trackProviderSelected } from '../../../utils/telemetry';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { NativeSelect } from '../../ui/NativeSelect';
import { ResponsesApiBaseUrlPicker } from '../../ResponsesApiBaseUrlPicker';
import { usePressState } from '../../ui/usePressState';
import { AuthSignIn } from '../../auth/AuthSignIn';
import { OpenAIIcon, AnthropicIcon, GroqIcon, OpenRouterIcon, DeepSeekIcon } from '../../icons/BrandIcons';
import { InterpreterLogoMark } from '../../InterpreterLogoMark';
import { useAuth } from '../../../contexts/AuthContext';
import { providers as providersIpc, openExternal } from '../../../ipc';
import { inferProfileIdFromEndpoint } from '@/lib/codex/profile-options';
import {
  AUTH_URL_COPIED_MESSAGE,
  AUTH_URL_OPEN_FAILED_MESSAGE,
  openAuthUrl,
} from '../../../utils/authUrl';
import {
  trackOnboardingError,
  trackOAuthModelListFailed,
  trackOAuthSignInCompleted,
  trackOAuthSignInFailed,
  trackOAuthSignInStarted,
} from '../../../utils/telemetry';
import {
  classifyOpenAIOAuthModelListError,
  getOpenAIOAuthModelListErrorMessage,
} from '../../../lib/openaiOAuthErrors';
import { OnboardingModal } from '../components/OnboardingModal';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import {
  buildOpenAIOAuthOnboardingPack,
  getHostedOnboardingFastProfileId,
  getOpenAIOAuthInitialSelectedProfileIds,
  getOnboardingModelPack,
  inferPreferredProfileIdFromOnboardingText,
  inferPreferredModelPackIdsFromOnboardingText,
  ONBOARDING_OPTIONAL_MODEL_PACK_ORDER,
  type OnboardingOptionalModelPackId,
  type OnboardingModelPack,
} from '../../../../shared/types/modelDefaults';
import type { Profile } from '../../../../shared/types/profile';
import type { LmStudioStatus, OllamaStatus } from '../../../../shared/types/provider';
import {
  getApiPresetBaseURL,
  isDeepSeekApiBaseURL,
  getUnsupportedResponsesApiBaseUrlMessage,
  type ApiFormat,
  type ApiPreset,
  type EnvApiKeysResult,
  type SupportedOpenAIOAuthModel,
} from '../../../../shared/types/provider';
import type { WireApi } from '../../../../shared/types/model';
import { buildLocalPackReviewPlan } from './localRuntimeOnboarding';
import { useInterpreterProviders } from '../../../hooks/use-interpreter-models';
import {
  apiPresetToOixProviderId,
  buildProviderMenuEntries,
  type ProviderMenuEntry,
} from '../../../lib/providers/interpreterProviderMenu';
import { getOnboardingState } from '../../../api';
import { parseOnboardingInterviewDraft } from '../../../../shared/types/onboardingState';
import { hasHostedApi } from '../../../../shared/productConfig';
export { buildOllamaPack, buildLmStudioPack } from './localRuntimeOnboarding';

export type ApiKeyProvider = ApiPreset;
type OAuthProvider = 'openai';
export type OptionalPackId = OnboardingOptionalModelPackId;

const hostedDistributionEnabled = hasHostedApi();

function BrandFavicon({ domain, className }: { domain: string; className?: string }) {
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=128`}
      alt=""
      className={className}
      loading="lazy"
    />
  );
}

/**
 * Per-provider config scaffolding for API-key packs.
 *
 * This is plumbing only (display name, env var, wire/base-url presets). The
 * model list itself is NOT stored here; it is fetched from the Interpreter
 * app-server via `listInterpreterModels(<providerId>)` when a pack is opened.
 */
interface ApiKeyPack {
  label: string;
  envVar: string;
  apiFormat: ApiFormat;
  baseURL: string;
  wireApi: WireApi;
}

interface OAuthStatus {
  isConnected: boolean;
  email?: string;
}

const API_KEY_MODEL_PACKS: Record<ApiKeyProvider, ApiKeyPack> = {
  openai: {
    label: 'OpenAI API',
    envVar: 'OPENAI_API_KEY',
    apiFormat: 'openai',
    baseURL: getApiPresetBaseURL('openai'),
    wireApi: 'responses',
  },
  anthropic: {
    label: 'Anthropic API',
    envVar: 'ANTHROPIC_API_KEY',
    apiFormat: 'anthropic',
    baseURL: getApiPresetBaseURL('anthropic'),
    wireApi: 'messages',
  },
  openrouter: {
    label: 'OpenRouter API',
    envVar: 'OPENROUTER_API_KEY',
    apiFormat: 'openai',
    baseURL: getApiPresetBaseURL('openrouter'),
    wireApi: 'responses',
  },
  groq: {
    label: 'Groq API',
    envVar: 'GROQ_API_KEY',
    apiFormat: 'openai',
    baseURL: getApiPresetBaseURL('groq'),
    wireApi: 'responses',
  },
  deepseek: {
    label: 'DeepSeek API',
    envVar: 'DEEPSEEK_API_KEY',
    apiFormat: 'openai',
    baseURL: getApiPresetBaseURL('deepseek'),
    wireApi: 'chat',
  },
};

function apiKeyProviderFromPackId(packId: OptionalPackId): ApiKeyProvider | null {
  switch (packId) {
    case 'api:openai':
      return 'openai';
    case 'api:anthropic':
      return 'anthropic';
    case 'api:openrouter':
      return 'openrouter';
    case 'api:groq':
      return 'groq';
    case 'api:deepseek':
      return 'deepseek';
    case 'local:ollama':
    case 'local:lmstudio':
      return null;
  }
}

/**
 * Map an Interpreter app-server provider menu entry back to the app-side
 * OptionalPackId the optional onboarding grid renders.
 *
 * Returns null for entries that are NOT part of the optional grid:
 *   - the OpenAI ChatGPT sign-in lane (rendered as a recommended card),
 *   - the custom-endpoint preset and the bundled cloud catalog (api with no
 *     first-class preset; surfaced via the "Add custom model" escape hatch),
 *   - the app-special hosted / CLI-agent fallback entries.
 *
 * This keeps the optional grid's visible set sourced from the app-server while
 * preserving the existing pack ids, icons, handlers, and ordering.
 */
function optionalPackIdFromMenuEntry(entry: ProviderMenuEntry): OptionalPackId | null {
  if (entry.appProviderType === 'local') {
    if (entry.oixProviderId === 'ollama') return 'local:ollama';
    if (entry.oixProviderId === 'lmstudio') return 'local:lmstudio';
    return null;
  }

  if (entry.appProviderType === 'api' && entry.appApiPreset) {
    return `api:${entry.appApiPreset}`;
  }

  return null;
}

const MODEL_CARD_BORDER_COLOR = 'color-mix(in oklch, var(--oa-border) 46%, transparent)';
const MODEL_CARD_BACKGROUND = 'color-mix(in oklch, var(--oa-bg-app) 88%, var(--oa-bg-subtle) 12%)';
const MODEL_SECTION_DIVIDER = 'color-mix(in oklch, var(--oa-border) 62%, transparent)';
const MODEL_CARD_ACTION_WIDTH = 'min(220px, 100%)';
const PRESSABLE_CARD_MOTION = 'transition-[background-color,border-color,transform] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transform-none motion-reduce:duration-0';
const ONBOARDING_MODAL_STYLE = {
  border: 'var(--border-width) solid var(--oa-border)',
  backgroundColor: 'color-mix(in oklch, var(--oa-bg-input) 98%, var(--oa-bg-app) 2%)',
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.14)',
};
function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function toOnboardingProfiles(pack: OnboardingModelPack): Profile[] {
  return pack.profiles.map((profileTemplate) => ({
    id: profileTemplate.id,
    name: profileTemplate.name,
    provider: profileTemplate.provider,
    providerId: profileTemplate.providerId,
    modelId: profileTemplate.modelId,
    baseURL: profileTemplate.baseURL,
    codexProfileId: profileTemplate.codexProfileId,
    helpDescription: profileTemplate.helpDescription,
    isBuiltin: false,
  }));
}

function getDefaultBaseUrlForFormat(format: ApiFormat): string {
  return format === 'anthropic'
    ? getApiPresetBaseURL('anthropic')
    : getApiPresetBaseURL('openai');
}

interface ModelPackCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  badge?: string;
  footer?: string;
  actionContent?: ReactNode;
  actionLabel: string;
  actionDisabled?: boolean;
  actionLoading?: boolean;
  onAction: () => void;
  fullCardClickable?: boolean;
  cardClassName?: string;
  actionAreaClassName?: string;
  vertical?: boolean;
  featured?: boolean;
}

function ModelPackCard({
  icon,
  title,
  description,
  badge,
  footer,
  actionContent,
  actionLabel,
  actionDisabled,
  actionLoading,
  onAction,
  fullCardClickable,
  cardClassName,
  actionAreaClassName,
  vertical,
  featured,
}: ModelPackCardProps) {
  const isCardClickable = !!fullCardClickable && !actionDisabled && !actionLoading;
  const { pressed, pressProps } = usePressState<HTMLDivElement>(!isCardClickable);

  const actionNode = actionContent ? (
    actionContent
  ) : (
    <Button
      type="button"
      onClick={(event) => {
        if (isCardClickable) {
          event.stopPropagation();
        }
        onAction();
      }}
      variant="outline"
      size="sm"
      className="w-full rounded-full border-black bg-black text-white hover:border-black hover:bg-black hover:text-white dark:border-white dark:bg-white dark:text-black dark:hover:border-white dark:hover:bg-white dark:hover:text-black"
      style={{ maxWidth: vertical ? '100%' : MODEL_CARD_ACTION_WIDTH }}
      disabled={actionDisabled}
    >
      {actionLoading && <Loader2 className="size-3.5 animate-spin" />}
      {actionLabel}
    </Button>
  );

  if (vertical) {
    return (
      <div
        data-pressed={pressed ? 'true' : undefined}
        className={`mx-auto flex min-h-[184px] w-full max-w-none flex-col rounded-[16px] px-4 pb-5 pt-6 text-center ${PRESSABLE_CARD_MOTION} ${isCardClickable ? 'transform-gpu data-[pressed=true]:scale-[0.985]' : ''} ${cardClassName || ''}`}
        style={{
          border: `var(--border-width) solid ${featured
            ? 'color-mix(in oklch, var(--oa-text-strong) 14%, var(--oa-border) 86%)'
            : MODEL_CARD_BORDER_COLOR}`,
          backgroundColor: featured
            ? 'color-mix(in oklch, var(--oa-bg-subtle) 12%, var(--oa-bg-app) 88%)'
            : MODEL_CARD_BACKGROUND,
          boxShadow: 'none',
        }}
        onClick={isCardClickable ? onAction : undefined}
        onPointerDown={isCardClickable ? pressProps.onPointerDown : undefined}
        onPointerUp={isCardClickable ? pressProps.onPointerUp : undefined}
        onPointerLeave={isCardClickable ? pressProps.onPointerLeave : undefined}
        onPointerCancel={isCardClickable ? pressProps.onPointerCancel : undefined}
        role={isCardClickable ? 'button' : undefined}
        tabIndex={isCardClickable ? 0 : undefined}
        onKeyDown={isCardClickable ? (event) => {
          pressProps.onKeyDown(event);
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onAction();
          }
        } : undefined}
        onKeyUp={isCardClickable ? pressProps.onKeyUp : undefined}
        onBlur={isCardClickable ? pressProps.onBlur : undefined}
      >
        <div className="mx-auto flex size-8 shrink-0 items-center justify-center text-foreground">
          {icon}
        </div>

        <div className="mt-3 flex flex-1 flex-col items-center">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <h3 className="text-[13.5px] font-medium text-[var(--oa-text-strong)]">{title}</h3>
              {badge && (
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--oa-text-muted)]">
                  {badge}
                </span>
              )}
            </div>
            <p className="mx-auto max-w-[214px] text-[10px] leading-[1.35] text-[var(--oa-text-muted)]">
              {description}
            </p>
          </div>

          {footer && (
            <p className="mx-auto mt-2 max-w-[214px] text-[9px] leading-4 text-[var(--oa-text-muted)]">
              {footer}
            </p>
          )}

          <div className={`mt-auto w-full pt-3.5 ${actionAreaClassName || ''}`}>
            <div className="w-full">
              {actionNode}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-pressed={pressed ? 'true' : undefined}
      className={`rounded-[16px] px-4 py-3.5 ${PRESSABLE_CARD_MOTION} ${isCardClickable ? 'transform-gpu data-[pressed=true]:scale-[0.985]' : ''} ${cardClassName || ''}`}
      style={{
        border: `var(--border-width) solid ${MODEL_CARD_BORDER_COLOR}`,
        backgroundColor: MODEL_CARD_BACKGROUND,
        boxShadow: 'none',
      }}
      onClick={isCardClickable ? onAction : undefined}
      onPointerDown={isCardClickable ? pressProps.onPointerDown : undefined}
      onPointerUp={isCardClickable ? pressProps.onPointerUp : undefined}
      onPointerLeave={isCardClickable ? pressProps.onPointerLeave : undefined}
      onPointerCancel={isCardClickable ? pressProps.onPointerCancel : undefined}
      role={isCardClickable ? 'button' : undefined}
      tabIndex={isCardClickable ? 0 : undefined}
      onKeyDown={isCardClickable ? (event) => {
        pressProps.onKeyDown(event);
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onAction();
        }
      } : undefined}
      onKeyUp={isCardClickable ? pressProps.onKeyUp : undefined}
      onBlur={isCardClickable ? pressProps.onBlur : undefined}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3.5 text-left">
          <div className="flex size-10 shrink-0 items-center justify-center text-foreground">
            {icon}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-medium text-[var(--oa-text-strong)]">{title}</h3>
              {badge && (
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--oa-text-muted)]">
                  {badge}
                </span>
              )}
            </div>
            <p className="mt-1 text-[13px] leading-5 text-[var(--oa-text-muted)]">
              {description}
            </p>

            {footer && (
              <p className="mt-1.5 text-[12px] text-[var(--oa-text-muted)]">
                {footer}
              </p>
            )}
          </div>
        </div>

        <div className={`w-full sm:w-[220px] sm:shrink-0 ${actionAreaClassName || ''}`}>
          <div className="w-full">
            {actionNode}
          </div>
        </div>
      </div>
    </div>
  );
}

interface CompactProviderGridItemProps {
  icon: ReactNode;
  title: string;
  status: string;
  badge: string;
  onAdd: () => void;
  addLabel: string;
  disabled?: boolean;
  loading?: boolean;
  cardClassName?: string;
}

function CompactProviderGridItem({
  icon,
  title,
  status,
  badge,
  onAdd,
  addLabel,
  disabled,
  loading,
  cardClassName,
}: CompactProviderGridItemProps) {
  const isInteractive = !disabled && !loading;
  const { pressed, pressProps } = usePressState<HTMLDivElement>(!isInteractive);

  return (
    <div
      data-pressed={pressed ? 'true' : undefined}
      className={`flex min-h-[78px] flex-col rounded-[16px] px-3 py-2 ${PRESSABLE_CARD_MOTION} ${isInteractive ? 'transform-gpu data-[pressed=true]:scale-[0.985]' : ''} ${cardClassName || ''}`}
      style={{
        border: `var(--border-width) solid ${MODEL_CARD_BORDER_COLOR}`,
        backgroundColor: MODEL_CARD_BACKGROUND,
      }}
      onClick={isInteractive ? onAdd : undefined}
      onPointerDown={isInteractive ? pressProps.onPointerDown : undefined}
      onPointerUp={isInteractive ? pressProps.onPointerUp : undefined}
      onPointerLeave={isInteractive ? pressProps.onPointerLeave : undefined}
      onPointerCancel={isInteractive ? pressProps.onPointerCancel : undefined}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onKeyDown={isInteractive ? (event) => {
        pressProps.onKeyDown(event);
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onAdd();
        }
      } : undefined}
      onKeyUp={isInteractive ? pressProps.onKeyUp : undefined}
      onBlur={isInteractive ? pressProps.onBlur : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="shrink-0">{icon}</div>
          <p className="truncate text-[12.5px] font-medium text-foreground">{title}</p>
        </div>
        <span className="inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[8.5px] text-[var(--oa-text-muted)]" style={{ border: `var(--border-width) solid ${MODEL_SECTION_DIVIDER}` }}>
          {badge}
        </span>
      </div>
      <p className="mt-1 text-[9.5px] leading-[1.3] text-[var(--oa-text-muted)]">{status}</p>

      <div className="mt-auto flex justify-end pt-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="rounded-full px-2 shadow-none hover:border-[var(--oa-border)] hover:bg-[var(--oa-bg-input)]"
          onClick={(event) => {
            event.stopPropagation();
            if (!isInteractive) return;
            onAdd();
          }}
          disabled={!isInteractive}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

interface ModelSetupScreenProps {
  onOpenPackReview: (reviewState: ModelPackReviewState) => void;
  initialShowCustomModel?: boolean;
}

export interface ModelPackReviewState {
  packId: string;
  title: string;
  subtitle: string;
  profiles: Profile[];
  defaultProfileId: string;
  fastProfileId?: string;
  initialSelectedProfileIds?: string[];
  errorMessage: string;
  requiredApiKeyProvider?: ApiKeyProvider;
}

export function resolveOnboardingReviewDefaultProfileId(
  preferenceText: string,
  profiles: Pick<Profile, 'id' | 'name' | 'modelId'>[],
  defaultProfileId: string,
): string {
  return inferPreferredProfileIdFromOnboardingText(preferenceText, profiles, defaultProfileId);
}

export function ModelSetupScreen({
  onOpenPackReview,
  initialShowCustomModel = false,
}: ModelSetupScreenProps) {
  "use no memo";

  const { t } = useTranslation();
  const { detectionResults } = useOnboarding();
  const { isAuthenticated, user } = useAuth();

  const [openAIOAuthStatus, setOpenAIOAuthStatus] = useState<OAuthStatus>({ isConnected: false });
  const [envApiKeys, setEnvApiKeys] = useState<EnvApiKeysResult | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [lmStudioStatus, setLmStudioStatus] = useState<LmStudioStatus | null>(null);

  const [setupLoading, setSetupLoading] = useState<string | null>(null);
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [preferredPackIds, setPreferredPackIds] = useState<OptionalPackId[]>([]);
  const [onboardingModelPreferenceText, setOnboardingModelPreferenceText] = useState('');

  const [showCustomModel, setShowCustomModel] = useState(initialShowCustomModel);

  const [customName, setCustomName] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [customApiFormat, setCustomApiFormat] = useState<ApiFormat>('openai');
  const [customBaseURL, setCustomBaseURL] = useState(getDefaultBaseUrlForFormat('openai'));

  const oauthPollTimers = useRef<Partial<Record<OAuthProvider, ReturnType<typeof setInterval>>>>({});
  const oauthTimeoutTimers = useRef<Partial<Record<OAuthProvider, ReturnType<typeof setTimeout>>>>({});
  const oauthAutoAddPackIntent = useRef<Partial<Record<OAuthProvider, boolean>>>({});
  // Guards against stale model-list responses for API-key packs: only the most
  // recent fetch for a given provider may open the pack review.
  const apiKeyModelFetchIdRef = useRef(0);

  const detectedProviders = detectionResults?.detectedProviders ?? [];
  const detectedTools = detectionResults?.detectedTools ?? [];

  const hasOllama = !!ollamaStatus?.running || detectedProviders.includes('ollama') || detectedTools.includes('ollama');
  const hasLmStudio = !!lmStudioStatus?.running || detectedProviders.includes('lmstudio') || detectedTools.includes('lmstudio');
  const hasOpenAIKey = envApiKeys ? envApiKeys.openai.found : detectedProviders.includes('openai-key');
  const hasAnthropicKey = envApiKeys ? envApiKeys.anthropic.found : detectedProviders.includes('anthropic-key');
  const hasOpenRouterKey = envApiKeys ? envApiKeys.openrouter.found : detectedProviders.includes('openrouter-key');
  const hasGroqKey = envApiKeys ? envApiKeys.groq.found : detectedProviders.includes('groq-key');
  const hasDeepSeekKey = envApiKeys ? envApiKeys.deepseek.found : detectedProviders.includes('deepseek-key');

  /*
   * GAP(app-server): Hosted provider (Interpreter service)
   *
   * The Interpreter-hosted service is NOT returned by listInterpreterProviders()
   * and its models (interpreter-smart / interpreter-fast) are NOT enumerated by
   * listInterpreterModels(). Reason: it is a configured account/auth-managed
   * service, not a provider preset in the oix runtime.
   *
   * Fallback: keep the hardcoded hosted pack from
   * shared/types/modelDefaults.ts getOnboardingModelPack('hosted') for the
   * recommended Interpreter card below (see the InterpreterLogoMark ModelPackCard
   * in the recommended grid). buildProviderMenuEntries() also synthesizes an
   * app-special '__app:hosted' entry for the same gap; the onboarding recommended
   * card stays on this hardcoded pack because it drives the hosted profile
   * templates the pack-review flow applies.
   *
   * Remove once the app-server enumerates the hosted provider in
   * listInterpreterProviders() and its models in listInterpreterModels().
   */
  const hostedPackProfiles = useMemo(
    () => toOnboardingProfiles(getOnboardingModelPack('hosted')),
    [],
  );

  useEffect(() => {
    let cancelled = false;

    getOnboardingState()
      .then(({ state }) => {
        if (cancelled) return;
        const parsedDraft = parseOnboardingInterviewDraft(state.interviewDraft);
        const preferenceText = [
          parsedDraft.modelsUsed,
          parsedDraft.currentSetup,
          state.interviewResult?.summary ?? '',
        ].filter(Boolean).join('\n');
        setOnboardingModelPreferenceText(preferenceText);
        setPreferredPackIds(inferPreferredModelPackIdsFromOnboardingText(preferenceText));
      })
      .catch((error) => {
        console.error('[ModelSetup] Failed to load onboarding AI setup preferences:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Optional-provider grid source of truth: the Interpreter app-server. We pass
  // includeUnconfigured=true so bundled quick-add presets (e.g. unconfigured
  // API-key providers) are listed before the user pastes a key. buildProvider
  // MenuEntries() applies the oix<->app id mapping; we then keep only the ids the
  // optional grid renders and re-apply ONBOARDING_OPTIONAL_MODEL_PACK_ORDER for stable ordering.
  const {
    data: runtimeProviders,
    loading: providersLoading,
    error: providersError,
    refresh: refreshProviders,
  } = useInterpreterProviders(true);

  const clearOAuthTimers = useCallback((provider: OAuthProvider) => {
    const pollTimer = oauthPollTimers.current[provider];
    if (pollTimer) {
      clearInterval(pollTimer);
      oauthPollTimers.current[provider] = undefined;
    }

    const timeoutTimer = oauthTimeoutTimers.current[provider];
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      oauthTimeoutTimers.current[provider] = undefined;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      providersIpc.getOAuthStatus('openai').catch(() => ({ isConnected: false })),
      providersIpc.getEnvApiKeys().catch(() => null),
      providersIpc.getOllamaStatus().catch(() => ({ running: false })),
      providersIpc.getLmStudioStatus().catch(() => ({ running: false })),
    ]).then(([openaiStatus, envKeys, ollama, lmStudio]) => {
      if (cancelled) return;
      setOpenAIOAuthStatus(openaiStatus);
      setEnvApiKeys(envKeys);
      setOllamaStatus(ollama);
      setLmStudioStatus(lmStudio);
    });

    return () => {
      cancelled = true;
      clearOAuthTimers('openai');
    };
  }, [clearOAuthTimers]);

  const openPackReview = useCallback((
    packId: string,
    title: string,
    subtitle: string,
    profiles: Profile[],
    defaultProfileId: string,
    fastProfileId: string | undefined,
    initialSelectedProfileIds: string[] | undefined,
    errorMessage: string,
    requiredApiKeyProvider?: ApiKeyProvider,
  ) => {
    setSetupLoading(null);
    setSetupError(null);
    trackProviderSelected({
      packId,
      wasDetected: !requiredApiKeyProvider,
      step: 'model_setup',
    });
    const resolvedDefaultProfileId = resolveOnboardingReviewDefaultProfileId(
      onboardingModelPreferenceText,
      profiles,
      defaultProfileId,
    );
    const resolvedInitialSelectedProfileIds = initialSelectedProfileIds
      ? Array.from(new Set([resolvedDefaultProfileId, ...initialSelectedProfileIds]))
      : initialSelectedProfileIds;
    onOpenPackReview({
      packId,
      title,
      subtitle,
      profiles,
      defaultProfileId: resolvedDefaultProfileId,
      fastProfileId,
      initialSelectedProfileIds: resolvedInitialSelectedProfileIds,
      errorMessage,
      requiredApiKeyProvider,
    });
  }, [onOpenPackReview, onboardingModelPreferenceText]);

  const loadOpenAIOAuthPack = useCallback(async (): Promise<OnboardingModelPack> => {
    const { models } = await providersIpc.listOpenAIOAuthModels();
    return buildOpenAIOAuthOnboardingPack(models);
  }, []);

  const getOpenAIOAuthFastProfileId = useCallback((pack: OnboardingModelPack): string | undefined => {
    return pack.profiles.find((profile) => profile.id !== pack.defaultProfileId)?.id;
  }, []);

  const openApiKeyPackReview = useCallback(async (
    keyType: ApiKeyProvider,
    credentials?: { apiKey?: string; environmentKey?: string },
  ) => {
    const normalizedApiKey = credentials?.apiKey?.trim() ?? '';
    const environmentKey = credentials?.environmentKey?.trim() || undefined;
    const requiresApiKey = normalizedApiKey.length === 0 && !environmentKey;
    const pack = API_KEY_MODEL_PACKS[keyType];

    // Models and provider transport metadata are sourced from OIX. Workstation's
    // preset only supplies presentation and a compatibility fallback for an
    // older runtime that does not report the newer fields.
    const oixProviderId = apiPresetToOixProviderId(keyType);
    const oixProvider = runtimeProviders?.find((provider) => provider.id === oixProviderId);
    const baseURL = oixProvider?.baseUrl?.trim() || pack.baseURL;
    const wireApi = oixProvider?.wireApi ?? pack.wireApi;
    const apiFormat = wireApi === 'messages' ? 'anthropic' : pack.apiFormat;
    const fetchId = ++apiKeyModelFetchIdRef.current;
    let models: SupportedOpenAIOAuthModel[];
    try {
      const result = await providersIpc.listInterpreterModels(oixProviderId);
      models = result.models;
    } catch (error) {
      if (fetchId !== apiKeyModelFetchIdRef.current) return;
      console.error(`[ModelSetup] Failed to load ${pack.label} models:`, error);
      trackOnboardingError({
        step: 'model_setup',
        stage: 'load_api_key_models',
        error,
        displayMessage: t('onboarding.modelSetup.failedProvider', { provider: pack.label }),
        context: { provider: keyType },
      });
      setSetupError(t('onboarding.modelSetup.failedProvider', { provider: pack.label }));
      setSetupLoading(null);
      return;
    }
    // Ignore stale responses; a newer fetch for this surface has superseded us.
    if (fetchId !== apiKeyModelFetchIdRef.current) return;

    if (models.length === 0) {
      // No silent fallback: surface the failure and let the user retry the card.
      trackOnboardingError({
        step: 'model_setup',
        stage: 'load_api_key_models',
        error: 'empty_model_list',
        displayMessage: t('onboarding.modelSetup.failedProvider', { provider: pack.label }),
        context: { provider: keyType },
      });
      setSetupError(t('onboarding.modelSetup.failedProvider', { provider: pack.label }));
      setSetupLoading(null);
      return;
    }

    const profilesToApply: Profile[] = models.map((model) => ({
      id: `onboarding:${keyType}-${toSlug(model.id)}`,
      name: model.name,
      provider: 'api',
      providerId: undefined,
      modelId: model.id,
      apiKey: normalizedApiKey || undefined,
      environmentKey,
      apiFormat,
      baseURL,
      useResponsesApi: wireApi === 'responses',
      wireApi,
      codexProfileId: oixProviderId,
      isBuiltin: false,
    }));

    const defaultModel = models.find((model) => model.isDefault) ?? models[0];
    const defaultProfileId = `onboarding:${keyType}-${toSlug(defaultModel.id)}`;
    const fastProfileId = profilesToApply.find((profile) => profile.id !== defaultProfileId)?.id;

    openPackReview(
      `api:${keyType}`,
      `${pack.label}`,
      t('onboarding.modelSetup.chooseModelsFromSubtitle', { provider: pack.label }),
      profilesToApply,
      defaultProfileId,
      fastProfileId,
      undefined,
      t('onboarding.modelSetup.failedProvider', { provider: pack.label }),
      requiresApiKey ? keyType : undefined,
    );
  }, [openPackReview, runtimeProviders, t]);

  const handleConnectOAuth = useCallback(async (autoAddPackOnSuccess = false) => {
    const provider: OAuthProvider = 'openai';
    setSetupError(null);
    setOauthLoading(provider);
    oauthAutoAddPackIntent.current[provider] = autoAddPackOnSuccess;

    try {
      const { authUrl, flowId } = await providersIpc.initiateOAuth(provider);
      trackOAuthSignInStarted({
        provider,
        surface: 'onboarding',
        flowId,
        autoAddPack: autoAddPackOnSuccess,
      });
      const openResult = await openAuthUrl(authUrl);
      if (openResult.status === 'failed') {
        trackOAuthSignInFailed({
          provider,
          surface: 'onboarding',
          flowId,
          error: openResult.openError,
          stage: 'open_browser',
        });
        setOauthLoading((current) => (current === provider ? null : current));
        setSetupError(AUTH_URL_OPEN_FAILED_MESSAGE);
        return;
      }
      setSetupError(openResult.status === 'copied' ? AUTH_URL_COPIED_MESSAGE : null);
      clearOAuthTimers(provider);

      oauthPollTimers.current[provider] = setInterval(async () => {
        try {
          const status = await providersIpc.getOAuthStatus(provider);
          if (status.error) {
            clearOAuthTimers(provider);
            oauthAutoAddPackIntent.current[provider] = false;
            setOauthLoading((current) => (current === provider ? null : current));
            trackOAuthSignInFailed({
              provider,
              surface: 'onboarding',
              flowId,
              error: status.error,
              stage: 'poll',
            });
            trackOnboardingError({
              step: 'model_setup',
              stage: 'oauth_status',
              error: status.error,
              displayMessage: status.error,
              context: { provider },
            });
            setSetupError(status.error);
            return;
          }
          if (!status.isConnected) return;

          setOpenAIOAuthStatus(status);
          clearOAuthTimers(provider);
          setOauthLoading((current) => (current === provider ? null : current));
          trackOAuthSignInCompleted({
            provider,
            surface: 'onboarding',
            flowId,
            hasEmail: Boolean(status.email),
          });

          if (oauthAutoAddPackIntent.current.openai) {
            oauthAutoAddPackIntent.current.openai = false;
            setSetupLoading('openai-oauth');

            try {
              const openAIPack = await loadOpenAIOAuthPack();
              openPackReview(
                'openai-oauth',
                t('onboarding.modelSetup.openaiAccountTitle'),
                t('onboarding.modelSetup.chooseModelsSubtitle'),
                toOnboardingProfiles(openAIPack),
                openAIPack.defaultProfileId,
                getOpenAIOAuthFastProfileId(openAIPack),
                getOpenAIOAuthInitialSelectedProfileIds(openAIPack),
                t('onboarding.modelSetup.failedProvider', { provider: 'OpenAI' }),
              );
            } catch (error) {
              const errorKind = classifyOpenAIOAuthModelListError(error);
              const displayMessage = getOpenAIOAuthModelListErrorMessage(error)
                ?? t('onboarding.modelSetup.failedProvider', { provider: 'OpenAI' });
              console.error('[ModelSetup] Failed to load supported OpenAI OAuth models:', error);
              trackOAuthModelListFailed({
                provider,
                surface: 'onboarding',
                flowId,
                stage: 'after_signin',
                errorKind,
                error,
              });
              trackOnboardingError({
                step: 'model_setup',
                stage: 'load_openai_oauth_models_after_connect',
                error,
                displayMessage,
                context: { provider },
              });
              setSetupLoading(null);
              setSetupError(displayMessage);
            }
          }
        } catch {
          // Keep polling.
        }
      }, 2000);

      oauthTimeoutTimers.current[provider] = setTimeout(() => {
        clearOAuthTimers(provider);
        oauthAutoAddPackIntent.current[provider] = false;
        setOauthLoading((current) => (current === provider ? null : current));
        trackOAuthSignInFailed({
          provider,
          surface: 'onboarding',
          flowId,
          error: 'OAuth connection timed out after 5 minutes.',
          stage: 'timeout',
        });
        trackOnboardingError({
          step: 'model_setup',
          stage: 'oauth_timeout',
          error: 'OAuth connection timed out after 5 minutes.',
          displayMessage: t('onboarding.modelSetup.connectionTimedOut'),
          context: { provider },
        });
        setSetupError(t('onboarding.modelSetup.connectionTimedOut'));
      }, 5 * 60 * 1000);
    } catch (error) {
      trackOAuthSignInFailed({
        provider,
        surface: 'onboarding',
        error,
        stage: 'initiate',
      });
      clearOAuthTimers(provider);
      oauthAutoAddPackIntent.current[provider] = false;
      setOauthLoading((current) => (current === provider ? null : current));
      console.error(`[ModelSetup] Failed to connect ${provider}:`, error);
      trackOnboardingError({
        step: 'model_setup',
        stage: 'initiate_oauth',
        error,
        displayMessage: t('onboarding.modelSetup.failedConnection'),
        context: { provider },
      });
      setSetupError(t('onboarding.modelSetup.failedConnection'));
    }
  }, [clearOAuthTimers, getOpenAIOAuthFastProfileId, loadOpenAIOAuthPack, openPackReview, t]);

  const handleCancelOAuth = useCallback(() => {
    const provider: OAuthProvider = 'openai';
    clearOAuthTimers(provider);
    oauthAutoAddPackIntent.current[provider] = false;
    setOauthLoading((current) => (current === provider ? null : current));
    setSetupError(null);
  }, [clearOAuthTimers]);

  const handleUseHostedPack = useCallback(() => {
    const pack = getOnboardingModelPack('hosted');
    openPackReview(
      'hosted',
      t('onboarding.modelSetup.interpreterTitle'),
      t('onboarding.modelSetup.chooseModelsSubtitle'),
      toOnboardingProfiles(pack),
      pack.defaultProfileId,
      getHostedOnboardingFastProfileId(pack),
      undefined,
      t('onboarding.modelSetup.failedProvider', { provider: 'Interpreter' }),
    );
  }, [openPackReview, t]);

  const handleUseOpenAIOAuthPack = useCallback(async () => {
    setSetupError(null);
    setSetupLoading('openai-oauth');

    try {
      const pack = await loadOpenAIOAuthPack();
      openPackReview(
        'openai-oauth',
        t('onboarding.modelSetup.openaiAccountTitle'),
        t('onboarding.modelSetup.chooseModelsSubtitle'),
        toOnboardingProfiles(pack),
        pack.defaultProfileId,
        getOpenAIOAuthFastProfileId(pack),
        getOpenAIOAuthInitialSelectedProfileIds(pack),
        t('onboarding.modelSetup.failedProvider', { provider: 'OpenAI' }),
      );
    } catch (error) {
      const errorKind = classifyOpenAIOAuthModelListError(error);
      const displayMessage = getOpenAIOAuthModelListErrorMessage(error)
        ?? t('onboarding.modelSetup.failedProvider', { provider: 'OpenAI' });
      console.error('[ModelSetup] Failed to load supported OpenAI OAuth models:', error);
      trackOAuthModelListFailed({
        provider: 'openai',
        surface: 'onboarding',
        stage: 'pack_load',
        errorKind,
        error,
      });
      trackOnboardingError({
        step: 'model_setup',
        stage: 'load_openai_oauth_pack',
        error,
        displayMessage,
        context: { provider: 'openai' },
      });
      setSetupError(displayMessage);
      setSetupLoading(null);
    }
  }, [getOpenAIOAuthFastProfileId, loadOpenAIOAuthPack, openPackReview, t]);

  const handleUseApiKeyPack = useCallback(async (keyType: ApiKeyProvider) => {
    const pack = API_KEY_MODEL_PACKS[keyType];
    setSetupError(null);
    setSetupLoading(`api:${keyType}`);

    try {
      const detectedEnvKeys = envApiKeys ?? await providersIpc.getEnvApiKeys();
      const oixProviderId = apiPresetToOixProviderId(keyType);
      const oixProvider = runtimeProviders?.find((provider) => provider.id === oixProviderId);
      const environmentKey = detectedEnvKeys[keyType].found
        ? (oixProvider?.envKey?.trim() || pack.envVar)
        : undefined;
      await openApiKeyPackReview(keyType, { environmentKey });
    } catch (error) {
      console.error(`[ModelSetup] Failed to read ${pack.envVar}:`, error);
      trackOnboardingError({
        step: 'model_setup',
        stage: 'read_env_api_key',
        error,
        displayMessage: t('onboarding.modelSetup.failedProvider', { provider: pack.label }),
        context: { provider: keyType, envVar: pack.envVar },
      });
      setSetupError(t('onboarding.modelSetup.failedProvider', { provider: pack.label }));
      setSetupLoading(null);
    }
  }, [envApiKeys, openApiKeyPackReview, runtimeProviders, t]);

  /*
   * GAP(app-server): Local runtime model enumeration (Ollama / LM Studio)
   *
   * listInterpreterProviders() lists the ollama / lmstudio providers (with
   * readiness), and that listing now drives whether the optional grid card shows
   * (see visibleOptionalPackIds). But the app-server does NOT enumerate the
   * INSTALLED local models or their tool-use support for these runtimes.
   *
   * Fallback: probe getOllamaStatus() / getLmStudioStatus() to discover installed
   * models and build the selectable pack via buildLocalPackReviewPlan(). This is a
   * local app-side runtime capability the app-server does not yet expose. The same
   * probe also still backs the per-card "Detected" badge/status copy below
   * (renderOptionalPackCard), since runtime readiness alone does not tell us which
   * models are tool-capable.
   *
   * Remove once the app-server lists installed local models (with tool-use
   * metadata) for a given runtime; then build the pack from that instead.
   *
   * See: src/components/onboarding/screens/localRuntimeOnboarding.ts (pack builders)
   */
  const handleUseOllamaPack = useCallback(async () => {
    setSetupLoading('local:ollama');
    let status: OllamaStatus = { running: false };

    try {
      status = await providersIpc.getOllamaStatus();
      setOllamaStatus(status);
    } catch {
      setOllamaStatus({ running: false });
    }

    const pack = buildLocalPackReviewPlan('ollama', status);
    const hasToolCapableModels = (status.models?.length || 0) > 0;
    const hasChatModels = (status.totalChatModels || 0) > 0;
    const subtitle = !status.running
      ? t('onboarding.modelSetup.ollamaUnreachableSubtitle')
      : hasChatModels && !hasToolCapableModels
        ? t('settings.profiles.provider.local.ollamaNoToolModels', { count: status.totalChatModels || 0 })
        : hasChatModels
          ? t('onboarding.modelSetup.chooseLocalModelsSubtitle')
          : t('settings.profiles.provider.local.ollamaNoModels');

    openPackReview(
      'local:ollama',
      t('onboarding.modelSetup.ollamaTitle'),
      subtitle,
      pack.profiles,
      pack.defaultProfileId,
      undefined,
      pack.requiresInstall && pack.defaultProfileId ? [pack.defaultProfileId] : undefined,
      t('onboarding.modelSetup.failedProvider', { provider: 'Ollama' }),
    );
    setSetupLoading(null);
  }, [openPackReview, t]);

  const handleUseLmStudioPack = useCallback(async () => {
    setSetupLoading('local:lmstudio');
    let status: LmStudioStatus = { running: false };

    try {
      status = await providersIpc.getLmStudioStatus();
      setLmStudioStatus(status);
    } catch {
      setLmStudioStatus({ running: false });
    }

    const pack = buildLocalPackReviewPlan('lmstudio', status);
    const hasToolCapableModels = (status.models?.length || 0) > 0;
    const hasChatModels = (status.totalChatModels || 0) > 0;
    const subtitle = !status.running
      ? t('onboarding.modelSetup.lmStudioUnreachableSubtitle')
      : hasChatModels && !hasToolCapableModels
        ? t('settings.profiles.provider.local.lmStudioNoToolModels', { count: status.totalChatModels || 0 })
        : hasChatModels
          ? t('onboarding.modelSetup.chooseLocalModelsSubtitle')
          : t('settings.profiles.provider.local.lmStudioNoModels');
    openPackReview(
      'local:lmstudio',
      t('onboarding.modelSetup.lmStudioTitle'),
      subtitle,
      pack.profiles,
      pack.defaultProfileId,
      undefined,
      pack.requiresInstall && pack.defaultProfileId ? [pack.defaultProfileId] : undefined,
      t('onboarding.modelSetup.failedProvider', { provider: 'LM Studio' }),
    );
    setSetupLoading(null);
  }, [openPackReview, t]);

  const handleInterpreterAuthSuccess = useCallback(() => {
    const hostedPack = getOnboardingModelPack('hosted');
    openPackReview(
      'hosted',
      t('onboarding.modelSetup.interpreterManagedTitle'),
      t('onboarding.modelSetup.chooseModelsSubtitle'),
      hostedPackProfiles,
      hostedPack.defaultProfileId,
      getHostedOnboardingFastProfileId(hostedPack),
      undefined,
      t('onboarding.modelSetup.failedProvider', { provider: 'Interpreter Managed' }),
    );
  }, [hostedPackProfiles, openPackReview]);

  const handleAddCustomModel = useCallback(async () => {
    const normalizedModelId = customModelId.trim();
    const normalizedApiKey = customApiKey.trim();
    const normalizedName = customName.trim() || normalizedModelId || 'Custom Model';
    const normalizedBaseURL = customBaseURL.trim() || getDefaultBaseUrlForFormat(customApiFormat);

    setSetupError(null);

    if (!normalizedModelId) {
      const message = t('onboarding.modelSetup.modelIdRequired');
      trackOnboardingError({
        step: 'model_setup',
        stage: 'custom_model_validation',
        error: message,
        displayMessage: message,
        context: { field: 'modelId' },
      });
      setSetupError(message);
      return;
    }
    if (!normalizedApiKey) {
      const message = t('onboarding.modelSetup.apiKeyRequired');
      trackOnboardingError({
        step: 'model_setup',
        stage: 'custom_model_validation',
        error: message,
        displayMessage: message,
        context: { field: 'apiKey' },
      });
      setSetupError(message);
      return;
    }
    const isDeepSeekEndpoint = isDeepSeekApiBaseURL(normalizedBaseURL);
    if (!isDeepSeekEndpoint) {
      const probeResult = await providersIpc.probeResponsesApiSupport(normalizedBaseURL);
      if (probeResult.reachable && !probeResult.supported) {
        const message = getUnsupportedResponsesApiBaseUrlMessage(normalizedBaseURL);
        trackOnboardingError({
          step: 'model_setup',
          stage: 'custom_model_validation',
          error: message,
          displayMessage: message,
          context: { field: 'baseURL', baseURL: normalizedBaseURL },
        });
        setSetupError(message);
        return;
      }
    }

    const profileId = `onboarding:custom-${toSlug(normalizedModelId) || 'model'}-${Date.now()}`;
    const customProfile: Profile = {
      id: profileId,
      name: normalizedName,
      provider: 'api',
      providerId: undefined,
      modelId: normalizedModelId,
      apiKey: normalizedApiKey,
      apiFormat: customApiFormat,
      baseURL: normalizedBaseURL,
      codexProfileId: inferProfileIdFromEndpoint(normalizedBaseURL),
      wireApi: isDeepSeekEndpoint ? 'chat' : 'responses',
      useResponsesApi: !isDeepSeekEndpoint,
      isBuiltin: false,
    };

    openPackReview(
      'custom',
      t('onboarding.modelSetup.customModelTitle'),
      t('onboarding.modelSetup.chooseModelsSubtitle'),
      [customProfile],
      profileId,
      undefined,
      undefined,
      t('onboarding.modelSetup.failedCustom'),
    );
  }, [
    customApiFormat,
    customApiKey,
    customBaseURL,
    customModelId,
    customName,
    t,
    openPackReview,
  ]);

  const detectedPackIds = useMemo(() => {
    const ids: OptionalPackId[] = [];
    if (hasOpenAIKey) ids.push('api:openai');
    if (hasAnthropicKey) ids.push('api:anthropic');
    if (hasOpenRouterKey) ids.push('api:openrouter');
    if (hasGroqKey) ids.push('api:groq');
    if (hasDeepSeekKey) ids.push('api:deepseek');
    if (hasOllama) ids.push('local:ollama');
    if (hasLmStudio) ids.push('local:lmstudio');
    ids.push(...preferredPackIds);

    return ONBOARDING_OPTIONAL_MODEL_PACK_ORDER.filter((packId) => ids.includes(packId));
  }, [
    hasAnthropicKey,
    hasGroqKey,
    hasDeepSeekKey,
    hasLmStudio,
    hasOllama,
    hasOpenAIKey,
    hasOpenRouterKey,
    preferredPackIds,
  ]);

  // Optional-grid visible set, built from the app-server provider list. We map
  // each runtime provider to its app OptionalPackId, drop ids that are not part
  // of the optional grid (OpenAI OAuth, custom endpoint, bundled cloud catalog,
  // hosted/agent fallbacks), keep only the compact first-run provider set, and
  // sort by its stable presentation order. The complete OIX catalog remains
  // available in Settings without an app-side allowlist. Until providers resolve,
  // this is empty and the grid shows a loading/error state instead of cards.
  const visibleOptionalPackIds = useMemo<OptionalPackId[]>(() => {
    if (!runtimeProviders) return [];
    const entries = buildProviderMenuEntries(runtimeProviders);
    const ids = new Set<OptionalPackId>();
    for (const entry of entries) {
      const packId = optionalPackIdFromMenuEntry(entry);
      if (packId && ONBOARDING_OPTIONAL_MODEL_PACK_ORDER.includes(packId)) {
        ids.add(packId);
      }
    }
    return ONBOARDING_OPTIONAL_MODEL_PACK_ORDER.filter((packId) => ids.has(packId));
  }, [runtimeProviders]);

  const actionsLocked = setupLoading !== null || oauthLoading !== null;

  const renderOptionalPackCard = useCallback((packId: OptionalPackId) => {
    const isDetected = detectedPackIds.includes(packId);
    const isPreferred = preferredPackIds.includes(packId);
    const localStatus = isDetected
      ? (isPreferred ? 'Mentioned in your AI setup.' : 'Found on this computer.')
      : 'Add a local runtime on this computer.';
    const localBadge = isDetected
      ? (isPreferred ? 'From setup' : 'Detected')
      : 'Local';

    switch (packId) {
      case 'local:ollama': {
        return (
          <CompactProviderGridItem
            key={packId}
            icon={<BrandFavicon domain="ollama.com" className="size-5 rounded-sm" />}
            title={t('onboarding.modelSetup.ollamaTitle')}
            status={localStatus}
            badge={localBadge}
            loading={setupLoading === 'local:ollama'}
            disabled={actionsLocked}
            addLabel={t('onboarding.toolAddons.add')}
            onAdd={handleUseOllamaPack}
          />
        );
      }

      case 'local:lmstudio': {
        return (
          <CompactProviderGridItem
            key={packId}
            icon={<BrandFavicon domain="lmstudio.ai" className="size-5 rounded-sm" />}
            title={t('onboarding.modelSetup.lmStudioTitle')}
            status={localStatus}
            badge={localBadge}
            loading={setupLoading === 'local:lmstudio'}
            disabled={actionsLocked}
            addLabel={t('onboarding.toolAddons.add')}
            onAdd={handleUseLmStudioPack}
          />
        );
      }

      default: {
        const keyType = apiKeyProviderFromPackId(packId);
        if (!keyType) {
          return null;
        }
        const pack = API_KEY_MODEL_PACKS[keyType];
        const hasKey = envApiKeys
          ? envApiKeys[keyType].found
          : detectedProviders.includes(`${keyType}-key`);
        const isApiPreferred = preferredPackIds.includes(packId);
        const isAdding = setupLoading === packId;
        return (
          <CompactProviderGridItem
            key={packId}
            icon={
              keyType === 'openai' ? <OpenAIIcon className="size-5 text-foreground" /> :
              keyType === 'anthropic' ? <AnthropicIcon className="size-5 text-foreground" /> :
              keyType === 'openrouter' ? <OpenRouterIcon className="size-5 text-foreground" /> :
              keyType === 'groq' ? <GroqIcon className="size-5 text-foreground" /> :
              keyType === 'deepseek' ? <DeepSeekIcon className="size-5 text-foreground" /> :
              <Key className="size-5 text-foreground" />
            }
            title={pack.label}
            status={hasKey
              ? 'API key detected.'
              : isApiPreferred
                ? 'Mentioned in your AI setup.'
                : 'Needs an API key.'}
            badge={hasKey ? 'Detected' : isApiPreferred ? 'From setup' : 'Needs key'}
            loading={isAdding}
            disabled={actionsLocked}
            addLabel={t('onboarding.toolAddons.add')}
            onAdd={() => void handleUseApiKeyPack(keyType)}
          />
        );
      }
    }
  }, [
    actionsLocked,
    detectedPackIds,
    detectedProviders,
    envApiKeys,
    handleConnectOAuth,
    handleUseApiKeyPack,
    handleUseLmStudioPack,
    handleUseOllamaPack,
    oauthLoading,
    preferredPackIds,
    setupLoading,
  ]);

  return (
    <OnboardingScreenShell size="wide" align="center" className="py-0 sm:py-0 lg:py-0" contentClassName="max-w-[800px]">
      <div className="flex w-full flex-col items-center space-y-3.5">
        <OnboardingHeading
          title="Models"
          description={hostedDistributionEnabled
            ? 'Pick Interpreter or connect a provider you already use.'
            : 'Connect a provider you already use.'}
          className="space-y-1"
          titleClassName="text-[18px] sm:text-[19px]"
          descriptionClassName="max-w-[24rem] text-[11px] leading-4.5"
        />

        {/*
          Recommended provider cards.

          - Interpreter card: documented app-server gap (GAP-HOSTED, see the
            hostedPackProfiles comment above). The hosted provider/models are not
            enumerated by the app-server, so this card stays on the hardcoded
            hosted pack.
          - ChatGPT card: maps to the app-server's OpenAI ChatGPT sign-in lane
            (oix provider id 'openai'). Its sign-in and model list already route
            through the app-server (providersIpc.initiateOAuth('openai') +
            providersIpc.listOpenAIOAuthModels()), so it stays a recommended card
            and is not part of the app-server-driven optional grid below.
        */}
        <div className={`grid w-full max-w-[720px] gap-3 py-4 md:items-stretch ${hostedDistributionEnabled ? 'md:grid-cols-2' : 'md:grid-cols-1'}`}>
          {hostedDistributionEnabled && <ModelPackCard
            icon={<InterpreterLogoMark fitSquare size={32} segmentClassName="bg-current" className="text-foreground" />}
            title={t('onboarding.modelSetup.interpreterTitle')}
            description="Use any model, fastest setup."
            cardClassName="w-full"
            vertical
            featured
            footer={isAuthenticated ? t('onboarding.modelSetup.signedInAs', { email: user?.email || t('onboarding.modelSetup.yourAccount') }) : undefined}
            actionContent={!isAuthenticated ? <AuthSignIn onAuthSuccess={handleInterpreterAuthSuccess} variant="onboardingCompact" /> : undefined}
            actionLabel={t('onboarding.modelSetup.chooseProvider')}
            actionLoading={setupLoading === 'hosted'}
            actionDisabled={actionsLocked}
            onAction={handleUseHostedPack}
          />}

          <ModelPackCard
            icon={<OpenAIIcon className="size-9 text-foreground" />}
            title={t('onboarding.modelSetup.chatgptTitle')}
            description="Reuse your subscription."
            cardClassName="w-full"
            vertical
            footer={
              openAIOAuthStatus.isConnected
                ? t('onboarding.modelSetup.connectedAs', { email: openAIOAuthStatus.email || t('onboarding.modelSetup.openaiUser') })
                : undefined
            }
            actionContent={!openAIOAuthStatus.isConnected ? (
              <div className="w-full space-y-2.5 text-center">
                <Button
                  type="button"
                  onClick={() => void handleConnectOAuth(true)}
                  variant="outline"
                  className="w-full rounded-full shadow-none"
                  style={{ borderWidth: 'var(--border-width)' }}
                  disabled={actionsLocked}
                >
                  {oauthLoading === 'openai' && <Loader2 className="size-3.5 animate-spin" />}
                  {oauthLoading === 'openai' ? t('onboarding.modelSetup.connecting') : t('onboarding.modelSetup.signInWithChatGPT')}
                </Button>
                <p className="py-1 text-[9px] leading-tight text-muted-foreground/60">
                  By continuing, you agree to their{' '}
                  <button
                    type="button"
                    className="rounded-sm underline decoration-muted-foreground/40 underline-offset-2 transition-[color,decoration-color] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:text-foreground hover:decoration-foreground/70"
                    onClick={() => void openExternal('https://openai.com/policies/privacy-policy/')}
                  >
                    privacy policy
                  </button>.
                </p>
                {oauthLoading === 'openai' ? (
                  <button
                    type="button"
                    onClick={handleCancelOAuth}
                    className="w-full text-center text-ui-xs text-muted-foreground/70 transition-colors"
                  >
                    {t('onboarding.common.cancel')}
                  </button>
                ) : null}
              </div>
            ) : undefined}
            actionLabel={t('onboarding.modelSetup.chooseProvider')}
            actionLoading={setupLoading === 'openai-oauth'}
            actionDisabled={actionsLocked}
            onAction={() => void handleUseOpenAIOAuthPack()}
          />
        </div>

        <div className="w-full max-w-[720px] space-y-2.5">
          {providersError ? (
            // No blank menu: the app-server provider list failed; surface it and
            // offer retry. The custom-model escape hatch below stays available so
            // the user is never fully blocked.
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <p className="text-ui-sm text-destructive">
                {t('onboarding.modelSetup.failedProviders')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => refreshProviders()}
              >
                {t('common.tryAgain')}
              </Button>
            </div>
          ) : providersLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-[var(--oa-text-muted)]" />
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {!providersLoading && !providersError
              ? visibleOptionalPackIds.map((packId) => renderOptionalPackCard(packId))
              : null}
            <CompactProviderGridItem
              icon={<Plus className="size-5 text-foreground" />}
              title={t('onboarding.modelSetup.customModelTitle')}
              status="Use a supported Chat Completions or Responses API endpoint."
              badge="Manual"
              loading={false}
              disabled={actionsLocked}
              addLabel={t('onboarding.toolAddons.add')}
              onAdd={() => setShowCustomModel(true)}
              cardClassName={showCustomModel ? 'ring-1 ring-border/70' : undefined}
            />
          </div>
        </div>

        <OnboardingModal
          open={showCustomModel}
          onClose={() => setShowCustomModel(false)}
          panelClassName="max-w-[720px] space-y-4 rounded-[24px] p-6 text-left"
          panelStyle={ONBOARDING_MODAL_STYLE}
        >
          <div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h2 className="text-[18px] font-medium text-[var(--oa-text-strong)]">
                    {t('onboarding.modelSetup.customModelTitle')}
                  </h2>
                  <p className="text-[12px] leading-5 text-[var(--oa-text-muted)]">
                    {t('onboarding.modelSetup.customModelDescription')}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setShowCustomModel(false)}
                  className="rounded-full p-1 text-[var(--oa-text-muted)] transition-colors hover:bg-[color-mix(in_oklch,var(--oa-bg-subtle)_72%,transparent)] hover:text-[var(--oa-text-strong)]"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-ui-xs text-muted-foreground">{t('onboarding.modelSetup.nameLabel')}</label>
                  <Input
                    value={customName}
                    onChange={(event) => setCustomName(event.target.value)}
                    placeholder={t('onboarding.modelSetup.namePlaceholder')}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-ui-xs text-muted-foreground">{t('onboarding.modelSetup.apiFormatLabel')}</label>
                  <NativeSelect
                    value={customApiFormat}
                    onValueChange={(value) => {
                      const format = value as ApiFormat;
                      setCustomApiFormat(format);
                      setCustomBaseURL(getDefaultBaseUrlForFormat(format));
                    }}
                    items={[
                      { value: 'openai', label: t('onboarding.modelSetup.openaiCompatible') },
                    ]}
                    className="w-full"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-ui-xs text-muted-foreground">{t('onboarding.modelSetup.modelIdLabel')}</label>
                  <Input
                    value={customModelId}
                    onChange={(event) => setCustomModelId(event.target.value)}
                    placeholder="gpt-5"
                  />
                </div>

                <div className="md:col-span-2">
                  <ResponsesApiBaseUrlPicker
                    label={t('onboarding.modelSetup.baseUrlLabel')}
                    baseURL={customBaseURL}
                    placeholder={getDefaultBaseUrlForFormat(customApiFormat)}
                    onBaseURLChange={setCustomBaseURL}
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-ui-xs text-muted-foreground">{t('onboarding.modelSetup.apiKeyLabel')}</label>
                  <Input
                    type="password"
                    value={customApiKey}
                    onChange={(event) => setCustomApiKey(event.target.value)}
                    placeholder="sk-..."
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCustomModel(false)}
                  disabled={actionsLocked}
                  className="rounded-full"
                >
                  {t('onboarding.common.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleAddCustomModel()}
                  disabled={actionsLocked}
                  className="rounded-full border-black bg-black text-white hover:border-black hover:bg-black hover:text-white dark:border-white dark:bg-white dark:text-black dark:hover:border-white dark:hover:bg-white dark:hover:text-black"
                >
                  {t('onboarding.modelSetup.addCustomModel')}
                </Button>
              </div>
          </div>
        </OnboardingModal>

        {setupError && (
          <p className="text-center text-ui-sm text-destructive">
            {setupError}
          </p>
        )}
      </div>
    </OnboardingScreenShell>
  );
}
