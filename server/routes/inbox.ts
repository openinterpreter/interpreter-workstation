/**
 * Unified Inbox API.
 * Aggregates messages from Email (Nylas), WhatsApp, and Telegram
 * into a single chronological feed.
 */

import { Router } from 'express';
import type { ChannelStatus, UnifiedMessage, UnifiedThread } from '../../shared/types/messaging';

// Lazy imports for channel modules
import { isConfigured as isWhatsAppConfigured } from '../tools/builtin-tools/whatsapp/credentials';
import {
  getConnectionState as getWhatsAppState,
  getPhoneNumber,
  getSocket,
  getCachedChats,
  getCachedMessages as getWhatsAppMessages,
  initializeSocket as initWhatsApp,
} from '../tools/builtin-tools/whatsapp/connection';
import { extractMessageBody } from '../tools/builtin-tools/whatsapp/extract';
import { sendWhatsAppMessageWithRetry } from '../tools/builtin-tools/whatsapp/outbound';
import { isConfigured as isTelegramConfigured, loadCredentials as loadTelegramCredentials } from '../tools/builtin-tools/telegram/credentials';
import { isBotRunning, getBotUsername, getStoredMessages, sendMessage as telegramSendMessage, initializeBot as initTelegram } from '../tools/builtin-tools/telegram/bot';

const router = Router();

// Guards to prevent multiple simultaneous auto-reconnect attempts
let waReconnecting = false;
let tgReconnecting = false;

/**
 * GET /status - Returns ChannelStatus[] for all three channels.
 */
