/**
 * WhatsApp connection manager.
 *
 * Patterns borrowed from Open Claw (session.ts / monitor.ts):
 * - Socket creation, credential save queue, backup-before-save
 * - Message deduplication, group metadata caching
 * - Text extraction via Baileys internals (extract.ts)
 * - Reconnection with exponential backoff, Boom error formatting
 *
 * Our own code (not from Open Claw):
 * - Chat list cache (chatStore) populated via `messaging-history.set`
 * - Message cache (messageStore) for reading threads
 * - History sync handler — Baileys v7 delivers the initial chat list
 *   through `messaging-history.set`, NOT `chats.upsert`.
 *
 * This module is self-contained. External consumers (inbox route, agent tools,
 * future monitors) interact only through exported accessor functions and
 * the connectionEvents EventEmitter.
 */

import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  isJidGroup,
  type WASocket,
  type WAMessage,
  type ConnectionState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import {
  AUTH_DIR,
  saveCredentials,
  deleteCredentials,
  enqueueSaveCreds,
  maybeRestoreCredsFromBackup,
} from './credentials';
import { extractMessageBody, describeReplyContext } from './extract';
import { isIgnoredJid } from './normalize';
import type { CachedChat, CachedMessage, CloseReason } from './types';

// ============================================================================
// Singleton state
// ============================================================================

type WhatsAppSocket = WASocket & {
  fetchMessagesFromWA: (chatId: string, limit: number) => Promise<WAMessage[]>;
};

let socket: WhatsAppSocket | null = null;
let connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
let currentPhoneNumber: string | undefined;
let connectedAtMs: number | undefined;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// In-memory stores populated by Baileys events
const chatStore = new Map<string, CachedChat>();
const messageStore: CachedMessage[] = [];
const MAX_STORED_MESSAGES = 5000;

// Message deduplication (pattern from Open Claw)
const recentMessageIds = new Set<string>();
const DEDUPE_MAX_SIZE = 2000;
const DEDUPE_TTL_MS = 60_000; // 1 minute
const STALE_UPSERT_GRACE_MS = 2 * 60 * 1000;

// Group metadata cache with TTL (pattern from Open Claw)
const groupMetaCache = new Map<string, {
  subject?: string;
  participants?: string[];
  expires: number;
}>();
const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
const HISTORY_SYNC_TIMEOUT_MS = 15_000;
const HISTORY_SYNC_BATCH_LIMIT = 50;

// ============================================================================
// Event emitter - the primary hook point for external consumers
// ============================================================================

export const connectionEvents = new EventEmitter();
connectionEvents.setMaxListeners(20);

// ============================================================================
// Accessors - simple functions consumed by inbox and agent tools
// ============================================================================

export function getSocket(): WhatsAppSocket | null {
  return socket;
}

export function getConnectionState() {
  return connectionState;
}

export function getPhoneNumber() {
  return currentPhoneNumber;
}

export function getCachedChats(): CachedChat[] {
  return Array.from(chatStore.values())
    .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
}

export function getCachedMessages(chatId?: string): CachedMessage[] {
  if (chatId) {
    return messageStore.filter(m => m.chatId === chatId);
  }
  return [...messageStore];
}

// ============================================================================
// On-demand history fetch (Baileys fetchMessageHistory)
// ============================================================================

function getHistoryAnchor(chatId: string): { key: { remoteJid: string; id: string; fromMe: boolean }; timestampSec: number } {
  const chat = chatStore.get(chatId);
  if (!chat || !chat.lastMessageId || typeof chat.lastMessageFromMe !== 'boolean') {
    throw new Error(`No history anchor for chat ${chatId}`);
  }

  const timestampSec = Math.floor(chat.lastMessageTime / 1000);
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
    throw new Error(`Invalid history anchor timestamp for chat ${chatId}`);
  }

  return {
    key: {
      remoteJid: chatId,
      id: chat.lastMessageId,
      fromMe: chat.lastMessageFromMe,
    },
    timestampSec,
  };
}

