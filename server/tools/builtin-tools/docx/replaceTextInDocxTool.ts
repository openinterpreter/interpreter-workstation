import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools.js';
import { readFile, writeFile } from 'fs/promises';
import { extname } from 'path';
import { resolvePathWithWorkspace } from '../../../utils/permissions.js';
import { getCurrentWorkspace } from '../../../utils/workspace.js';
import { emitEvent } from '../../../utils/ipcBridge.js';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry.js';
import { convertDocxToPlaintext } from './utils.js';
import {
  replaceTextInDocxBuffer,
  type DocxTextReplacement,
} from './replaceTextInDocx.js';

interface ReplacementInput {
  old_text: unknown;
  new_text: unknown;
  replace_all?: unknown;
}

function normalizeReplacements(input: unknown): DocxTextReplacement[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('replacements must be a non-empty array');
  }

  return input.map((item, index) => {
    const replacement = item as ReplacementInput;
    if (!replacement || typeof replacement !== 'object') {
      throw new Error(`Replacement ${index + 1} must be an object`);
    }

    if (typeof replacement.old_text !== 'string' || replacement.old_text.length === 0) {
      throw new Error(`Replacement ${index + 1} must include a non-empty old_text string`);
    }

    if (typeof replacement.new_text !== 'string') {
      throw new Error(`Replacement ${index + 1} must include a new_text string`);
    }

    if (replacement.old_text.includes('\n') || replacement.old_text.includes('\r')) {
      throw new Error(`Replacement ${index + 1} old_text must stay within a single paragraph`);
    }

    if (replacement.new_text.includes('\n') || replacement.new_text.includes('\r')) {
      throw new Error(`Replacement ${index + 1} new_text must stay within a single paragraph`);
    }

    if (
      replacement.replace_all !== undefined
      && typeof replacement.replace_all !== 'boolean'
    ) {
      throw new Error(`Replacement ${index + 1} replace_all must be a boolean when provided`);
    }

    return {
      oldText: replacement.old_text,
      newText: replacement.new_text,
      replaceAll: replacement.replace_all ?? false,
    };
  });
}

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findSimilarParagraphs(plainText: string, query: string): string[] {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) {
    return [];
  }

  const queryTokens = normalizedQuery
    .split(' ')
    .filter((token) => token.length >= 3);

  return plainText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const normalizedParagraph = normalizeForSearch(paragraph);
      const paragraphTokens = new Set(
        normalizedParagraph.split(' ').filter((token) => token.length >= 3),
      );
      const sharedTokens = queryTokens.filter((token) => paragraphTokens.has(token)).length;
      const score = normalizedParagraph.includes(normalizedQuery)
        ? 100
        : sharedTokens;

      return { paragraph, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.paragraph.localeCompare(right.paragraph))
    .slice(0, 3)
    .map((candidate) => candidate.paragraph);
}

function buildMissingReplacementMessage(
  originalPlainText: string,
  replacements: DocxTextReplacement[],
  missingIndexes: number[],
): string {
  const lines = ['Error: one or more exact DOCX text replacements were not found. No changes were written.', ''];

  for (const index of missingIndexes) {
    const replacement = replacements[index]!;
    lines.push(`Replacement ${index + 1}:`);
    lines.push(`old_text: ${JSON.stringify(replacement.oldText)}`);

    const suggestions = findSimilarParagraphs(originalPlainText, replacement.oldText);
    if (suggestions.length > 0) {
      lines.push('Closest visible text snippets:');
      suggestions.forEach((suggestion) => {
        lines.push(`- ${suggestion}`);
      });
    }

    lines.push('');
  }

  lines.push('Use read_word first if you need to confirm the exact current text.');
  return lines.join('\n');
}

export const replaceTextInDocxTool: BuiltinToolDefinition = {
  name: 'replace_text_in_docx',
  description:
    'Replace exact text inside an existing Word document (.docx). ' +
    'This is a deterministic DOCX text-edit tool, not a natural-language editor. ' +
    'Provide exact old_text/new_text pairs. Replacements are applied in order and preserve surrounding OOXML as much as possible. ' +
    'Use read_word first when you need to confirm the current text.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the existing Word document (.docx).',
      },
      replacements: {
        type: 'array',
        description: 'Exact text replacements to apply in order.',
        items: {
          type: 'object',
          properties: {
            old_text: {
              type: 'string',
              description: 'Exact current text to replace. Must stay within a single paragraph.',
            },
            new_text: {
              type: 'string',
              description: 'Replacement text. Must stay within a single paragraph.',
            },
            replace_all: {
              type: 'boolean',
              description: 'When true, replace every exact match in the document. Defaults to false.',
            },
          },
          required: ['old_text', 'new_text'],
          additionalProperties: false,
        },
      },
    },
    required: ['path', 'replacements'],
  },
  fileAccess: {
    mode: 'write',
    pathArg: 'path',
  },
  mode: 'write',
  fileTypes: ['.docx'],
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    try {
      const inputPath = args.path as string;
      const replacements = normalizeReplacements(args.replacements);
      const workspace = context?.workspace || getCurrentWorkspace();
      const resolvedPath = resolvePathWithWorkspace(inputPath, workspace);

      if (!inputPath) {
        return {
          content: [{ type: 'text', text: 'Error: path is required' }],
          isError: true,
        };
      }

      if (extname(resolvedPath).toLowerCase() !== '.docx') {
        return {
          content: [{ type: 'text', text: 'Error: Only .docx files are supported' }],
          isError: true,
        };
      }

      const originalBuffer = await readFile(resolvedPath);
      const originalPlainText = await convertDocxToPlaintext(originalBuffer);
      const result = await replaceTextInDocxBuffer(originalBuffer, replacements);
      const missingIndexes = result.appliedReplacements
        .map((replacement, index) => replacement.occurrences === 0 ? index : -1)
        .filter((index) => index >= 0);

      if (missingIndexes.length > 0) {
        return {
          content: [{
            type: 'text',
            text: buildMissingReplacementMessage(originalPlainText, replacements, missingIndexes),
          }],
          isError: true,
        };
      }

      await writeFile(resolvedPath, result.buffer);
      emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedPath });

      const appliedLines = result.appliedReplacements.map((replacement, index) => (
        `${index + 1}. ${JSON.stringify(replacement.oldText)} -> ${JSON.stringify(replacement.newText)} (${replacement.occurrences} match${replacement.occurrences === 1 ? '' : 'es'})`
      ));

      const changedPartLines = result.changedParts.map((partPath) => `- ${partPath}`);

      return {
        content: [{
          type: 'text',
          text: [
            `Updated DOCX: ${resolvedPath}`,
            '',
            'Applied replacements:',
            ...appliedLines,
            '',
            'Changed OOXML parts:',
            ...changedPartLines,
          ].join('\n'),
        }],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to replace DOCX text';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
};
