import { replaceSkillMentionsWithLabels } from '../../shared/utils/skillMentions';

const SENTENCE_END_PUNCTUATION = new Set(['.', '!', '?', '。', '！', '？']);
const SENTENCE_TRAILING_CLOSERS = new Set(['"', '\'', ')', ']', '}', '”', '’']);
const FILE_EXTENSIONS_TO_SPELL = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'pdf',
  'txt',
  'md',
  'json',
  'yaml',
  'yml',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'html',
  'css',
  'scss',
  'xml',
  'toml',
  'ini',
  'wav',
  'mp3',
  'mp4',
  'm4a',
  'zip',
  'tar',
  'gz',
  '7z',
]);

export interface StreamingSentenceSplitResult {
  completedSentences: string[];
  remainder: string;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

export function splitStreamingTextIntoSentences(buffer: string): StreamingSentenceSplitResult {
  if (!buffer) {
    return { completedSentences: [], remainder: '' };
  }

  const completedSentences: string[] = [];
  let start = 0;
  let index = 0;

  while (index < buffer.length) {
    const char = buffer[index];

    if (char === '\n' || char === '\r') {
      let cursor = index + 1;

      if (char === '\r' && cursor < buffer.length && buffer[cursor] === '\n') {
        cursor += 1;
      }

      const sentence = buffer.slice(start, index).trim();
      if (sentence.length > 0) {
        completedSentences.push(sentence);
      }

      while (cursor < buffer.length && (buffer[cursor] === '\n' || buffer[cursor] === '\r')) {
        cursor += 1;
      }

      while (cursor < buffer.length && (buffer[cursor] === ' ' || buffer[cursor] === '\t')) {
        cursor += 1;
      }

      start = cursor;
      index = cursor;
      continue;
    }

    if (SENTENCE_END_PUNCTUATION.has(char)) {
      let end = index + 1;
      while (end < buffer.length && SENTENCE_TRAILING_CLOSERS.has(buffer[end])) {
        end += 1;
      }

      if (end >= buffer.length) {
        break;
      }

      if (isWhitespace(buffer[end])) {
        const sentence = buffer.slice(start, end).trim();
        if (sentence.length > 0) {
          completedSentences.push(sentence);
        }

        while (end < buffer.length && isWhitespace(buffer[end])) {
          end += 1;
        }

        start = end;
        index = end;
        continue;
      }
    }

    index += 1;
  }

  return {
    completedSentences,
    remainder: buffer.slice(start),
  };
}

export function flushSentenceRemainder(remainder: string): string | null {
  const trimmed = remainder.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripMarkdownSyntax(text: string): string {
  if (!text) return '';

  let plain = text;

  // Images/links: keep human-readable text, drop URLs/markup.
  plain = plain.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1');
  plain = plain.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

  // Code markers: keep code text, drop markdown wrappers.
  plain = plain.replace(/```([\s\S]*?)```/g, '$1');
  plain = plain.replace(/`([^`]+)`/g, '$1');

  // Common block-level markdown markers.
  plain = plain.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  plain = plain.replace(/^\s{0,3}>\s?/gm, '');
  plain = plain.replace(/^\s*[-*+]\s+/gm, '');
  plain = plain.replace(/^\s*\d+\.\s+/gm, '');

  // Inline emphasis/strike markers.
  plain = plain.replace(/\*\*([^*]+)\*\*/g, '$1');
  plain = plain.replace(/__([^_]+)__/g, '$1');
  plain = plain.replace(/\*([^*]+)\*/g, '$1');
  plain = plain.replace(/_([^_]+)_/g, '$1');
  plain = plain.replace(/~~([^~]+)~~/g, '$1');

  // Remove accidental leftover wrapper tokens.
  plain = plain.replace(/[*~`#>]/g, '');

  return plain.replace(/\s+/g, ' ').trim();
}

function spellExtensionCharacters(extensionSegment: string): string {
  return extensionSegment
    .split('')
    .map((char) => {
      if (/[a-z]/i.test(char)) return char.toUpperCase();
      return char;
    })
    .join(' ');
}

function looksLikeFilenameToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length < 2) return false;

  const extension = parts[parts.length - 1]?.toLowerCase();
  if (!extension || !FILE_EXTENSIONS_TO_SPELL.has(extension)) {
    return false;
  }

  const baseName = parts.slice(0, -1).join('.');
  return /[a-z]/i.test(baseName);
}

function expandFilenameForSpeech(text: string): string {
  return text.replace(
    /(^|[\s([{"'“‘])([A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]{1,5})(?=$|[\s)\]},"'“”’‘:;!?])/g,
    (fullMatch, prefix: string, token: string) => {
      if (!looksLikeFilenameToken(token)) {
        return fullMatch;
      }

      const segments = token.split('.');
      const extension = segments.pop();
      if (!extension) {
        return fullMatch;
      }

      const basename = segments
        .join('.')
        .replace(/_+/g, ' underscore ')
        .replace(/-+/g, ' dash ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!basename) {
        return fullMatch;
      }

      return `${prefix}${basename} dot ${spellExtensionCharacters(extension)}`;
    },
  );
}

export function stripMarkdownForTtsHighlight(text: string): string {
  return stripMarkdownSyntax(replaceSkillMentionsWithLabels(text));
}

export function stripMarkdownForTts(text: string): string {
  return expandFilenameForSpeech(stripMarkdownSyntax(replaceSkillMentionsWithLabels(text)));
}

function splitTextIntoSentenceChunks(text: string): string[] {
  if (!text.trim()) return [];
  const { completedSentences, remainder } = splitStreamingTextIntoSentences(text);
  const tail = flushSentenceRemainder(remainder);
  return tail ? [...completedSentences, tail] : completedSentences;
}

export function splitTextForTtsPlayback(text: string): string[] {
  return splitTextIntoSentenceChunks(text)
    .map((sentence) => stripMarkdownForTts(sentence).trim())
    .filter((sentence) => sentence.length > 0);
}

export function splitTextForTtsHighlight(text: string): string[] {
  return splitTextIntoSentenceChunks(stripMarkdownForTtsHighlight(text))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}
