import { describe, test, expect } from 'bun:test';
import {
  extractMessageBody,
  extractDownloadableMedia,
  extractText,
  extractMediaPlaceholder,
  describeReplyContext,
} from './extract';
import type { WAMessage } from '@whiskeysockets/baileys';

function makeWAMessage(message: Record<string, unknown>): WAMessage {
  return {
    key: { remoteJid: '15551234567@s.whatsapp.net', id: 'test-msg', fromMe: true },
    message,
    messageTimestamp: 1700000000,
  } as unknown as WAMessage;
}

describe('extractText', () => {
  test('should extract plain conversation text', () => {
    expect(extractText({ conversation: 'Hello world' } as any)).toBe('Hello world');
  });

  test('should extract extended text message', () => {
    expect(extractText({ extendedTextMessage: { text: 'Extended hello' } } as any)).toBe('Extended hello');
  });

  test('should extract image caption', () => {
    expect(extractText({ imageMessage: { caption: 'Photo caption' } } as any)).toBe('Photo caption');
  });

  test('should extract video caption', () => {
    expect(extractText({ videoMessage: { caption: 'Video caption' } } as any)).toBe('Video caption');
  });

  test('should extract document caption', () => {
    expect(extractText({ documentMessage: { caption: 'Doc caption' } } as any)).toBe('Doc caption');
  });

  test('should return contact placeholder', () => {
    expect(extractText({ contactMessage: { displayName: 'Jane Doe' } } as any)).toBe('[Contact: Jane Doe]');
  });

  test('should return contacts array placeholder', () => {
    const result = extractText({
      contactsArrayMessage: {
        contacts: [
          { displayName: 'Alice' },
          { displayName: 'Bob' },
        ],
      },
    } as any);
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
  });

  test('should return undefined for empty message', () => {
    expect(extractText({} as any)).toBeUndefined();
  });

  test('should return undefined for null', () => {
    expect(extractText(undefined)).toBeUndefined();
  });

  test('should trim whitespace from text', () => {
    expect(extractText({ conversation: '  spaced  ' } as any)).toBe('spaced');
  });

  test('should prefer conversation over caption when both present', () => {
    expect(extractText({
      conversation: 'conv text',
      imageMessage: { caption: 'cap text' },
    } as any)).toBe('conv text');
  });

  test('should unwrap viewOnceMessage', () => {
    expect(extractText({
      viewOnceMessage: { message: { conversation: 'view once text' } },
    } as any)).toBe('view once text');
  });

  test('should unwrap ephemeralMessage', () => {
    expect(extractText({
      ephemeralMessage: { message: { conversation: 'ephemeral text' } },
    } as any)).toBe('ephemeral text');
  });
});

describe('extractMediaPlaceholder', () => {
  test('should return [Image] for image message', () => {
    const result = extractMediaPlaceholder({ imageMessage: { mimetype: 'image/jpeg' } } as any);
    expect(result?.placeholder).toBe('[Image]');
    expect(result?.mediaType).toBe('image');
  });

  test('should return [Video] for video message', () => {
    const result = extractMediaPlaceholder({ videoMessage: { mimetype: 'video/mp4' } } as any);
    expect(result?.placeholder).toBe('[Video]');
    expect(result?.mediaType).toBe('video');
  });

  test('should return [Voice message] for audio message', () => {
    const result = extractMediaPlaceholder({ audioMessage: { mimetype: 'audio/ogg' } } as any);
    expect(result?.placeholder).toBe('[Voice message]');
    expect(result?.mediaType).toBe('audio');
  });

  test('should return [File: name] for document with filename', () => {
    const result = extractMediaPlaceholder({ documentMessage: { fileName: 'report.pdf' } } as any);
    expect(result?.placeholder).toBe('[File: report.pdf]');
    expect(result?.mediaType).toBe('document');
  });

  test('should return [Document] for document without filename', () => {
    const result = extractMediaPlaceholder({ documentMessage: {} } as any);
    expect(result?.placeholder).toBe('[Document]');
  });

  test('should return [Sticker] for sticker message', () => {
    const result = extractMediaPlaceholder({ stickerMessage: { mimetype: 'image/webp' } } as any);
    expect(result?.placeholder).toBe('[Sticker]');
    expect(result?.mediaType).toBe('sticker');
  });

  test('should return [Location] with coords', () => {
    const result = extractMediaPlaceholder({
      locationMessage: { degreesLatitude: 37.7749, degreesLongitude: -122.4194 },
    } as any);
    expect(result?.placeholder).toContain('37.7749');
    expect(result?.placeholder).toContain('-122.4194');
    expect(result?.mediaType).toBe('location');
  });

  test('should return undefined for text-only message', () => {
    expect(extractMediaPlaceholder({ conversation: 'text' } as any)).toBeUndefined();
  });

  test('should return undefined for null', () => {
    expect(extractMediaPlaceholder(undefined)).toBeUndefined();
  });
});

