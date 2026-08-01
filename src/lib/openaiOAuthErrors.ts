export type OpenAIOAuthModelListErrorKind = 'not_connected' | 'no_supported_models' | 'other';

function extractErrorMessage(error: unknown): string | null {
  if (typeof error === 'string') {
    return error.trim() || null;
  }

  if (error instanceof Error) {
    return error.message.trim() || null;
  }

  return null;
}

export function classifyOpenAIOAuthModelListError(error: unknown): OpenAIOAuthModelListErrorKind {
  const message = extractErrorMessage(error);

  switch (message) {
    case 'OpenAI OAuth account is not connected':
      return 'not_connected';
    case 'OpenAI OAuth account has no supported models':
      return 'no_supported_models';
    default:
      return 'other';
  }
}

export function getOpenAIOAuthModelListErrorMessage(error: unknown): string | null {
  switch (classifyOpenAIOAuthModelListError(error)) {
    case 'not_connected':
      return 'Sign in with ChatGPT to load models.';
    case 'no_supported_models':
      return 'No supported ChatGPT models are available on this account.';
    default:
      return null;
  }
}
