import { nanoid } from 'nanoid';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import {
  downloadMediaMessage,
  type WAMessage,
} from '@whiskeysockets/baileys';
import {
  connectionEvents,
  getPhoneNumber,
  getSocket,
  sendWhatsAppMessageWithRetry,
  broadcastEvent,
  notifyAgent,
} from './whatsappBridgeDependencies';
import {
  extractDownloadableMedia,
  type ExtractedMediaContent,
} from '../tools/builtin-tools/whatsapp/extract';
import { jidToPhone } from '../tools/builtin-tools/whatsapp/normalize';
import type { CachedMessage } from '../tools/builtin-tools/whatsapp/types';

interface PendingBridgeSession {
  requestId: string;
  chatId: string;
  pendingMessages: string[];
  createdAt: number;
}

interface ActiveBridgeSession {
  requestId: string;
  chatId: string;
  agentId: string;
  conversationId: string | null;
  pendingMessages: string[];
  createdAt: number;
  lastActivityAt: number;
}

type BridgeSession = PendingBridgeSession | ActiveBridgeSession;
type InboundMessagePayload = {
  textPart?: string;
  attachmentMentions: string[];
};
type InboundBatch = {
  chatId: string;
  textParts: string[];
  attachmentMentions: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
};

const OUTBOUND_IGNORE_TTL_MS = 60_000;
const OUTBOUND_SIGNATURE_TTL_MS = 10_000;
const INBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const INBOUND_MEDIA_MAX_ATTEMPTS = 3;
const INBOUND_MEDIA_TIMEOUT_MS = 25_000;
const INBOUND_MEDIA_RETRY_DELAY_MS = 500;
const INBOUND_BATCH_WINDOW_MS = 1_200;
const EMPTY_MESSAGE = '[media]';
const WHATSAPP_ATTACHMENTS_DIR = join(tmpdir(), 'interpreter-whatsapp-media');

const DEFAULT_MEDIA_EXTENSION: Record<ExtractedMediaContent['mediaType'], string> = {
  image: '.jpg',
  video: '.mp4',
  audio: '.ogg',
  document: '.bin',
  sticker: '.webp',
};

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
};

let activeSession: BridgeSession | null = null;
let listenersInitialized = false;
let inboundProcessingQueue: Promise<void> = Promise.resolve();
let pendingInboundBatch: InboundBatch | null = null;

const ignoredOutboundMessageIds = new Map<string, number>();
const ignoredOutboundSignatures = new Map<string, number>();

function normalizeDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

function isSelfChat(chatId: string): boolean {
  const phone = normalizeDigits(getPhoneNumber());
  const chatPhone = normalizeDigits(jidToPhone(chatId));
  if (!phone || !chatPhone) return false;
  return phone === chatPhone;
}

function isMessageTextUsable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed !== EMPTY_MESSAGE;
}

function canonicalizeChatId(chatId: string): string {
  const normalizedChatId = chatId.trim();
  const phone = jidToPhone(normalizedChatId);
  if (!phone) return normalizedChatId;
  return `${phone}@s.whatsapp.net`;
}

function getSignature(chatId: string, text: string): string {
  return `${canonicalizeChatId(chatId)}:${text.trim()}`;
}

function cleanupOutboundIgnoreMaps(now = Date.now()): void {
  for (const [messageId, expiresAt] of ignoredOutboundMessageIds) {
    if (expiresAt <= now) ignoredOutboundMessageIds.delete(messageId);
  }
  for (const [signature, expiresAt] of ignoredOutboundSignatures) {
    if (expiresAt <= now) ignoredOutboundSignatures.delete(signature);
  }
}

function markOutboundEchoToIgnore(chatId: string, messageId: string | undefined, text: string): void {
  const now = Date.now();
  cleanupOutboundIgnoreMaps(now);

  if (messageId) {
    ignoredOutboundMessageIds.set(messageId, now + OUTBOUND_IGNORE_TTL_MS);
  }

  if (isMessageTextUsable(text)) {
    ignoredOutboundSignatures.set(
      getSignature(chatId, text),
      now + OUTBOUND_SIGNATURE_TTL_MS
    );
  }
}