router.get('/status', async (_req, res) => {
  try {
    const statuses: ChannelStatus[] = [];

    // Email (Nylas) status
    try {
      const { getServerPort } = await import('../utils/serverPort');
      const port = getServerPort();
      const response = await fetch(`http://localhost:${port}/api/servers/nylas/setup/status`);
      const data = await response.json() as any;
      statuses.push({
        channel: 'email',
        configured: data.configured || false,
        label: data.email,
      });
    } catch {
      statuses.push({ channel: 'email', configured: false });
    }

    // WhatsApp status - auto-reconnect if configured but disconnected
    const waConfigured = isWhatsAppConfigured() || getWhatsAppState() === 'connected';
    if (waConfigured && getWhatsAppState() === 'disconnected' && !waReconnecting) {
      waReconnecting = true;
      initWhatsApp()
        .catch(err => console.error('[Inbox] WhatsApp auto-reconnect failed:', err))
        .finally(() => { waReconnecting = false; });
    }
    statuses.push({
      channel: 'whatsapp',
      configured: waConfigured,
      label: waConfigured ? getPhoneNumber() : undefined,
    });

    // Telegram status - auto-reconnect if configured but not running
    const tgConfigured = isTelegramConfigured() || isBotRunning();
    if (tgConfigured && !isBotRunning() && !tgReconnecting) {
      tgReconnecting = true;
      loadTelegramCredentials().then(creds => {
        if (creds?.botToken) {
          return initTelegram(creds.botToken);
        }
      })
        .catch(err => console.error('[Inbox] Telegram auto-reconnect failed:', err))
        .finally(() => { tgReconnecting = false; });
    }
    statuses.push({
      channel: 'telegram',
      configured: tgConfigured,
      label: tgConfigured ? getBotUsername() : undefined,
    });

    res.json({ channels: statuses });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /messages - Aggregates messages from all configured channels.
 * Query params: limit, cursor, search
 */
router.get('/messages', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const search = (req.query.search as string)?.toLowerCase();
    const channelFilter = req.query.channel as string | undefined;
    const allMessages: UnifiedMessage[] = [];

    // Fetch email messages (if configured)
    if (!channelFilter || channelFilter === 'email') {
      try {
        const { getToolManager } = await import('../tools/toolManagerAccessor');
        const tm = getToolManager();
        if (tm) {
          const result = await tm.callTool('builtin-nylas', 'nylas_list_messages', { limit });
          if (result?.content?.[0]?.text) {
            const parsed = JSON.parse(result.content[0].text);
            const emailMessages = parsed.messages || [];
            for (const msg of emailMessages) {
              allMessages.push({
                id: `email:${msg.id}`,
                channel: 'email',
                threadId: msg.thread_id || msg.id,
                from: msg.from || 'Unknown',
                fromId: msg.from || '',
                date: msg.date || '',
                snippet: msg.snippet || '',
                subject: msg.subject,
                unread: msg.unread || false,
              });
            }
          }
        }
      } catch {
        // Nylas not configured or failed
      }
    }

    // Fetch WhatsApp chats from in-memory cache
    if (!channelFilter || channelFilter === 'whatsapp') {
      if (getWhatsAppState() === 'connected') {
        const chats = getCachedChats();
        for (const chat of chats.slice(0, limit)) {
          allMessages.push({
            id: `whatsapp:${chat.id}`,
            channel: 'whatsapp',
            threadId: chat.id,
            from: chat.name,
            fromId: chat.id,
            date: chat.lastMessageTime ? new Date(chat.lastMessageTime).toISOString() : '',
            snippet: chat.lastMessage,
            unread: chat.unreadCount > 0,
            isGroup: chat.isGroup,
            groupName: chat.isGroup ? chat.name : undefined,
          });
        }
      }
    }

    // Fetch Telegram messages
    if (!channelFilter || channelFilter === 'telegram') {
      if (isBotRunning()) {
        const stored = getStoredMessages();
        // Group by chat and take latest message per chat
        const chatLatest = new Map<number, typeof stored[0]>();
        for (const msg of stored) {
          const existing = chatLatest.get(msg.chatId);
          if (!existing || msg.date > existing.date) {
            chatLatest.set(msg.chatId, msg);
          }
        }

        for (const msg of chatLatest.values()) {
          allMessages.push({
            id: `telegram:${msg.chatId}`,
            channel: 'telegram',
            threadId: String(msg.chatId),
            from: msg.chatTitle || msg.from || `Chat ${msg.chatId}`,
            fromId: String(msg.chatId),
            date: new Date(msg.date * 1000).toISOString(),
            snippet: msg.text.slice(0, 200),
            unread: false,
            isGroup: msg.chatType === 'group' || msg.chatType === 'supergroup',
            groupName: msg.chatType !== 'private' ? msg.chatTitle : undefined,
          });
        }
      }
    }

    // Apply search filter
    let filtered = allMessages;
    if (search) {
      filtered = allMessages.filter(m =>
        m.from.toLowerCase().includes(search) ||
        m.snippet.toLowerCase().includes(search) ||
        (m.subject && m.subject.toLowerCase().includes(search)) ||
        (m.groupName && m.groupName.toLowerCase().includes(search))
      );
    }

    // Sort by date descending
    filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Apply limit
    const messages = filtered.slice(0, limit);

    res.json({ count: messages.length, messages });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /thread/:channel/:threadId - Returns full message history for a thread.
 */
router.get('/thread/:channel/:threadId', async (req, res) => {
  try {
    const { channel, threadId } = req.params;

    if (channel === 'email') {
      // Fetch email thread via Nylas
      try {
        const { getToolManager } = await import('../tools/toolManagerAccessor');
        const tm = getToolManager();
        if (tm) {
          const result = await tm.callTool('builtin-nylas', 'nylas_read_message', { message_id: threadId });
          if (result?.content?.[0]?.text) {
            const email = JSON.parse(result.content[0].text);
            const thread: UnifiedThread = {
              id: threadId,
              channel: 'email',
              participants: [
                { id: email.from || '', name: email.from || 'Unknown' },
                ...(email.to || []).map((t: string) => ({ id: t, name: t })),
              ],
              messages: [{
                id: email.id,
                from: email.from || 'Unknown',
                fromId: email.from || '',
                date: email.date || '',
                body: email.body || email.snippet || '',
                isOutgoing: false,
                attachments: email.attachments?.map((a: any) => ({
                  id: a.id,
                  filename: a.filename,
                  mimeType: a.content_type,
                  size: a.size,
                })),
              }],
              subject: email.subject,
            };
            return res.json(thread);
          }
        }
      } catch {
        return res.status(500).json({ error: 'Failed to fetch email thread' });
      }
    }

    if (channel === 'whatsapp') {
      if (getWhatsAppState() !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp not connected' });
      }

      // Use cached messages first
      const cachedMessages = getWhatsAppMessages(threadId);

      // If we have cached messages, use them
      if (cachedMessages.length > 0) {
        const participantMap = new Map<string, string>();
        for (const m of cachedMessages) {
          if (!participantMap.has(m.fromId)) {
            participantMap.set(m.fromId, m.from);
          }
        }

        const thread: UnifiedThread = {
          id: threadId,
          channel: 'whatsapp',
          participants: Array.from(participantMap.entries()).map(([id, name]) => ({ id, name })),
          messages: cachedMessages.map(m => ({
            id: m.id,
            from: m.from,
            fromId: m.fromId,
            date: new Date(m.timestamp).toISOString(),
            body: m.body,
            isOutgoing: m.isOutgoing,
            deliveryStatus: m.deliveryStatus,
            deliveryStatusCode: m.deliveryStatusCode,
            deliveryUpdatedAt: m.deliveryUpdatedAt
              ? new Date(m.deliveryUpdatedAt).toISOString()
              : undefined,
          })),
        };
        return res.json(thread);
      }

      // Fallback: try fetching from WA servers if socket available
      const sock = getSocket();
      if (sock) {
        try {
          const messages = await sock.fetchMessagesFromWA(threadId, 100);
          const thread: UnifiedThread = {
            id: threadId,
            channel: 'whatsapp',
            participants: [],
            messages: messages.map((msg: any) => {
              const { body } = extractMessageBody(msg);
              return {
                id: msg.key?.id || '',
                from: msg.pushName || msg.key?.participant?.split('@')[0]?.split(':')[0] || 'Unknown',
                fromId: msg.key?.participant || msg.key?.remoteJid || '',
                date: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : '',
                body: body || '[media]',
                isOutgoing: msg.key?.fromMe || false,
              };
            }),
          };
          return res.json(thread);
        } catch (err: any) {
          return res.status(500).json({ error: `Failed to fetch messages: ${err.message}` });
        }
      }

      return res.json({ id: threadId, channel: 'whatsapp', participants: [], messages: [] });
    }

    if (channel === 'telegram') {
      if (!isBotRunning()) {
        return res.status(400).json({ error: 'Telegram bot not connected' });
      }

      const chatId = Number(threadId);
      const stored = getStoredMessages().filter(m => m.chatId === chatId);

      const thread: UnifiedThread = {
        id: threadId,
        channel: 'telegram',
        participants: [],
        messages: stored.map(m => ({
          id: String(m.id),
          from: m.from,
          fromId: String(m.fromId),
          date: new Date(m.date * 1000).toISOString(),
          body: m.text,
          isOutgoing: m.isOutgoing,
        })),
      };

      // Add participants from messages
      const participantMap = new Map<number, string>();
      for (const m of stored) {
        if (!participantMap.has(m.fromId)) {
          participantMap.set(m.fromId, m.from);
        }
      }
      thread.participants = Array.from(participantMap.entries()).map(([id, name]) => ({
        id: String(id),
        name,
      }));

      return res.json(thread);
    }

    res.status(400).json({ error: `Unknown channel: ${channel}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /send - Send a message to any channel.
 */
router.post('/send', async (req, res) => {
  try {
    const { channel, threadId, message } = req.body;

    if (!channel || !threadId || !message) {
      return res.status(400).json({ error: 'channel, threadId, and message are required' });
    }

    if (channel === 'whatsapp') {
      if (getWhatsAppState() !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp not connected' });
      }
      const sock = getSocket();
      if (!sock) {
        return res.status(500).json({ error: 'WhatsApp socket not available' });
      }
      const result = await sendWhatsAppMessageWithRetry({
        sock,
        chatId: threadId,
        text: message,
      });
      const messageIds = result.parts
        .map((part) => part.messageId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      return res.json({
        success: true,
        messageId: messageIds[0],
        messageIds,
        partsSent: result.parts.length,
      });
    }

    if (channel === 'telegram') {
      if (!isBotRunning()) {
        return res.status(400).json({ error: 'Telegram bot not connected' });
      }
      const result = await telegramSendMessage(threadId, message);
      return res.json({ success: true, messageId: result.messageId });
    }

    if (channel === 'email') {
      return res.status(400).json({ error: 'Use Nylas tools directly to send email' });
    }

    res.status(400).json({ error: `Unknown channel: ${channel}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
