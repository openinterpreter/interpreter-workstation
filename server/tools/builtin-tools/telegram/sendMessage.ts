/**
 * telegram_send_message tool - Send a message via Telegram bot.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { isBotRunning, sendMessage } from './bot';
import { rejectIfInternalContext } from '../../../utils/contentGuard.js';

export const sendMessageTool: BuiltinToolDefinition = {
  name: 'telegram_send_message',
  description: 'Send a text message via Telegram bot. The message will be sent from the connected bot account.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: {
        type: 'string',
        description: 'The Telegram chat ID (numeric) to send the message to',
      },
      message: {
        type: 'string',
        description: 'The text message to send',
      },
    },
    required: ['chat_id', 'message'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
  },
  handler: async (args) => {
    try {
      if (!isBotRunning()) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Telegram bot not connected' }) }],
          isError: true,
        };
      }

      const chatId = args.chat_id as string;
      const message = args.message as string;

      if (!chatId || !message) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'chat_id and message are required' }) }],
          isError: true,
        };
      }

      const contextRejection = rejectIfInternalContext(message);
      if (contextRejection) return contextRejection;

      const result = await sendMessage(chatId, message);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            messageId: result.messageId,
            chatId: result.chatId,
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
