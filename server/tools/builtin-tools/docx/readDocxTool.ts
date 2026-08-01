// Read DOCX Tool
// Reads Word documents and returns content as plaintext

import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { extname } from 'path';
import { resolvePathWithWorkspace } from '../../../utils/permissions.js';
import { getCurrentWorkspace } from '../../../utils/workspace';
import {
  injectMarkersIntoDocx,
  convertDocxToPlaintext,
  removeMarkersFromText,
} from './utils.js';

const MAX_DOCX_OUTPUT_SIZE = 18000;
const DEFAULT_PARAGRAPH_BATCH_SIZE = 50;

function buildReadWordChunkGuidance(path: string, totalParagraphs: number): string {
  const firstBatchEnd = Math.min(DEFAULT_PARAGRAPH_BATCH_SIZE, totalParagraphs);
  const secondBatchStart = firstBatchEnd + 1;
  const secondBatchEnd = Math.min(
    secondBatchStart + DEFAULT_PARAGRAPH_BATCH_SIZE - 1,
    totalParagraphs,
  );

  const lines = [
    'Use read_word with paragraph ranges instead, for example:',
    `read_word(path="${path}", start_paragraph=1, end_paragraph=${firstBatchEnd})`,
  ];

  if (secondBatchStart <= totalParagraphs) {
    lines.push(
      `read_word(path="${path}", start_paragraph=${secondBatchStart}, end_paragraph=${secondBatchEnd})`,
    );
  }

  return lines.join('\n');
}

export const readDocxTool: BuiltinToolDefinition = {
  name: 'read_docx',
  description: 'Read a Word document (.docx) and return its full content as plaintext. This expands the whole document into context. Use this for explicit inspection or final verification only. If you only need a specific section, prefer read_word with paragraph ranges. When using replace_text_in_docx, use read_word/read_docx first to confirm the exact current text.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the Word document (absolute or workspace-relative)'
      }
    },
    required: ['path']
  },
  fileAccess: {
    mode: 'read',
    pathArg: 'path'
  },
  mode: 'read',
  fileTypes: ['.docx'],
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    try {
      const filePath = args.path as string;

      if (!filePath) {
        return {
          content: [{ type: 'text', text: 'Error: File path is required' }],
          isError: true
        };
      }

      // Resolve path (handles workspace-relative and absolute paths)
      const workspace = context?.workspace || getCurrentWorkspace();
      const resolvedPath = resolvePathWithWorkspace(filePath, workspace);

      if (!existsSync(resolvedPath)) {
        return {
          content: [
            { type: 'text', text: `Error: File not found: ${resolvedPath}` },
          ],
          isError: true
        };
      }

      const ext = extname(resolvedPath).toLowerCase();
      if (ext !== '.docx') {
        return {
          content: [
            { type: 'text', text: 'Error: Only .docx files are supported' },
          ],
          isError: true
        };
      }

      const docxData = await readFile(resolvedPath);

      const { markedData, paragraphIndex } = await injectMarkersIntoDocx(docxData);
      const plainText = await convertDocxToPlaintext(markedData);
      const cleanText = removeMarkersFromText(plainText);
      const paragraphCount = Object.keys(paragraphIndex).length;

      if (cleanText.length > MAX_DOCX_OUTPUT_SIZE) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Document too large to read at once (${cleanText.length.toLocaleString()} characters, ${paragraphCount.toLocaleString()} paragraphs).

${buildReadWordChunkGuidance(args.path as string, paragraphCount)}`,
            },
          ],
          isError: true,
        };
      }

      const header = `Successfully read Word document (${paragraphCount} paragraphs)\nPath: ${resolvedPath}\n\n`;
      return {
        content: [
          { type: 'text', text: header + cleanText },
        ],
        isError: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read Word document';
      return {
        content: [
          { type: 'text', text: `Error reading Word document: ${message}` },
        ],
        isError: true
      };
    }
  }
};
