export interface MarkdownFrontmatterData {
  [key: string]: unknown;
}

export interface MarkdownFrontmatter {
  data: MarkdownFrontmatterData;
  rawBlock: string;
  bodyPrefix: string;
}

export interface ParsedMarkdownFrontmatter {
  body: string;
  frontmatter: MarkdownFrontmatter | null;
}

export type MarkdownSourceLineTarget =
  | { region: 'frontmatter' }
  | { region: 'body'; lineStart: number; lineEnd: number };

const FRONTMATTER_DELIMITER = '---';

function countLineBreaks(value: string): number {
  const matches = value.match(/\r\n|\n/g);
  return matches ? matches.length : 0;
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  return countLineBreaks(value) + 1;
}

function resolveBodyPrefix(afterFrontmatter: string): string {
  let offset = 0;

  while (offset < afterFrontmatter.length) {
    if (afterFrontmatter.startsWith('\r\n', offset)) {
      offset += 2;
      continue;
    }

    if (afterFrontmatter.startsWith('\n', offset)) {
      offset += 1;
      continue;
    }

    break;
  }

  return afterFrontmatter.slice(0, offset);
}

function normalizeFrontmatterData(data: unknown): MarkdownFrontmatterData {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as MarkdownFrontmatterData;
  }

  return { value: data };
}

function isIgnorableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

function findNextMeaningfulLineIndex(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!isIgnorableLine(lines[index]!)) {
      return index;
    }
  }

  return -1;
}

function splitInlineCollectionItems(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const previousChar = index > 0 ? value[index - 1] : '';

    if (quote) {
      current += char;
      if (char === quote && previousChar !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  const trimmedCurrent = current.trim();
  if (trimmedCurrent !== '') {
    items.push(trimmedCurrent);
  }

  return items;
}

function findTopLevelSeparator(value: string, separator: string): number {
  let quote: '"' | "'" | null = null;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const previousChar = index > 0 ? value[index - 1] : '';

    if (quote) {
      if (char === quote && previousChar !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if (char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === separator && depth === 0) {
      return index;
    }
  }

  return -1;
}

function parseQuotedString(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }

  return value;
}

function parseInlineObject(value: string): Record<string, unknown> {
  const inner = value.slice(1, -1).trim();
  if (inner === '') {
    return {};
  }

  return splitInlineCollectionItems(inner).reduce<Record<string, unknown>>((result, item) => {
    const separatorIndex = findTopLevelSeparator(item, ':');
    if (separatorIndex === -1) {
      throw new Error(`Invalid inline object item: ${item}`);
    }

    const key = item.slice(0, separatorIndex).trim();
    const rawValue = item.slice(separatorIndex + 1).trim();
    result[parseQuotedString(key)] = parseFrontmatterScalar(rawValue);
    return result;
  }, {});
}

type BlockScalarStyle = 'literal' | 'folded';
type BlockScalarChomping = 'clip' | 'strip' | 'keep';

interface BlockScalarHeader {
  style: BlockScalarStyle;
  chomping: BlockScalarChomping;
  indentIndicator: number | null;
}

function parseBlockScalarHeader(value: string): BlockScalarHeader | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  const styleChar = trimmed[0];
  if (styleChar !== '|' && styleChar !== '>') {
    return null;
  }

  let chomping: BlockScalarChomping = 'clip';
  let indentIndicator: number | null = null;
  let index = 1;

  while (index < trimmed.length) {
    const char = trimmed[index]!;

    if (char === '+' || char === '-') {
      if (chomping !== 'clip') {
        throw new Error(`Invalid block scalar header in frontmatter: ${trimmed}`);
      }
      chomping = char === '+' ? 'keep' : 'strip';
      index += 1;
      continue;
    }

    if (char >= '1' && char <= '9') {
      if (indentIndicator !== null) {
        throw new Error(`Invalid block scalar header in frontmatter: ${trimmed}`);
      }
      indentIndicator = Number(char);
      index += 1;
      continue;
    }

    break;
  }

  const trailing = trimmed.slice(index).trim();
  if (trailing !== '' && !trailing.startsWith('#')) {
    throw new Error(`Invalid block scalar header in frontmatter: ${trimmed}`);
  }

  return {
    style: styleChar === '|' ? 'literal' : 'folded',
    chomping,
    indentIndicator,
  };
}

function foldBlockScalarLines(lines: string[]): string {
  let result = '';

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]!;
    const next = lines[index + 1];
    result += current;

    if (next === undefined) {
      continue;
    }

    if (current === '' || next === '') {
      result += '\n';
      continue;
    }

    result += ' ';
  }

  return result;
}

