// Converter Server
// Provides tools for converting documents between formats using x2t

import type { BuiltinServerDefinition } from '../../builtinTools.js';
import { convertFileTool } from './convertFileTool.js';

export const converterServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-converter',
  name: 'File Converter',
  description: 'Convert between document, spreadsheet, and presentation formats. Uses the spreadsheet engine when supported, with converter fallback (docx, pdf, xlsx, csv, pptx, html, epub, odt, ods, odp, etc.)',
  isBuiltin: true,
  tools: [convertFileTool],
  resources: [],
  prompts: [],
};
