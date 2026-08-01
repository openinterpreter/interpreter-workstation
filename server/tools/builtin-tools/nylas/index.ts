import type { BuiltinServerDefinition } from '../../builtinTools';
import { listMessagesTool } from './listMessages';
import { listThreadsTool } from './listThreads';
import { listDraftsTool } from './listDrafts';
import { searchMessagesTool } from './searchMessages';
import { readMessageTool } from './readMessage';
import { downloadAttachmentTool } from './downloadAttachment';
import { listFoldersTool } from './listFolders';
import { createDraftTool } from './createDraft';
import { sendEmailTool } from './sendEmail';
import { sendDraftTool } from './sendDraft';

export const nylasServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-nylas',
  name: 'Nylas Email',
  description: 'Access email using connected account. List folders/messages/threads/drafts, search, read messages, create/send drafts, download attachments.',
  isBuiltin: true,
  tools: [
    listFoldersTool,
    listMessagesTool,
    listThreadsTool,
    listDraftsTool,
    searchMessagesTool,
    readMessageTool,
    createDraftTool,
    sendEmailTool,
    sendDraftTool,
    downloadAttachmentTool
  ],
  resources: [],
  prompts: []
};
