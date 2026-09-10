/**
 * Trusted providers keep prompt data local or under EU handling, so no
 * redaction promise is shown. Every other (or unknown) provider requires
 * basemind redaction before model-bound text leaves the device. Unknown
 * fails closed: redact and notify.
 */
const TRUSTED_PROVIDERS = new Set(['mistral', 'local']);

export function needsRedactionForProvider(
  provider: string | null | undefined,
): boolean {
  if (!provider) return true;
  return !TRUSTED_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Fail-closed send policy: attachment payloads must never ride on the
 * regex-only fallback. Text-only turns keep the existing fallback so a
 * redaction outage degrades instead of blocking chat.
 */
export function shouldBlockAttachmentSend(options: {
  hasAttachmentPayload: boolean;
  nerFailed: boolean;
}): boolean {
  return options.hasAttachmentPayload && options.nerFailed;
}