describe('extractMessageBody', () => {
  test('should return text for plain conversation', () => {
    const msg = makeWAMessage({ conversation: 'Hello world' });
    const result = extractMessageBody(msg);
    expect(result.body).toBe('Hello world');
    expect(result.mediaType).toBeUndefined();
  });

  test('should return text for extended text message', () => {
    const msg = makeWAMessage({ extendedTextMessage: { text: 'Extended hello' } });
    expect(extractMessageBody(msg).body).toBe('Extended hello');
  });

  test('should combine caption and media placeholder for image with caption', () => {
    const msg = makeWAMessage({ imageMessage: { caption: 'Check this', mimetype: 'image/jpeg' } });
    const result = extractMessageBody(msg);
    expect(result.body).toContain('Check this');
    expect(result.body).toContain('[Image]');
    expect(result.mediaType).toBe('image');
  });

  test('should return only placeholder for image without caption', () => {
    const msg = makeWAMessage({ imageMessage: { mimetype: 'image/jpeg' } });
    const result = extractMessageBody(msg);
    expect(result.body).toBe('[Image]');
    expect(result.mediaType).toBe('image');
  });

  test('should return voice message placeholder for audio', () => {
    const msg = makeWAMessage({ audioMessage: { ptt: true, mimetype: 'audio/ogg' } });
    const result = extractMessageBody(msg);
    expect(result.body).toBe('[Voice message]');
    expect(result.mediaType).toBe('audio');
  });

  test('should return empty string for empty message', () => {
    const msg = makeWAMessage({});
    expect(extractMessageBody(msg).body).toBe('');
  });

  test('should return empty string when message field is undefined', () => {
    const msg = { key: { remoteJid: 'x', id: 'y', fromMe: true } } as unknown as WAMessage;
    expect(extractMessageBody(msg).body).toBe('');
  });

  test('should unwrap viewOnceMessage and extract body', () => {
    const msg = makeWAMessage({
      viewOnceMessage: { message: { imageMessage: { caption: 'view once cap', mimetype: 'image/jpeg' } } },
    });
    const result = extractMessageBody(msg);
    expect(result.body).toContain('view once cap');
    expect(result.body).toContain('[Image]');
  });

  test('should unwrap ephemeralMessage and extract body', () => {
    const msg = makeWAMessage({
      ephemeralMessage: { message: { conversation: 'disappearing' } },
    });
    expect(extractMessageBody(msg).body).toBe('disappearing');
  });
});