function waitForHistorySync(sock: WASocket, requestId: string, chatId: string): Promise<WAMessage[]> {
  return new Promise((resolve, reject) => {
    const onTimeout = () => {
      cleanup();
      reject(new Error(`Timed out waiting for history sync for ${chatId}`));
    };

    const timeout = setTimeout(onTimeout, HISTORY_SYNC_TIMEOUT_MS);

    const handler = (payload: {
      peerDataRequestSessionId?: string | null;
      messages?: WAMessage[];
    }) => {
      if (!payload || payload.peerDataRequestSessionId !== requestId) return;
      const messages = (payload.messages || []).filter(msg => msg.key?.remoteJid === chatId);
      cleanup();
      resolve(messages);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      sock.ev.off('messaging-history.set', handler);
    };

    sock.ev.on('messaging-history.set', handler);
  });
}

async function fetchMessagesFromWA(sock: WASocket, chatId: string, limit: number): Promise<WAMessage[]> {
  const total = Math.max(0, Math.floor(limit));
  if (total === 0) return [];

  let anchor = getHistoryAnchor(chatId);
  const results: WAMessage[] = [];
  const seenIds = new Set<string>();
  let remaining = total;

  while (remaining > 0) {
    const batchCount = Math.min(HISTORY_SYNC_BATCH_LIMIT, remaining);
    const requestId = await sock.fetchMessageHistory(batchCount, anchor.key, anchor.timestampSec);
    const batch = await waitForHistorySync(sock, requestId, chatId);
    if (batch.length === 0) break;

    const before = results.length;
    for (const msg of batch) {
      const id = msg.key?.id;
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      results.push(msg);
    }
    const added = results.length - before;
    remaining -= added;
    if (added === 0) break;

    const oldest = batch.reduce<null | WAMessage>((current, msg) => {
      if (!msg.key?.id || msg.messageTimestamp == null) return current;
      const ts = Number(msg.messageTimestamp);
      if (!Number.isFinite(ts) || ts <= 0) return current;
      if (!current) return msg;
      const currentTs = Number(current.messageTimestamp);
      return ts < currentTs ? msg : current;
    }, null);

    if (!oldest?.key?.id || oldest.messageTimestamp == null) break;
    const nextTimestamp = Number(oldest.messageTimestamp);
    if (!Number.isFinite(nextTimestamp) || nextTimestamp <= 0) break;
    if (nextTimestamp >= anchor.timestampSec && oldest.key.id === anchor.key.id) break;

    anchor = {
      key: {
        remoteJid: chatId,
        id: oldest.key.id,
        fromMe: Boolean(oldest.key.fromMe),
      },
      timestampSec: nextTimestamp,
    };
  }

  return results.sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
}

// ============================================================================
// Message deduplication
// ============================================================================

function isRecentMessage(dedupeKey: string): boolean {
  if (recentMessageIds.has(dedupeKey)) return true;
  recentMessageIds.add(dedupeKey);
  // Evict oldest entries when set gets too large
  if (recentMessageIds.size > DEDUPE_MAX_SIZE) {
    const iterator = recentMessageIds.values();
    const oldest = iterator.next().value;
    if (oldest) recentMessageIds.delete(oldest);
  }
  // Auto-expire after TTL
  setTimeout(() => recentMessageIds.delete(dedupeKey), DEDUPE_TTL_MS);
  return false;
}

function resolveDeliveryStatus(statusCode: number | undefined): CachedMessage['deliveryStatus'] {
  if (statusCode == null || !Number.isFinite(statusCode)) {
    return undefined;
  }
  if (statusCode <= 0) return 'error';
  if (statusCode === 1) return 'pending';
  if (statusCode === 2) return 'server_ack';
  if (statusCode === 3) return 'delivered';
  if (statusCode === 4) return 'read';
  if (statusCode === 5) return 'played';
  return 'unknown';
}

function isStaleUpsertMessage(params: {
  upsertType?: string;
  timestampMs: number;
  connectedAt?: number;
}): boolean {
  if (!params.connectedAt) return false;
  if (params.upsertType === 'notify') return false;
  if (!Number.isFinite(params.timestampMs) || params.timestampMs <= 0) return false;
  return params.timestampMs < params.connectedAt - STALE_UPSERT_GRACE_MS;
}

