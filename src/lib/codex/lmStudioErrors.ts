const LMSTUDIO_TEMPLATE_ERROR_SIGNATURE = "error rendering prompt with jinja template";
function normalizeErrorText(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

export function isLmStudioPromptTemplateFailure(
  message: string | null | undefined,
  additionalDetails: string | null | undefined,
): boolean {
  const normalizedMessage = normalizeErrorText(message);
  const normalizedDetails = normalizeErrorText(additionalDetails);
  const haystack = `${normalizedMessage}\n${normalizedDetails}`;

  return haystack.includes(LMSTUDIO_TEMPLATE_ERROR_SIGNATURE);
}

export function formatLmStudioPromptTemplateFailure(
  message?: string | null,
  additionalDetails?: string | null,
): string {
  const originalErrorMessage = typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : "";
  const normalizedDetails = typeof additionalDetails === "string" && additionalDetails.trim().length > 0
    ? additionalDetails.trim()
    : "";
  const rawErrorSection = originalErrorMessage
    ? normalizedDetails
      ? `${originalErrorMessage}\n${normalizedDetails}`
      : originalErrorMessage
    : normalizedDetails;
  const guidance = [
    "The selected model from LM Studio doesn't support Interpreter tools.",
    "Choose a tool-capable model in LM Studio, or switch to an Interpreter hosted model, then retry.",
  ].join("\n");

  return rawErrorSection ? `${rawErrorSection}\n\n${guidance}` : guidance;
}
