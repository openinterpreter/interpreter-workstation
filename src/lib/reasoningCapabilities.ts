import type { AgentModelConfig } from '../../shared/types/model';
import {
  findSupportedResponsesApiBaseUrlOption,
  type OpenRouterModelCatalogResult,
  type SupportedOpenAIOAuthModel,
} from '../../shared/types/provider';
import {
  REASONING_EFFORT_ORDER,
  type ReasoningEffort,
} from '../../shared/types/reasoning';

export type ReasoningCapability = {
  supportedEfforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  source: 'exact' | 'generic';
};

function capabilityFromOpenAiOAuthModel(
  modelId: string,
  models: SupportedOpenAIOAuthModel[],
): ReasoningCapability | null {
  const model = models.find((entry) => entry.id === modelId);
  if (!model?.supportedReasoningEfforts?.length) {
    return null;
  }

  return {
    supportedEfforts: [...model.supportedReasoningEfforts],
    defaultEffort: model.defaultReasoningEffort,
    source: 'exact',
  };
}

function capabilityFromOpenRouterCatalog(
  modelId: string,
  catalog: OpenRouterModelCatalogResult | null,
): ReasoningCapability | null {
  const model = catalog?.models.find((entry) => entry.id === modelId);
  if (!model?.supportedReasoningEfforts?.length) {
    return null;
  }

  return {
    supportedEfforts: [...model.supportedReasoningEfforts],
    defaultEffort: model.defaultReasoningEffort,
    source: 'generic',
  };
}

function capabilityFromOpenAiApiModel(modelId: string): ReasoningCapability | null {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId.startsWith('gpt-5')) {
    return null;
  }

  if (normalizedModelId === 'gpt-5-pro' || /^gpt-5-pro-\d{4}-\d{2}-\d{2}$/.test(normalizedModelId)) {
    return {
      supportedEfforts: ['high'],
      defaultEffort: 'high',
      source: 'generic',
    };
  }

  if (normalizedModelId === 'gpt-5.6-luna' || /^gpt-5\.6-luna-\d{4}-\d{2}-\d{2}$/.test(normalizedModelId)) {
    return {
      supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      source: 'generic',
    };
  }

  if (normalizedModelId === 'gpt-5.4-pro' || /^gpt-5\.4-pro-\d{4}-\d{2}-\d{2}$/.test(normalizedModelId)) {
    return {
      supportedEfforts: ['medium', 'high', 'xhigh'],
      defaultEffort: 'high',
      source: 'generic',
    };
  }

  if (normalizedModelId === 'gpt-5.4' || /^gpt-5\.4-\d{4}-\d{2}-\d{2}$/.test(normalizedModelId)) {
    return {
      supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'none',
      source: 'generic',
    };
  }

  if (normalizedModelId === 'gpt-5.3-codex' || /^gpt-5\.3-codex-\d{4}-\d{2}-\d{2}$/.test(normalizedModelId)) {
    return {
      supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      source: 'generic',
    };
  }

  if (normalizedModelId === 'gpt-5.2-codex' || /^gpt-5\.2-codex-\d{4}-\d{2}-\d{2}$/.test(normalizedModelId)) {
    return {
      supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      source: 'generic',
    };
  }

  if (normalizedModelId === 'gpt-5.2' || /^gpt-5\.2-\d{4}-\d{2}-\d{2}$/.test(normalizedModelId)) {
    return {
      supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'none',
      source: 'generic',
    };
  }

  if (normalizedModelId === 'gpt-5.1' || /^gpt-5\.1-\d{4}-\d{2}-\d{2}$/.test(normalizedModelId)) {
    return {
      supportedEfforts: ['none', 'low', 'medium', 'high'],
      defaultEffort: 'none',
      source: 'generic',
    };
  }

  if (normalizedModelId === 'gpt-5' || /^gpt-5-\d{4}-\d{2}-\d{2}$/.test(normalizedModelId)) {
    return {
      supportedEfforts: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'medium',
      source: 'generic',
    };
  }

  return null;
}

function capabilityFromUnknownOpenAiApiModel(): ReasoningCapability {
  return {
    supportedEfforts: [...REASONING_EFFORT_ORDER],
    source: 'generic',
  };
}

export function getReasoningCapabilityForModelConfig(
  modelConfig: Pick<AgentModelConfig, 'provider' | 'modelId' | 'baseURL' | 'apiFormat'>,
  options: {
    openAiOAuthModels?: SupportedOpenAIOAuthModel[];
    openRouterCatalog?: OpenRouterModelCatalogResult | null;
  } = {},
): ReasoningCapability | null {
  const modelId = modelConfig.modelId?.trim();
  if (!modelId) {
    return null;
  }

  if (modelConfig.provider === 'openai-oauth') {
    return capabilityFromOpenAiOAuthModel(modelId, options.openAiOAuthModels ?? []);
  }

  if (modelConfig.provider === 'hosted') {
    return capabilityFromOpenRouterCatalog(modelId, options.openRouterCatalog ?? null);
  }

  if (modelConfig.provider === 'api') {
    const baseUrlOption = findSupportedResponsesApiBaseUrlOption(modelConfig.baseURL);
    if (baseUrlOption?.id === 'openrouter') {
      return capabilityFromOpenRouterCatalog(modelId, options.openRouterCatalog ?? null);
    }
    if (baseUrlOption?.id === 'openai') {
      return capabilityFromOpenAiApiModel(modelId) ?? capabilityFromUnknownOpenAiApiModel();
    }
    if (modelConfig.apiFormat === 'openai') {
      return capabilityFromUnknownOpenAiApiModel();
    }
  }

  return null;
}

export function resolveReasoningEffort(
  capability: ReasoningCapability | null,
  selectedEffort?: ReasoningEffort,
): ReasoningEffort | undefined {
  if (!capability?.supportedEfforts.length) {
    return undefined;
  }
  if (selectedEffort && capability.supportedEfforts.includes(selectedEffort)) {
    return selectedEffort;
  }
  return capability.defaultEffort ?? capability.supportedEfforts[0];
}
