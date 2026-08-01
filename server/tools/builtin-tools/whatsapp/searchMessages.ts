/**
 * whatsapp_search_messages tool - Search WhatsApp messages.
 * Searches the in-memory message cache.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { getConnectionState, getCachedMessages } from './connection';

export const searchMessagesTool: BuiltinToolDefinition = {
  name: 'whatsapp_search_messages',
  description: 'Search WhatsApp messages by text query. Searches cached messages received since connection.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to match against message text',
      },
      chat_id: {
        type: 'string',
        description: 'Optional: limit search to a specific chat JID',
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
      if (getConnectionState() !== 'connected') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'WhatsApp not connected' }) }],
          isError: true,
        };
      }

      const query = (args.query as string).toLowerCase();
      const chatId = args.chat_id as string | undefined;
      const limit = (args.limit as number) || 20;

      let allMessages = getCachedMessages(chatId);

      const matches = allMessages
        .filter(m => m.body.toLowerCase().includes(query))
        .slice(-limit)
        .map(m => ({
          id: m.id,
          chatId: m.chatId,
          from: m.from,
          fromId: m.fromId,
          date: new Date(m.timestamp).toISOString(),
          body: m.body,
          isOutgoing: m.isOutgoing,
          isGroup: m.isGroup,
          groupName: m.groupName,
          replyToId: m.replyToId,
          replyToBody: m.replyToBody,
          mediaType: m.mediaType,
        }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query, count: matches.length, messages: matches }),
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
