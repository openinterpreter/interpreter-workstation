/**
 * WhatsApp builtin server definition.
 * Registers all WhatsApp tools for the agent.
 */

import type { BuiltinServerDefinition } from '../../builtinTools';
import { listChatsTool } from './listChats';
import { readChatTool } from './readChat';
import { sendMessageTool } from './sendMessage';
import { searchMessagesTool } from './searchMessages';

export const whatsappServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-whatsapp',
  name: 'WhatsApp',
  description: 'Send and receive WhatsApp messages',
  isBuiltin: true,
  tools: [
    listChatsTool,
    readChatTool,
    sendMessageTool,
    searchMessagesTool,
  ],
  resources: [],
  prompts: [],
};