describe('extractDownloadableMedia', () => {
  test('should extract image media metadata', () => {
    const msg = makeWAMessage({ imageMessage: { mimetype: 'image/jpeg', url: 'https://...' } });
    const result = extractDownloadableMedia(msg);
    expect(result).toBeDefined();
    expect(result!.mediaType).toBe('image');
    expect(result!.mimeType).toBe('image/jpeg');
  });

  test('should extract video media metadata', () => {
    const msg = makeWAMessage({ videoMessage: { mimetype: 'video/mp4' } });
    const result = extractDownloadableMedia(msg);
    expect(result).toBeDefined();
    expect(result!.mediaType).toBe('video');
  });

  test('should extract audio metadata with voice flag', () => {
    const msg = makeWAMessage({ audioMessage: { mimetype: 'audio/ogg', ptt: true } });
    const result = extractDownloadableMedia(msg);
    expect(result).toBeDefined();
    expect(result!.mediaType).toBe('audio');
    expect(result!.isVoiceMessage).toBe(true);
  });

  test('should extract audio metadata without voice flag', () => {
    const msg = makeWAMessage({ audioMessage: { mimetype: 'audio/mp3', ptt: false } });
    const result = extractDownloadableMedia(msg);
    expect(result).toBeDefined();
    expect(result!.isVoiceMessage).toBe(false);
  });

  test('should extract document metadata with filename', () => {
    const msg = makeWAMessage({ documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf' } });
    const result = extractDownloadableMedia(msg);
    expect(result).toBeDefined();
    expect(result!.mediaType).toBe('document');
    expect(result!.fileName).toBe('report.pdf');
  });

  test('should extract sticker media metadata', () => {
    const msg = makeWAMessage({ stickerMessage: { mimetype: 'image/webp' } });
    const result = extractDownloadableMedia(msg);
    expect(result).toBeDefined();
    expect(result!.mediaType).toBe('sticker');
  });

  test('should return undefined for text-only message', () => {
    const msg = makeWAMessage({ conversation: 'text only' });
    expect(extractDownloadableMedia(msg)).toBeUndefined();
  });

  test('should return undefined for empty message', () => {
    const msg = makeWAMessage({});
    expect(extractDownloadableMedia(msg)).toBeUndefined();
  });

  test('should unwrap viewOnce and extract media', () => {
    const msg = makeWAMessage({
      viewOnceMessage: { message: { imageMessage: { mimetype: 'image/png' } } },
    });
    const result = extractDownloadableMedia(msg);
    expect(result).toBeDefined();
    expect(result!.mediaType).toBe('image');
    expect(result!.mimeType).toBe('image/png');
  });
});

describe('describeReplyContext', () => {
  test('should extract quoted text message', () => {
    const msg = {
      extendedTextMessage: {
        text: 'Reply body',
        contextInfo: {
          stanzaId: 'quoted-id',
          participant: '15559999999@s.whatsapp.net',
          quotedMessage: { conversation: 'Original text' },
        },
      },
    };
    const result = describeReplyContext(msg as any);
    expect(result).not.toBeNull();
    expect(result!.body).toBe('Original text');
    expect(result!.sender).toBe('15559999999');
    expect(result!.id).toBe('quoted-id');
  });

  test('should extract quoted media placeholder when no text', () => {
    const msg = {
      extendedTextMessage: {
        text: 'Reply to image',
        contextInfo: {
          stanzaId: 'quoted-img',
          participant: '15559999999@s.whatsapp.net',
          quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } },
        },
      },
    };
    const result = describeReplyContext(msg as any);
    expect(result).not.toBeNull();
    expect(result!.body).toBe('[Image]');
  });

  test('should return null when no context info', () => {
    const msg = { conversation: 'No reply context' };
    expect(describeReplyContext(msg as any)).toBeNull();
  });

  test('should return null for null input', () => {
    expect(describeReplyContext(undefined)).toBeNull();
  });

  test('should return null when quoted message has no extractable content', () => {
    const msg = {
      extendedTextMessage: {
        text: 'Reply',
        contextInfo: {
          stanzaId: 'quoted-empty',
          participant: '15559999999@s.whatsapp.net',
          quotedMessage: {},
        },
      },
    };
    expect(describeReplyContext(msg as any)).toBeNull();
  });
});
