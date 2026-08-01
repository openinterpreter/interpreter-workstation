import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import * as fs from 'fs/promises';
import mammoth from 'mammoth';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';

const MAX_WORD_OUTPUT_SIZE = 18000;
const DEFAULT_PARAGRAPH_BATCH_SIZE = 50;

function buildParagraphRangeGuidance(params: {
  path: string;
  totalParagraphs: number;
  startParagraph?: number;
  endParagraph?: number;
}): string {
  const start = params.startParagraph ?? 1;
  const firstBatchEnd = Math.min(
    start + DEFAULT_PARAGRAPH_BATCH_SIZE - 1,
    params.totalParagraphs,
  );
  const secondBatchStart = firstBatchEnd + 1;
  const secondBatchEnd = Math.min(
    secondBatchStart + DEFAULT_PARAGRAPH_BATCH_SIZE - 1,
    params.totalParagraphs,
  );

  const lines = [
    params.startParagraph === undefined && params.endParagraph === undefined
      ? 'Use paragraph ranges to read in chunks:'
      : 'The selected range is too large. Retry with a smaller range:',
    `read_word(path="${params.path}", start_paragraph=${start}, end_paragraph=${firstBatchEnd})`,
  ];

  if (secondBatchStart <= params.totalParagraphs) {
    lines.push(
      `read_word(path="${params.path}", start_paragraph=${secondBatchStart}, end_paragraph=${secondBatchEnd})`,
    );
  }

  return lines.join('\n');
}
async function extractWordText(
  filePath: string,
  startParagraph?: number,
  endParagraph?: number,
): Promise<{ text: string; totalParagraphs: number }> {
  const buffer = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  const fullText = result.value || '';
  const paragraphs = fullText.split('\n\n').filter((paragraph) => paragraph.trim().length > 0);
  const totalParagraphs = paragraphs.length;

  if (startParagraph === undefined && endParagraph === undefined) {
    return {
      text: fullText,
      totalParagraphs,
    };
  }

  const start = startParagraph ?? 1;
  const end = endParagraph ?? totalParagraphs;

  if (start < 1 || start > totalParagraphs) {
    throw new Error(`Invalid start paragraph ${start}. Document has ${totalParagraphs} paragraphs (1-${totalParagraphs}).`);
  }
  if (end < 1 || end > totalParagraphs) {
    throw new Error(`Invalid end paragraph ${end}. Document has ${totalParagraphs} paragraphs (1-${totalParagraphs}).`);
  }
  if (start > end) {
    throw new Error(`Invalid paragraph range: start paragraph ${start} is greater than end paragraph ${end}.`);
  }

  return {
    text: paragraphs.slice(start - 1, end).join('\n\n'),
    totalParagraphs,
  };
}

export const readWordTool: BuiltinToolDefinition = {
  name: 'read_word',
  description: 'Read text content from a Word document (.docx). Optionally specify paragraph ranges to inspect only specific sections. For long documents, read in smaller batches using start_paragraph/end_paragraph. When using replace_text_in_docx, read the exact current text first if you are not certain about the existing wording.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the Word document (.docx) to read',
      },
      start_paragraph: {
        type: 'number',
        description: 'Start paragraph number (1-based). If omitted, starts from paragraph 1.',
      },
      end_paragraph: {
        type: 'number',
        description: 'End paragraph number (1-based). If omitted, reads to the last paragraph.',
      },
    },
    required: ['path'],
  },
  fileAccess: {
    mode: 'read',
    pathArg: 'path',
  },
  mode: 'read',
  fileTypes: ['.docx'],
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    try {
      const workspace = context?.workspace || getCurrentWorkspace();
      const filePath = resolvePathWithWorkspace(args.path as string, workspace);
      const startParagraph = args.start_paragraph as number | undefined;
      const endParagraph = args.end_paragraph as number | undefined;

      if (!filePath.toLowerCase().endsWith('.docx')) {
        return {
          content: [{
            type: 'text',
            text: 'Error: File must be a Word document (.docx extension)',
          }],
          isError: true,
        };
      }

      const { text, totalParagraphs } = await extractWordText(filePath, startParagraph, endParagraph);
      if (text.length > MAX_WORD_OUTPUT_SIZE) {
        return {
          content: [{
            type: 'text',
            text: `Error: Document content too large to read at once (${text.length.toLocaleString()} characters, ${totalParagraphs.toLocaleString()} paragraphs).\n\n${buildParagraphRangeGuidance({
              path: args.path as string,
              totalParagraphs,
              startParagraph,
              endParagraph,
            })}`
          }],
          isError: true
        };
      }

      const paraInfo = startParagraph !== undefined || endParagraph !== undefined
        ? `Paragraphs ${startParagraph ?? 1}-${endParagraph ?? totalParagraphs} of ${totalParagraphs}`
        : `All ${totalParagraphs} paragraphs`;

      return {
        content: [{
          type: 'text',
          text: `[${args.path} - ${paraInfo}]\n\n${text}`,
        }],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error reading Word document: ${error.message}`,
        }],
        isError: true,
      };
    }
  },
};
