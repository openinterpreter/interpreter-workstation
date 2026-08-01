/**
 * WhatsApp JID normalization utilities.
 * Ported from Open Claw's whatsapp/normalize.ts patterns.
 *
 * Handles:
 * - User JIDs: "1234567890:0@s.whatsapp.net" -> "1234567890"
 * - LID JIDs: "123456@lid"
 * - Group JIDs: "120363012345678901@g.us"
 * - Raw phone numbers
 */

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;

function stripWhatsAppPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, '').trim();
    if (candidate === before) return candidate;
  }
}

/**
 * Check if a JID represents a WhatsApp group.
 */
export function isWhatsAppGroupJid(value: string): boolean {
  const candidate = stripWhatsAppPrefixes(value);
  const lower = candidate.toLowerCase();
  if (!lower.endsWith('@g.us')) return false;
  const localPart = candidate.slice(0, candidate.length - '@g.us'.length);
  if (!localPart || localPart.includes('@')) return false;
  return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}

/**
 * Check if a JID represents a WhatsApp user (DM).
 */
export function isWhatsAppUserJid(value: string): boolean {
  const candidate = stripWhatsAppPrefixes(value);
  return WHATSAPP_USER_JID_RE.test(candidate) || WHATSAPP_LID_RE.test(candidate);
}

/**
 * Extract the phone number from a user JID.
 * "1234567890:0@s.whatsapp.net" -> "1234567890"
 * "123456@lid" -> "123456"
 */
export function extractPhoneFromJid(jid: string): string | null {
  const candidate = stripWhatsAppPrefixes(jid);
  const userMatch = candidate.match(WHATSAPP_USER_JID_RE);
  if (userMatch) return userMatch[1];
  const lidMatch = candidate.match(WHATSAPP_LID_RE);
  if (lidMatch) return lidMatch[1];
  return null;
}

/**
 * Convert a JID to its E.164-like phone representation.
 * For user JIDs, returns the phone number portion.
 * For group JIDs, returns null.
 */
export function jidToPhone(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const candidate = stripWhatsAppPrefixes(jid);
  if (isWhatsAppGroupJid(candidate)) return null;
  return extractPhoneFromJid(candidate);
}

/**
 * Normalize a WhatsApp target identifier.
 * Accepts JIDs, phone numbers, or prefixed formats.
 * Returns normalized JID or null if invalid.
 */
export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppPrefixes(value);
  if (!candidate) return null;

  // Group JID - normalize case
  if (isWhatsAppGroupJid(candidate)) {
    const localPart = candidate.slice(0, candidate.length - '@g.us'.length);
    return `${localPart}@g.us`;
  }

  // User JID - extract phone and rebuild
  if (isWhatsAppUserJid(candidate)) {
    const phone = extractPhoneFromJid(candidate);
    if (!phone) return null;
    return `${phone}@s.whatsapp.net`;
  }

  // If it contains @, it's a JID format we don't understand
  if (candidate.includes('@')) return null;

  // Treat as raw phone number - strip non-digits except leading +
  const cleaned = candidate.replace(/^(\+?)/, '$1').replace(/[^\d]/g, '');
  if (cleaned.length < 1) return null;
  return `${cleaned}@s.whatsapp.net`;
}

/**
 * Check if a JID is a status broadcast or broadcast list (should be ignored).
 */
export function isIgnoredJid(jid: string): boolean {
  return jid.endsWith('@status') ||
    jid.endsWith('@broadcast') ||
    jid === 'status@broadcast';
}
