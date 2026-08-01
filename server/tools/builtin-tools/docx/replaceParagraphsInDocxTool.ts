import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools.js';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolvePathWithWorkspace } from '../../../utils/permissions.js';
import { getCurrentWorkspace } from '../../../utils/workspace.js';
import { emitEvent } from '../../../utils/ipcBridge.js';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry.js';
import { extractDocxToFolder, getExtractedFolderPath, repackageDocxFromFolder } from './ooxmlPackage.js';
import {
  buildParagraphXml,
  extractParagraphTemplate,
  replaceParagraphInDocument,
  selectParagraph,
  type ParagraphSelectionRequest,
} from './documentStructure.js';

interface RawReplacementParagraph {
  text?: unknown;
}

function normalizeParagraphs(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('paragraphs must be a non-empty array');
  }

  return input.map((item, index) => {
    if (typeof item === 'string') {
      return item;
    }

    const paragraph = item as RawReplacementParagraph;
    if (typeof paragraph?.text !== 'string') {
      throw new Error(`Paragraph ${index + 1} must be a string or an object with a text field`);
    }

    return paragraph.text;
  });
}

function normalizeTarget(input: unknown): ParagraphSelectionRequest {
  if (!input || typeof input !== 'object') {
    throw new Error('target is required');
  }

  const raw = input as Record<string, unknown>;
  const target: ParagraphSelectionRequest = {};

  if (raw.paragraph_index !== undefined) {
    if (!Number.isInteger(raw.paragraph_index) || (raw.paragraph_index as number) < 1) {
      throw new Error('target.paragraph_index must be an integer >= 1 when provided');
    }
    target.paragraphIndex = raw.paragraph_index as number;
  }

  if (raw.paragraph_text !== undefined) {
    if (typeof raw.paragraph_text !== 'string' || raw.paragraph_text.trim().length === 0) {
      throw new Error('target.paragraph_text must be a non-empty string when provided');
    }
    target.paragraphText = raw.paragraph_text;
  }

  if (raw.occurrence_index !== undefined) {
    if (!Number.isInteger(raw.occurrence_index) || (raw.occurrence_index as number) < 1) {
      throw new Error('target.occurrence_index must be an integer >= 1 when provided');
    }
    target.occurrenceIndex = raw.occurrence_index as number;
  }

  if (target.paragraphIndex === undefined && target.paragraphText === undefined) {
    throw new Error('target requires paragraph_index or paragraph_text');
  }

  return target;
}

export const replaceParagraphsInDocxTool: BuiltinToolDefinition = {
  name: 'replace_paragraphs_in_docx',
  description:
    'Replace one visible paragraph in an existing Word document (.docx) with one or more new paragraphs. ' +
    'Anchors to a paragraph index or exact visible paragraph text and can inherit the target paragraph formatting to preserve nearby style.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the source Word document (.docx).',
      },
      output_path: {
        type: 'string',
        description: 'Optional output .docx path. If omitted, edits the source file in place.',
      },
      target: {
        type: 'object',
        description: 'The visible paragraph to replace.',
        properties: {
          paragraph_index: {
            type: 'number',
            description: 'Visible 1-based paragraph index from read_word.',
          },
          paragraph_text: {
            type: 'string',
            description: 'Exact visible paragraph text when paragraph_index is unavailable.',
          },
          occurrence_index: {
            type: 'number',
            description: '1-based paragraph_text match to replace when the same paragraph appears multiple times. Defaults to 1.',
          },
        },
        additionalProperties: false,
      },
      paragraphs: {
        type: 'array',
        description: 'Replacement paragraphs. Each item may be a string or { text }.',
        items: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Paragraph text to insert.' },
              },
              required: ['text'],
              additionalProperties: false,
            },
          ],
        },
      },
      inherit_formatting: {
        type: 'boolean',
        description: 'Whether to inherit paragraph/run formatting from the replaced paragraph. Defaults to true.',
      },
    },
    required: ['path', 'target', 'paragraphs'],
  },
  fileAccess: {
    mode: 'write',
    pathArg: ['path', 'output_path'],
    pathArgModes: {
      path: 'read',
      output_path: 'write',
    },
  },
  mode: 'write',
  fileTypes: ['.docx'],
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args: Record<string, unknown>, context?: BuiltinToolContext) => {
    let extractionRoot: string | null = null;

    try {
      const inputPath = typeof args.path === 'string' ? args.path : '';
      if (!inputPath) {
        return {
          content: [{ type: 'text', text: 'Error: path is required' }],
          isError: true,
        };
      }

      const target = normalizeTarget(args.target);
      const paragraphs = normalizeParagraphs(args.paragraphs);
      const workspace = context?.workspace || getCurrentWorkspace();
      const resolvedInputPath = resolvePathWithWorkspace(inputPath, workspace);
      const rawOutputPath = typeof args.output_path === 'string' && args.output_path.trim().length > 0
        ? args.output_path
        : inputPath;
      const resolvedOutputPath = resolvePathWithWorkspace(rawOutputPath, workspace);

      if (path.extname(resolvedInputPath).toLowerCase() !== '.docx') {
        return {
          content: [{ type: 'text', text: 'Error: path must reference a .docx file' }],
          isError: true,
        };
      }

      if (path.extname(resolvedOutputPath).toLowerCase() !== '.docx') {
        return {
          content: [{ type: 'text', text: 'Error: output_path must end with .docx when provided' }],
          isError: true,
        };
      }

      if (!existsSync(resolvedInputPath)) {
        return {
          content: [{ type: 'text', text: `Error: File not found: ${resolvedInputPath}` }],
          isError: true,
        };
      }

      extractionRoot = await mkdtemp(path.join(tmpdir(), 'docx-replace-paragraphs-'));
      const extractedFolder = getExtractedFolderPath(resolvedInputPath, extractionRoot);
      await extractDocxToFolder(resolvedInputPath, extractedFolder, false);

      const documentXmlPath = path.join(extractedFolder, 'word', 'document.xml');
      if (!existsSync(documentXmlPath)) {
        throw new Error('Invalid DOCX package: missing word/document.xml');
      }

      let documentXml = await readFile(documentXmlPath, 'utf-8');
      const targetParagraph = selectParagraph(documentXml, target);
      const inheritFormatting = typeof args.inherit_formatting === 'boolean'
        ? args.inherit_formatting
        : true;
      const template = inheritFormatting ? extractParagraphTemplate(targetParagraph) : undefined;
      const replacementXml = paragraphs.map((paragraph) => buildParagraphXml(paragraph, template)).join('');

      documentXml = replaceParagraphInDocument(documentXml, replacementXml, targetParagraph);

      await writeFile(documentXmlPath, documentXml, 'utf-8');
      await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
      await repackageDocxFromFolder(extractedFolder, resolvedOutputPath);

      if (!existsSync(resolvedOutputPath)) {
        throw new Error(`Output DOCX was not created at ${resolvedOutputPath}`);
      }

      await emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedOutputPath });

      return {
        content: [{
          type: 'text',
          text: [
            `Replaced paragraph in DOCX: ${resolvedOutputPath}`,
            '',
            `Target paragraph: ${targetParagraph.visibleIndex ?? 'non-visible paragraph'}`,
            `Paragraphs inserted: ${paragraphs.length}`,
            `Formatting inherited: ${inheritFormatting ? 'yes' : 'no'}`,
          ].join('\n'),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error replacing DOCX paragraph: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    } finally {
      if (extractionRoot) {
        await rm(extractionRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  },
};