function applyMessageDeliveryStatus(params: {
  remoteJid: string;
  messageId: string;
  statusCode: number;
}) {
  const status = resolveDeliveryStatus(params.statusCode);
  const timestamp = Date.now();
  for (let index = messageStore.length - 1; index >= 0; index--) {
    const message = messageStore[index];
    if (message.id !== params.messageId) continue;
    if (message.chatId !== params.remoteJid) continue;
    message.deliveryStatus = status;
    message.deliveryStatusCode = params.statusCode;
    message.deliveryUpdatedAt = timestamp;
    break;
  }
  connectionEvents.emit('message_status', {
    chatId: params.remoteJid,
    messageId: params.messageId,
    status,
    statusCode: params.statusCode,
    timestamp,
  });
}

// ============================================================================
// Group metadata cache (ported from Open Claw monitor.ts)
// ============================================================================

async function getGroupMeta(sock: WASocket, jid: string): Promise<{
  subject?: string;
  participants?: string[];
}> {
  const cached = groupMetaCache.get(jid);
  if (cached && cached.expires > Date.now()) {
    return cached;
  }
  try {
    const meta = await sock.groupMetadata(jid);
    const participants = meta.participants?.map(p => p.id) ?? [];
    const entry = {
      subject: meta.subject,
      participants,
      expires: Date.now() + GROUP_META_TTL_MS,
    };
    groupMetaCache.set(jid, entry);
    return entry;
  } catch {
    // Cache a stub to avoid hammering the API for invalid groups
    const stub = { expires: Date.now() + GROUP_META_TTL_MS };
    groupMetaCache.set(jid, stub);
    return {};
  }
}

// ============================================================================
// Error formatting
// ============================================================================

