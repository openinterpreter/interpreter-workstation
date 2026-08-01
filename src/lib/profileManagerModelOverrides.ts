import type { ApiFormat, ModelConfig } from '../../shared/types/model';
import { PROVIDER_MODEL_DEFAULTS } from '../../shared/types/modelDefaults';
import { getApiPresetBaseURL, getDefaultResponsesApiBaseURL } from '../../shared/types/provider';
import {
  DEFAULT_LOCAL_MODEL,
  getLocalDefaultBaseURL,
  inferLocalRuntime,
  LM_STUDIO_DEFAULT_MODEL_KEY,
  type LocalRuntime,
} from '../utils/localModelOptions';

export type ModelOverrideKind = 'vision' | 'fast';

export function getDefaultLocalModelId(runtime: LocalRuntime): string {
  return runtime === 'lmstudio' ? LM_STUDIO_DEFAULT_MODEL_KEY : DEFAULT_LOCAL_MODEL;
}

export function getDefaultHostedOverrideModelId(kind: ModelOverrideKind): string {
  return kind === 'fast'
    ? PROVIDER_MODEL_DEFAULTS.hosted.fast
    : PROVIDER_MODEL_DEFAULTS.hosted.vision;
}

function getDefaultApiOverrideBaseURL(apiFormat: ApiFormat): string {
  return apiFormat === 'anthropic'
    ? getApiPresetBaseURL('anthropic')
    : getDefaultResponsesApiBaseURL();
}

export function normalizeModelOverrideConfig(
  config: ModelConfig | undefined,
  kind: ModelOverrideKind = 'vision',
): ModelConfig | undefined {
  if (!config) {
    return undefined;
  }

  if (config.provider === 'hosted') {
    return {
      ...config,
      modelId: config.modelId || getDefaultHostedOverrideModelId(kind),
    };
  }

  if (config.provider === 'local') {
    const runtime = inferLocalRuntime(config.baseURL);
    return {
      ...config,
      modelId: config.modelId || getDefaultLocalModelId(runtime),
      baseURL: config.baseURL?.trim() || getLocalDefaultBaseURL(runtime),
    };
  }

  if (config.provider === 'api') {
    const apiFormat = config.apiFormat ?? 'openai';
    return {
      ...config,
      apiFormat,
      baseURL: config.baseURL?.trim() || getDefaultApiOverrideBaseURL(apiFormat),
    };
  }

  return config;
}
