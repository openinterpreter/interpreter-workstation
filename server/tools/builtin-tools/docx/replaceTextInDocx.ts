import JSZip from 'jszip';
import { convertDocxToPlaintext, decodeXmlEntities } from './utils.js';
import { validateOoxmlDocument } from './xmlValidation.js';

export interface DocxTextReplacement {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface AppliedDocxTextReplacement extends DocxTextReplacement {
  occurrences: number;
}

export interface ReplaceTextInDocxResult {
  buffer: Buffer;
  changedParts: string[];
  appliedReplacements: AppliedDocxTextReplacement[];
}

interface TextNodeInfo {
  start: number;
  end: number;
  attrs: string;
  decodedText: string;
}

const TEXT_PART_PRIORITY = [
  'word/document.xml',
  'word/header1.xml',
  'word/header2.xml',
  'word/header3.xml',
  'word/footer1.xml',
  'word/footer2.xml',
  'word/footer3.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'word/comments.xml',
  'word/commentsExtended.xml',
  'word/commentsExtensible.xml',
  'word/commentsIds.xml',
] as const;

const TEXT_PART_PATTERNS = [
  /^word\/document\.xml$/,
  /^word\/header\d+\.xml$/,
  /^word\/footer\d+\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
  /^word\/comments(?:Extended|Extensible|Ids)?\.xml$/,
] as const;

function isTextBearingPart(filePath: string): boolean {
  return TEXT_PART_PATTERNS.some((pattern) => pattern.test(filePath));
}

function sortTextParts(filePaths: string[]): string[] {
  const priorityOrder = new Map<string, number>(
    TEXT_PART_PRIORITY.map((filePath, index) => [filePath, index]),
  );
  return [...filePaths].sort((left, right) => {
    const leftPriority = priorityOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priorityOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.localeCompare(right);
  });
}

function encodeXmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ensureXmlSpacePreserve(attrs: string, text: string): string {
  if (!(/^\s|\s$/).test(text)) {
    return attrs;
  }

  if (/xml:space\s*=\s*['"]preserve['"]/.test(attrs)) {
    return attrs;
  }

  return attrs ? `${attrs} xml:space="preserve"` : ' xml:space="preserve"';
}

function collectTextNodes(paragraphXml: string): TextNodeInfo[] {
  const textNodes: TextNodeInfo[] = [];
  const textNodeRegex = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

  let match: RegExpExecArray | null;
  while ((match = textNodeRegex.exec(paragraphXml)) !== null) {
    textNodes.push({
      start: match.index,
      end: match.index + match[0].length,
      attrs: match[1] ?? '',
      decodedText: decodeXmlEntities(match[2] ?? ''),
    });
  }

  return textNodes;
}

function rebuildParagraphXml(
  paragraphXml: string,
  textNodes: TextNodeInfo[],
  updatedTexts: string[],
): string {
  let rebuilt = '';
  let cursor = 0;

  for (let index = 0; index < textNodes.length; index += 1) {
    const node = textNodes[index]!;
    rebuilt += paragraphXml.slice(cursor, node.start);
    rebuilt += `<w:t${ensureXmlSpacePreserve(node.attrs, updatedTexts[index] ?? '')}>${encodeXmlEntities(updatedTexts[index] ?? '')}</w:t>`;
    cursor = node.end;
  }

  rebuilt += paragraphXml.slice(cursor);
  return rebuilt;
}

function replaceFirstOccurrenceInParagraph(
  paragraphXml: string,
  oldText: string,
  newText: string,
): { changed: boolean; xml: string } {
  const textNodes = collectTextNodes(paragraphXml);
  if (textNodes.length === 0) {
    return { changed: false, xml: paragraphXml };
  }

  const paragraphText = textNodes.map((node) => node.decodedText).join('');
  const startIndex = paragraphText.indexOf(oldText);
  if (startIndex === -1) {
    return { changed: false, xml: paragraphXml };
  }

  const endIndex = startIndex + oldText.length;
  const updatedTexts = textNodes.map((node) => node.decodedText);

  let runningIndex = 0;
  for (let index = 0; index < textNodes.length; index += 1) {
    const node = textNodes[index]!;
    const nodeStart = runningIndex;
    const nodeEnd = runningIndex + node.decodedText.length;
    runningIndex = nodeEnd;

    if (nodeEnd <= startIndex || nodeStart >= endIndex) {
      continue;
    }

    const sliceStart = Math.max(0, startIndex - nodeStart);
    const sliceEnd = Math.min(node.decodedText.length, endIndex - nodeStart);
    const prefix = node.decodedText.slice(0, sliceStart);
    const suffix = node.decodedText.slice(sliceEnd);

    if (nodeStart <= startIndex && endIndex <= nodeEnd) {
      updatedTexts[index] = `${prefix}${newText}${suffix}`;
      continue;
    }

    if (nodeStart <= startIndex) {
      updatedTexts[index] = `${prefix}${newText}`;
      continue;
    }

    if (endIndex <= nodeEnd) {
      updatedTexts[index] = suffix;
      continue;
    }

    updatedTexts[index] = '';
  }

  return {
    changed: true,
    xml: rebuildParagraphXml(paragraphXml, textNodes, updatedTexts),
  };
}

export function replaceTextInXmlPart(
  xml: string,
  replacement: DocxTextReplacement,
): { xml: string; count: number } {
  let appliedCount = 0;
  const paragraphRegex = /<w:p\b[\s\S]*?<\/w:p>/g;

  const updatedXml = xml.replace(paragraphRegex, (paragraphXml) => {
    if (!replacement.replaceAll && appliedCount > 0) {
      return paragraphXml;
    }

    let updatedParagraph = paragraphXml;
    let changedInParagraph = false;

    while (true) {
      const next = replaceFirstOccurrenceInParagraph(
        updatedParagraph,
        replacement.oldText,
        replacement.newText,
      );
      if (!next.changed) {
        break;
      }

      updatedParagraph = next.xml;
      appliedCount += 1;
      changedInParagraph = true;

      if (!replacement.replaceAll) {
        break;
      }
    }

    return changedInParagraph ? updatedParagraph : paragraphXml;
  });

  return { xml: updatedXml, count: appliedCount };
}

function buildValidationError(filePath: string, xml: string): Error {
  const validation = validateOoxmlDocument(xml);
  if (validation.valid) {
    return new Error(`Updated OOXML is invalid: ${filePath}`);
  }

  const firstError = validation.errors[0];
  const line = firstError?.line ? ` line ${firstError.line}` : '';
  const column = firstError?.column ? `:${firstError.column}` : '';
  const message = firstError?.message ?? 'Unknown XML validation error';
  return new Error(`Updated OOXML is invalid in ${filePath}${line}${column}: ${message}`);
}

export async function replaceTextInDocxBuffer(
  docxData: Buffer,
  replacements: DocxTextReplacement[],
): Promise<ReplaceTextInDocxResult> {
  const zip = await JSZip.loadAsync(docxData);
  const candidateParts = sortTextParts(
    Object.values(zip.files)
      .filter((entry) => !entry.dir && isTextBearingPart(entry.name))
      .map((entry) => entry.name),
  );

  const partContents = new Map<string, string>();
  for (const partPath of candidateParts) {
    const file = zip.file(partPath);
    if (!file) {
      continue;
    }
    partContents.set(partPath, await file.async('string'));
  }

  const changedParts = new Set<string>();
  const appliedReplacements: AppliedDocxTextReplacement[] = [];

  for (const replacement of replacements) {
    let appliedCount = 0;

    for (const partPath of candidateParts) {
      if (!replacement.replaceAll && appliedCount > 0) {
        break;
      }

      const currentXml = partContents.get(partPath);
      if (currentXml === undefined) {
        continue;
      }

      const partResult = replaceTextInXmlPart(currentXml, {
        ...replacement,
        replaceAll: replacement.replaceAll ?? false,
      });
      if (partResult.count === 0) {
        continue;
      }

      partContents.set(partPath, partResult.xml);
      changedParts.add(partPath);
      appliedCount += partResult.count;
    }

    appliedReplacements.push({
      ...replacement,
      occurrences: appliedCount,
    });
  }

  for (const partPath of changedParts) {
    const updatedXml = partContents.get(partPath);
    if (!updatedXml) {
      continue;
    }

    const validation = validateOoxmlDocument(updatedXml);
    if (!validation.valid) {
      throw buildValidationError(partPath, updatedXml);
    }
    zip.file(partPath, updatedXml);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await convertDocxToPlaintext(buffer);

  return {
    buffer,
    changedParts: Array.from(changedParts),
    appliedReplacements,
  };
}
