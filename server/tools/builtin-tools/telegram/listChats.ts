/**
 * telegram_list_chats tool - List Telegram chats the bot has received messages from.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { isBotRunning, getStoredMessages } from './bot';

export const listChatsTool: BuiltinToolDefinition = {
  name: 'telegram_list_chats',
  description: 'List Telegram chats that the bot has received messages from. Shows chat names, IDs, types, and last message preview.',
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
      if (!isBotRunning()) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Telegram bot not connected' }) }],
          isError: true,
        };
      }

      const limit = (args.limit as number) || 20;
      const messages = getStoredMessages();

      // Aggregate chats from stored messages
      const chatMap = new Map<number, {
        id: number;
        name: string;
        type: string;
        lastMessage: string;
        lastMessageTime: string;
        messageCount: number;
      }>();

      for (const msg of messages) {
        const existing = chatMap.get(msg.chatId);
        if (!existing || msg.date > new Date(existing.lastMessageTime).getTime() / 1000) {
          chatMap.set(msg.chatId, {
            id: msg.chatId,
            name: msg.chatTitle || `Chat ${msg.chatId}`,
            type: msg.chatType,
            lastMessage: msg.text.slice(0, 100),
            lastMessageTime: new Date(msg.date * 1000).toISOString(),
            messageCount: (existing?.messageCount || 0) + 1,
          });
        } else if (existing) {
          existing.messageCount++;
        }
      }

      const chats = Array.from(chatMap.values())
        .sort((a, b) => new Date(b.lastMessageTime).getTime() - new Date(a.lastMessageTime).getTime())
        .slice(0, limit);

      return {
        content: [{ type: 'text', text: JSON.stringify({ count: chats.length, chats }) }],
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
