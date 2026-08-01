import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { setCurrentWorkspace } from '../../../utils/workspace';
import { readWordTool } from './readWordTool';
import { replaceParagraphsInDocxTool } from './replaceParagraphsInDocxTool';
import { insertParagraphsInDocxTool } from './insertParagraphsInDocxTool';
import { insertTableInDocxTool } from './insertTableInDocxTool';
import { updateTableCellsInDocxTool } from './updateTableCellsInDocxTool';

async function createDocx(
  filePath: string,
  paragraphXmls: string[],
): Promise<void> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder('word')?.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphXmls.join('')}<w:sectPr/></w:body></w:document>`,
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await writeFile(filePath, buffer);
}

describe('structured DOCX tools', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    setCurrentWorkspace(null);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('appends paragraphs at the end of the document', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'structured-docx-tool-'));
    const docxPath = join(tempDir, 'notes.docx');
    await createDocx(docxPath, [
      '<w:p><w:r><w:t>Original note.</w:t></w:r></w:p>',
    ]);

    const result = await insertParagraphsInDocxTool.handler({
      path: docxPath,
      paragraphs: [
        'Additional note: Parent requested follow-up meeting in November 2023.',
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toContain('Paragraphs inserted: 1');

    const readResult = await readWordTool.handler({ path: docxPath });
    const text = readResult.content?.[0]?.text ?? '';
    expect(readResult.isError).toBe(false);
    expect(text).toContain('Original note.');
    expect(text).toContain('Additional note: Parent requested follow-up meeting in November 2023.');
  });

  test('inserts paragraphs after an anchor paragraph and inherits its formatting', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'structured-docx-tool-'));
    const docxPath = join(tempDir, 'styled.docx');
    await createDocx(docxPath, [
      [
        '<w:p>',
        '<w:pPr><w:spacing w:after="160"/></w:pPr>',
        '<w:r><w:rPr><w:b/></w:rPr><w:t>Section header</w:t></w:r>',
        '</w:p>',
      ].join(''),
      '<w:p><w:r><w:t>Existing body text.</w:t></w:r></w:p>',
    ]);

    const result = await insertParagraphsInDocxTool.handler({
      path: docxPath,
      paragraphs: ['Inserted follow-up paragraph.'],
      location: {
        position: 'after',
        paragraph_text: 'Section header',
      },
    });

    expect(result.isError).not.toBe(true);

    const outputBuffer = await readFile(docxPath);
    const zip = await JSZip.loadAsync(outputBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string') ?? '';

    expect(documentXml).toContain('Inserted follow-up paragraph.');
    expect(documentXml).toContain('<w:spacing w:after="160"/>');
    expect(documentXml).toContain('<w:b/>');
  });

  test('inserts a table after an anchor paragraph', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'structured-docx-tool-'));
    const docxPath = join(tempDir, 'report.docx');
    await createDocx(docxPath, [
      '<w:p><w:r><w:t>Assessment summary</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Existing closing note.</w:t></w:r></w:p>',
    ]);

    const result = await insertTableInDocxTool.handler({
      path: docxPath,
      rows: [
        ['Category', 'Status'],
        ['Attendance', 'Improving'],
        ['Reading', 'On target'],
      ],
      first_row_header: true,
      location: {
        position: 'after',
        paragraph_text: 'Assessment summary',
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toContain('Rows x columns: 3 x 2');

    const outputBuffer = await readFile(docxPath);
    const zip = await JSZip.loadAsync(outputBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string') ?? '';

    expect(documentXml).toContain('<w:tbl>');
    expect(documentXml).toContain('Category');
    expect(documentXml).toContain('Improving');
    expect(documentXml).toContain('<w:tblStyle w:val="TableGrid"/>');
  });

  test('replaces a paragraph with rewritten content and preserves formatting', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'structured-docx-tool-'));
    const docxPath = join(tempDir, 'rewrite.docx');
    await createDocx(docxPath, [
      '<w:p><w:r><w:t>Original lead paragraph.</w:t></w:r></w:p>',
      [
        '<w:p>',
        '<w:pPr><w:jc w:val="both"/></w:pPr>',
        '<w:r><w:rPr><w:i/></w:rPr><w:t>Draft science paragraph.</w:t></w:r>',
        '</w:p>',
      ].join(''),
      '<w:p><w:r><w:t>Closing note.</w:t></w:r></w:p>',
    ]);

    const result = await replaceParagraphsInDocxTool.handler({
      path: docxPath,
      target: {
        paragraph_text: 'Draft science paragraph.',
      },
      paragraphs: [
        'The Webb observations focus on why this atmospheric retrieval method matters for future studies of rocky planets around cool stars.',
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toContain('Paragraphs inserted: 1');

    const outputBuffer = await readFile(docxPath);
    const zip = await JSZip.loadAsync(outputBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string') ?? '';

    expect(documentXml).not.toContain('Draft science paragraph.');
    expect(documentXml).toContain('The Webb observations focus on why this atmospheric retrieval method matters for future studies of rocky planets around cool stars.');
    expect(documentXml).toContain('<w:jc w:val="both"/>');
    expect(documentXml).toContain('<w:i/>');
  });

  test('updates existing DOCX table cells and preserves cell formatting', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'structured-docx-tool-'));
    const docxPath = join(tempDir, 'table-update.docx');
    await createDocx(docxPath, [
      '<w:p><w:r><w:t>Report heading</w:t></w:r></w:p>',
      [
        '<w:tbl>',
        '<w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>',
        '<w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>',
        '<w:tr>',
        '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Name</w:t></w:r></w:p></w:tc>',
        '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc>',
        '</w:tr>',
        '<w:tr>',
        '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Old student</w:t></w:r></w:p></w:tc>',
        '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Pending</w:t></w:r></w:p></w:tc>',
        '</w:tr>',
        '</w:tbl>',
      ].join(''),
    ]);

    const result = await updateTableCellsInDocxTool.handler({
      path: docxPath,
      table_index: 1,
      cells: [
        { row_index: 2, column_index: 1, text: 'JOHN SMITH' },
        { row_index: 2, column_index: 2, text: 'Completed\nReviewed' },
      ],
    });

    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toContain('Cells updated: 2');

    const outputBuffer = await readFile(docxPath);
    const zip = await JSZip.loadAsync(outputBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string') ?? '';

    expect(documentXml).not.toContain('Old student');
    expect(documentXml).toContain('JOHN SMITH');
    expect(documentXml).toContain('Completed');
    expect(documentXml).toContain('Reviewed');
    expect(documentXml).toContain('<w:tcW w:w="2400" w:type="dxa"/>');
    expect(documentXml).toContain('<w:b/>');
  });
});
