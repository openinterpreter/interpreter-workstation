/**
 * Telegram builtin server definition.
 * Registers all Telegram tools for the agent.
 */

import type { BuiltinServerDefinition } from '../../builtinTools';
import { listChatsTool } from './listChats';
import { readChatTool } from './readChat';
import { sendMessageTool } from './sendMessage';
import { searchMessagesTool } from './searchMessages';

export const telegramServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-telegram',
  name: 'Telegram',
  description: 'Send and receive Telegram messages via bot',
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
