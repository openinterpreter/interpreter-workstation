export interface ParagraphMatch {
  attrs: string;
  innerXml: string;
  start: number;
  end: number;
  visibleIndex: number | null;
  normalizedVisibleText: string;
}

export interface ParagraphSelectionRequest {
  paragraphIndex?: number;
  paragraphText?: string;
  occurrenceIndex?: number;
}

export interface ParagraphTemplate {
  paragraphPropertiesXml: string;
  runPropertiesXml: string;
}

export interface TableCellMatch {
  attrs: string;
  innerXml: string;
  start: number;
  end: number;
  rowIndex: number;
  columnIndex: number;
}

export interface TableRowMatch {
  attrs: string;
  innerXml: string;
  start: number;
  end: number;
  rowIndex: number;
  cells: TableCellMatch[];
}

export interface TableMatch {
  attrs: string;
  innerXml: string;
  start: number;
  end: number;
  tableIndex: number;
  rows: TableRowMatch[];
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function extractParagraphVisibleText(innerXml: string): string {
  const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;
  let text = '';
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(innerXml)) !== null) {
    if (match[1] !== undefined) {
      text += match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
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

export function listParagraphs(documentXml: string): ParagraphMatch[] {
  const paragraphPattern = /<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/g;
  const paragraphs: ParagraphMatch[] = [];
  let match: RegExpExecArray | null;
  let visibleIndex = 0;

  while ((match = paragraphPattern.exec(documentXml)) !== null) {
    const [, attrs, innerXml] = match;
    const normalizedText = normalizeVisibleText(extractParagraphVisibleText(innerXml));

    paragraphs.push({
      attrs,
      innerXml,
      start: match.index,
      end: paragraphPattern.lastIndex,
      visibleIndex: normalizedText.length > 0 ? ++visibleIndex : null,
      normalizedVisibleText: normalizedText,
    });
  }

  return paragraphs;
}

export function selectParagraph(
  documentXml: string,
  request: ParagraphSelectionRequest,
): ParagraphMatch {
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

  const occurrenceIndex = request.occurrenceIndex ?? 1;
  const paragraph = matchingParagraphs[occurrenceIndex - 1];
  if (!paragraph) {
    throw new Error(
      `paragraph_text matched ${matchingParagraphs.length} paragraph(s); occurrence_index ${occurrenceIndex} is out of range.`,
    );
  }

  return paragraph;
}

export function extractParagraphTemplate(paragraph: ParagraphMatch): ParagraphTemplate {
  const paragraphPropertiesXml = paragraph.innerXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? '';
  const runPropertiesXml = paragraph.innerXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? '';

  return {
    paragraphPropertiesXml,
    runPropertiesXml,
  };
}

function buildTextContentXml(text: string): string {
  if (text.length === 0) {
    return '<w:t></w:t>';
  }

  const parts: string[] = [];
  let buffer = '';

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const preserve = /^\s|\s$| {2,}/.test(buffer) ? ' xml:space="preserve"' : '';
    parts.push(`<w:t${preserve}>${escapeXml(buffer)}</w:t>`);
    buffer = '';
  };

  for (const char of text) {
    if (char === '\t') {
      flushBuffer();
      parts.push('<w:tab/>');
      continue;
    }

    if (char === '\n') {
      flushBuffer();
      parts.push('<w:br/>');
      continue;
    }

    buffer += char;
  }

  flushBuffer();
  return parts.join('');
}

export function buildParagraphXml(text: string, template?: ParagraphTemplate): string {
  const paragraphPropertiesXml = template?.paragraphPropertiesXml ?? '';
  const runPropertiesXml = template?.runPropertiesXml ?? '';
  return `<w:p>${paragraphPropertiesXml}<w:r>${runPropertiesXml}${buildTextContentXml(text)}</w:r></w:p>`;
}

function buildCellParagraphXml(text: string, template?: ParagraphTemplate, bold: boolean = false): string {
  const paragraphPropertiesXml = template?.paragraphPropertiesXml ?? '';
  let runPropertiesXml = template?.runPropertiesXml ?? '';

  if (bold && !runPropertiesXml.includes('<w:b')) {
    runPropertiesXml = runPropertiesXml
      ? runPropertiesXml.replace('</w:rPr>', '<w:b/></w:rPr>')
      : '<w:rPr><w:b/></w:rPr>';
  }

  return `<w:p>${paragraphPropertiesXml}<w:r>${runPropertiesXml}${buildTextContentXml(text)}</w:r></w:p>`;
}

export function buildTableXml(
  rows: string[][],
  template?: ParagraphTemplate,
  firstRowHeader: boolean = false,
): string {
  const columnCount = rows[0]?.length ?? 0;
  const gridColumns = Array.from({ length: columnCount }, () => '<w:gridCol w:w="2400"/>').join('');
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((cell) => {
      const cellText = cell ?? '';
      return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${buildCellParagraphXml(cellText, template, firstRowHeader && rowIndex === 0)}</w:tc>`;
    }).join('');
    return `<w:tr>${cells}</w:tr>`;
  }).join('');

  return [
    '<w:tbl>',
    '<w:tblPr>',
    '<w:tblStyle w:val="TableGrid"/>',
    '<w:tblW w:w="0" w:type="auto"/>',
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>',
    '</w:tblPr>',
    `<w:tblGrid>${gridColumns}</w:tblGrid>`,
    rowXml,
    '</w:tbl>',
  ].join('');
}

export function listTables(documentXml: string): TableMatch[] {
  const tablePattern = /<w:tbl\b([^>]*)>([\s\S]*?)<\/w:tbl>/g;
  const tables: TableMatch[] = [];
  let tableMatch: RegExpExecArray | null;
  let tableIndex = 0;

  while ((tableMatch = tablePattern.exec(documentXml)) !== null) {
    const [tableXml, attrs, innerXml] = tableMatch;
    const rows: TableRowMatch[] = [];
    const rowPattern = /<w:tr\b([^>]*)>([\s\S]*?)<\/w:tr>/g;
    let rowMatch: RegExpExecArray | null;
    let rowIndex = 0;

    while ((rowMatch = rowPattern.exec(tableXml)) !== null) {
      const [rowXml, rowAttrs, rowInnerXml] = rowMatch;
      const rowStart = tableMatch.index + rowMatch.index;
      const cells: TableCellMatch[] = [];
      const cellPattern = /<w:tc\b([^>]*)>([\s\S]*?)<\/w:tc>/g;
      let cellMatch: RegExpExecArray | null;
      let columnIndex = 0;

      while ((cellMatch = cellPattern.exec(rowXml)) !== null) {
        const [, cellAttrs, cellInnerXml] = cellMatch;
        const cellStart = rowStart + cellMatch.index;
        cells.push({
          attrs: cellAttrs,
          innerXml: cellInnerXml,
          start: cellStart,
          end: cellStart + cellMatch[0].length,
          rowIndex: rowIndex + 1,
          columnIndex: columnIndex + 1,
        });
        columnIndex += 1;
      }

      rows.push({
        attrs: rowAttrs,
        innerXml: rowInnerXml,
        start: rowStart,
        end: rowStart + rowXml.length,
        rowIndex: rowIndex + 1,
        cells,
      });
      rowIndex += 1;
    }

    tables.push({
      attrs,
      innerXml,
      start: tableMatch.index,
      end: tableMatch.index + tableXml.length,
      tableIndex: ++tableIndex,
      rows,
    });
  }

  return tables;
}

export function selectTable(documentXml: string, tableIndex: number): TableMatch {
  const tables = listTables(documentXml);
  const table = tables.find((candidate) => candidate.tableIndex === tableIndex);
  if (!table) {
    throw new Error(`Table ${tableIndex} was not found. Document has ${tables.length} table(s).`);
  }
  return table;
}

export function extractCellParagraphTemplate(cell: TableCellMatch): ParagraphTemplate | undefined {
  const paragraphs = listParagraphs(cell.innerXml);
  const paragraph = paragraphs.find((candidate) => candidate.normalizedVisibleText.length > 0) ?? paragraphs[0];
  return paragraph ? extractParagraphTemplate(paragraph) : undefined;
}

export function buildTableCellXml(
  cell: TableCellMatch,
  text: string,
  template?: ParagraphTemplate,
): string {
  const cellPropertiesXml = cell.innerXml.match(/^\s*((?:<w:tcPr\b[\s\S]*?<\/w:tcPr>)|(?:<w:tcPr\b[^>]*\/>))/)?.[1] ?? '';
  return `<w:tc${cell.attrs}>${cellPropertiesXml}${buildParagraphXml(text, template)}</w:tc>`;
}

export function replaceTableCellInDocument(
  documentXml: string,
  cell: TableCellMatch,
  replacementXml: string,
): string {
  return documentXml.slice(0, cell.start) + replacementXml + documentXml.slice(cell.end);
}

export function insertBlocksIntoDocument(
  documentXml: string,
  insertionXml: string,
  position: 'start' | 'end' | 'before' | 'after',
  anchor?: ParagraphMatch,
): string {
  if (position === 'before' || position === 'after') {
    if (!anchor) {
      throw new Error(`Paragraph anchor is required for ${position} insertion.`);
    }

    const insertAt = position === 'before' ? anchor.start : anchor.end;
    return documentXml.slice(0, insertAt) + insertionXml + documentXml.slice(insertAt);
  }

  const bodyMatch = documentXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch || bodyMatch.index === undefined) {
    throw new Error('Invalid DOCX package: missing w:body.');
  }

  const bodyStart = bodyMatch.index + '<w:body>'.length;
  const bodyInnerXml = bodyMatch[1] ?? '';
  const sectionMatch = bodyInnerXml.match(/(<w:sectPr\b[\s\S]*?\/>|<w:sectPr\b[\s\S]*?<\/w:sectPr>)\s*$/);
  const sectionXml = sectionMatch?.[1] ?? '';
  const contentEnd = sectionMatch
    ? bodyStart + bodyInnerXml.length - sectionMatch[0].length
    : bodyStart + bodyInnerXml.length;

  if (position === 'start') {
    return documentXml.slice(0, bodyStart) + insertionXml + documentXml.slice(bodyStart);
  }

  const insertionPoint = sectionXml ? contentEnd : bodyStart + bodyInnerXml.length;
  return documentXml.slice(0, insertionPoint) + insertionXml + documentXml.slice(insertionPoint);
}

export function replaceParagraphInDocument(
  documentXml: string,
  replacementXml: string,
  anchor: ParagraphMatch,
): string {
  return documentXml.slice(0, anchor.start) + replacementXml + documentXml.slice(anchor.end);
}
