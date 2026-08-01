import {
  BUILTIN_PROVIDER_IDS,
  canSelectLocalModelForTools,
  localRuntimeModelIdsMatch,
  type LmStudioModelInfo,
  type LmStudioStatus,
  type LocalModelToolUseSupport,
  type OllamaModelInfo,
  type OllamaStatus,
} from '../../../../shared/types/provider';
import { LM_STUDIO_RECOMMENDED_MODEL_IDS, OLLAMA_RECOMMENDED_MODEL_IDS } from '../../../../shared/types/modelDefaults';
import type { Profile } from '../../../../shared/types/profile';

export type LocalOnboardingRuntime = 'ollama' | 'lmstudio';

interface LocalPackBuildOptions {
  includeRecommendedFallback?: boolean;
}

export interface LocalPackReviewPlan {
  profiles: Profile[];
  defaultProfileId: string;
  requiresInstall: boolean;
}

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const LM_STUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1';

const OLLAMA_MODEL_NAMES: Record<string, string> = {
  'qwen3.5:4b': 'Qwen3.5 4B (Local)',
  'qwen3.5:0.8b': 'Qwen3.5 0.8B (Local)',
  'qwen3.5:9b': 'Qwen3.5 9B (Local)',
};

const LM_STUDIO_MODEL_NAMES: Record<string, string> = {
  'qwen/qwen3.5-4b': 'Qwen3.5 4B (LM Studio)',
  'qwen/qwen3.5-0.8b': 'Qwen3.5 0.8B (LM Studio)',
  'qwen/qwen3.5-9b': 'Qwen3.5 9B (LM Studio)',
};

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function normalizeLmStudioModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (!normalized) return '';
  return normalized;
}

function getSelectableRuntimeModels<T extends { id: string; toolUseSupport: LocalModelToolUseSupport }>(
  models: T[] | undefined,
): T[] {
  if (!models || models.length === 0) {
    return [];
  }

  const dedupedModels: T[] = [];
  const seenIds = new Set<string>();

  for (const model of models) {
    const normalizedId = model.id.trim();
    if (!normalizedId || seenIds.has(normalizedId)) {
      continue;
    }
    seenIds.add(normalizedId);
    if (normalizedId === model.id) {
      dedupedModels.push(model);
      continue;
    }
    dedupedModels.push({ ...model, id: normalizedId });
  }

  return dedupedModels.filter((model) => canSelectLocalModelForTools(model.toolUseSupport));
}