function parseBlockScalar(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  header: BlockScalarHeader,
): { value: string; nextIndex: number } {
  let contentIndent = header.indentIndicator === null
    ? null
    : parentIndent + header.indentIndicator;

  if (contentIndent !== null && contentIndent <= parentIndent) {
    throw new Error('Invalid block scalar indentation in frontmatter');
  }

  if (contentIndent === null) {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (isBlankLine(line)) {
        continue;
      }

      const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
      if (lineIndent <= parentIndent) {
        return { value: '', nextIndex: startIndex };
      }

      contentIndent = lineIndent;
      break;
    }
  }

  if (contentIndent === null) {
    return { value: '', nextIndex: startIndex };
  }

  const contentLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index]!;

    if (isBlankLine(line)) {
      contentLines.push(line.length > contentIndent ? line.slice(contentIndent) : '');
      index += 1;
      continue;
    }

    const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
    if (lineIndent < contentIndent) {
      if (lineIndent > parentIndent) {
        throw new Error(`Invalid block scalar indentation in frontmatter: ${line}`);
      }
      break;
    }

    contentLines.push(line.slice(contentIndent));
    index += 1;
  }

  let value = header.style === 'literal'
    ? contentLines.join('\n')
    : foldBlockScalarLines(contentLines);

  if (header.chomping === 'strip') {
    value = value.replace(/\n+$/g, '');
  } else if (header.chomping === 'clip') {
    value = value === '' ? '' : value.replace(/\n*$/g, '\n');
  } else if (value !== '' && !value.endsWith('\n')) {
    value = `${value}\n`;
  }

  return {
    value,
    nextIndex: index,
  };
}

function parseFrontmatterScalar(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed === '') {
    return '';
  }

  if (trimmed.startsWith('"') !== trimmed.endsWith('"')) {
    throw new Error(`Unterminated quoted string in frontmatter: ${trimmed}`);
  }

  if (trimmed.startsWith("'") !== trimmed.endsWith("'")) {
    throw new Error(`Unterminated quoted string in frontmatter: ${trimmed}`);
  }

  if (trimmed.startsWith('[') !== trimmed.endsWith(']')) {
    throw new Error(`Unterminated inline array in frontmatter: ${trimmed}`);
  }

  if (trimmed.startsWith('{') !== trimmed.endsWith('}')) {
    throw new Error(`Unterminated inline object in frontmatter: ${trimmed}`);
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return parseQuotedString(trimmed);
  }

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  if (trimmed === 'null' || trimmed === '~') {
    return null;
  }

  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') {
      return [];
    }
    return splitInlineCollectionItems(inner).map(parseFrontmatterScalar);
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return parseInlineObject(trimmed);
  }

  return trimmed;
}

