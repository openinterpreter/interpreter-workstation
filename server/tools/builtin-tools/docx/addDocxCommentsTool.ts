import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools.js';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolvePathWithWorkspace } from '../../../utils/permissions.js';
import { getCurrentWorkspace } from '../../../utils/workspace.js';
import { emitEvent } from '../../../utils/ipcBridge.js';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry.js';
import {
  addRelationship,
  extractDocxToFolder,
  getExtractedFolderPath,
  repackageDocxFromFolder,
} from './ooxmlPackage.js';
import { decodeXmlEntities } from './utils.js';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const COMMENTS_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';

interface CommentRequest {
  commentText: string;
  paragraphIndex?: number;
  paragraphText?: string;
  occurrenceIndex: number;
  author: string;
  initials: string;
}

interface RawCommentInput {
  comment_text: unknown;
  paragraph_index?: unknown;
  paragraph_text?: unknown;
  occurrence_index?: unknown;
  author?: unknown;
  initials?: unknown;
}

interface ParagraphMatch {
  attrs: string;
  innerXml: string;
  start: number;
  end: number;
  visibleIndex: number | null;
  normalizedVisibleText: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeCommentRequests(input: unknown): CommentRequest[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('comments must be a non-empty array');
  }

  return input.map((item, index) => {
    const raw = item as RawCommentInput;
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Comment ${index + 1} must be an object`);
    }

    if (typeof raw.comment_text !== 'string' || raw.comment_text.trim().length === 0) {
      throw new Error(`Comment ${index + 1} must include a non-empty comment_text string`);
    }

    const hasParagraphIndex = raw.paragraph_index !== undefined;
    const hasParagraphText = raw.paragraph_text !== undefined;
    if (!hasParagraphIndex && !hasParagraphText) {
      throw new Error(`Comment ${index + 1} must include paragraph_index or paragraph_text`);
    }

    if (hasParagraphIndex) {
      if (!Number.isInteger(raw.paragraph_index) || (raw.paragraph_index as number) < 1) {
        throw new Error(`Comment ${index + 1} paragraph_index must be an integer >= 1`);
      }
    }

    if (hasParagraphText && (typeof raw.paragraph_text !== 'string' || raw.paragraph_text.trim().length === 0)) {
      throw new Error(`Comment ${index + 1} paragraph_text must be a non-empty string when provided`);
    }

    if (
      raw.occurrence_index !== undefined
      && (!Number.isInteger(raw.occurrence_index) || (raw.occurrence_index as number) < 1)
    ) {
      throw new Error(`Comment ${index + 1} occurrence_index must be an integer >= 1 when provided`);
    }

    if (raw.author !== undefined && (typeof raw.author !== 'string' || raw.author.trim().length === 0)) {
      throw new Error(`Comment ${index + 1} author must be a non-empty string when provided`);
    }

    if (raw.initials !== undefined && (typeof raw.initials !== 'string' || raw.initials.trim().length === 0)) {
      throw new Error(`Comment ${index + 1} initials must be a non-empty string when provided`);
    }

    return {
      commentText: raw.comment_text.trim(),
      paragraphIndex: hasParagraphIndex ? raw.paragraph_index as number : undefined,
      paragraphText: hasParagraphText ? raw.paragraph_text as string : undefined,
      occurrenceIndex: (raw.occurrence_index as number | undefined) ?? 1,
      author: typeof raw.author === 'string' ? raw.author.trim() : 'Interpreter',
      initials: typeof raw.initials === 'string' ? raw.initials.trim() : 'I',
    };
  });
}

function extractParagraphVisibleText(innerXml: string): string {
  const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;
  let text = '';
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(innerXml)) !== null) {
    if (match[1] !== undefined) {
      text += decodeXmlEntities(match[1]);
      continue;
    }

    const token = match[0];
    if (token.startsWith('<w:tab')) {
      text += '\t';
    } else {
      text += '\n';
    }
  }

  return text;
}

function listParagraphs(documentXml: string): ParagraphMatch[] {
  const paragraphPattern = /<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/g;
  const paragraphs: ParagraphMatch[] = [];
  let match: RegExpExecArray | null;
  let visibleIndex = 0;

  while ((match = paragraphPattern.exec(documentXml)) !== null) {
    const [, attrs, innerXml] = match;
    const normalizedVisibleText = normalizeVisibleText(extractParagraphVisibleText(innerXml));

    paragraphs.push({
      attrs,
      innerXml,
      start: match.index,
      end: paragraphPattern.lastIndex,
      visibleIndex: normalizedVisibleText.length > 0 ? ++visibleIndex : null,
      normalizedVisibleText,
    });
  }

  return paragraphs;
}

function selectParagraph(documentXml: string, request: CommentRequest): ParagraphMatch {
  const paragraphs = listParagraphs(documentXml);

  if (request.paragraphIndex !== undefined) {
    const paragraph = paragraphs.find((candidate) => candidate.visibleIndex === request.paragraphIndex);
    if (!paragraph) {
      const maxIndex = paragraphs.reduce((max, candidate) => Math.max(max, candidate.visibleIndex ?? 0), 0);
      throw new Error(`Paragraph ${request.paragraphIndex} was not found. Document has ${maxIndex} visible paragraphs.`);
    }

    if (
      request.paragraphText !== undefined
      && paragraph.normalizedVisibleText !== normalizeVisibleText(request.paragraphText)
    ) {
      throw new Error(`Paragraph ${request.paragraphIndex} does not match the supplied paragraph_text.`);
    }

    return paragraph;
  }

  const normalizedTarget = normalizeVisibleText(request.paragraphText ?? '');
  const matchingParagraphs = paragraphs.filter(
    (candidate) => candidate.normalizedVisibleText === normalizedTarget,
  );

  if (matchingParagraphs.length === 0) {
    throw new Error('No paragraph matched the supplied paragraph_text.');
  }

  const paragraph = matchingParagraphs[request.occurrenceIndex - 1];
  if (!paragraph) {
    throw new Error(
      `paragraph_text matched ${matchingParagraphs.length} paragraph(s); occurrence_index ${request.occurrenceIndex} is out of range.`,
    );
  }

  return paragraph;
}

function nextCommentId(commentsXml: string): number {
  const idPattern = /<w:comment\b[^>]*w:id="(\d+)"/g;
  let maxId = -1;
  let match: RegExpExecArray | null;

  while ((match = idPattern.exec(commentsXml)) !== null) {
    const id = Number.parseInt(match[1] ?? '-1', 10);
    if (Number.isFinite(id) && id > maxId) {
      maxId = id;
    }
  }

  return maxId + 1;
}

function buildCommentBodyXml(text: string): string {
  const lines = text.split(/\r?\n+/).filter((line) => line.trim().length > 0);
  const paragraphTexts = lines.length > 0 ? lines : [''];

  return paragraphTexts.map((line) => {
    const escapedText = escapeXml(line);
    const preserve = /^\s|\s$/.test(line) ? ' xml:space="preserve"' : '';
    return `<w:p><w:r><w:t${preserve}>${escapedText}</w:t></w:r></w:p>`;
  }).join('');
}

function buildCommentXml(id: number, request: CommentRequest, timestamp: string): string {
  return `<w:comment w:id="${id}" w:author="${escapeXml(request.author)}" w:date="${timestamp}" w:initials="${escapeXml(request.initials)}">${buildCommentBodyXml(request.commentText)}</w:comment>`;
}

function appendCommentXml(commentsXml: string, commentXml: string): string {
  if (!commentsXml.includes('</w:comments>')) {
    throw new Error('Invalid comments.xml: missing closing </w:comments> tag');
  }

  return commentsXml.replace('</w:comments>', `${commentXml}</w:comments>`);
}

function buildCommentReferenceRun(commentId: number): string {
  return `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>`;
}

function addCommentMarkupToParagraph(paragraph: ParagraphMatch, commentId: number): string {
  const paragraphPropertiesMatch = paragraph.innerXml.match(/^(\s*<w:pPr\b[\s\S]*?<\/w:pPr>)([\s\S]*)$/);
  const paragraphProperties = paragraphPropertiesMatch?.[1] ?? '';
  const paragraphBody = paragraphPropertiesMatch?.[2] ?? paragraph.innerXml;

  return `<w:p${paragraph.attrs}>${paragraphProperties}<w:commentRangeStart w:id="${commentId}"/>${paragraphBody}<w:commentRangeEnd w:id="${commentId}"/>${buildCommentReferenceRun(commentId)}</w:p>`;
}

async function ensureCommentsPart(extractedFolder: string): Promise<string> {
  const documentRelsPath = path.join(extractedFolder, 'word', '_rels', 'document.xml.rels');
  let relsContent = '';
  if (existsSync(documentRelsPath)) {
    relsContent = await readFile(documentRelsPath, 'utf-8');
  }

  const relationshipMatch = relsContent.match(
    new RegExp(`<Relationship[^>]+Type="${COMMENTS_RELATIONSHIP_TYPE}"[^>]+Target="([^"]+)"`, 'i'),
  );
  const target = relationshipMatch?.[1] ?? 'comments.xml';

  if (!relationshipMatch) {
    const relationshipResult = await addRelationship(
      extractedFolder,
      'comments',
      target,
      'word/document.xml',
      false,
    );
    if (!relationshipResult.success) {
      throw new Error(relationshipResult.error ?? 'Failed to create DOCX comments relationship');
    }
  }

  const normalizedTarget = target.replace(/\\/g, '/').replace(/^\/+/, '');
  const commentsPartPath = path.join(extractedFolder, 'word', ...normalizedTarget.split('/'));
  await mkdir(path.dirname(commentsPartPath), { recursive: true });

  if (!existsSync(commentsPartPath)) {
    await writeFile(
      commentsPartPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${WORD_NS}"></w:comments>`,
      'utf-8',
    );
  }

  return commentsPartPath;
}

