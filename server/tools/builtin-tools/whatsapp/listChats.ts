/**
 * whatsapp_list_chats tool - List recent WhatsApp chats.
 * Uses the in-memory cache populated by Baileys events.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { getConnectionState, getCachedChats } from './connection';

export const listChatsTool: BuiltinToolDefinition = {
  name: 'whatsapp_list_chats',
  description: 'List recent WhatsApp chats. Returns chat names, JIDs, group status, and last message preview.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of chats to return (default: 20)',
      },
    },
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

      const limit = (args.limit as number) || 20;
      const chats = getCachedChats().slice(0, limit);

      const result = chats.map(chat => ({
        id: chat.id,
        name: chat.name,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        lastMessageTime: chat.lastMessageTime
          ? new Date(chat.lastMessageTime).toISOString()
          : undefined,
        lastMessage: chat.lastMessage,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ count: result.length, chats: result }) }],
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
