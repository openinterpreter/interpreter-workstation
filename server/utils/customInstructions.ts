export const CUSTOM_INSTRUCTIONS_MAX_CHARS = 12000;

export function normalizeCustomInstructions(
  customInstructions: string | null | undefined,
): string | null {
  if (typeof customInstructions !== 'string') return null;

  const trimmed = customInstructions.trim();
  if (!trimmed) return null;
  if (trimmed.length <= CUSTOM_INSTRUCTIONS_MAX_CHARS) return trimmed;
  return trimmed.slice(0, CUSTOM_INSTRUCTIONS_MAX_CHARS);
}

export function appendCustomInstructionsToPrompt(
  systemPrompt: string,
  customInstructions: string | null | undefined,
): string {
  const normalizedInstructions = normalizeCustomInstructions(customInstructions);
  if (!normalizedInstructions) return systemPrompt;

  return `${systemPrompt}

## Persistent User Custom Instructions

The user saved these instructions in Settings > General > Custom Instructions.
Follow them unless the user explicitly overrides them in this conversation.

<user_custom_instructions>
${normalizedInstructions}
</user_custom_instructions>`;
}
