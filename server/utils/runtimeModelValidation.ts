import { isValidHostedModelId } from '../../shared/utils/modelIdValidation';

const PROVIDER_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[^\s/]+$/i;

function isValidRuntimeHostedModelId(modelId: string): boolean {
  return isValidHostedModelId(modelId) || PROVIDER_MODEL_ID_PATTERN.test(modelId);
}

export function validateRuntimeModelId(
  modelProvider: string | null | undefined,
  modelId: string,
): string | null {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    return 'Model is required.';
  }

  if (modelProvider === 'interpreter' && !isValidRuntimeHostedModelId(trimmedModelId)) {
    return `Invalid hosted model ID '${trimmedModelId}'. Expected 'interpreter-smart', 'interpreter-fast', or <provider>/<model_id> (e.g. 'anthropic/claude-sonnet-4.6'). If this is a local model, switch to a Local profile in Settings > Models.`;
  }

  if (modelProvider === 'openrouter' && !isValidRuntimeHostedModelId(trimmedModelId)) {
    return `Invalid OpenRouter model ID '${trimmedModelId}'. Expected format: <provider>/<model_id> (e.g. 'anthropic/claude-sonnet-4.6'). If this is a local model, switch to a Local profile in Settings > Models.`;
  }

  // Do not infer model capabilities from the model name. The selected
  // provider's Responses API is authoritative for tool compatibility.
  return null;
}
