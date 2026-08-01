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
  insertBlocksIntoDocument,
  selectParagraph,
  type ParagraphSelectionRequest,
} from './documentStructure.js';

type InsertPosition = 'start' | 'end' | 'before' | 'after';

interface RawLocationInput {
  position?: unknown;
  paragraph_index?: unknown;
  paragraph_text?: unknown;
  occurrence_index?: unknown;
}

interface RawParagraphInput {
  text?: unknown;
}

interface InsertLocation extends ParagraphSelectionRequest {
  position: InsertPosition;
}

function normalizeParagraphs(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('paragraphs must be a non-empty array');
  }

  return input.map((item, index) => {
    if (typeof item === 'string') {
      return item;
    }

    const paragraph = item as RawParagraphInput;
    if (typeof paragraph?.text !== 'string') {
      throw new Error(`Paragraph ${index + 1} must be a string or an object with a text field`);
    }
    return paragraph.text;
  });
}

function normalizeLocation(input: unknown): InsertLocation {
  if (!input || typeof input !== 'object') {
    return { position: 'end' };
  }

  const raw = input as RawLocationInput;
  const position = raw.position ?? 'end';
  if (position !== 'start' && position !== 'end' && position !== 'before' && position !== 'after') {
    throw new Error('location.position must be one of: start, end, before, after');
  }

  const location: InsertLocation = { position };

  if (raw.paragraph_index !== undefined) {
    if (!Number.isInteger(raw.paragraph_index) || (raw.paragraph_index as number) < 1) {
      throw new Error('location.paragraph_index must be an integer >= 1 when provided');
    }
    location.paragraphIndex = raw.paragraph_index as number;
  }

  if (raw.paragraph_text !== undefined) {
    if (typeof raw.paragraph_text !== 'string' || raw.paragraph_text.trim().length === 0) {
      throw new Error('location.paragraph_text must be a non-empty string when provided');
    }
    location.paragraphText = raw.paragraph_text;
  }

  if (raw.occurrence_index !== undefined) {
    if (!Number.isInteger(raw.occurrence_index) || (raw.occurrence_index as number) < 1) {
      throw new Error('location.occurrence_index must be an integer >= 1 when provided');
    }
    location.occurrenceIndex = raw.occurrence_index as number;
  }

  if ((position === 'before' || position === 'after') && location.paragraphIndex === undefined && location.paragraphText === undefined) {
    throw new Error(`location.${position} requires paragraph_index or paragraph_text`);
  }

  return location;
}

export const insertParagraphsInDocxTool: BuiltinToolDefinition = {
  name: 'insert_paragraphs_in_docx',
  description:
    'Insert one or more paragraphs into an existing Word document (.docx). ' +
    'Supports appending at the end, inserting at the start, or inserting before/after a target paragraph. ' +
    'Can inherit paragraph/run formatting from the anchor paragraph to preserve the surrounding style.',
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
      paragraphs: {
        type: 'array',
        description: 'Paragraphs to insert. Each item may be a string or { text }.',
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
      location: {
        type: 'object',
        description: 'Where to insert the paragraphs. Defaults to { position: "end" }.',
        properties: {
          position: {
            type: 'string',
            enum: ['start', 'end', 'before', 'after'],
            description: 'Insertion position relative to the document or an anchor paragraph.',
          },
          paragraph_index: {
            type: 'number',
            description: 'Visible 1-based paragraph index from read_word when inserting before/after an anchor paragraph.',
          },
          paragraph_text: {
            type: 'string',
            description: 'Exact visible anchor paragraph text when paragraph_index is unavailable.',
          },
          occurrence_index: {
            type: 'number',
            description: '1-based anchor match to use when paragraph_text appears multiple times. Defaults to 1.',
          },
        },
        additionalProperties: false,
      },
      inherit_formatting: {
        type: 'boolean',
        description: 'Whether to inherit paragraph/run formatting from the anchor paragraph. Defaults to true for before/after inserts.',
      },
    },
    required: ['path', 'paragraphs'],
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

      const paragraphs = normalizeParagraphs(args.paragraphs);
      const location = normalizeLocation(args.location);
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

      extractionRoot = await mkdtemp(path.join(tmpdir(), 'docx-insert-paragraphs-'));
      const extractedFolder = getExtractedFolderPath(resolvedInputPath, extractionRoot);
      await extractDocxToFolder(resolvedInputPath, extractedFolder, false);

      const documentXmlPath = path.join(extractedFolder, 'word', 'document.xml');
      if (!existsSync(documentXmlPath)) {
        throw new Error('Invalid DOCX package: missing word/document.xml');
      }

      let documentXml = await readFile(documentXmlPath, 'utf-8');
      const anchorParagraph = location.position === 'before' || location.position === 'after'
        ? selectParagraph(documentXml, location)
        : undefined;
      const inheritFormatting = typeof args.inherit_formatting === 'boolean'
        ? args.inherit_formatting
        : Boolean(anchorParagraph);
      const template = inheritFormatting && anchorParagraph
        ? extractParagraphTemplate(anchorParagraph)
        : undefined;

      const insertionXml = paragraphs.map((paragraph) => buildParagraphXml(paragraph, template)).join('');
      documentXml = insertBlocksIntoDocument(documentXml, insertionXml, location.position, anchorParagraph);

      await writeFile(documentXmlPath, documentXml, 'utf-8');
      await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
      await repackageDocxFromFolder(extractedFolder, resolvedOutputPath);

      if (!existsSync(resolvedOutputPath)) {
        throw new Error(`Output DOCX was not created at ${resolvedOutputPath}`);
      }

      await emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedOutputPath });

      const locationDescription = anchorParagraph?.visibleIndex
        ? `${location.position} paragraph ${anchorParagraph.visibleIndex}`
        : location.position;

      return {
        content: [{
          type: 'text',
          text: [
            `Inserted paragraphs into DOCX: ${resolvedOutputPath}`,
            '',
            `Insertion point: ${locationDescription}`,
            `Paragraphs inserted: ${paragraphs.length}`,
            `Inherited formatting: ${inheritFormatting ? 'yes' : 'no'}`,
          ].join('\n'),
        }],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to insert DOCX paragraphs';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    } finally {
      if (extractionRoot) {
        await rm(extractionRoot, { recursive: true, force: true });
      }
    }
  },
};
