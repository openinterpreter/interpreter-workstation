/**
 * telegram_search_messages tool - Search cached Telegram messages.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { isBotRunning, getStoredMessages } from './bot';

export const searchMessagesTool: BuiltinToolDefinition = {
  name: 'telegram_search_messages',
  description: 'Search Telegram messages by text query. Searches cached messages received during the current bot session.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to match against message text',
      },
      chat_id: {
        type: 'string',
        description: 'Optional: limit search to a specific chat ID',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 20)',
      },
    },
    required: ['query'],
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

      const query = (args.query as string).toLowerCase();
      const chatId = args.chat_id ? Number(args.chat_id) : undefined;
      const limit = (args.limit as number) || 20;

      let results = getStoredMessages()
        .filter(m => m.text.toLowerCase().includes(query));

      if (chatId && !isNaN(chatId)) {
        results = results.filter(m => m.chatId === chatId);
      }

      const messages = results
        .slice(-limit)
        .map(m => ({
          id: m.id,
          chatId: m.chatId,
          chatTitle: m.chatTitle || `Chat ${m.chatId}`,
          from: m.from,
          fromId: m.fromId,
          date: new Date(m.date * 1000).toISOString(),
          body: m.text,
          isOutgoing: m.isOutgoing,
        }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query, count: messages.length, messages }),
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
