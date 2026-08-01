import type { ComposerAttachmentRecord } from './types';

export type PastedContentSegment =
  | { type: 'text'; text: string }
  | { type: 'pasted-content'; label: string; text: string };

const FALLBACK_PASTED_CONTENT_PREFIX = 'rendered';

const SERIALIZED_PASTED_CONTENT_REGEX =
  /<pasted-content\s+label=("(?:[^"\\]|\\.)*")>\r?\n([\s\S]*?)\r?\n<\/pasted-content>/g;

export function hasSerializedPastedContent(text: string): boolean {
  SERIALIZED_PASTED_CONTENT_REGEX.lastIndex = 0;
  return SERIALIZED_PASTED_CONTENT_REGEX.test(text);
}

export function createSerializedPastedTextRecord(
  id: string,
  label: string,
  text: string,
): ComposerAttachmentRecord {
  return {
    id,
    kind: 'pasted-text',
    label,
    size: text.length,
    text,
  };
}

export function parsePastedContentSegments(text: string): PastedContentSegment[] {
  if (!text) {
    return [{ type: 'text', text: '' }];
  }

  SERIALIZED_PASTED_CONTENT_REGEX.lastIndex = 0;

  const segments: PastedContentSegment[] = [];
  let lastIndex = 0;
  let changed = false;
  let match: RegExpExecArray | null;

  while ((match = SERIALIZED_PASTED_CONTENT_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        text: text.slice(lastIndex, match.index),
      });
    }

    const rawLabelLiteral = match[1];
    const body = match[2] ?? '';

    try {
      const label = JSON.parse(rawLabelLiteral);
      if (typeof label === 'string') {
        segments.push({
          type: 'pasted-content',
          label,
          text: body,
        });
        changed = true;
      } else {
        segments.push({ type: 'text', text: match[0] });
      }
    } catch {
      segments.push({ type: 'text', text: match[0] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (!changed) {
    return [{ type: 'text', text }];
  }

  if (lastIndex < text.length) {
    segments.push({
      type: 'text',
      text: text.slice(lastIndex),
    });
  }

  return mergeAdjacentTextSegments(segments);
}

export function collapsePastedContentToLabels(text: string): string {
  return parsePastedContentSegments(text)
    .map((segment) => segment.type === 'text' ? segment.text : segment.label)
    .join('');
}

export function tokenizePastedContent(
  text: string,
  idPrefix: string,
): {
  content: string;
  recordsById: Record<string, ComposerAttachmentRecord>;
  tokenToRecordId: Record<string, string>;
} {
  const segments = parsePastedContentSegments(text);
  const recordsById: Record<string, ComposerAttachmentRecord> = {};
  const tokenToRecordId: Record<string, string> = {};

  let pastedContentCount = 0;
  const content = segments.map((segment) => {
    if (segment.type === 'text') {
      return segment.text;
    }

    const safePrefix = sanitizePastedContentPrefix(idPrefix);
    const attachmentId = `rendered-pasted-${safePrefix}-${pastedContentCount}`;
    // Keep the placeholder alphanumeric so markdown parsing never splits it
    // before the remark transform can swap it for a pasted-content node.
    const token = `INTERPRETERPASTEDCONTENTTOKEN${safePrefix}TOKEN${pastedContentCount}`;
    pastedContentCount += 1;

    recordsById[attachmentId] = createSerializedPastedTextRecord(
      attachmentId,
      segment.label,
      segment.text,
    );
    tokenToRecordId[token] = attachmentId;
    return token;
  }).join('');

  return {
    content,
    recordsById,
    tokenToRecordId,
  };
}

function sanitizePastedContentPrefix(idPrefix: string): string {
  const cleaned = idPrefix.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned || FALLBACK_PASTED_CONTENT_PREFIX;
}

function mergeAdjacentTextSegments(
  segments: PastedContentSegment[],
): PastedContentSegment[] {
  const merged: PastedContentSegment[] = [];

  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (segment.type === 'text' && previous?.type === 'text') {
      previous.text = `${previous.text}${segment.text}`;
      continue;
    }
    merged.push(segment);
  }

  return merged;
}
