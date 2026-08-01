import { isValidHostedModelId } from '../../shared/utils/modelIdValidation';
import {
  DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID,
  isOpenAiModelId,
  isOpenAiApiModelProvider,
  supportsOpenAiResponsesCustomTools,
} from '../../shared/utils/openAiResponsesTools';

export function validateRuntimeModelId(
  modelProvider: string | null | undefined,
  modelId: string,
): string | null {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    return 'Model is required.';
  }

  if (modelProvider === 'interpreter' && !isValidHostedModelId(trimmedModelId)) {
    return `Invalid hosted model ID '${trimmedModelId}'. Expected 'interpreter-smart', 'interpreter-fast', or <provider>/<model_id> (e.g. 'anthropic/claude-sonnet-4.6'). If this is a local model, switch to a Local profile in Settings > Models.`;
  }

  if (modelProvider === 'openrouter' && !isValidHostedModelId(trimmedModelId)) {
    return `Invalid OpenRouter model ID '${trimmedModelId}'. Expected format: <provider>/<model_id> (e.g. 'anthropic/claude-sonnet-4.6'). If this is a local model, switch to a Local profile in Settings > Models.`;
  }

  if (
    (isOpenAiApiModelProvider(modelProvider)
      || ((modelProvider === 'interpreter' || modelProvider === 'openrouter')
        && isOpenAiModelId(trimmedModelId))) &&
    !supportsOpenAiResponsesCustomTools(trimmedModelId)
  ) {
    return `OpenAI model '${trimmedModelId}' does not support Interpreter's custom/freeform agent tools. Use ${DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID}, or another model that supports Responses custom tools.`;
  }

  return null;
}