export const addDocxCommentsTool: BuiltinToolDefinition = {
  name: 'add_docx_comments',
  description:
    'Add real Word comments to an existing .docx file. ' +
    'Each comment anchors to a whole visible paragraph selected by paragraph_index from read_word, or by exact paragraph_text. ' +
    'Use this for review notes, legal comments, approval comments, or editorial markup without rewriting the document body. ' +
    'Supports writing in place or saving to a new output .docx path.',
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
      comments: {
        type: 'array',
        description:
          'Comments to add. Each item must include comment_text plus paragraph_index from read_word or exact paragraph_text. Comments anchor to the full target paragraph.',
        items: {
          type: 'object',
          properties: {
            comment_text: {
              type: 'string',
              description: 'Comment text to store in Word.',
            },
            paragraph_index: {
              type: 'number',
              description: 'Visible 1-based paragraph number from read_word.',
            },
            paragraph_text: {
              type: 'string',
              description: 'Exact visible paragraph text when paragraph_index is unavailable.',
            },
            occurrence_index: {
              type: 'number',
              description: '1-based match to use when paragraph_text appears multiple times. Defaults to 1.',
            },
            author: {
              type: 'string',
              description: 'Optional comment author name. Defaults to "Interpreter".',
            },
            initials: {
              type: 'string',
              description: 'Optional comment initials. Defaults to "I".',
            },
          },
          required: ['comment_text'],
          additionalProperties: false,
        },
      },
    },
    required: ['path', 'comments'],
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

      const comments = normalizeCommentRequests(args.comments);
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

      extractionRoot = await mkdtemp(path.join(tmpdir(), 'docx-comments-'));
      const extractedFolder = getExtractedFolderPath(resolvedInputPath, extractionRoot);
      await extractDocxToFolder(resolvedInputPath, extractedFolder, false);

      const documentXmlPath = path.join(extractedFolder, 'word', 'document.xml');
      if (!existsSync(documentXmlPath)) {
        throw new Error('Invalid DOCX package: missing word/document.xml');
      }

      let documentXml = await readFile(documentXmlPath, 'utf-8');
      const commentsPartPath = await ensureCommentsPart(extractedFolder);
      let commentsXml = await readFile(commentsPartPath, 'utf-8');

      const touchedParagraphIndexes = new Set<number>();
      const appliedComments: string[] = [];
      const timestamp = new Date().toISOString();

      for (const request of comments) {
        const paragraph = selectParagraph(documentXml, request);
        if (paragraph.visibleIndex === null) {
          throw new Error('Cannot attach a comment to an empty paragraph.');
        }

        if (touchedParagraphIndexes.has(paragraph.visibleIndex)) {
          throw new Error(
            `Multiple comments targeted paragraph ${paragraph.visibleIndex} in one call. Split them into separate paragraphs or separate tool calls.`,
          );
        }
        touchedParagraphIndexes.add(paragraph.visibleIndex);

        const commentId = nextCommentId(commentsXml);
        commentsXml = appendCommentXml(commentsXml, buildCommentXml(commentId, request, timestamp));
        const updatedParagraphXml = addCommentMarkupToParagraph(paragraph, commentId);
        documentXml = documentXml.slice(0, paragraph.start) + updatedParagraphXml + documentXml.slice(paragraph.end);

        appliedComments.push(`${commentId}: paragraph ${paragraph.visibleIndex} -> ${JSON.stringify(request.commentText)}`);
      }

      await writeFile(documentXmlPath, documentXml, 'utf-8');
      await writeFile(commentsPartPath, commentsXml, 'utf-8');

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
            `Updated DOCX comments: ${resolvedOutputPath}`,
            '',
            'Applied comments:',
            ...appliedComments.map((line) => `- ${line}`),
          ].join('\n'),
        }],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add DOCX comments';
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
