import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { readDocxTool } from './readDocxTool';
import { setCurrentWorkspace } from '../../../utils/workspace';

async function createDocx(filePath: string, paragraphCount: number, paragraphLength: number): Promise<void> {
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

  const paragraphs: string[] = [];
  for (let index = 1; index <= paragraphCount; index += 1) {
    const text = `Paragraph-${index}-` + 'x'.repeat(paragraphLength);
    paragraphs.push(`<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`);
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}<w:sectPr/></w:body></w:document>`;
  zip.folder('word')?.file('document.xml', documentXml);

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await writeFile(filePath, buffer);
}

describe('readDocxTool', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setCurrentWorkspace(null);
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  test('returns actionable error for large documents', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'read-docx-tool-test-'));
    const docxPath = join(tmpDir, 'large.docx');
    await createDocx(docxPath, 280, 120);

    const result = await readDocxTool.handler({ path: docxPath });
    const text = result.content?.[0]?.text ?? '';

    expect(result.isError).toBe(true);
    expect(text).toContain('Document too large to read at once');
    expect(text).toContain('Use read_word with paragraph ranges instead');
    expect(text).toContain('start_paragraph=1');
    expect(text).toContain('start_paragraph=51');
  });

  test('reads a small DOCX file as plaintext', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'read-docx-tool-test-'));
    const docxPath = join(tmpDir, 'small.docx');
    await createDocx(docxPath, 3, 12);

    const result = await readDocxTool.handler({ path: docxPath });
    const text = result.content?.[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(text).toContain('Successfully read Word document (3 paragraphs)');
    expect(text).toContain('Paragraph-1-');
    expect(text).toContain('Paragraph-2-');
    expect(text).toContain('Paragraph-3-');
  });
});