function isIgnoredOutboundEcho(message: CachedMessage): boolean {
  cleanupOutboundIgnoreMaps();

  if (ignoredOutboundMessageIds.has(message.id)) {
    return true;
  }

  if (!isMessageTextUsable(message.body)) {
    return false;
  }

  const signature = getSignature(message.chatId, message.body);
  return ignoredOutboundSignatures.has(signature);
}

function hasActiveAgentSession(session: BridgeSession | null): session is ActiveBridgeSession {
  return Boolean(session && 'agentId' in session);
}

function enqueueIncomingMessage(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (!activeSession) return;
  activeSession.pendingMessages.push(trimmed);
  if (hasActiveAgentSession(activeSession)) {
    flushPendingMessages();
  }
}

function flushPendingMessages(): void {
  if (!hasActiveAgentSession(activeSession)) return;
  while (activeSession.pendingMessages.length > 0) {
    const text = activeSession.pendingMessages.shift();
    if (!text) continue;
    notifyAgent(activeSession.agentId, text, 'whatsapp');
    activeSession.lastActivityAt = Date.now();
  }
}

function createSessionFromInbound(chatId: string, initialMessage: string): void {
  const firstMessage = initialMessage.trim();
  if (!firstMessage) return;
  const requestId = `whatsapp-bridge-${nanoid()}`;
  const canonicalChatId = canonicalizeChatId(chatId);

  activeSession = {
    requestId,
    chatId: canonicalChatId,
    pendingMessages: [],
    createdAt: Date.now(),
  };

  broadcastEvent('agent-tab:create-requested', {
    requestId,
    initialMessage: firstMessage,
    timeout: 120000,
    activate: true,
    channel: 'whatsapp',
    channelLabel: 'WhatsApp',
    channelThreadId: chatId,
  });
}

function sanitizeFilenameSegment(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/[\[\]{}()]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
}