function parseFrontmatterBlock(
  lines: string[],
  startIndex: number,
  indent: number,
  mode: 'array' | 'map',
): { value: unknown; nextIndex: number } {
  const collection: Array<unknown> | Record<string, unknown> = mode === 'array' ? [] : {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index]!;
    if (isIgnorableLine(line)) {
      index += 1;
      continue;
    }

    const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
    if (lineIndent < indent) {
      break;
    }

    if (lineIndent > indent) {
      throw new Error(`Unexpected indentation in frontmatter: ${line}`);
    }

    const trimmed = line.trim();

    if (mode === 'array') {
      if (!trimmed.startsWith('-')) {
        throw new Error(`Invalid list item in frontmatter: ${line}`);
      }

      const itemText = trimmed === '-' ? '' : trimmed.slice(1).trimStart();
      index += 1;

      if (itemText !== '') {
        const blockScalarHeader = parseBlockScalarHeader(itemText);
        if (blockScalarHeader) {
          const parsed = parseBlockScalar(lines, index, indent, blockScalarHeader);
          (collection as Array<unknown>).push(parsed.value);
          index = parsed.nextIndex;
          continue;
        }

        (collection as Array<unknown>).push(parseFrontmatterScalar(itemText));
        continue;
      }

      const nextMeaningfulIndex = findNextMeaningfulLineIndex(lines, index);
      if (nextMeaningfulIndex === -1) {
        (collection as Array<unknown>).push(null);
        break;
      }

      const nextIndent = lines[nextMeaningfulIndex]!.match(/^\s*/)?.[0].length ?? 0;
      if (nextIndent <= indent) {
        (collection as Array<unknown>).push(null);
        continue;
      }

      const nextMode = lines[nextMeaningfulIndex]!.trim().startsWith('-') ? 'array' : 'map';
      const nested = parseFrontmatterBlock(lines, index, nextIndent, nextMode);
      (collection as Array<unknown>).push(nested.value);
      index = nested.nextIndex;
      continue;
    }

    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      throw new Error(`Invalid frontmatter entry: ${line}`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trimStart();
    index += 1;

    if (rawValue !== '') {
      const blockScalarHeader = parseBlockScalarHeader(rawValue);
      if (blockScalarHeader) {
        const parsed = parseBlockScalar(lines, index, indent, blockScalarHeader);
        (collection as Record<string, unknown>)[parseQuotedString(key)] = parsed.value;
        index = parsed.nextIndex;
        continue;
      }

      (collection as Record<string, unknown>)[parseQuotedString(key)] = parseFrontmatterScalar(rawValue);
      continue;
    }

    const nextMeaningfulIndex = findNextMeaningfulLineIndex(lines, index);
    if (nextMeaningfulIndex === -1) {
      (collection as Record<string, unknown>)[parseQuotedString(key)] = null;
      break;
    }

    const nextIndent = lines[nextMeaningfulIndex]!.match(/^\s*/)?.[0].length ?? 0;
    if (nextIndent <= indent) {
      (collection as Record<string, unknown>)[parseQuotedString(key)] = null;
      continue;
    }

    const nextMode = lines[nextMeaningfulIndex]!.trim().startsWith('-') ? 'array' : 'map';
    const nested = parseFrontmatterBlock(lines, index, nextIndent, nextMode);
    (collection as Record<string, unknown>)[parseQuotedString(key)] = nested.value;
    index = nested.nextIndex;
  }

  return {
    value: collection,
    nextIndex: index,
  };
}

function parseFrontmatterData(matterText: string): MarkdownFrontmatterData {
  const lines = matterText.replace(/\r\n/g, '\n').split('\n');
  const meaningfulLines = lines.filter((line) => !isIgnorableLine(line));

  if (meaningfulLines.length === 0) {
    return {};
  }

  const parsed = parseFrontmatterBlock(lines, 0, 0, 'map');
  return normalizeFrontmatterData(parsed.value);
}