function getStatusCode(err: unknown): number | undefined {
  return (
    (err as { output?: { statusCode?: number } })?.output?.statusCode ??
    (err as { status?: number })?.status
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return String(err);

  // Extract from Boom-like errors (common with Baileys)
  const output = (err as any)?.output;
  const payload = output?.payload;
  const status = output?.statusCode ?? payload?.statusCode;
  const message = payload?.message ?? (err as any)?.message ?? (err as any)?.error?.message;

  const pieces: string[] = [];
  if (typeof status === 'number') pieces.push(`status=${status}`);
  if (payload?.error) pieces.push(payload.error);
  if (message) pieces.push(message);

  return pieces.length > 0 ? pieces.join(' ') : String(err);
}

// ============================================================================
// Reconnection with exponential backoff
// ============================================================================

const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 2_000;

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS,
  );
  reconnectAttempts++;
  console.log(`[WhatsApp] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initializeSocket().catch(err =>
      console.error('[WhatsApp] Reconnection failed:', formatError(err))
    );
  }, delay);
}

function cancelReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ============================================================================
// Socket initialization
// ============================================================================

export async function initializeSocket(): Promise<void> {
  if (socket) return;

  connectionState = 'connecting';
  connectionEvents.emit('connecting');

  await mkdir(AUTH_DIR, { recursive: true });

  // Restore corrupted creds from backup (Open Claw pattern)
  maybeRestoreCredsFromBackup();

  const logger = pino({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ['Interpreter', 'Desktop', '1.0.0'],
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => true,
    markOnlineOnConnect: false,
  }) as WhatsAppSocket;

  sock.fetchMessagesFromWA = (chatId, limit) => fetchMessagesFromWA(sock, chatId, limit);
  socket = sock;

  // ---------- Credential persistence (with serialized save queue) ----------
  sock.ev.on('creds.update', () => enqueueSaveCreds(saveCreds));

  // ---------- Connection lifecycle ----------
  sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
    try {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionEvents.emit('qr', qr);
      }

      if (connection === 'open') {
        connectionState = 'connected';
        connectedAtMs = Date.now();
        reconnectAttempts = 0; // Reset backoff on successful connection
        const me = sock.user;
        if (me?.id) {
          currentPhoneNumber = me.id.split('@')[0].split(':')[0];
        }
        saveCredentials({
          phoneNumber: currentPhoneNumber,
          connectedAt: new Date().toISOString(),
        }).catch(err => console.error('[WhatsApp] Failed to save credentials:', err));
        connectionEvents.emit('connected', { phoneNumber: currentPhoneNumber });
        console.log('[WhatsApp] Connected:', currentPhoneNumber);
      }

      if (connection === 'close') {
        const statusCode = getStatusCode(lastDisconnect?.error);
        const reason: CloseReason = {
          status: statusCode,
          isLoggedOut: statusCode === DisconnectReason.loggedOut,
          error: lastDisconnect?.error,
        };

        connectionState = 'disconnected';
        socket = null;

        if (reason.isLoggedOut) {
          console.log('[WhatsApp] Logged out - clearing credentials');
          chatStore.clear();
          messageStore.length = 0;
          groupMetaCache.clear();
          recentMessageIds.clear();
          deleteCredentials().catch(() => {});
          connectionEvents.emit('logged_out');
          connectionEvents.emit('disconnected', reason);
        } else {
          console.log('[WhatsApp] Disconnected:', formatError(lastDisconnect?.error));
          connectionEvents.emit('disconnected', reason);
          scheduleReconnect();
        }
      }
    } catch (err) {
      console.error('[WhatsApp] connection.update handler error:', formatError(err));
    }
  });

  // ---------- History sync (primary source of initial chats in Baileys v7) ----------
  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress }: any) => {
    console.log(`[WhatsApp] History sync: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages (isLatest=${isLatest}, progress=${progress})`);

    // Process chats from history
    if (chats?.length) {
      for (const chat of chats) {
        const jid = chat.id;
        if (!jid || isIgnoredJid(jid)) continue;

        const existing = chatStore.get(jid);
        const ts = chat.conversationTimestamp
          ? Number(chat.conversationTimestamp) * 1000
          : (existing?.lastMessageTime || 0);

        const updated: CachedChat = {
          id: jid,
          name: chat.name || chat.subject || existing?.name || jid.split('@')[0],
          isGroup: Boolean(isJidGroup(jid)),
          lastMessageTime: ts,
          lastMessage: existing?.lastMessage || '',
          unreadCount: chat.unreadCount ?? existing?.unreadCount ?? 0,
          lastMessageId: existing?.lastMessageId,
          lastMessageFromMe: existing?.lastMessageFromMe,
        };
        chatStore.set(jid, updated);
      }
      console.log(`[WhatsApp] Chat store now has ${chatStore.size} chats`);
    }

    // Process contacts from history (update chat names)
    if (contacts?.length) {
      for (const contact of contacts) {
        const jid = contact.id;
        if (!jid) continue;
        const name = contact.notify || contact.name || contact.verifiedName;
        if (name) {
          const existing = chatStore.get(jid);
          if (existing) {
            existing.name = name;
          }
        }
      }
    }

    // Process messages from history (populate message store)
    if (messages?.length) {
      for (const msg of messages) {
        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid || isIgnoredJid(remoteJid)) continue;

        const id = msg.key?.id;
        const isGroup = Boolean(isJidGroup(remoteJid));
        const isOutgoing = msg.key?.fromMe || false;

        const { body: text, mediaType } = extractMessageBody(msg);
        const timestamp = msg.messageTimestamp
          ? Number(msg.messageTimestamp) * 1000
          : Date.now();

        let fromName = 'Unknown';
        let fromId = '';
        if (isOutgoing) {
          fromName = 'You';
          fromId = sock.user?.id || '';
        } else if (isGroup && msg.key?.participant) {
          fromId = msg.key.participant;
          fromName = msg.pushName || fromId.split('@')[0].split(':')[0];
        } else {
          fromId = remoteJid;
          fromName = msg.pushName || remoteJid.split('@')[0].split(':')[0];
        }

        const cachedMsg: CachedMessage = {
          id: id || `${Date.now()}`,
          chatId: remoteJid,
          from: fromName,
          fromId,
          timestamp,
          body: text || '[media]',
          isOutgoing,
          isGroup,
          mediaType,
        };
        messageStore.push(cachedMsg);

        // Update chat's last message if this is newer
        const chat = chatStore.get(remoteJid);
        if (chat && timestamp >= chat.lastMessageTime) {
          chat.lastMessageTime = timestamp;
          chat.lastMessage = text ? text.slice(0, 200) : '[media]';
          if (id) {
            chat.lastMessageId = id;
            chat.lastMessageFromMe = isOutgoing;
          }
        }
      }
      // Trim message store
      while (messageStore.length > MAX_STORED_MESSAGES) {
        messageStore.shift();
      }
      console.log(`[WhatsApp] Message store now has ${messageStore.length} messages`);
    }
  });

  // ---------- Chat sync events (secondary — only fires for new group creation in v7) ----------
  sock.ev.on('chats.upsert', (chats: any[]) => {
    console.log(`[WhatsApp] chats.upsert: ${chats.length} chats`);
    for (const chat of chats) {
      const jid = chat.id;
      if (!jid || isIgnoredJid(jid)) continue;

      const existing = chatStore.get(jid);
      const ts = chat.conversationTimestamp
        ? Number(chat.conversationTimestamp) * 1000
        : (existing?.lastMessageTime || Date.now());

      const updated: CachedChat = {
        id: jid,
        name: chat.name || chat.subject || existing?.name || jid.split('@')[0],
        isGroup: Boolean(isJidGroup(jid)),
        lastMessageTime: ts,
        lastMessage: existing?.lastMessage || '',
        unreadCount: chat.unreadCount || existing?.unreadCount || 0,
        lastMessageId: existing?.lastMessageId,
        lastMessageFromMe: existing?.lastMessageFromMe,
      };
      chatStore.set(jid, updated);
      connectionEvents.emit('chat_update', updated);
    }
    console.log(`[WhatsApp] Synced ${chats.length} chats (total: ${chatStore.size})`);
  });

  sock.ev.on('chats.update', (updates: any[]) => {
    console.log(`[WhatsApp] chats.update: ${updates.length} updates`);
    for (const update of updates) {
      const jid = update.id;
      if (!jid) continue;
      const existing = chatStore.get(jid);
      if (existing) {
        if (update.name || update.subject) {
          existing.name = update.name || update.subject || existing.name;
        }
        if (update.conversationTimestamp) {
          existing.lastMessageTime = Number(update.conversationTimestamp) * 1000;
        }
        if (typeof update.unreadCount === 'number') {
          existing.unreadCount = update.unreadCount;
        }
        connectionEvents.emit('chat_update', existing);
      }
    }
  });

  // ---------- Message events (with deduplication & robust extraction) ----------
  sock.ev.on('messages.upsert', async (upsert: { type?: string; messages?: WAMessage[] }) => {
    console.log(`[WhatsApp] messages.upsert: ${upsert.messages?.length ?? 0} messages (type=${upsert.type})`);
    for (const msg of upsert.messages ?? []) {
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid || isIgnoredJid(remoteJid)) continue;

      const id = msg.key?.id;
      const isGroup = Boolean(isJidGroup(remoteJid));
      const isOutgoing = msg.key?.fromMe || false;

      // Deduplication
      if (id) {
        const dedupeKey = `${remoteJid}:${id}`;
        if (isRecentMessage(dedupeKey)) continue;
      }

      // Text extraction
      const { body: text, mediaType } = extractMessageBody(msg);
      const timestamp = msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : Date.now();
      if (isStaleUpsertMessage({
        upsertType: upsert.type,
        timestampMs: timestamp,
        connectedAt: connectedAtMs,
      })) {
        continue;
      }
      const rawStatus = (msg as any)?.status;
      const statusCode = typeof rawStatus === 'number' ? rawStatus : undefined;
      const deliveryStatus = resolveDeliveryStatus(statusCode);

      // Determine sender
      let fromName = 'Unknown';
      let fromId = '';
      if (isOutgoing) {
        fromName = 'You';
        fromId = sock.user?.id || '';
      } else if (isGroup && msg.key?.participant) {
        fromId = msg.key.participant;
        fromName = msg.pushName || fromId.split('@')[0].split(':')[0];
      } else {
        fromId = remoteJid;
        fromName = msg.pushName || remoteJid.split('@')[0].split(':')[0];
      }

      // Group metadata (with TTL cache)
      let groupName: string | undefined;
      if (isGroup) {
        const cached = chatStore.get(remoteJid);
        if (cached?.name && cached.name !== remoteJid.split('@')[0]) {
          groupName = cached.name;
        } else {
          const meta = await getGroupMeta(sock, remoteJid);
          groupName = meta.subject || remoteJid.split('@')[0];
        }
      }

      // Reply context
      const replyContext = describeReplyContext(msg.message as any);

      // Store message
      const cachedMsg: CachedMessage = {
        id: id || `${Date.now()}`,
        chatId: remoteJid,
        from: fromName,
        fromId,
        timestamp,
        body: text || '[media]',
        isOutgoing,
        isGroup,
        groupName,
        replyToId: replyContext?.id,
        replyToBody: replyContext?.body,
        replyToSender: replyContext?.sender,
        mediaType,
        deliveryStatus,
        deliveryStatusCode: statusCode,
        deliveryUpdatedAt: deliveryStatus ? Date.now() : undefined,
      };
      messageStore.push(cachedMsg);
      while (messageStore.length > MAX_STORED_MESSAGES) {
        messageStore.shift();
      }

      // Update chat store
      const chatName = isGroup
        ? (groupName || remoteJid.split('@')[0])
        : (msg.pushName || remoteJid.split('@')[0].split(':')[0]);

      const existingChat = chatStore.get(remoteJid);
      const updatedChat: CachedChat = {
        id: remoteJid,
        name: existingChat?.name || chatName,
        isGroup,
        lastMessageTime: timestamp,
        lastMessage: text ? text.slice(0, 200) : '[media]',
        unreadCount: isOutgoing
          ? 0
          : (existingChat?.unreadCount || 0) + (upsert.type === 'notify' ? 1 : 0),
        lastMessageId: id || existingChat?.lastMessageId,
        lastMessageFromMe: id ? isOutgoing : existingChat?.lastMessageFromMe,
      };
      chatStore.set(remoteJid, updatedChat);

      // Emit events for monitoring hooks
      connectionEvents.emit('message', cachedMsg, msg);
      connectionEvents.emit('chat_update', updatedChat);
    }
  });

  sock.ev.on('messages.update', (updates: any[]) => {
    for (const update of updates ?? []) {
      const remoteJid = update?.key?.remoteJid;
      const messageId = update?.key?.id;
      if (!remoteJid || !messageId) continue;

      const rawStatus = update?.update?.status ?? update?.status;
      const statusCode =
        typeof rawStatus === 'number'
          ? rawStatus
          : typeof rawStatus === 'string'
            ? Number(rawStatus)
            : NaN;
      if (!Number.isFinite(statusCode)) continue;

      applyMessageDeliveryStatus({
        remoteJid,
        messageId,
        statusCode,
      });
    }
  });

  // ---------- Contact events ----------
  sock.ev.on('contacts.upsert', (contacts: any[]) => {
    console.log(`[WhatsApp] contacts.upsert: ${contacts.length} contacts`);
    for (const contact of contacts) {
      const jid = contact.id;
      if (!jid) continue;
      const name = contact.notify || contact.name || contact.verifiedName;
      if (name) {
        const existing = chatStore.get(jid);
        if (existing) {
          existing.name = name;
          connectionEvents.emit('chat_update', existing);
        }
      }
    }
  });

  // ---------- WebSocket error handling ----------
  if (sock.ws && typeof (sock.ws as any).on === 'function') {
    (sock.ws as any).on('error', (err: Error) => {
      console.error('[WhatsApp] WebSocket error:', err.message);
    });
  }
}

// ============================================================================
// Disconnect
// ============================================================================

export async function disconnectSocket(): Promise<void> {
  cancelReconnect();
  if (socket) {
    try {
      socket.end(undefined);
    } catch {
      // Ignore close errors
    }
    socket = null;
  }
  connectionState = 'disconnected';
  currentPhoneNumber = undefined;
  connectedAtMs = undefined;
  reconnectAttempts = 0;
  chatStore.clear();
  messageStore.length = 0;
  groupMetaCache.clear();
  recentMessageIds.clear();
  await deleteCredentials();
}
