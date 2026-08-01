/**
 * whatsapp_send_message tool - Send a WhatsApp message.
 * Requires user approval before sending.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { getSocket, getConnectionState } from './connection';
import { sendWhatsAppMessageWithRetry } from './outbound';
import { rejectIfInternalContext } from '../../../utils/contentGuard.js';

export const sendMessageTool: BuiltinToolDefinition = {
  name: 'whatsapp_send_message',
  description: 'Send a WhatsApp message. Markdown links to local files are auto-attached as media/documents.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: {
        type: 'string',
        description: 'The recipient JID (e.g., "1234567890@s.whatsapp.net" or group JID)',
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
      if (getConnectionState() !== 'connected') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'WhatsApp not connected' }) }],
          isError: true,
        };
      }

      const sock = getSocket();
      if (!sock) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'WhatsApp socket not available' }) }],
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

      const result = await sendWhatsAppMessageWithRetry({
        sock,
        chatId,
        text: message,
      });
      const messageIds = result.parts
        .map((part) => part.messageId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            messageId: messageIds[0] || 'unknown',
            messageIds,
            partsSent: result.parts.length,
            chatId,
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
