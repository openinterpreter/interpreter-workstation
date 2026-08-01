import { getApiEndpointKind, type ApiEndpointKind, type OpenRouterModel } from '../../shared/types/provider';
import { getDefaultApiProviderModelId } from '../../shared/types/modelDefaults';
import {
  supportsOpenAiResponsesCustomTools,
} from '../../shared/utils/openAiResponsesTools';

export interface ApiProviderModelOption {
  id: string;
  name: string;
}

export { getApiEndpointKind, type ApiEndpointKind };

export type ApiModelFieldConfig =
  | {
      kind: 'select';
      provider: 'openrouter' | 'openai' | 'groq' | 'deepseek' | 'runtime';
      description: string;
      options: ApiProviderModelOption[];
      defaultModelId?: string;
    }
  | {
      kind: 'freeform';
      provider: 'custom';
      description: string;
    };

const OPENROUTER_MODEL_SELECT_DESCRIPTION = 'Select an OpenRouter model from the list.';
const OPENAI_MODEL_SELECT_DESCRIPTION = 'Select an OpenAI model that supports custom/freeform agent tools.';
const GROQ_MODEL_SELECT_DESCRIPTION = 'Select a Groq tool-calling model from the list.';
const DEEPSEEK_MODEL_SELECT_DESCRIPTION = 'Select a DeepSeek Chat Completions model from the list.';
const CUSTOM_MODEL_ID_DESCRIPTION = 'Enter the exact model ID from your API provider.';
const RUNTIME_MODEL_SELECT_DESCRIPTION = 'Select a model reported by the OIX provider.';

export function normalizeApiModelOptions(models: Array<{ id: string; name: string }>): ApiProviderModelOption[] {
  return Array.from(
    new Map(
      models
        .map((model) => ({
          id: model.id.trim(),
          name: model.name.trim() || model.id.trim(),
        }))
        .filter((model) => model.id)
        .map((model) => [model.id, model] as const),
    ).values(),
  );
}

/**
 * Build the API model-picker field config for a base URL.
 *
 * All model lists come from the caller (the Interpreter app-server) — this util
 * never holds its own model arrays. `openRouterModels` feeds the OpenRouter
 * picker; `providerModels` feeds the openai/groq/deepseek selects. Only the
 * preferred-default id and the OpenAI custom-tool support filter are policy here.
 */
export function buildApiModelFieldConfig(
  baseURL: string | undefined,
  openRouterModels: OpenRouterModel[],
  providerModels: ApiProviderModelOption[],
  runtimeProviderId?: string,
): ApiModelFieldConfig {
  const endpointKind = getApiEndpointKind(baseURL);

  if (endpointKind === 'openrouter') {
    const options = normalizeApiModelOptions(openRouterModels);
    return {
      kind: 'select',
      provider: 'openrouter',
      description: OPENROUTER_MODEL_SELECT_DESCRIPTION,
      options,
      defaultModelId: getDefaultApiProviderModelId('openrouter', options) ?? undefined,
    };
  }

  if (endpointKind === 'groq') {
    const options = normalizeApiModelOptions(providerModels);
    return {
      kind: 'select',
      provider: 'groq',
      description: GROQ_MODEL_SELECT_DESCRIPTION,
      options,
      defaultModelId: getDefaultApiProviderModelId('groq', options) ?? undefined,
    };
  }

  if (endpointKind === 'openai') {
    const options = normalizeApiModelOptions(providerModels).filter((option) =>
      supportsOpenAiResponsesCustomTools(option.id),
    );
    return {
      kind: 'select',
      provider: 'openai',
      description: OPENAI_MODEL_SELECT_DESCRIPTION,
      options,
      defaultModelId: getDefaultApiProviderModelId('openai', options) ?? undefined,
    };
  }

  if (endpointKind === 'deepseek') {
    const options = normalizeApiModelOptions(providerModels);
    return {
      kind: 'select',
      provider: 'deepseek',
      description: DEEPSEEK_MODEL_SELECT_DESCRIPTION,
      options,
      defaultModelId: getDefaultApiProviderModelId('deepseek', options) ?? undefined,
    };
  }

  if (runtimeProviderId) {
    const options = normalizeApiModelOptions(providerModels);
    if (options.length > 0) {
      return {
        kind: 'select',
        provider: 'runtime',
        description: RUNTIME_MODEL_SELECT_DESCRIPTION,
        options,
        defaultModelId: options[0]?.id,
      };
    }
  }

  return {
    kind: 'freeform',
    provider: 'custom',
    description: CUSTOM_MODEL_ID_DESCRIPTION,
  };
}