function extractFrontmatterBoundary(markdown: string): {
  matterText: string;
  rawBlock: string;
  bodyPrefix: string;
  body: string;
} | null {
  if (!markdown.startsWith(FRONTMATTER_DELIMITER)) {
    return null;
  }

  if (markdown.charAt(FRONTMATTER_DELIMITER.length) === FRONTMATTER_DELIMITER.slice(-1)) {
    return null;
  }

  const remainder = markdown.slice(FRONTMATTER_DELIMITER.length);
  const firstLineBreakIndex = remainder.search(/\r?\n/);
  if (firstLineBreakIndex === -1) {
    return null;
  }

  const languageRaw = remainder.slice(0, firstLineBreakIndex);
  const remainderWithLeadingNewline = remainder.slice(languageRaw.length);
  const closeToken = '\n---';
  const closeIndex = remainderWithLeadingNewline.indexOf(closeToken);
  if (closeIndex === -1) {
    return null;
  }

  const rawBlockLength =
    FRONTMATTER_DELIMITER.length
    + languageRaw.length
    + closeIndex
    + closeToken.length;
  const rawBlock = markdown.slice(0, rawBlockLength);
  const afterFrontmatter = markdown.slice(rawBlockLength);
  const bodyPrefix = resolveBodyPrefix(afterFrontmatter);
  const body = afterFrontmatter.slice(bodyPrefix.length);
  const matterText = remainderWithLeadingNewline.slice(0, closeIndex).replace(/^\r?\n/, '');

  return {
    matterText,
    rawBlock,
    bodyPrefix,
    body,
  };
}

export function extractMarkdownFrontmatter(markdown: string): ParsedMarkdownFrontmatter {
  const boundary = extractFrontmatterBoundary(markdown);
  if (!boundary) {
    return {
      body: markdown,
      frontmatter: null,
    };
  }

  try {
    return {
      body: boundary.body,
      frontmatter: {
        data: parseFrontmatterData(boundary.matterText),
        rawBlock: boundary.rawBlock,
        bodyPrefix: boundary.bodyPrefix,
      },
    };
  } catch {
    return {
      body: markdown,
      frontmatter: null,
    };
  }
}

export function serializeMarkdownWithFrontmatter(
  body: string,
  frontmatter: MarkdownFrontmatter | null,
): string {
  if (!frontmatter) {
    return body;
  }

  if (body.length === 0) {
    return frontmatter.rawBlock;
  }

  return `${frontmatter.rawBlock}${frontmatter.bodyPrefix}${body}`;
}

function serializeFrontmatterKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function serializeFrontmatterInlineValue(value: unknown): string {
  if (value == null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeFrontmatterInlineValue(entry)).join(', ')}]`;
  }

  if (typeof value === 'object') {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${serializeFrontmatterKey(key)}: ${serializeFrontmatterInlineValue(entry)}`)
      .join(', ')} }`;
  }

  return JSON.stringify(String(value));
}

function serializeFrontmatterEntry(
  key: string,
  value: unknown,
): string[] {
  if (typeof value === 'string' && value.includes('\n')) {
    const lines = value.split(/\r?\n/);
    return [
      `${serializeFrontmatterKey(key)}: |-`,
      ...lines.map((line) => `  ${line}`),
    ];
  }

  return [`${serializeFrontmatterKey(key)}: ${serializeFrontmatterInlineValue(value)}`];
}

export function serializeFrontmatterData(data: MarkdownFrontmatterData): string {
  const lines = ['---'];

  for (const [key, value] of Object.entries(data)) {
    lines.push(...serializeFrontmatterEntry(key, value));
  }

  lines.push('---');
  return lines.join('\n');
}

export function getMarkdownBodyLineOffset(frontmatter: MarkdownFrontmatter | null): number {
  if (!frontmatter) {
    return 0;
  }

  return countLines(frontmatter.rawBlock) + countLineBreaks(frontmatter.bodyPrefix);
}

export function mapMarkdownSourceLineRangeToBody(
  frontmatter: MarkdownFrontmatter | null,
  lineStart: number,
  lineEnd?: number,
): MarkdownSourceLineTarget {
  const normalizedEnd = lineEnd ?? lineStart;
  const offset = getMarkdownBodyLineOffset(frontmatter);

  if (offset === 0) {
    return {
      region: 'body',
      lineStart,
      lineEnd: normalizedEnd,
    };
  }

  if (normalizedEnd <= offset) {
    return { region: 'frontmatter' };
  }

  return {
    region: 'body',
    lineStart: Math.max(1, lineStart - offset),
    lineEnd: Math.max(1, normalizedEnd - offset),
  };
}