function sanitizeMentionLabel(label: string): string {
  const cleaned = label
    .replace(/[\[\]\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'attachment';
}

function formatTimestampForFile(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function normalizeExtension(extension: string): string {
  const cleaned = extension.trim().toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (!cleaned) return '';
  return cleaned.startsWith('.') ? cleaned : `.${cleaned}`;
}

function extensionFromMimeType(mimeType: string | undefined): string | null {
  if (!mimeType) return null;
  const normalizedMime = mimeType.split(';')[0].trim().toLowerCase();
  if (!normalizedMime) return null;

  const mapped = MIME_EXTENSION_MAP[normalizedMime];
  if (mapped) return mapped;

  const subtype = normalizedMime.split('/')[1];
  if (!subtype) return null;

  const normalizedSubtype = subtype.replace(/^x-/, '').split('+')[0];
  if (!normalizedSubtype) return null;

  const ext = normalizeExtension(normalizedSubtype);
  return ext || null;
}

function resolveAttachmentExtension(media: ExtractedMediaContent): string {
  const fromFilename = media.fileName ? normalizeExtension(extname(media.fileName)) : '';
  if (fromFilename) return fromFilename;

  const fromMimeType = extensionFromMimeType(media.mimeType);
  if (fromMimeType) return fromMimeType;

  return DEFAULT_MEDIA_EXTENSION[media.mediaType];
}

function buildAttachmentBaseName(media: ExtractedMediaContent, message: CachedMessage): string {
  if (media.fileName) {
    const stem = sanitizeFilenameSegment(basename(media.fileName, extname(media.fileName)));
    if (stem) return stem;
  }

  const category = media.mediaType === 'audio' && media.isVoiceMessage
    ? 'voice-message'
    : media.mediaType;
  const timestamp = formatTimestampForFile(message.timestamp);
  const idSuffix = sanitizeFilenameSegment(message.id).slice(-8);

  return idSuffix
    ? `whatsapp-${category}-${timestamp}-${idSuffix}`
    : `whatsapp-${category}-${timestamp}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function allocateUniqueAttachmentPath(
  directory: string,
  baseName: string,
  extension: string
): Promise<string> {
  let counter = 0;

  while (true) {
    const suffix = counter === 0 ? '' : `-${counter + 1}`;
    const candidatePath = join(directory, `${baseName}${suffix}${extension}`);
    if (!(await pathExists(candidatePath))) {
      return candidatePath;
    }
    counter++;
  }
}

function buildAttachmentMention(filePath: string): string {
  const label = sanitizeMentionLabel(basename(filePath));
  return `[${label}](${filePath})`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

function isRetriableInboundMediaError(err: unknown): boolean {
  const text = describeError(err).toLowerCase();
  return (
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('disconnect') ||
    text.includes('closed') ||
    text.includes('reset') ||
    text.includes('econnreset') ||
    text.includes('etimedout')
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function downloadInboundMediaWithRetry(params: {
  rawMessage: WAMessage;
  messageId: string;
}): Promise<Buffer | null> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= INBOUND_MEDIA_MAX_ATTEMPTS; attempt++) {
    try {
      const data = await withTimeout(
        downloadMediaMessage(params.rawMessage, 'buffer', {}),
        INBOUND_MEDIA_TIMEOUT_MS,
        'downloadMediaMessage'
      );
      if (!Buffer.isBuffer(data) || data.length === 0) {
        console.warn('[WhatsAppBridge] Media download returned no data:', params.messageId);
        return null;
      }
      if (data.length > INBOUND_MEDIA_MAX_BYTES) {
        console.warn(
          `[WhatsAppBridge] Media exceeds max size (${data.length} bytes > ${INBOUND_MEDIA_MAX_BYTES} bytes): ${params.messageId}`
        );
        return null;
      }
      return data;
    } catch (error) {
      lastErr = error;
      const shouldRetry =
        attempt < INBOUND_MEDIA_MAX_ATTEMPTS && isRetriableInboundMediaError(error);
      if (!shouldRetry) {
        break;
      }
      const delayMs = INBOUND_MEDIA_RETRY_DELAY_MS * attempt;
      console.warn(
        `[WhatsAppBridge] Retrying inbound media download in ${delayMs}ms (${attempt}/${INBOUND_MEDIA_MAX_ATTEMPTS - 1}): ${describeError(error)}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.error(
    `[WhatsAppBridge] Inbound media download failed after retries (${params.messageId}): ${describeError(lastErr)}`
  );
  return null;
}

async function saveIncomingMediaAttachment(
  message: CachedMessage,
  rawMessage: WAMessage
): Promise<string | null> {
  const media = extractDownloadableMedia(rawMessage);
  if (!media) return null;

  const sock = getSocket();
  if (!sock) {
    console.warn('[WhatsAppBridge] Cannot save media attachment: WhatsApp socket unavailable');
    return null;
  }

  try {
    const data = await downloadInboundMediaWithRetry({
      rawMessage,
      messageId: message.id,
    });
    if (!data) {
      return null;
    }

    const attachmentsDir = WHATSAPP_ATTACHMENTS_DIR;
    await mkdir(attachmentsDir, { recursive: true });

    const extension = resolveAttachmentExtension(media);
    const baseName = buildAttachmentBaseName(media, message);
    const safeBaseName = sanitizeFilenameSegment(baseName) || 'whatsapp-attachment';
    const targetPath = await allocateUniqueAttachmentPath(attachmentsDir, safeBaseName, extension);

    await writeFile(targetPath, data);
    return targetPath;
  } catch (error) {
    console.error('[WhatsAppBridge] Failed to download/save media attachment:', error);
    return null;
  }
}

function isAttachmentPlaceholderLine(line: string): boolean {
  return /^\[(?:image|video|voice message|sticker|document|file:\s*.+)\]$/i.test(line.trim());
}

function stripAttachmentPlaceholderLines(text: string): string {
  const filtered = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isAttachmentPlaceholderLine(line));
  return filtered.join('\n').trim();
}

function dispatchInboundText(chatId: string, inboundText: string): void {
  const canonicalChatId = canonicalizeChatId(chatId);

  if (!activeSession) {
    createSessionFromInbound(canonicalChatId, inboundText);
    return;
  }

  if (activeSession.chatId !== canonicalChatId) {
    // MVP supports one active self-chat bridge only.
    return;
  }

  enqueueIncomingMessage(inboundText);
}

function buildInboundBatchText(batch: InboundBatch): string {
  const textParts = batch.textParts.filter((part) => part.trim().length > 0);
  const attachmentMentions = batch.attachmentMentions.filter((mention) => mention.trim().length > 0);

  const sections: string[] = [];
  if (textParts.length > 0) {
    sections.push(textParts.join('\n'));
  }
  if (attachmentMentions.length > 0) {
    if (sections.length > 0) {
      sections.push('');
    }
    sections.push(...attachmentMentions);
  }
  return sections.join('\n').trim();
}

function flushPendingInboundBatch(): void {
  if (!pendingInboundBatch) return;
  const batch = pendingInboundBatch;
  clearPendingInboundBatch();
  const combined = buildInboundBatchText(batch);
  if (!combined) return;
  dispatchInboundText(batch.chatId, combined);
}

function clearPendingInboundBatch(): void {
  if (!pendingInboundBatch) return;
  if (pendingInboundBatch.flushTimer) {
    clearTimeout(pendingInboundBatch.flushTimer);
    pendingInboundBatch.flushTimer = null;
  }
  pendingInboundBatch = null;
}

function queueInboundPayload(chatId: string, payload: InboundMessagePayload): void {
  if (!payload.textPart && payload.attachmentMentions.length === 0) {
    return;
  }
  const canonicalChatId = canonicalizeChatId(chatId);

  if (pendingInboundBatch && pendingInboundBatch.chatId !== canonicalChatId) {
    flushPendingInboundBatch();
  }

  if (!pendingInboundBatch) {
    pendingInboundBatch = {
      chatId: canonicalChatId,
      textParts: [],
      attachmentMentions: [],
      flushTimer: null,
    };
  }

  if (payload.textPart?.trim()) {
    pendingInboundBatch.textParts.push(payload.textPart.trim());
  }
  for (const mention of payload.attachmentMentions) {
    if (mention.trim()) {
      pendingInboundBatch.attachmentMentions.push(mention.trim());
    }
  }

  if (pendingInboundBatch.flushTimer) {
    clearTimeout(pendingInboundBatch.flushTimer);
  }
  pendingInboundBatch.flushTimer = setTimeout(() => {
    flushPendingInboundBatch();
  }, INBOUND_BATCH_WINDOW_MS);
}

async function buildInboundAgentMessagePayload(
  message: CachedMessage,
  rawMessage?: WAMessage
): Promise<InboundMessagePayload | null> {
  const trimmedBody = message.body.trim();
  const attachmentMentions: string[] = [];
  let textPart = isMessageTextUsable(trimmedBody) ? trimmedBody : '';

  if (rawMessage) {
    const savedAttachmentPath = await saveIncomingMediaAttachment(message, rawMessage);
    if (savedAttachmentPath) {
      attachmentMentions.push(buildAttachmentMention(savedAttachmentPath));
    }
  }

  // When we have downloaded attachment(s), remove noisy [Image]/[Video] placeholder lines
  // so the final payload reads like a normal user message + mentions.
  if (attachmentMentions.length > 0 && textPart) {
    textPart = stripAttachmentPlaceholderLines(textPart);
  }

  if (!textPart && attachmentMentions.length === 0 && trimmedBody.length > 0) {
    textPart = trimmedBody;
  }

  if (!textPart && attachmentMentions.length === 0) {
    return null;
  }
  return {
    textPart: textPart || undefined,
    attachmentMentions,
  };
}

async function handleInboundMessage(message: CachedMessage, rawMessage?: WAMessage): Promise<void> {
  if (!isSelfChat(message.chatId)) return;
  if (isIgnoredOutboundEcho(message)) return;

  const inboundPayload = await buildInboundAgentMessagePayload(message, rawMessage);
  if (!inboundPayload) return;
  queueInboundPayload(message.chatId, inboundPayload);
}

function queueInboundMessageProcessing(message: CachedMessage, rawMessage?: WAMessage): void {
  inboundProcessingQueue = inboundProcessingQueue
    .then(() => handleInboundMessage(message, rawMessage))
    .catch((error) => {
      console.error('[WhatsAppBridge] Failed to process inbound message:', error);
    });
}

export function initializeWhatsAppBridge(): void {
  if (listenersInitialized) return;
  listenersInitialized = true;

  connectionEvents.on('message', (message: CachedMessage, rawMessage?: WAMessage) => {
    queueInboundMessageProcessing(message, rawMessage);
  });
  connectionEvents.on('logged_out', () => {
    activeSession = null;
    clearPendingInboundBatch();
  });
}

export function onWhatsAppBridgeTabCreated(requestId: string, agentId: string): void {
  if (!activeSession) return;
  if (activeSession.requestId !== requestId) return;
  if (hasActiveAgentSession(activeSession)) return;

  activeSession = {
    ...activeSession,
    agentId,
    conversationId: null,
    lastActivityAt: Date.now(),
  };

  flushPendingMessages();
}

export function bindWhatsAppBridgeConversation(agentId: string, conversationId: string): void {
  if (!hasActiveAgentSession(activeSession)) return;
  if (activeSession.agentId !== agentId) return;
  if (activeSession.conversationId === conversationId) return;

  activeSession.conversationId = conversationId;
  activeSession.lastActivityAt = Date.now();
}

export async function forwardWhatsAppAssistantMessage(
  conversationId: string,
  assistantResponseText: string
): Promise<boolean> {
  const session = activeSession;
  if (!hasActiveAgentSession(session)) return false;
  if (session.conversationId !== conversationId) return false;

  const text = assistantResponseText.trim();
  if (!text) return false;

  const sock = getSocket();
  if (!sock) {
    console.warn('[WhatsAppBridge] Cannot forward assistant message: WhatsApp socket unavailable');
    return false;
  }

  try {
    const result = await sendWhatsAppMessageWithRetry({
      sock,
      chatId: session.chatId,
      text,
      options: {
        onBeforeSend: (part) => {
          if (part.textForEcho) {
            markOutboundEchoToIgnore(session.chatId, undefined, part.textForEcho);
          }
        },
        onSent: (part) => {
          markOutboundEchoToIgnore(
            session.chatId,
            part.messageId ?? undefined,
            part.textForEcho ?? ''
          );
        },
      },
    });
    if (result.parts.length === 0) {
      return false;
    }
    session.lastActivityAt = Date.now();
    return true;
  } catch (error) {
    console.error('[WhatsAppBridge] Failed to send assistant reply:', error);
    return false;
  }
}

export function closeWhatsAppBridgeSession(criteria?: {
  agentId?: string;
  conversationId?: string;
}): boolean {
  if (!activeSession) return false;

  if (criteria?.agentId && (!hasActiveAgentSession(activeSession) || activeSession.agentId !== criteria.agentId)) {
    return false;
  }

  if (criteria?.conversationId) {
    if (!hasActiveAgentSession(activeSession)) return false;
    if (activeSession.conversationId !== criteria.conversationId) return false;
  }

  activeSession = null;
  return true;
}
