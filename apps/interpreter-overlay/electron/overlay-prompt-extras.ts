import { appendCustomInstructionsToPrompt } from '../../../server/utils/customInstructions';

export function appendOverlayPromptExtras(
  basePrompt: string,
  options: {
    systemAddendum?: string | null;
    customInstructions?: string | null;
  },
): string {
  const trimmedAddendum = options.systemAddendum?.trim();
  const promptWithAddendum = trimmedAddendum
    ? `${basePrompt}\n\n${trimmedAddendum}`
    : basePrompt;
  return appendCustomInstructionsToPrompt(promptWithAddendum, options.customInstructions);
}
