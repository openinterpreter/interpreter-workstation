// DOCX Server
// Provides tools for reading Word documents

import type { BuiltinServerDefinition } from '../../builtinTools.js';
import { addDocxImageTool } from './addDocxImageTool.js';
import { addDocxCommentsTool } from './addDocxCommentsTool.js';
import { addDocxRelationshipTool } from './addRelationshipTool.js';
import { readDocxTool } from './readDocxTool.js';
import { readWordTool } from './readWordTool.js';
import { createDocxTool } from './createDocxTool.js';
import { replaceTextInDocxTool } from './replaceTextInDocxTool.js';
import { replaceParagraphsInDocxTool } from './replaceParagraphsInDocxTool.js';
import { insertParagraphsInDocxTool } from './insertParagraphsInDocxTool.js';
import { insertTableInDocxTool } from './insertTableInDocxTool.js';
import { updateTableCellsInDocxTool } from './updateTableCellsInDocxTool.js';

export const docxServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-docx',
  name: 'Word Documents',
  description: 'Read, create, and edit Word (.docx) documents',
  isBuiltin: true,
  tools: [
    readDocxTool,
    readWordTool,
    createDocxTool,
    replaceTextInDocxTool,
    replaceParagraphsInDocxTool,
    insertParagraphsInDocxTool,
    insertTableInDocxTool,
    updateTableCellsInDocxTool,
    addDocxCommentsTool,
    addDocxRelationshipTool,
    addDocxImageTool,
  ],
  resources: [],
  prompts: []
};
