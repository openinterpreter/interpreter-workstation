/**
 * telegram_read_chat tool - Read messages from a Telegram chat.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { isBotRunning, getStoredMessages } from './bot';

export const readChatTool: BuiltinToolDefinition = {
  name: 'telegram_read_chat',
  description: 'Read messages from a Telegram chat. Returns messages cached during the current bot session.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: {
        type: 'string',
        description: 'The Telegram chat ID (numeric)',
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
      if (!isBotRunning()) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Telegram bot not connected' }) }],
          isError: true,
        };
      }

      const chatId = Number(args.chat_id);
      const limit = (args.limit as number) || 50;

      if (isNaN(chatId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'chat_id must be a number' }) }],
          isError: true,
        };
      }

      const messages = getStoredMessages()
        .filter(m => m.chatId === chatId)
        .slice(-limit)
        .map(m => ({
          id: m.id,
          from: m.from,
          fromId: m.fromId,
          date: new Date(m.date * 1000).toISOString(),
          body: m.text,
          isOutgoing: m.isOutgoing,
        }));

      // Determine chat info from first message
      const firstMsg = getStoredMessages().find(m => m.chatId === chatId);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            chatId: String(chatId),
            chatTitle: firstMsg?.chatTitle || `Chat ${chatId}`,
            chatType: firstMsg?.chatType || 'unknown',
            count: messages.length,
            messages,
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
