import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { readWordTool } from './readWordTool';
import { setCurrentWorkspace } from '../../../utils/workspace';

async function createDocx(filePath: string, paragraphs: string[]): Promise<void> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  const body = paragraphs
    .map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${paragraph}</w:t></w:r></w:p>`)
    .join('');
  zip.folder('word')?.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await writeFile(filePath, buffer);
}

function buildParagraphs(paragraphCount: number, paragraphLength: number): string[] {
  return Array.from({ length: paragraphCount }, (_, index) => (
    `Paragraph-${index + 1}-` + 'x'.repeat(paragraphLength)
  ));
}

describe('readWordTool', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setCurrentWorkspace(null);
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  test('returns actionable error for large document reads without range', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'read-word-tool-test-'));
    const docxPath = join(tmpDir, 'large.docx');
    await createDocx(docxPath, buildParagraphs(280, 120));

    const result = await readWordTool.handler({ path: docxPath });
    const text = result.content?.[0]?.text ?? '';

    expect(result.isError).toBe(true);
    expect(text).toContain('Document content too large to read at once');
    expect(text).toContain('Use paragraph ranges to read in chunks');
    expect(text).toContain('start_paragraph=1');
    expect(text).toContain('start_paragraph=51');
  });

  test('reads a targeted paragraph range from a DOCX file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'read-word-tool-test-'));
    const docxPath = join(tmpDir, 'sample.docx');
    await createDocx(docxPath, [
      'Alpha clause',
      'Beta clause',
      'Gamma clause',
      'Delta clause',
    ]);

    const result = await readWordTool.handler({
      path: docxPath,
      start_paragraph: 2,
      end_paragraph: 3,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(text).toContain('[');
    expect(text).toContain('Paragraphs 2-3 of 4');
    expect(text).toContain('Beta clause');
    expect(text).toContain('Gamma clause');
    expect(text).not.toContain('Alpha clause');
    expect(text).not.toContain('Delta clause');
  });
});
