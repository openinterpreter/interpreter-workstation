const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_FIELD_NAMES = new Set([
  'accessToken',
  'access_token',
  'apiKey',
  'apiKeys',
  'api_key',
  'authToken',
  'clientSecret',
  'client_secret',
  'codeVerifier',
  'experimental_bearer_token',
  'refreshToken',
  'refresh_token',
]);
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function redactFeedbackMetadata(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactFeedbackMetadata(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (SENSITIVE_FIELD_NAMES.has(key)) {
      if (key === 'apiKeys' && isRecord(nestedValue)) {
        redacted[key] = Object.fromEntries(
          Object.keys(nestedValue).map((nestedKey) => [nestedKey, REDACTED_VALUE])
        );
      } else {
        redacted[key] = REDACTED_VALUE;
      }
      continue;
    }

    if (
      (parentKey === 'headers' || parentKey === 'http_headers') &&
      SENSITIVE_HEADER_NAMES.has(key.toLowerCase())
    ) {
      redacted[key] = REDACTED_VALUE;
      continue;
    }

    redacted[key] = redactFeedbackMetadata(nestedValue, key);
  }

  return redacted;
}

export function formatFeedbackMetadataDump(metadata: unknown): string {
  return `<feedback_metadata_dump>\n${JSON.stringify(metadata)}\n</feedback_metadata_dump>\n`;
}

export function appendFeedbackMetadataDump(logContent: string | null | undefined, metadata: unknown): string {
  const metadataDump = formatFeedbackMetadataDump(metadata);
  const trimmedLogContent = logContent?.trimEnd();
  if (!trimmedLogContent) {
    return metadataDump;
  }

  return `${trimmedLogContent}\n\n${metadataDump}`;
}
