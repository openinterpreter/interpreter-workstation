import { INTERPRETER_STARTER_CREDITS } from '../../shared/constants/interpreter-plans';

const EXPENSIVE_MODEL_IDS = new Set([
  'anthropic/claude-opus-4.6',
  'anthropic/claude-opus-4.7',
  'claude-opus-4.6',
  'claude-opus-4.7',
  'openai/gpt-5.4',
  'gpt-5.4',
  'google/gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview',
]);

export const LOW_USAGE_PERCENT_THRESHOLD = 10;

export function normalizeModelId(modelId?: string | null): string {
  return modelId?.trim().toLowerCase() ?? '';
}

export function isExpensiveModelId(modelId?: string | null): boolean {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return false;
  return EXPENSIVE_MODEL_IDS.has(normalized);
}

export function calculatePercentRemaining(
  remainingCredits: number,
  maxCredits: number = INTERPRETER_STARTER_CREDITS,
): number {
  if (!Number.isFinite(maxCredits) || maxCredits <= 0) {
    return 0;
  }

  return Math.min(Math.max((remainingCredits / maxCredits) * 100, 0), 100);
}

export function formatRemainingPercentLabel(percentRemaining: number): string {
  return `${Math.max(0, Math.floor(percentRemaining))}%`;
}
