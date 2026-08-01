/**
 * whatsapp_read_chat tool - Read messages from a WhatsApp chat.
 * Uses in-memory cache, falls back to fetching from WA servers.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { getSocket, getConnectionState, getCachedMessages } from './connection';
import { extractMessageBody } from './extract';

export const readChatTool: BuiltinToolDefinition = {
  name: 'whatsapp_read_chat',
  description: 'Read messages from a WhatsApp chat. Returns cached messages, or fetches from WhatsApp servers if needed.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: {
        type: 'string',
        description: 'The chat JID (e.g., "1234567890@s.whatsapp.net" or group JID)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of messages to return (default: 50)',
      },
    },
    required: ['chat_id'],
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args) => {
    try {
      if (getConnectionState() !== 'connected') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'WhatsApp not connected' }) }],
          isError: true,
        };
      }

      const chatId = args.chat_id as string;
      const limit = (args.limit as number) || 50;
      const isGroup = chatId.endsWith('@g.us');

      // Try cached messages first
      const cached = getCachedMessages(chatId);
      if (cached.length > 0) {
        const result = cached.slice(-limit).map(m => ({
          id: m.id,
          from: m.from,
          fromId: m.fromId,
          timestamp: m.timestamp,
          date: new Date(m.timestamp).toISOString(),
          body: m.body,
          isOutgoing: m.isOutgoing,
          isGroup: m.isGroup,
          replyToId: m.replyToId,
          replyToBody: m.replyToBody,
          replyToSender: m.replyToSender,
          mediaType: m.mediaType,
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              chatId,
              isGroup,
              count: result.length,
              messages: result,
              source: 'cache',
            }),
          }],
          isError: false,
        };
      }

      // Fallback: fetch from WA servers
      const sock = getSocket();
      if (!sock) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'WhatsApp socket not available' }) }],
          isError: true,
        };
      }

      const messages = await sock.fetchMessagesFromWA(chatId, limit);

      const result = messages.map((msg: any) => {
        const fromJid = msg.key?.participant || msg.key?.remoteJid || '';
        const isOutgoing = msg.key?.fromMe || false;
        const { body, mediaType } = extractMessageBody(msg);

        return {
          id: msg.key?.id || '',
          from: msg.pushName || fromJid.split('@')[0].split(':')[0] || 'Unknown',
          fromId: fromJid,
          timestamp: msg.messageTimestamp
            ? Number(msg.messageTimestamp) * 1000
            : 0,
          date: msg.messageTimestamp
            ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
            : '',
          body,
          isOutgoing,
          isGroup,
          mediaType,
        };
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            chatId,
            isGroup,
            count: result.length,
            messages: result,
            source: 'server',
          }),
        }],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
        isError: true,
      };
    }
  },
};
