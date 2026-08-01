import { describe, test, expect } from 'bun:test';
import {
  jidToPhone,
  normalizeWhatsAppTarget,
  isWhatsAppGroupJid,
  isWhatsAppUserJid,
  extractPhoneFromJid,
  isIgnoredJid,
} from './normalize';

describe('jidToPhone', () => {
  test('should extract phone from standard user JID', () => {
    expect(jidToPhone('15551234567@s.whatsapp.net')).toBe('15551234567');
  });

  test('should strip device suffix from user JID', () => {
    expect(jidToPhone('15551234567:0@s.whatsapp.net')).toBe('15551234567');
    expect(jidToPhone('15551234567:42@s.whatsapp.net')).toBe('15551234567');
  });

  test('should extract phone from LID JID', () => {
    expect(jidToPhone('987654@lid')).toBe('987654');
  });

  test('should return null for group JIDs', () => {
    expect(jidToPhone('120363012345678901@g.us')).toBeNull();
    expect(jidToPhone('120363-999888777@g.us')).toBeNull();
  });

  test('should return null for null, undefined, empty string', () => {
    expect(jidToPhone(null)).toBeNull();
    expect(jidToPhone(undefined)).toBeNull();
    expect(jidToPhone('')).toBeNull();
  });

  test('should strip whatsapp: prefix before extraction', () => {
    expect(jidToPhone('whatsapp:15551234567@s.whatsapp.net')).toBe('15551234567');
  });

  test('should strip repeated whatsapp: prefixes', () => {
    expect(jidToPhone('whatsapp:whatsapp:15551234567@s.whatsapp.net')).toBe('15551234567');
  });

  test('should handle case-insensitive whatsapp: prefix', () => {
    expect(jidToPhone('WhatsApp:15551234567@s.whatsapp.net')).toBe('15551234567');
  });
});

describe('extractPhoneFromJid', () => {
  test('should extract from user JID', () => {
    expect(extractPhoneFromJid('15551234567@s.whatsapp.net')).toBe('15551234567');
  });

  test('should extract from user JID with device suffix', () => {
    expect(extractPhoneFromJid('15551234567:0@s.whatsapp.net')).toBe('15551234567');
  });

  test('should extract from LID JID', () => {
    expect(extractPhoneFromJid('5555@lid')).toBe('5555');
  });

  test('should return null for group JID', () => {
    expect(extractPhoneFromJid('120363012345678901@g.us')).toBeNull();
  });

  test('should return null for bare text', () => {
    expect(extractPhoneFromJid('not-a-jid')).toBeNull();
  });

  test('should return null for unknown domain', () => {
    expect(extractPhoneFromJid('12345@unknown.domain')).toBeNull();
  });
});

describe('normalizeWhatsAppTarget', () => {
  test('should normalize raw phone number to user JID', () => {
    expect(normalizeWhatsAppTarget('15551234567')).toBe('15551234567@s.whatsapp.net');
  });

  test('should strip + from phone number', () => {
    expect(normalizeWhatsAppTarget('+15551234567')).toBe('15551234567@s.whatsapp.net');
  });

  test('should strip formatting from phone number', () => {
    expect(normalizeWhatsAppTarget('+1 (555) 123-4567')).toBe('15551234567@s.whatsapp.net');
  });

  test('should normalize existing user JID by stripping device suffix', () => {
    expect(normalizeWhatsAppTarget('15551234567:0@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
  });

  test('should pass through already-normalized user JID', () => {
    expect(normalizeWhatsAppTarget('15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
  });

  test('should normalize group JID preserving local part', () => {
    expect(normalizeWhatsAppTarget('120363012345678901@g.us')).toBe('120363012345678901@g.us');
  });

  test('should return null for empty string', () => {
    expect(normalizeWhatsAppTarget('')).toBeNull();
  });

  test('should return null for unknown JID domain', () => {
    expect(normalizeWhatsAppTarget('user@unknown.net')).toBeNull();
  });

  test('should strip whatsapp: prefix', () => {
    expect(normalizeWhatsAppTarget('whatsapp:15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
  });
});

describe('isWhatsAppGroupJid', () => {
  test('should identify standard group JID', () => {
    expect(isWhatsAppGroupJid('120363012345678901@g.us')).toBe(true);
  });

  test('should identify group JID with hyphenated local part', () => {
    expect(isWhatsAppGroupJid('120363-012345678901@g.us')).toBe(true);
  });

  test('should reject user JID', () => {
    expect(isWhatsAppGroupJid('15551234567@s.whatsapp.net')).toBe(false);
  });

  test('should reject LID JID', () => {
    expect(isWhatsAppGroupJid('12345@lid')).toBe(false);
  });

  test('should handle whatsapp: prefix on group JID', () => {
    expect(isWhatsAppGroupJid('whatsapp:120363012345678901@g.us')).toBe(true);
  });

  test('should reject group-like JID with @ in local part', () => {
    expect(isWhatsAppGroupJid('bad@local@g.us')).toBe(false);
  });

  test('should reject empty string', () => {
    expect(isWhatsAppGroupJid('')).toBe(false);
  });
});

describe('isWhatsAppUserJid', () => {
  test('should identify standard user JID', () => {
    expect(isWhatsAppUserJid('15551234567@s.whatsapp.net')).toBe(true);
  });

  test('should identify user JID with device suffix', () => {
    expect(isWhatsAppUserJid('15551234567:0@s.whatsapp.net')).toBe(true);
  });

  test('should identify LID JID', () => {
    expect(isWhatsAppUserJid('12345@lid')).toBe(true);
  });

  test('should reject group JID', () => {
    expect(isWhatsAppUserJid('120363012345678901@g.us')).toBe(false);
  });

  test('should reject bare phone number', () => {
    expect(isWhatsAppUserJid('15551234567')).toBe(false);
  });

  test('should reject empty string', () => {
    expect(isWhatsAppUserJid('')).toBe(false);
  });
});

describe('isIgnoredJid', () => {
  test('should ignore status@broadcast', () => {
    expect(isIgnoredJid('status@broadcast')).toBe(true);
  });

  test('should ignore @status suffix', () => {
    expect(isIgnoredJid('something@status')).toBe(true);
  });

  test('should ignore @broadcast suffix', () => {
    expect(isIgnoredJid('something@broadcast')).toBe(true);
  });

  test('should not ignore normal user JID', () => {
    expect(isIgnoredJid('15551234567@s.whatsapp.net')).toBe(false);
  });

  test('should not ignore group JID', () => {
    expect(isIgnoredJid('120363012345678901@g.us')).toBe(false);
  });
});
