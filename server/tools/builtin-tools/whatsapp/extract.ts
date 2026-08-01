/**
 * Robust message content extraction for WhatsApp messages.
 * Ported from Open Claw's inbound/extract.ts patterns.
 *
 * Uses Baileys' normalizeMessageContent and extractMessageContent
 * for proper handling of all WhatsApp message types including
 * viewOnce, ephemeral, forwarded, and protocol-wrapped messages.
 */

import {
  extractMessageContent,
  normalizeMessageContent,
  getContentType,
  type proto,
  type WAMessage,
} from '@whiskeysockets/baileys';

export interface ExtractedMediaContent {
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mimeType?: string;
  fileName?: string;
  isVoiceMessage?: boolean;
}

/**
 * Unwrap protocol-level wrappers (viewOnce, ephemeral, etc.)
 * to get to the actual user-facing message content.
 */
function unwrapMessage(rawMessage: proto.IMessage | undefined): proto.IMessage | undefined {
  if (!rawMessage) return undefined;
  const normalized = normalizeMessageContent(rawMessage);
  return normalized ?? rawMessage;
}

/**
 * Extract context info from any message type.
 * Context info contains quoted message references, mentions, etc.
 */
function extractContextInfo(message: proto.IMessage): proto.IContextInfo | undefined {
  if (!message) return undefined;
  const candidates = [
    message.extendedTextMessage?.contextInfo,
    message.imageMessage?.contextInfo,
    message.videoMessage?.contextInfo,
    message.audioMessage?.contextInfo,
    message.documentMessage?.contextInfo,
    message.stickerMessage?.contextInfo,
    message.contactMessage?.contextInfo,
    message.locationMessage?.contextInfo,
    message.liveLocationMessage?.contextInfo,
  ];
  return candidates.find(c => c != null) ?? undefined;
}

/**
 * Extract plain text from a WhatsApp message.
 * Handles conversation, extendedText, captions, contacts, etc.
 * Ported from Open Claw extract.ts extractText.
 */
export function extractText(rawMessage: proto.IMessage | undefined): string | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) return undefined;

  const extracted = extractMessageContent(message);
  const candidates = [message, extracted && extracted !== message ? extracted : undefined];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (typeof candidate.conversation === 'string' && candidate.conversation.trim()) {
      return candidate.conversation.trim();
    }
    const extended = candidate.extendedTextMessage?.text;
    if (extended?.trim()) {
      return extended.trim();
    }
    const caption =
      candidate.imageMessage?.caption ??
      candidate.videoMessage?.caption ??
      candidate.documentMessage?.caption;
    if (caption?.trim()) {
      return caption.trim();
    }
  }

  // Contact message placeholder
  const contact = message.contactMessage ?? undefined;
  if (contact) {
    const name = contact.displayName || 'Unknown';
    return `[Contact: ${name}]`;
  }

  const contactsArray = message.contactsArrayMessage?.contacts;
  if (contactsArray && contactsArray.length > 0) {
    const names = contactsArray
      .map(c => c.displayName || 'Unknown')
      .slice(0, 3)
      .join(', ');
    const remaining = contactsArray.length > 3 ? ` +${contactsArray.length - 3} more` : '';
    return `[Contacts: ${names}${remaining}]`;
  }

  return undefined;
}

/**
 * Extract a media type placeholder when the message contains media but no text.
 * Ported from Open Claw extract.ts extractMediaPlaceholder.
 */
export function extractMediaPlaceholder(
  rawMessage: proto.IMessage | undefined,
): { placeholder: string; mediaType: string } | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) return undefined;

  if (message.imageMessage) {
    return { placeholder: '[Image]', mediaType: 'image' };
  }
  if (message.videoMessage) {
    return { placeholder: '[Video]', mediaType: 'video' };
  }
  if (message.audioMessage) {
    return { placeholder: '[Voice message]', mediaType: 'audio' };
  }
  if (message.documentMessage) {
    const fileName = message.documentMessage.fileName;
    return {
      placeholder: fileName ? `[File: ${fileName}]` : '[Document]',
      mediaType: 'document',
    };
  }
  if (message.stickerMessage) {
    return { placeholder: '[Sticker]', mediaType: 'sticker' };
  }
  if (message.locationMessage || message.liveLocationMessage) {
    const loc = message.liveLocationMessage ?? message.locationMessage;
    const lat = loc?.degreesLatitude;
    const lng = loc?.degreesLongitude;
    if (lat != null && lng != null) {
      return { placeholder: `[Location: ${lat}, ${lng}]`, mediaType: 'location' };
    }
    return { placeholder: '[Location]', mediaType: 'location' };
  }
  if (message.reactionMessage) {
    return {
      placeholder: `[Reaction: ${message.reactionMessage.text || ''}]`,
      mediaType: 'reaction',
    };
  }
  if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
    const poll = message.pollCreationMessage ?? message.pollCreationMessageV2 ?? message.pollCreationMessageV3;
    return {
      placeholder: `[Poll: ${poll?.name || 'Poll'}]`,
      mediaType: 'poll',
    };
  }

  return undefined;
}

