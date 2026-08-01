import { type CSSProperties, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Search } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Switch } from '../../ui/switch';
import { getCustomPreset } from '../../../lib/codex/profiles';
import type { WireApi } from '../../../../shared/types/model';
import {
  createProfile,
  downloadLmStudioModel,
  getProfiles,
  pullOllamaModel,
  setDefaultProfile,
  setFastProfile,
  updateProfile,
} from '../../../api';
import { providers as providersIpc } from '../../../ipc';
import type { Profile } from '../../../../shared/types/profile';
import { BUILTIN_PROVIDER_IDS, isOllamaVersionBelowDeveloperRoleFloor, MIN_OLLAMA_DEVELOPER_ROLE_VERSION, type OpenRouterModelCatalogResult, type LmStudioStatus, type OllamaStatus } from '../../../../shared/types/provider';
import { type ApiKeyProvider, type ModelPackReviewState } from './ModelSetupScreen';
import { OnboardingModal } from '../components/OnboardingModal';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';
import { trackModelsConfigured } from '../../../utils/telemetry';
import { HostedProviderIcon } from '../../icons/HostedProviderIcon';
import { ExpensiveModelBadge } from '../../ModelSignalBadges';
import { trackOnboardingError } from '../../../utils/telemetry';
import { formatAddModelsLabel } from '../../../utils/onboardingModelReviewLabel';
import { normalizeDisplayText } from '../../../utils/normalizeDisplayText';
import {
  buildHostedModelPickerGroups,
  filterHostedModelPickerGroups,
  shouldSuppressHostedModelInDefaultBrowse,
  type HostedModelPickerItem,
} from '../../../utils/hostedOpenRouterPicker';
import { PROVIDER_MODEL_DEFAULTS } from '../../../../shared/types/modelDefaults';
import {
  isExpensiveModelId,
} from '../../../utils/modelCostSignals';
import {
  buildLocalPackReviewPlan,
  isLocalProfileInstalled,
  resolvePersistedLocalProfiles,
  type LocalOnboardingRuntime,
} from './localRuntimeOnboarding';

interface ModelPackReviewScreenProps {
  reviewState: ModelPackReviewState | null;
  onReviewComplete: (packId: ModelPackReviewState['packId']) => void;
}

interface HostedFeaturedCard {
  id: string;
  title: string;
  description: string;
  item: HostedModelPickerItem;
}

const HOSTED_FEATURED_MODELS = [
  { id: 'openai/gpt-5.4', title: 'GPT-5.4', description: 'Strong reasoning model.' },
  { id: 'openai/gpt-5.4-mini', title: 'GPT-5.4-mini', description: 'Inexpensive and balanced.' },
  { id: 'anthropic/claude-sonnet-4.6', title: 'Claude Sonnet 4.6', description: 'Strong daily-use reasoning.' },
  { id: 'anthropic/claude-opus-4.6', title: 'Claude Opus 4.6', description: 'Strong writing and analysis.' },
  { id: 'google/gemini-3.1-pro-preview', title: 'Gemini 3.1 Pro', description: 'Long-context multimodal work.' },
  { id: 'qwen/qwen3.5-397b-a17b', title: 'Qwen 3.5', description: 'Inexpensive open-weight reasoning.' },
  { id: 'minimax/minimax-m2.5', title: 'MiniMax M2.5', description: 'Inexpensive coding and reasoning.' },
] as const;

const HOSTED_CARD_DESCRIPTION_STYLE: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

const HOVER_ONLY_CARD_CLASS = '[background-color:var(--review-bg)] transition-[background-color] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:[background-color:var(--review-hover-bg)] motion-reduce:duration-0';
const REVIEW_CARD_BG = 'color-mix(in oklch, var(--oa-bg-app) 97%, var(--oa-bg-subtle) 3%)';
const REVIEW_CARD_SELECTED_BG = 'color-mix(in oklch, var(--oa-bg-subtle) 24%, var(--oa-bg-app) 76%)';
const REVIEW_FEATURED_CARD_BG = 'color-mix(in oklch, var(--oa-bg-app) 96%, var(--oa-bg-subtle) 4%)';
const REVIEW_FEATURED_CARD_SELECTED_BG = 'color-mix(in oklch, var(--oa-bg-subtle) 30%, var(--oa-bg-app) 70%)';
const REVIEW_MODAL_RESULT_BG = 'color-mix(in oklch, var(--oa-bg-app) 98%, transparent)';
const REVIEW_CARD_HOVER_BG = 'color-mix(in oklch, var(--oa-bg-subtle) 22%, var(--oa-bg-app) 78%)';
const REVIEW_CARD_SELECTED_HOVER_BG = 'color-mix(in oklch, var(--oa-bg-subtle) 34%, var(--oa-bg-app) 66%)';
const API_KEY_INPUT_PLACEHOLDERS: Record<ApiKeyProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  openrouter: 'sk-or-...',
  groq: 'gsk_...',
  deepseek: 'sk-...',
};

function formatInstallModelsLabel(selectedCount: number): string {
  if (selectedCount === 1) {
    return 'Install 1 model';
  }
  return `Install ${selectedCount} models`;
}

function withHoverBackground(
  style: CSSProperties,
  backgroundColor: string,
  hoverBackgroundColor: string,
): CSSProperties {
  const nextStyle = { ...style };
  delete nextStyle.backgroundColor;

  return {
    ...nextStyle,
    '--review-bg': backgroundColor,
    '--review-hover-bg': hoverBackgroundColor,
  };
}

function toHostedProfileId(modelId: string): string {
  return `onboarding:hosted-${modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')}`;
}

function getHostedRowDescription(profile: Profile): string {
  if (profile.modelId === PROVIDER_MODEL_DEFAULTS.hosted.main) {
    return 'Routes to the smartest model.';
  }
  if (profile.modelId === PROVIDER_MODEL_DEFAULTS.hosted.fast) {
    return 'Routes to the fastest model.';
  }
  return profile.helpDescription?.trim() || '';
}

function HostedModelIcon({
  modelId,
  provider,
  className,
}: {
  modelId: string;
  provider?: string;
  className?: string;
}) {
  return (
    <HostedProviderIcon
      modelId={modelId}
      provider={provider}
      className={`${className || ''} rounded-[4px] object-contain grayscale`}
    />
  );
}

