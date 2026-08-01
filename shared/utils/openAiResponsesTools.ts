export const OPENAI_API_MODEL_PROVIDERS = ['openai', 'openai-api'] as const;
// OpenAI lists gpt-5.4-nano as a Responses and Chat Completions model:
// https://developers.openai.com/api/docs/models/gpt-5.4-nano
export const DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID = 'gpt-5.4-nano' as const;

export type OpenAiApiModelProvider = (typeof OPENAI_API_MODEL_PROVIDERS)[number];

export function isOpenAiApiModelProvider(
  modelProvider: string | null | undefined,
): modelProvider is OpenAiApiModelProvider {
  return OPENAI_API_MODEL_PROVIDERS.some((provider) => provider === modelProvider);
}

export function normalizeOpenAiModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  return normalized.startsWith('openai/')
    ? normalized.slice('openai/'.length)
    : normalized;
}

export function isOpenAiModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized.startsWith('openai/') || normalized.startsWith('gpt-');
}

export function supportsOpenAiResponsesCustomTools(modelId: string): boolean {
  const normalizedModelId = normalizeOpenAiModelId(modelId);
  return (
    normalizedModelId === 'gpt-5' ||
    normalizedModelId.startsWith('gpt-5.') ||
    normalizedModelId.startsWith('gpt-5-')
  );
}