function isLikelyEmbeddingModelId(modelId: string): boolean {
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

export function buildOllamaPack(
  ollamaModels?: OllamaModelInfo[],
  options?: LocalPackBuildOptions,
): { defaultProfileId: string; profiles: Profile[] } {
  const includeRecommendedFallback = options?.includeRecommendedFallback ?? true;
  const selectableModels = getSelectableRuntimeModels(ollamaModels);
  if (selectableModels.length > 0) {
    const profiles = selectableModels.map((model) => {
      const modelSlug = toSlug(model.id);
      const baseName = model.paramsString ? model.id.split(':')[0] : model.displayName;
      const label = model.paramsString ? `${baseName} (${model.paramsString})` : model.displayName;
      return {
        id: `onboarding:ollama-${modelSlug}`,
        name: OLLAMA_MODEL_NAMES[model.id] || `${label} (Local)`,
        provider: 'local' as const,
        providerId: BUILTIN_PROVIDER_IDS.LOCAL,
        modelId: model.id,
        baseURL: OLLAMA_DEFAULT_BASE_URL,
        codexProfileId: 'ollama',
        isBuiltin: false,
      };
    });

    return { defaultProfileId: profiles[0]?.id || '', profiles };
  }

  if (!includeRecommendedFallback) {
    return { defaultProfileId: '', profiles: [] };
  }

  const profiles = OLLAMA_RECOMMENDED_MODEL_IDS.map((modelId) => {
    const modelSlug = toSlug(modelId);
    return {
      id: `onboarding:ollama-${modelSlug}`,
      name: OLLAMA_MODEL_NAMES[modelId] || `${modelId} (Local)`,
      provider: 'local' as const,
      providerId: BUILTIN_PROVIDER_IDS.LOCAL,
      modelId,
      baseURL: OLLAMA_DEFAULT_BASE_URL,
      codexProfileId: 'ollama',
      isBuiltin: false,
    };
  });

  return { defaultProfileId: profiles[0]?.id || '', profiles };
}

export function buildLmStudioPack(
  lmStudioModels?: LmStudioModelInfo[],
  fallbackModelIds?: string[],
  options?: LocalPackBuildOptions,
): { defaultProfileId: string; profiles: Profile[] } {
  const includeRecommendedFallback = options?.includeRecommendedFallback ?? true;
  const selectableModels = getSelectableRuntimeModels(lmStudioModels);
  if (selectableModels.length > 0) {
    const profiles = selectableModels.map((model) => {
      const modelSlug = toSlug(model.id);
      const label = model.paramsString ? `${model.displayName} (${model.paramsString})` : model.displayName;
      return {
        id: `onboarding:lmstudio-${modelSlug}`,
        name: `${label} (LM Studio)`,
        provider: 'local' as const,
        providerId: BUILTIN_PROVIDER_IDS.LOCAL,
        modelId: model.id,
        baseURL: LM_STUDIO_DEFAULT_BASE_URL,
        codexProfileId: 'lmstudio',
        isBuiltin: false,
      };
    });

    return { defaultProfileId: profiles[0]?.id || '', profiles };
  }

  if (!includeRecommendedFallback) {
    return { defaultProfileId: '', profiles: [] };
  }

  const modelIds = (fallbackModelIds || [])
    .map((modelId) => normalizeLmStudioModelId(modelId))
    .filter(Boolean)
    .filter((modelId) => !isLikelyEmbeddingModelId(modelId));

  const dedupedIds = Array.from(new Set(modelIds));
  const orderedIds = [
    ...LM_STUDIO_RECOMMENDED_MODEL_IDS,
    ...dedupedIds.filter((modelId) => !LM_STUDIO_RECOMMENDED_MODEL_IDS.includes(modelId as typeof LM_STUDIO_RECOMMENDED_MODEL_IDS[number])),
  ];

  const profiles = orderedIds.map((modelId) => {
    const modelSlug = toSlug(modelId);
    return {
      id: `onboarding:lmstudio-${modelSlug}`,
      name: LM_STUDIO_MODEL_NAMES[modelId] || `${modelId} (LM Studio)`,
      provider: 'local' as const,
      providerId: BUILTIN_PROVIDER_IDS.LOCAL,
      modelId,
      baseURL: LM_STUDIO_DEFAULT_BASE_URL,
      codexProfileId: 'lmstudio',
      isBuiltin: false,
    };
  });

  return { defaultProfileId: profiles[0]?.id || '', profiles };
}

export function buildLocalPackReviewPlan(
  runtime: LocalOnboardingRuntime,
  status: OllamaStatus | LmStudioStatus,
): LocalPackReviewPlan {
  const selectableModels = runtime === 'lmstudio'
    ? getSelectableRuntimeModels((status as LmStudioStatus).lmStudioModels)
    : getSelectableRuntimeModels((status as OllamaStatus).ollamaModels);
  const requiresInstall = !!status.running && selectableModels.length === 0;
  const includeRecommendedFallback = !status.running || requiresInstall;
  const pack = runtime === 'lmstudio'
    ? buildLmStudioPack(
      (status as LmStudioStatus).lmStudioModels,
      status.models,
      { includeRecommendedFallback },
    )
    : buildOllamaPack(
      (status as OllamaStatus).ollamaModels,
      { includeRecommendedFallback },
    );

  return {
    profiles: pack.profiles,
    defaultProfileId: pack.defaultProfileId,
    requiresInstall,
  };
}

export function isLocalProfileInstalled(
  runtime: LocalOnboardingRuntime,
  installedModelIds: string[] | undefined,
  profileModelId: string,
): boolean {
  const normalizedModelId = profileModelId.trim();
  if (!normalizedModelId) {
    return false;
  }

  const normalizedInstalledModelIds = (installedModelIds || [])
    .map((modelId) => modelId.trim())
    .filter(Boolean);

  if (normalizedInstalledModelIds.includes(normalizedModelId)) {
    return true;
  }

  return runtime === 'lmstudio'
    && normalizedInstalledModelIds.some((modelId) => localRuntimeModelIdsMatch(modelId, normalizedModelId));
}

export function resolvePersistedLocalProfiles(
  runtime: LocalOnboardingRuntime,
  selectedProfiles: Profile[],
  installedProfiles: Profile[],
): Profile[] {
  const resolvedProfiles: Profile[] = [];
  const seenProfileIds = new Set<string>();

  for (const selectedProfile of selectedProfiles) {
    const exactMatch = installedProfiles.find((profile) => profile.modelId === selectedProfile.modelId);
    const matchedProfile = exactMatch
      || (
        runtime === 'lmstudio'
          ? installedProfiles.find((profile) =>
            localRuntimeModelIdsMatch(profile.modelId, selectedProfile.modelId))
          : undefined
      );

    const profileToPersist = matchedProfile || selectedProfile;
    if (seenProfileIds.has(profileToPersist.id)) {
      continue;
    }

    seenProfileIds.add(profileToPersist.id);
    resolvedProfiles.push(profileToPersist);
  }

  return resolvedProfiles;
}