/**
 * Extract mentioned JIDs from a message.
 * Ported from Open Claw extract.ts extractMentionedJids.
 */
export function extractMentionedJids(
  rawMessage: proto.IMessage | undefined,
): string[] | undefined {
  const message = unwrapMessage(rawMessage);
  if (!message) return undefined;

  const candidates = [
    message.extendedTextMessage?.contextInfo?.mentionedJid,
    message.imageMessage?.contextInfo?.mentionedJid,
    message.videoMessage?.contextInfo?.mentionedJid,
  ];

  const flattened = candidates.flatMap(arr => arr ?? []).filter(Boolean);
  return flattened.length > 0 ? Array.from(new Set(flattened)) : undefined;
}

/**
 * Describe the reply context (quoted message) if present.
 * Ported from Open Claw extract.ts describeReplyContext.
 */
export function describeReplyContext(rawMessage: proto.IMessage | undefined): {
  id?: string;
  body: string;
  sender: string;
  senderJid?: string;
} | null {
  const message = unwrapMessage(rawMessage);
  if (!message) return null;

  const contextInfo = extractContextInfo(message);
  const quoted = normalizeMessageContent(contextInfo?.quotedMessage as proto.IMessage | undefined);
  if (!quoted) return null;

  let body = extractText(quoted);
  if (!body) {
    const media = extractMediaPlaceholder(quoted);
    body = media?.placeholder;
  }
  if (!body) return null;

  const senderJid = contextInfo?.participant ?? undefined;
  const sender = senderJid ? senderJid.split('@')[0].split(':')[0] : 'unknown';

  return {
    id: contextInfo?.stanzaId ? String(contextInfo.stanzaId) : undefined,
    body,
    sender,
    senderJid,
  };
}

/**
 * Extract the full body text from a WAMessage, combining text + media placeholder.
 * This is the main entry point for getting displayable message content.
 */
export function extractMessageBody(msg: WAMessage): {
  body: string;
  mediaType?: string;
} {
  const rawMessage = msg.message as proto.IMessage | undefined;
  const text = extractText(rawMessage);
  const media = extractMediaPlaceholder(rawMessage);

  if (text && media) {
    return { body: `${text}\n${media.placeholder}`, mediaType: media.mediaType };
  }
  if (text) {
    return { body: text };
  }
  if (media) {
    return { body: media.placeholder, mediaType: media.mediaType };
  }
  return { body: '' };
}

/**
 * Extract downloadable media metadata from a message.
 * This is used when the caller needs to persist incoming media to disk.
 */
export function extractDownloadableMedia(msg: WAMessage): ExtractedMediaContent | undefined {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  if (!message) return undefined;

  const extracted = extractMessageContent(message);
  const candidates = [message, extracted && extracted !== message ? extracted : undefined];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const contentType = getContentType(candidate);
    if (!contentType) continue;

    if (candidate.imageMessage) {
      return {
        mediaType: 'image',
        mimeType: candidate.imageMessage.mimetype ?? undefined,
      };
    }

    if (candidate.videoMessage) {
      return {
        mediaType: 'video',
        mimeType: candidate.videoMessage.mimetype ?? undefined,
      };
    }

    if (candidate.audioMessage) {
      return {
        mediaType: 'audio',
        mimeType: candidate.audioMessage.mimetype ?? undefined,
        isVoiceMessage: Boolean(candidate.audioMessage.ptt),
      };
    }

    if (candidate.documentMessage) {
      return {
        mediaType: 'document',
        mimeType: candidate.documentMessage.mimetype ?? undefined,
        fileName: candidate.documentMessage.fileName ?? undefined,
      };
    }

    if (candidate.stickerMessage) {
      return {
        mediaType: 'sticker',
        mimeType: candidate.stickerMessage.mimetype ?? undefined,
      };
    }
  }

  return undefined;
}
