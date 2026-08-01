import {
  canSelectLocalModelForTools,
  localRuntimeModelIdsMatch,
  resolveLocalRuntimeModelId,
  type LocalModelProviderRuntime,
  type LmStudioStatus,
  type OllamaStatus,
} from '../../shared/types/provider';
import {
  LOCAL_MODEL_DEFAULTS,
  LM_STUDIO_RECOMMENDED_MODEL_IDS,
  OLLAMA_RECOMMENDED_MODEL_IDS,
} from '../../shared/types/modelDefaults';

export type LocalRuntime = LocalModelProviderRuntime;
export {
  localRuntimeModelIdsMatch,
  resolveLocalRuntimeModelId,
};

export interface LocalModelOption {
  id: string;
  name: string;
}

export const DEFAULT_LOCAL_MODEL = LOCAL_MODEL_DEFAULTS.ollama;
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
export const LM_STUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1';
export const LM_STUDIO_DEFAULT_MODEL_KEY = LOCAL_MODEL_DEFAULTS.lmstudio;

const LOCAL_MODEL_NAMES: Record<string, string> = {
  'qwen3.5:4b': 'Qwen3.5 4B (recommended default)',
  'qwen3.5:0.8b': 'Qwen3.5 0.8B',
  'qwen3.5:9b': 'Qwen3.5 9B',
  'qwen/qwen3.5-4b': 'Qwen3.5 4B (recommended default)',
  'qwen/qwen3.5-0.8b': 'Qwen3.5 0.8B',
  'qwen/qwen3.5-9b': 'Qwen3.5 9B',
};

function buildRecommendedLocalModels(modelIds: readonly string[]): LocalModelOption[] {
  return modelIds.map((id) => ({
    id,
    name: LOCAL_MODEL_NAMES[id] ?? id,
  }));
}

const OLLAMA_RECOMMENDED_MODELS = buildRecommendedLocalModels(OLLAMA_RECOMMENDED_MODEL_IDS);
const LM_STUDIO_RECOMMENDED_MODELS = buildRecommendedLocalModels(LM_STUDIO_RECOMMENDED_MODEL_IDS);

export function inferLocalRuntime(baseURL?: string): LocalRuntime {
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
    // Fall through to simple string checks.
  }

  if (normalized.includes(':1234') || normalized.toLowerCase().includes('lmstudio')) {
    return 'lmstudio';
  }

  return 'ollama';
}

export function getLocalDefaultBaseURL(runtime: LocalRuntime): string {
  return runtime === 'lmstudio' ? LM_STUDIO_DEFAULT_BASE_URL : OLLAMA_DEFAULT_BASE_URL;
}

export function buildLocalModelOptions(
  runtime: LocalRuntime,
  ollamaStatus: OllamaStatus | null,
  lmStudioStatus: LmStudioStatus | null,
): LocalModelOption[] {
  if (runtime === 'lmstudio' && lmStudioStatus?.lmStudioModels) {
    const toolCapable = lmStudioStatus.lmStudioModels.filter((model) => canSelectLocalModelForTools(model.toolUseSupport));
    return toolCapable.map((model) => ({
      id: model.id,
      name: model.paramsString ? `${model.displayName} (${model.paramsString})` : model.displayName,
    }));
  }

  if (runtime === 'ollama' && ollamaStatus?.ollamaModels) {
    const toolCapable = ollamaStatus.ollamaModels.filter((model) => canSelectLocalModelForTools(model.toolUseSupport));
    if (toolCapable.length > 0) {
      return toolCapable.map((model) => {
        const baseName = model.paramsString ? model.id.split(':')[0] : model.displayName;
        return {
          id: model.id,
          name: model.paramsString ? `${baseName} (${model.paramsString})` : model.displayName,
        };
      });
    }
  }

  const deduped = new Map<string, LocalModelOption>();
  const recommendedModels = runtime === 'lmstudio'
    ? LM_STUDIO_RECOMMENDED_MODELS
    : OLLAMA_RECOMMENDED_MODELS;
  const installedModelIds = runtime === 'lmstudio'
    ? (lmStudioStatus?.models || [])
    : (ollamaStatus?.models || []);

  for (const model of recommendedModels) {
    deduped.set(model.id, model);
  }

  for (const modelId of installedModelIds) {
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId || deduped.has(normalizedModelId)) continue;
    deduped.set(normalizedModelId, { id: normalizedModelId, name: `${normalizedModelId} (installed)` });
  }

  return Array.from(deduped.values());
}