export function ModelPackReviewScreen({
  reviewState,
  onReviewComplete,
}: ModelPackReviewScreenProps) {
  "use no memo";

  const { t } = useTranslation();
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const [reviewProfiles, setReviewProfiles] = useState<Profile[]>([]);
  const [reviewDefaultProfileId, setReviewDefaultProfileId] = useState('');
  const [reviewFastProfileId, setReviewFastProfileId] = useState<string | null>(null);
  const [selectedReviewProfileIds, setSelectedReviewProfileIds] = useState<Set<string>>(new Set());
  const [setupLoading, setSetupLoading] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [localStatusLoading, setLocalStatusLoading] = useState(false);
  const [localRuntimeStatus, setLocalRuntimeStatus] = useState<OllamaStatus | LmStudioStatus | null>(null);
  const [hostedCatalog, setHostedCatalog] = useState<OpenRouterModelCatalogResult | null>(null);
  const [hostedCatalogLoading, setHostedCatalogLoading] = useState(false);
  const [hostedCatalogError, setHostedCatalogError] = useState<string | null>(null);
  const [hostedQuery, setHostedQuery] = useState('');
  const [showHostedSearch, setShowHostedSearch] = useState(false);
  const [hostedVisibleCount, setHostedVisibleCount] = useState(18);
  const [reviewApiKeyValue, setReviewApiKeyValue] = useState('');
  const [reviewApiKeyError, setReviewApiKeyError] = useState<string | null>(null);
  const [localInstallStatus, setLocalInstallStatus] = useState<string | null>(null);
  const [localInstallError, setLocalInstallError] = useState<string | null>(null);
  const deferredHostedQuery = useDeferredValue(hostedQuery);

  useEffect(() => {
    if (!reviewState) {
      setReviewProfiles([]);
      setReviewDefaultProfileId('');
      setReviewFastProfileId(null);
      setSelectedReviewProfileIds(new Set());
      setReviewApiKeyValue('');
      setReviewApiKeyError(null);
      setLocalInstallStatus(null);
      setLocalInstallError(null);
      return;
    }
    setReviewProfiles(reviewState.profiles);
    setReviewDefaultProfileId(reviewState.defaultProfileId);
    setReviewFastProfileId(reviewState.fastProfileId ?? null);
    setSetupError(null);
    const firstProfileApiKey = reviewState.profiles.find((profile) => profile.provider === 'api')?.apiKey?.trim() || '';
    setReviewApiKeyValue(firstProfileApiKey);
    setReviewApiKeyError(null);
    setLocalInstallStatus(null);
    setLocalInstallError(null);
    const initialSelectedProfileIds = reviewState.initialSelectedProfileIds?.filter((profileId) =>
      reviewState.profiles.some((profile) => profile.id === profileId),
    ) ?? [];
    setSelectedReviewProfileIds(
      new Set(
        initialSelectedProfileIds.length > 0
          ? initialSelectedProfileIds
          : reviewState.profiles.map((profile) => profile.id),
      ),
    );
  }, [reviewState]);

  const [localChatOverride, setLocalChatOverride] = useState<boolean | null>(null);
  const isLocalOllamaPack = reviewState?.packId === 'local:ollama';
  const isLocalLmStudioPack = reviewState?.packId === 'local:lmstudio';
  const isLocalPack = isLocalOllamaPack || isLocalLmStudioPack;
  const ollamaServerVersion = isLocalOllamaPack && localRuntimeStatus && 'version' in localRuntimeStatus
    ? localRuntimeStatus.version
    : undefined;
  let localRuntime: LocalOnboardingRuntime | null = null;
  if (isLocalLmStudioPack) {
    localRuntime = 'lmstudio';
  } else if (isLocalOllamaPack) {
    localRuntime = 'ollama';
  }
  // Local wire API: defaults to the runtime preset (Ollama chat, LM Studio
  // chat); the toggle records an explicit override for this pack.
  const defaultLocalUsesChat = localRuntime
    ? (getCustomPreset(localRuntime)?.wireApi ?? 'chat') === 'chat'
    : true;
  const localUsesChatCompletions = localChatOverride ?? defaultLocalUsesChat;
  const localWireApi: WireApi = localUsesChatCompletions ? 'chat' : 'responses';
  const isHostedPack = reviewState?.packId === 'hosted';
  const requiresInlineApiKey = !!reviewState?.requiredApiKeyProvider;

  const refreshLocalRuntimeStatus = useCallback(async () => {
    if (!reviewState || !localRuntime) return;
    if (!isLocalPack) {
      setLocalRuntimeStatus(null);
      return;
    }

    setLocalStatusLoading(true);
    const status = isLocalLmStudioPack
      ? await providersIpc.getLmStudioStatus().catch(() => ({ running: false, models: [] as string[] }))
      : await providersIpc.getOllamaStatus().catch(() => ({ running: false, models: [] as string[] }));
    setLocalRuntimeStatus(status);
    if (status.running) {
      const nextPlan = buildLocalPackReviewPlan(localRuntime, status);
      setReviewProfiles(nextPlan.profiles);
      setReviewDefaultProfileId(nextPlan.defaultProfileId);
      setReviewFastProfileId(null);
      setSelectedReviewProfileIds(new Set(
        (nextPlan.requiresInstall && nextPlan.defaultProfileId
          ? nextPlan.profiles.filter((profile) => profile.id === nextPlan.defaultProfileId)
          : nextPlan.profiles
        ).map((profile) => profile.id),
      ));
    }
    setLocalStatusLoading(false);
  }, [isLocalLmStudioPack, isLocalPack, localRuntime, reviewState]);

  useEffect(() => {
    if (!reviewState || !isLocalPack) {
      setLocalRuntimeStatus(null);
      setLocalStatusLoading(false);
      return;
    }
    void refreshLocalRuntimeStatus();
  }, [isLocalPack, refreshLocalRuntimeStatus, reviewState]);

  const reportReviewError = useCallback((
    stage: string,
    error: unknown,
    displayMessage?: string,
    context?: Record<string, unknown>,
  ) => {
    trackOnboardingError({
      step: 'model_review',
      stage,
      error,
      displayMessage,
      context: {
        packId: reviewState?.packId,
        ...context,
      },
    });
  }, [reviewState?.packId]);

  const refreshHostedCatalog = useCallback(async (options?: { forceRefresh?: boolean }) => {
    if (!isHostedPack) {
      setHostedCatalog(null);
      setHostedCatalogError(null);
      return;
    }

    setHostedCatalogLoading(true);
    setHostedCatalogError(null);
    try {
      const catalog = await providersIpc.listOpenRouterModels(options);
      setHostedCatalog(catalog);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load models.';
      reportReviewError('load_hosted_catalog', error, message, {
        forceRefresh: options?.forceRefresh === true,
      });
      setHostedCatalogError(message);
    } finally {
      setHostedCatalogLoading(false);
    }
  }, [isHostedPack, reportReviewError]);

  useEffect(() => {
    if (!isHostedPack) {
      setHostedCatalog(null);
      setHostedCatalogLoading(false);
      setHostedCatalogError(null);
      setHostedQuery('');
      setShowHostedSearch(false);
      return;
    }
    void refreshHostedCatalog();
  }, [isHostedPack, refreshHostedCatalog]);

  const hostedPickerGroups = useMemo(() => {
    if (!isHostedPack || !reviewState) {
      return [];
    }

    const groups = buildHostedModelPickerGroups(
      reviewState.profiles.map((profile) => ({
        id: profile.modelId,
        name: profile.name,
      })),
      hostedCatalog?.models || [],
    );

    return filterHostedModelPickerGroups(groups, deferredHostedQuery).filter(
      (group) => group.id !== 'interpreter',
    );
  }, [deferredHostedQuery, hostedCatalog?.models, isHostedPack, reviewState]);

  const hostedPickerItems = useMemo(
    () => hostedPickerGroups.flatMap((group) => group.items),
    [hostedPickerGroups],
  );

  const hostedPickerItemById = useMemo(
    () => new Map(hostedPickerItems.map((item) => [item.id, item])),
    [hostedPickerItems],
  );

  const hostedFeaturedItems = useMemo<HostedFeaturedCard[]>(() => {
    return HOSTED_FEATURED_MODELS.map((model) => ({
      ...model,
      item: hostedPickerItemById.get(model.id) ?? {
        id: model.id,
        name: model.title,
        secondaryLabel: model.id,
        provider: model.title,
        description: '',
      },
    }));
  }, [hostedPickerItemById]);

  const hostedFeaturedItemIds = useMemo(
    () => new Set(hostedFeaturedItems.map((item) => item.id)),
    [hostedFeaturedItems],
  );

  const hostedSelectedExtraItems = useMemo(() => {
    return reviewProfiles
      .filter((profile) =>
        selectedReviewProfileIds.has(profile.id)
        && profile.modelId !== PROVIDER_MODEL_DEFAULTS.hosted.main
        && profile.modelId !== PROVIDER_MODEL_DEFAULTS.hosted.fast
        && !hostedFeaturedItemIds.has(profile.modelId),
      )
      .map((profile) => {
        const item = hostedPickerItemById.get(profile.modelId);
        return {
          id: profile.modelId,
          title: profile.name,
          description: (item?.description?.trim() || item?.provider || profile.helpDescription || 'Added model.').replace(/\.$/, '') + '.',
          item: item ?? {
            id: profile.modelId,
            name: profile.name,
            secondaryLabel: profile.modelId,
            provider: 'Hosted',
            description: profile.helpDescription || '',
          },
        };
      });
  }, [hostedFeaturedItemIds, hostedPickerItemById, reviewProfiles, selectedReviewProfileIds]);

  const hostedModalResults = useMemo(() => {
    const normalizedQuery = deferredHostedQuery.trim();
    const visibleItems = normalizedQuery
      ? hostedPickerItems
      : hostedPickerItems.filter((item) => !shouldSuppressHostedModelInDefaultBrowse(item));

    return visibleItems.slice(0, hostedVisibleCount);
  }, [deferredHostedQuery, hostedPickerItems, hostedVisibleCount]);

  useEffect(() => {
    setHostedVisibleCount(deferredHostedQuery.trim() ? 24 : 18);
  }, [deferredHostedQuery, showHostedSearch]);

  const handleHostedResultsScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const currentTarget = event.currentTarget;
    const remainingScroll = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight;
    if (remainingScroll > 72) return;

    setHostedVisibleCount((previous) => previous + 24);
  }, []);

  const selectedCount = useMemo(() => {
    return reviewProfiles.filter((profile) => selectedReviewProfileIds.has(profile.id)).length;
  }, [reviewProfiles, selectedReviewProfileIds]);

  const selectedProfiles = useMemo(() => (
    reviewProfiles.filter((profile) => selectedReviewProfileIds.has(profile.id))
  ), [reviewProfiles, selectedReviewProfileIds]);

  const selectedLocalProfilesNeedingInstall = useMemo(() => {
    if (!isLocalPack || !localRuntime || !localRuntimeStatus?.running) {
      return [];
    }

    return selectedProfiles.filter((profile) =>
      !isLocalProfileInstalled(localRuntime, localRuntimeStatus.models, profile.modelId));
  }, [isLocalPack, localRuntime, localRuntimeStatus?.models, localRuntimeStatus?.running, selectedProfiles]);

  const continueWillInstallSelectedModels = selectedLocalProfilesNeedingInstall.length > 0;
  const localPackReadyToContinue = !isLocalPack || (!!localRuntimeStatus?.running && !localStatusLoading);

  const buildHostedReviewProfile = useCallback((item: HostedModelPickerItem): Profile => ({
    id: toHostedProfileId(item.id),
    name: item.name,
    provider: 'hosted',
    providerId: BUILTIN_PROVIDER_IDS.HOSTED,
    modelId: item.id,
    helpDescription: item.description.trim() || `Routes to ${item.name}.`,
    isBuiltin: false,
  }), []);

  const toggleHostedReviewProfile = useCallback((item: HostedModelPickerItem) => {
    const existingProfile = reviewProfiles.find((profile) => profile.modelId === item.id);

    if (existingProfile) {
      setSelectedReviewProfileIds((prev) => {
        const next = new Set(prev);
        if (next.has(existingProfile.id)) {
          next.delete(existingProfile.id);
        } else {
          next.add(existingProfile.id);
        }
        return next;
      });
      return;
    }

    const nextProfile = buildHostedReviewProfile(item);
    setReviewProfiles((prev) => [...prev, nextProfile]);
    setSelectedReviewProfileIds((prev) => new Set(prev).add(nextProfile.id));
  }, [buildHostedReviewProfile, reviewProfiles]);

  const handleReviewApiKeyChange = useCallback((value: string) => {
    setReviewApiKeyValue(value);
    if (reviewApiKeyError) {
      setReviewApiKeyError(null);
    }
    const normalizedApiKey = value.trim();
    setReviewProfiles((prev) => prev.map((profile) => (
      profile.provider === 'api'
        ? { ...profile, apiKey: normalizedApiKey || undefined }
        : profile
    )));
  }, [reviewApiKeyError]);

  const actionsLocked = setupLoading !== null;

  const handleConfirmPackReview = useCallback(async () => {
    if (!reviewState) return;

    if (isLocalPack && (!localRuntimeStatus?.running || localStatusLoading)) {
      const message = t('onboarding.modelReview.unreachable', { runtime: isLocalLmStudioPack ? 'LM Studio' : 'Ollama' });
      reportReviewError('local_runtime_unreachable', message, message, {
        runtime: isLocalLmStudioPack ? 'lmstudio' : 'ollama',
      });
      setSetupError(message);
      return;
    }

    if (selectedProfiles.length === 0) {
      const message = t('onboarding.modelReview.selectAtLeastOne');
      reportReviewError('validation', message, message, { field: 'selectedProfiles' });
      setSetupError(message);
      return;
    }

    const normalizedApiKey = reviewApiKeyValue.trim();
    if (reviewState.requiredApiKeyProvider && !normalizedApiKey) {
      const message = t('onboarding.modelSetup.providerApiKeyRequired', 'API key is required.');
      reportReviewError('validation', message, message, {
        field: 'apiKey',
        provider: reviewState.requiredApiKeyProvider,
      });
      setReviewApiKeyError(message);
      return;
    }
    const selectedProfilesWithApiKey = reviewState.requiredApiKeyProvider
      ? selectedProfiles.map((profile) => (
        profile.provider === 'api'
          ? { ...profile, apiKey: normalizedApiKey }
          : profile
      ))
      : selectedProfiles;

    let selectedDefaultProfile = selectedProfilesWithApiKey.find((profile) => profile.id === reviewDefaultProfileId)
      || selectedProfilesWithApiKey[0];
    let selectedFastProfileId = reviewFastProfileId
      && selectedProfilesWithApiKey.some((profile) => profile.id === reviewFastProfileId)
      ? reviewFastProfileId
      : null;
    let profilesToPersist = selectedProfilesWithApiKey;

    setSetupError(null);
    setLocalInstallError(null);
    setSetupLoading(reviewState.packId);

    try {
      if (isLocalPack && localRuntime && localRuntimeStatus?.running && selectedLocalProfilesNeedingInstall.length > 0) {
        const runtimeLabel = localRuntime === 'lmstudio' ? 'LM Studio' : 'Ollama';

        for (const profile of selectedLocalProfilesNeedingInstall) {
          setLocalInstallStatus(`Installing ${profile.modelId} with ${runtimeLabel}...`);

          const result = localRuntime === 'lmstudio'
            ? await downloadLmStudioModel(
              profile.modelId.trim(),
              (progress) => {
                if (progress.error) {
                  const message = normalizeDisplayText(progress.error);
                  setLocalInstallError(message);
                  setSetupError(message);
                  return;
                }

                if (progress.total && progress.completed) {
                  const percent = Math.floor((progress.completed / progress.total) * 100);
                  setLocalInstallStatus(`Downloading ${percent}%`);
                  return;
                }

                if (typeof progress.progress === 'number' && typeof progress.maxProgress === 'number' && progress.maxProgress > 0) {
                  const percent = Math.floor((progress.progress / progress.maxProgress) * 100);
                  setLocalInstallStatus(`Downloading ${percent}%`);
                  return;
                }

                if (progress.text) {
                  setLocalInstallStatus(normalizeDisplayText(progress.text));
                  return;
                }

                if (progress.status) {
                  setLocalInstallStatus(normalizeDisplayText(progress.status));
                }
              },
              profile.baseURL,
            )
            : await pullOllamaModel(
              profile.modelId,
              (progress) => {
                if (progress.error) {
                  const message = normalizeDisplayText(progress.error);
                  setLocalInstallError(message);
                  setSetupError(message);
                  return;
                }

                if (progress.total && progress.completed) {
                  const percent = Math.floor((progress.completed / progress.total) * 100);
                  setLocalInstallStatus(`${progress.status || 'Downloading'} ${percent}%`);
                  return;
                }

                if (progress.status) {
                  setLocalInstallStatus(normalizeDisplayText(progress.status));
                }
              },
              profile.baseURL,
            );

          if (!result.success) {
            const message = normalizeDisplayText(result.error) || reviewState.errorMessage;
            reportReviewError('local_model_install_failed', result.error || message, message, {
              runtime: localRuntime,
              modelId: profile.modelId,
            });
            setLocalInstallError(message);
            setSetupError(message);
            return;
          }
        }

        setLocalInstallStatus('Refreshing installed local models...');
        const latestStatus = localRuntime === 'lmstudio'
          ? await providersIpc.getLmStudioStatus().catch(() => null)
          : await providersIpc.getOllamaStatus().catch(() => null);

        if (!latestStatus?.running) {
          const message = `Unable to refresh ${runtimeLabel} after installation.`;
          reportReviewError('refresh_local_runtime_after_install', message, message, {
            runtime: localRuntime,
          });
          setLocalInstallError(message);
          setSetupError(message);
          return;
        }

        const nextPlan = buildLocalPackReviewPlan(localRuntime, latestStatus);
        setLocalRuntimeStatus(latestStatus);
        setReviewProfiles(nextPlan.profiles);
        setReviewDefaultProfileId(nextPlan.defaultProfileId);
        setReviewFastProfileId(null);

        if (nextPlan.requiresInstall) {
          const message = 'Installation completed, but no tool-capable local model was detected yet.';
          reportReviewError('local_model_still_missing_after_install', message, message, {
            runtime: localRuntime,
          });
          setLocalInstallError(message);
          setSetupError(message);
          return;
        }

        profilesToPersist = resolvePersistedLocalProfiles(localRuntime, selectedProfilesWithApiKey, nextPlan.profiles);
        if (profilesToPersist.length === 0) {
          const message = 'Installed local models were not detected after installation.';
          reportReviewError('persisted_local_models_missing', message, message, {
            runtime: localRuntime,
          });
          setLocalInstallError(message);
          setSetupError(message);
          return;
        }

        selectedDefaultProfile = resolvePersistedLocalProfiles(localRuntime, [selectedDefaultProfile], nextPlan.profiles)[0]
          || profilesToPersist[0];
        selectedFastProfileId = null;
        setSelectedReviewProfileIds(new Set(profilesToPersist.map((profile) => profile.id)));
        setLocalInstallStatus('Local models installed and ready.');
      }

      const { profiles: existingProfiles } = await getProfiles();
      const existingProfileIds = new Set(existingProfiles.map((profile) => profile.id));

      for (const profilePayload of profilesToPersist) {
        // Local packs carry no wireApi of their own; apply the pack-level toggle.
        const effectivePayload: Profile = isLocalPack
          ? { ...profilePayload, wireApi: localWireApi, useResponsesApi: localWireApi === 'responses' }
          : profilePayload;
        const updates: Partial<Profile> = {
          name: effectivePayload.name,
          provider: effectivePayload.provider,
          providerId: effectivePayload.providerId,
          modelId: effectivePayload.modelId,
          apiKey: effectivePayload.apiKey,
          environmentKey: effectivePayload.environmentKey,
          apiFormat: effectivePayload.apiFormat,
          baseURL: effectivePayload.baseURL,
          codexProfileId: effectivePayload.codexProfileId,
          wireApi: effectivePayload.wireApi,
          helpDescription: effectivePayload.helpDescription,
          providerConfig: undefined,
          useResponsesApi: effectivePayload.useResponsesApi,
          fastModel: undefined,
          visionModel: undefined,
          isBuiltin: false,
        };

        if (existingProfileIds.has(effectivePayload.id)) {
          await updateProfile(effectivePayload.id, updates);
        } else {
          await createProfile({ ...effectivePayload, isBuiltin: false });
        }
      }

      await setDefaultProfile(selectedDefaultProfile.id);
      if (selectedFastProfileId) {
        await setFastProfile(selectedFastProfileId);
      }
      trackModelsConfigured({
        packId: reviewState.packId,
        profileCount: selectedProfilesWithApiKey.length,
        defaultProfileId: selectedDefaultProfile.id,
        hasApiKey: !!reviewState.requiredApiKeyProvider && normalizedApiKey.length > 0,
      });
      onReviewComplete(reviewState.packId);
    } catch (error) {
      console.error(`[ModelSetup] ${reviewState.errorMessage}`, error);
      reportReviewError('confirm_pack_review', error, reviewState.errorMessage);
      setSetupError(reviewState.errorMessage);
    } finally {
      setSetupLoading(null);
    }
  }, [
    isLocalPack,
    isLocalLmStudioPack,
    localRuntime,
    localStatusLoading,
    localRuntimeStatus?.running,
    localWireApi,
    onReviewComplete,
    reviewApiKeyValue,
    reviewDefaultProfileId,
    reviewFastProfileId,
    reviewState,
    selectedLocalProfilesNeedingInstall,
    selectedProfiles,
    reportReviewError,
    t,
  ]);

  // Set footer config for the "Add Models" button
  useEffect(() => {
    if (!reviewState) return;
    let continueLabel = continueWillInstallSelectedModels
      ? formatInstallModelsLabel(selectedCount)
      : formatAddModelsLabel(selectedCount);

    if (setupLoading === reviewState.packId) {
      continueLabel = continueWillInstallSelectedModels
        ? t('onboarding.modelReview.installingSelectedModels')
        : t('onboarding.modelReview.addingModels');
    }

    setFooterConfig({
      step: stepRef.current,
      continueLabel,
      continueAction: () => { void handleConfirmPackReview(); },
      continueDisabled: actionsLocked
        || !localPackReadyToContinue
        || selectedCount === 0
        || (requiresInlineApiKey && reviewApiKeyValue.trim().length === 0),
      continueLoading: setupLoading === reviewState.packId,
    });
  }, [reviewState, setupLoading, actionsLocked, continueWillInstallSelectedModels, localPackReadyToContinue, selectedCount, handleConfirmPackReview, requiresInlineApiKey, reviewApiKeyValue, setFooterConfig, t]);

  if (!reviewState) {
    return null;
  }
  const visibleReviewProfiles = isHostedPack
    ? reviewProfiles.filter((profile) =>
        profile.modelId === PROVIDER_MODEL_DEFAULTS.hosted.main
        || profile.modelId === PROVIDER_MODEL_DEFAULTS.hosted.fast
      )
    : reviewProfiles;
  const shouldConstrainList = !isHostedPack && visibleReviewProfiles.length > 6;

  return (
    <OnboardingScreenShell
      size="medium"
      align="center"
      className="py-0 sm:py-0 lg:py-0"
      contentClassName={isHostedPack ? 'max-w-[800px]' : 'max-w-[620px]'}
    >
      <div className="flex w-full flex-col items-center space-y-3.5 py-4">
        <OnboardingHeading
          title={reviewState.title}
          description={reviewState.subtitle}
          className="space-y-1.5 pb-2"
          descriptionClassName="max-w-[26rem] text-[12px] leading-5"
        />

        {isLocalPack && (
          <div
            className="w-full max-w-[520px] space-y-2 rounded-[16px] px-3.5 py-3"
            style={{
              border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 58%, transparent)',
              backgroundColor: 'color-mix(in oklch, var(--oa-bg-app) 96%, var(--oa-bg-subtle) 4%)',
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[12px] text-[var(--oa-text-strong)]">
                {t('onboarding.modelReview.serverStatus', { runtime: isLocalLmStudioPack ? 'LM Studio' : 'Ollama' })}
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void refreshLocalRuntimeStatus()}
                disabled={localStatusLoading || actionsLocked}
                className="rounded-full px-2.5 hover:border-[var(--oa-border)] hover:bg-[var(--oa-bg-input)]"
              >
                {localStatusLoading && <Loader2 className="size-3.5 animate-spin" />}
                {t('onboarding.modelReview.refresh')}
              </Button>
            </div>

            <div className="space-y-1">
              <p className={`text-[12px] ${localRuntimeStatus?.running ? 'text-[var(--oa-text-strong)]' : 'text-yellow-700 dark:text-yellow-400'}`}>
                {localRuntimeStatus?.running
                  ? `${t('onboarding.modelReview.reachable', { runtime: isLocalLmStudioPack ? 'LM Studio' : 'Ollama' })}${ollamaServerVersion ? ` (v${ollamaServerVersion})` : ''}`
                  : t('onboarding.modelReview.unreachable', { runtime: isLocalLmStudioPack ? 'LM Studio' : 'Ollama' })}
              </p>
              {localRuntimeStatus?.running && isOllamaVersionBelowDeveloperRoleFloor(ollamaServerVersion) && (
                <p className="text-[11px] text-yellow-700 dark:text-yellow-400">
                  {t('settings.profiles.provider.local.ollamaOutdated', {
                    version: ollamaServerVersion,
                    minVersion: MIN_OLLAMA_DEVELOPER_ROLE_VERSION,
                  })}
                </p>
              )}
              {!localRuntimeStatus?.running && isLocalLmStudioPack && (
                <p className="text-[11px] text-[var(--oa-text-muted)]">
                  {t('onboarding.modelReview.lmStudioHint', { command: 'lms server start' })}
                </p>
              )}
              {!localRuntimeStatus?.running && isLocalOllamaPack && (
                <p className="text-[11px] text-[var(--oa-text-muted)]">
                  {t('onboarding.modelReview.ollamaHint', { command: 'ollama serve' })}
                </p>
              )}
              {localRuntimeStatus?.running && typeof localRuntimeStatus.models?.length === 'number' && (
                <p className="text-[11px] text-[var(--oa-text-muted)]">
                  {t('onboarding.modelReview.detectedModels', { count: localRuntimeStatus.models.length })}
                </p>
              )}
              {localRuntimeStatus?.running
                && (localRuntimeStatus.totalChatModels || 0) > 0
                && (localRuntimeStatus.models?.length || 0) === 0 && (
                <p className="text-[11px] text-yellow-700 dark:text-yellow-400">
                  {isLocalLmStudioPack
                    ? t('settings.profiles.provider.local.lmStudioNoToolModels', { count: localRuntimeStatus.totalChatModels || 0 })
                    : t('settings.profiles.provider.local.ollamaNoToolModels', { count: localRuntimeStatus.totalChatModels || 0 })}
                </p>
              )}
              {localRuntimeStatus?.running
                && (localRuntimeStatus.totalChatModels || 0) === 0 && (
                <p className="text-[11px] text-yellow-700 dark:text-yellow-400">
                  {isLocalLmStudioPack
                    ? t('settings.profiles.provider.local.lmStudioNoModels')
                    : t('settings.profiles.provider.local.ollamaNoModels')}
                </p>
              )}
              {localRuntimeStatus?.running && continueWillInstallSelectedModels && (
                <p className="text-[11px] text-[var(--oa-text-muted)]">
                  {t('onboarding.modelReview.installToContinue')}
                </p>
              )}
              {localInstallStatus && (
                <p className="text-[11px] text-[var(--oa-text-muted)]">
                  {localInstallStatus}
                </p>
              )}
              {localInstallError && (
                <p className="text-[11px] text-yellow-700 dark:text-yellow-400">
                  {localInstallError}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="min-w-0">
                <p className="text-[12px] text-[var(--oa-text-strong)]">
                  {t('settings.profiles.provider.local.chatCompletionsLabel')}
                </p>
                <p className="text-[11px] text-[var(--oa-text-muted)]">
                  {t('settings.profiles.provider.local.chatCompletionsDescription')}
                </p>
              </div>
              <Switch
                checked={localUsesChatCompletions}
                onCheckedChange={(checked) => setLocalChatOverride(checked)}
                aria-label={t('settings.profiles.provider.local.chatCompletionsLabel')}
              />
            </div>
          </div>
        )}

        {reviewState.requiredApiKeyProvider && (
          <div
            className="w-full max-w-[520px] space-y-2 rounded-[16px] px-3.5 py-3"
            style={{
              border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 58%, transparent)',
              backgroundColor: 'color-mix(in oklch, var(--oa-bg-app) 96%, var(--oa-bg-subtle) 4%)',
            }}
          >
            <div className="space-y-1">
              <p className="text-[12px] text-[var(--oa-text-strong)]">
                {reviewState.title}
              </p>
              <p className="text-[11px] text-[var(--oa-text-muted)]">
                {t('onboarding.modelSetup.enterApiKeyPrompt', 'Paste your API key to continue.')}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-ui-xs text-muted-foreground">{t('onboarding.modelSetup.apiKeyLabel')}</label>
              <Input
                type="password"
                value={reviewApiKeyValue}
                onChange={(event) => handleReviewApiKeyChange(event.target.value)}
                placeholder={API_KEY_INPUT_PLACEHOLDERS[reviewState.requiredApiKeyProvider]}
                autoFocus
              />
              {reviewApiKeyError && (
                <p className="text-ui-xs text-destructive">{reviewApiKeyError}</p>
              )}
            </div>
          </div>
        )}

        <div className={`w-full ${isHostedPack ? 'max-w-[640px]' : 'max-w-[520px]'} space-y-2`}>
          <div
            className={shouldConstrainList ? 'max-h-[300px] overflow-y-auto pr-1' : undefined}
          >
            <div className="space-y-2">
              {visibleReviewProfiles.map((profile) => {
                const isSelected = selectedReviewProfileIds.has(profile.id);
                const isDefault = profile.id === reviewDefaultProfileId;
                const isFast = profile.id === reviewFastProfileId;
                const profileDescription = isHostedPack ? getHostedRowDescription(profile) : '';
                const isInstalledLocalProfile = !isLocalPack
                  || !localRuntime
                  || !localRuntimeStatus?.running
                  || isLocalProfileInstalled(localRuntime, localRuntimeStatus.models, profile.modelId);
                return (
                  <label
                    key={profile.id}
                    className={`group flex items-start gap-3 rounded-[16px] px-3.5 py-3 ${HOVER_ONLY_CARD_CLASS}`}
                    style={withHoverBackground({
                      border: isSelected
                        ? 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 18%, var(--oa-border) 82%)'
                        : 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 60%, transparent)',
                      backgroundColor: isSelected
                        ? REVIEW_CARD_SELECTED_BG
                        : REVIEW_CARD_BG,
                      boxShadow: isSelected ? '0 10px 22px -24px var(--shadow-color)' : 'none',
                    },
                    isSelected
                      ? REVIEW_CARD_SELECTED_BG
                      : REVIEW_CARD_BG,
                    isSelected
                      ? REVIEW_CARD_SELECTED_HOVER_BG
                      : REVIEW_CARD_HOVER_BG)}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelectedReviewProfileIds((prev) => {
                          const next = new Set(prev);
                          if (checked) {
                            next.add(profile.id);
                          } else {
                            next.delete(profile.id);
                          }
                          return next;
                        });
                      }}
                      className="sr-only"
                    />

                    <div
                      className="flex size-5 shrink-0 items-center justify-center rounded-full transition-[background-color,border-color] duration-150"
                      style={{
                        border: isSelected
                          ? 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 18%, var(--oa-border) 82%)'
                          : 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 14%, var(--oa-border) 86%)',
                        backgroundColor: isSelected
                          ? 'color-mix(in oklch, var(--oa-text-strong) 10%, transparent)'
                          : 'color-mix(in oklch, var(--oa-bg-input) 92%, var(--oa-bg-app) 8%)',
                      }}
                    >
                      {isSelected ? <Check className="size-3 text-[var(--oa-text-strong)]" /> : null}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-3">
                        <p className="truncate text-[14px] font-medium leading-5 text-[var(--oa-text-strong)]">
                          {profile.name}
                        </p>
                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
                          {isDefault && (
                            <span
                              className="rounded-full px-2 py-0.5 text-[10px] text-[var(--oa-text-muted)]"
                              style={{
                                border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 48%, transparent)',
                                backgroundColor: 'color-mix(in oklch, var(--oa-bg-subtle) 22%, transparent)',
                              }}
                            >
                              {t('onboarding.modelReview.default')}
                            </span>
                          )}
                          {isFast && (
                            <span
                              className="rounded-full px-2 py-0.5 text-[10px] text-[var(--oa-text-muted)]"
                              style={{
                                border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 48%, transparent)',
                                backgroundColor: 'color-mix(in oklch, var(--oa-bg-subtle) 22%, transparent)',
                              }}
                            >
                              {t('settings.profiles.detail.fastModelLabel')}
                            </span>
                          )}
                        </div>
                      </div>
                      {profileDescription && (
                        <p className="mt-1 text-[12px] leading-5 text-[var(--oa-text-muted)]">
                          {profileDescription}
                        </p>
                      )}
                      {isLocalPack && localRuntimeStatus?.running && !isInstalledLocalProfile && (
                        <p className="mt-1 text-[11px] leading-5 text-yellow-700 dark:text-yellow-400">
                          {t('settings.profiles.provider.local.notInstalled', { modelId: profile.modelId })}
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {isHostedPack && (
          <div className="w-full max-w-[640px] space-y-5">
            <div className="grid grid-cols-2 gap-2.5">
              {hostedFeaturedItems.map((entry) => {
                const profile = reviewProfiles.find((candidate) => candidate.modelId === entry.id);
                const isSelected = profile ? selectedReviewProfileIds.has(profile.id) : false;

                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => toggleHostedReviewProfile(entry.item)}
                    className={`grid grid-cols-[auto_1fr_auto] items-start gap-2.5 rounded-[16px] px-3 py-2.5 text-left ${HOVER_ONLY_CARD_CLASS}`}
                    aria-pressed={isSelected}
                    style={withHoverBackground({
                      border: isSelected
                        ? 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 24%, var(--oa-border) 76%)'
                        : 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 74%, transparent)',
                      backgroundColor: isSelected
                        ? REVIEW_FEATURED_CARD_SELECTED_BG
                        : REVIEW_FEATURED_CARD_BG,
                      boxShadow: isSelected ? '0 10px 22px -24px var(--shadow-color)' : '0 6px 16px -24px var(--shadow-color)',
                    },
                    isSelected
                      ? REVIEW_FEATURED_CARD_SELECTED_BG
                      : REVIEW_FEATURED_CARD_BG,
                    isSelected
                      ? REVIEW_CARD_SELECTED_HOVER_BG
                      : REVIEW_CARD_HOVER_BG)}
                  >
                    <div className="flex h-5 items-center justify-center pt-0.5 text-[var(--oa-text-strong)]">
                      <HostedModelIcon modelId={entry.id} provider={entry.item.provider} className="size-[18px]" />
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2.5">
                        <p className="truncate text-[13px] font-medium leading-5 text-[var(--oa-text-strong)]">
                          {entry.title}
                        </p>
                        {isExpensiveModelId(entry.id) ? <ExpensiveModelBadge /> : null}
                      </div>
                      <p className="text-[11px] leading-4 text-[var(--oa-text-muted)]">
                        {entry.description}
                      </p>
                    </div>
                    <div
                      className="mt-0.5 flex size-5 items-center justify-center rounded-full"
                      style={{
                        border: isSelected
                          ? 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 18%, var(--oa-border) 82%)'
                          : 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 14%, var(--oa-border) 86%)',
                        backgroundColor: isSelected
                          ? 'color-mix(in oklch, var(--oa-text-strong) 10%, transparent)'
                          : 'color-mix(in oklch, var(--oa-bg-input) 92%, var(--oa-bg-app) 8%)',
                      }}
                    >
                      {isSelected ? <Check className="size-3 text-[var(--oa-text-strong)]" /> : null}
                    </div>
                  </button>
                );
              })}

              {hostedSelectedExtraItems.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => toggleHostedReviewProfile(entry.item)}
                  className={`grid grid-cols-[auto_1fr_auto] items-start gap-2.5 rounded-[16px] px-3 py-2.5 text-left ${HOVER_ONLY_CARD_CLASS}`}
                  aria-pressed="true"
                  style={withHoverBackground({
                    border: 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 24%, var(--oa-border) 76%)',
                    backgroundColor: REVIEW_FEATURED_CARD_SELECTED_BG,
                    boxShadow: '0 10px 22px -24px var(--shadow-color)',
                  },
                  REVIEW_FEATURED_CARD_SELECTED_BG,
                  REVIEW_CARD_SELECTED_HOVER_BG)}
                >
                  <div className="flex h-5 items-center justify-center pt-0.5 text-[var(--oa-text-strong)]">
                    <HostedModelIcon modelId={entry.id} provider={entry.item.provider} className="size-[18px]" />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2.5">
                      <p className="truncate text-[13px] font-medium leading-5 text-[var(--oa-text-strong)]">
                        {entry.title}
                      </p>
                      {isExpensiveModelId(entry.id) ? <ExpensiveModelBadge /> : null}
                    </div>
                    <p
                      className="text-[11px] leading-4 text-[var(--oa-text-muted)]"
                      style={HOSTED_CARD_DESCRIPTION_STYLE}
                    >
                      {entry.description}
                    </p>
                  </div>
                  <div
                    className="mt-0.5 flex size-5 items-center justify-center rounded-full"
                    style={{
                      border: 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 18%, var(--oa-border) 82%)',
                      backgroundColor: 'color-mix(in oklch, var(--oa-text-strong) 10%, transparent)',
                    }}
                  >
                    <Check className="size-3 text-[var(--oa-text-strong)]" />
                  </div>
                </button>
              ))}

              <button
                type="button"
                onClick={() => setShowHostedSearch(true)}
                className={`grid grid-cols-[auto_1fr] items-start gap-2.5 rounded-[16px] px-3 py-2.5 text-left ${HOVER_ONLY_CARD_CLASS}`}
                style={withHoverBackground({
                  border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 56%, transparent)',
                  backgroundColor: REVIEW_FEATURED_CARD_BG,
                },
                REVIEW_FEATURED_CARD_BG,
                REVIEW_CARD_HOVER_BG)}
              >
                <div className="flex h-5 items-center justify-center pt-0.5 text-[var(--oa-text-muted)]">
                  <Search className="size-[18px]" />
                </div>
                <div className="min-w-0 space-y-0.5">
                  <p className="text-[13px] font-medium leading-5 text-[var(--oa-text-strong)]">
                    Search
                  </p>
                  <p className="text-[11px] leading-4 text-[var(--oa-text-muted)]">
                    Browse all models.
                  </p>
                </div>
              </button>
            </div>

            <p className="text-center text-[11px] text-[var(--oa-text-muted)]">
              Add more models in settings. Usage goes down slower with cheaper models.
            </p>
          </div>
        )}

        <OnboardingModal
          open={isHostedPack && showHostedSearch}
          onClose={() => setShowHostedSearch(false)}
          panelClassName="max-w-[680px] space-y-4 rounded-[24px] p-6"
          panelStyle={{
            border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 58%, transparent)',
            backgroundColor: 'color-mix(in oklch, var(--oa-bg-app) 96%, var(--oa-bg-subtle) 4%)',
            boxShadow: '0 24px 80px -40px var(--shadow-color)',
          }}
        >
          {isHostedPack && showHostedSearch && (
            <div>
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--oa-text-muted)]" />
                  <Input
                    value={hostedQuery}
                    onChange={(event) => setHostedQuery(event.target.value)}
                    placeholder="Search models"
                    className="h-10 pl-9"
                    autoFocus
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowHostedSearch(false)}
                  className="rounded-full px-4"
                >
                  Close
                </Button>
              </div>

              <div
                className="space-y-1.5 pr-1"
                style={{
                  maxHeight: '340px',
                  overflowY: 'auto',
                }}
                onScroll={handleHostedResultsScroll}
              >
                {hostedCatalogLoading && (
                  <div className="flex items-center justify-center py-8 text-[12px] text-[var(--oa-text-muted)]">
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Loading models
                  </div>
                )}

                {!hostedCatalogLoading && hostedModalResults.map((item) => {
                  const profile = reviewProfiles.find((candidate) => candidate.modelId === item.id);
                  const isSelected = profile ? selectedReviewProfileIds.has(profile.id) : false;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => toggleHostedReviewProfile(item)}
                      className={`grid w-full grid-cols-[auto_1fr_auto] items-start gap-3 rounded-[14px] px-3 py-2 text-left ${HOVER_ONLY_CARD_CLASS}`}
                      style={withHoverBackground({
                        border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 52%, transparent)',
                        backgroundColor: isSelected
                          ? REVIEW_CARD_SELECTED_BG
                          : REVIEW_MODAL_RESULT_BG,
                      },
                      isSelected
                        ? REVIEW_CARD_SELECTED_BG
                        : REVIEW_MODAL_RESULT_BG,
                      isSelected
                        ? REVIEW_CARD_SELECTED_HOVER_BG
                        : REVIEW_CARD_HOVER_BG)}
                    >
                      <div className="flex h-5 items-center justify-center pt-0.5 text-[var(--oa-text-strong)]">
                        <HostedModelIcon modelId={item.id} provider={item.provider} className="size-[18px]" />
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-start justify-between gap-3">
                          <p className="truncate text-[12px] font-medium text-[var(--oa-text-strong)]">
                            {item.name}
                          </p>
                          <span className="shrink-0 text-[10px] text-[var(--oa-text-muted)]">
                            {item.provider}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-[var(--oa-text-muted)]">
                          {item.description || item.secondaryLabel}
                        </p>
                      </div>

                      <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full transition-[background-color,border-color] duration-150"
                        style={{
                          border: isSelected
                            ? 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 18%, var(--oa-border) 82%)'
                            : 'var(--border-width) solid color-mix(in oklch, var(--oa-text-strong) 14%, var(--oa-border) 86%)',
                          backgroundColor: isSelected
                            ? 'color-mix(in oklch, var(--oa-text-strong) 10%, transparent)'
                            : 'color-mix(in oklch, var(--oa-bg-input) 92%, var(--oa-bg-app) 8%)',
                        }}
                      >
                        {isSelected ? <Check className="size-3 text-[var(--oa-text-strong)]" /> : null}
                      </div>
                    </button>
                  );
                })}

                {!hostedCatalogLoading && hostedModalResults.length === 0 && (
                  <p className="px-1 py-8 text-center text-[11px] text-[var(--oa-text-muted)]">
                    No matching models.
                  </p>
                )}
              </div>

              {hostedCatalogError && (
                <p className="text-center text-[11px] text-destructive">
                  {hostedCatalogError}
                </p>
              )}
            </div>
          )}
        </OnboardingModal>

        {setupError && (
          <p className="max-w-[520px] text-center text-[12px] text-destructive">
            {setupError}
          </p>
        )}
      </div>
    </OnboardingScreenShell>
  );
}
