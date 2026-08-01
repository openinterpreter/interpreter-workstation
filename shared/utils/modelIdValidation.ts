import {
  INTERPRETER_MODEL_ID_SET,
  OPENROUTER_MODEL_ID_SET,
} from '../generated/modelCatalog';

export function isValidHostedModelId(modelId: string): boolean {
  return INTERPRETER_MODEL_ID_SET.has(modelId) || OPENROUTER_MODEL_ID_SET.has(modelId);
}

export function validateProfileModelId(
  provider: string | undefined,
  modelId: string | undefined,
): string | null {
  if (!modelId?.trim()) return null;

  const trimmed = modelId.trim();

  if (provider === 'hosted' && !isValidHostedModelId(trimmed)) {
    return `Invalid model ID '${trimmed}'. Expected 'interpreter-smart', 'interpreter-fast', or <provider>/<model_id> (e.g. 'anthropic/claude-sonnet-4.6').`;
  }

  return null;
}
