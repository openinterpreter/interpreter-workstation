import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { replaceTextInDocxTool } from './replaceTextInDocxTool';
import { readWordTool } from './readWordTool';
import { setCurrentWorkspace } from '../../../utils/workspace';

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

describe('replaceTextInDocxTool', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    setCurrentWorkspace(null);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('replaces text that spans multiple runs', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'replace-docx-tool-'));
    const docxPath = join(tempDir, 'sample.docx');
    await createDocx(docxPath, [
      '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>',
    ]);

    const result = await replaceTextInDocxTool.handler({
      path: docxPath,
      replacements: [
        {
          old_text: 'Hello world',
          new_text: 'Hi there',
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.content?.[0]?.text).toContain('Updated DOCX');
    expect(result.content?.[0]?.text).toContain('"Hello world" -> "Hi there" (1 match)');

    const readResult = await readWordTool.handler({ path: docxPath });
    const text = readResult.content?.[0]?.text ?? '';

    expect(readResult.isError).toBe(false);
    expect(text).toContain('Hi there');
    expect(text).not.toContain('Hello world');
  });

  test('replaces every exact match when replace_all is true', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'replace-docx-tool-'));
    const docxPath = join(tempDir, 'sample.docx');
    await createDocx(docxPath, [
      '<w:p><w:r><w:t>Alpha clause</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Alpha clause</w:t></w:r></w:p>',
    ]);

    const result = await replaceTextInDocxTool.handler({
      path: docxPath,
      replacements: [
        {
          old_text: 'Alpha clause',
          new_text: 'Beta clause',
          replace_all: true,
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.content?.[0]?.text).toContain('(2 matches)');

    const updatedBuffer = await readFile(docxPath);
    const zip = await JSZip.loadAsync(updatedBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    expect(documentXml).toContain('Beta clause');
    expect(documentXml).not.toContain('Alpha clause');
  });

  test('fails without writing changes when exact text is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'replace-docx-tool-'));
    const docxPath = join(tempDir, 'sample.docx');
    await createDocx(docxPath, [
      '<w:p><w:r><w:t>Current text</w:t></w:r></w:p>',
    ]);
    const beforeBuffer = await readFile(docxPath);

    const result = await replaceTextInDocxTool.handler({
      path: docxPath,
      replacements: [
        {
          old_text: 'Missing text',
          new_text: 'Updated text',
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('exact DOCX text replacements were not found');
    expect(result.content?.[0]?.text).toContain('No changes were written');

    const afterBuffer = await readFile(docxPath);
    expect(afterBuffer.equals(beforeBuffer)).toBe(true);
  });

  test('preserves paragraph tab settings while applying replacements', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'replace-docx-tool-'));
    const docxPath = join(tempDir, 'sample.docx');
    await createDocx(docxPath, [
      [
        '<w:p>',
        '<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>',
        '<w:r><w:t>TERRY HARTSDALE’s social developmental history:</w:t></w:r>',
        '</w:p>',
      ].join(''),
      '<w:p><w:r><w:t>TERRY likes science.</w:t></w:r></w:p>',
    ]);

    const result = await replaceTextInDocxTool.handler({
      path: docxPath,
      replacements: [
        {
          old_text: 'TERRY HARTSDALE’s',
          new_text: 'JOHN SMITH’s',
          replace_all: true,
        },
        {
          old_text: 'TERRY',
          new_text: 'JOHN',
          replace_all: true,
        },
      ],
    });

    expect(result.isError).toBe(false);

    const updatedBuffer = await readFile(docxPath);
    const zip = await JSZip.loadAsync(updatedBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    expect(documentXml).toContain('<w:tabs>');
    expect(documentXml).toContain('JOHN SMITH’s social developmental history:');
    expect(documentXml).toContain('JOHN likes science.');

    const readResult = await readWordTool.handler({ path: docxPath });
    const text = readResult.content?.[0]?.text ?? '';
    expect(readResult.isError).toBe(false);
    expect(text).toContain('JOHN SMITH’s social developmental history:');
    expect(text).toContain('JOHN likes science.');
  });
});
