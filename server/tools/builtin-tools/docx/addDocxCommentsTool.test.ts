import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { addDocxCommentsTool } from './addDocxCommentsTool';
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

describe('addDocxCommentsTool', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    setCurrentWorkspace(null);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('adds a Word comment to a paragraph selected by paragraph index', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'docx-comments-tool-'));
    const inputPath = join(tempDir, 'source.docx');
    const outputPath = join(tempDir, 'reviewed.docx');
    await createDocx(inputPath, [
      '<w:p><w:r><w:t>Alpha heading</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Beta clause requires a liability cap.</w:t></w:r></w:p>',
    ]);

    const result = await addDocxCommentsTool.handler({
      path: inputPath,
      output_path: outputPath,
      comments: [
        {
          paragraph_index: 2,
          comment_text: 'Add a fees-paid cap with standard carve-outs.',
          author: 'Interpreter',
          initials: 'I',
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.content?.[0]?.text).toContain('paragraph 2');

    const outputBuffer = await readFile(outputPath);
    const zip = await JSZip.loadAsync(outputBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    const commentsXml = await zip.file('word/comments.xml')?.async('string');
    const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
    const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string');

    expect(documentXml).toContain('<w:commentRangeStart w:id="0"/>');
    expect(documentXml).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(documentXml).toContain('<w:commentReference w:id="0"/>');
    expect(commentsXml).toContain('Add a fees-paid cap with standard carve-outs.');
    expect(relsXml).toContain('relationships/comments');
    expect(contentTypesXml).toContain('word/comments.xml');

    const sourceBuffer = await readFile(inputPath);
    const sourceZip = await JSZip.loadAsync(sourceBuffer);
    expect(await sourceZip.file('word/comments.xml')?.async('string')).toBeUndefined();
  });

  test('selects paragraphs by exact paragraph_text with occurrence disambiguation', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'docx-comments-tool-'));
    const inputPath = join(tempDir, 'source.docx');
    await createDocx(inputPath, [
      '<w:p><w:r><w:t>Repeated clause</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Repeated clause</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Unique clause</w:t></w:r></w:p>',
    ]);

    const result = await addDocxCommentsTool.handler({
      path: inputPath,
      comments: [
        {
          paragraph_text: 'Repeated clause',
          occurrence_index: 2,
          comment_text: 'Comment the second repeated paragraph only.',
        },
        {
          paragraph_text: 'Unique clause',
          comment_text: 'Comment the unique paragraph.',
        },
      ],
    });

    expect(result.isError).toBe(false);

    const outputBuffer = await readFile(inputPath);
    const zip = await JSZip.loadAsync(outputBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    const commentsXml = await zip.file('word/comments.xml')?.async('string');

    expect(documentXml?.match(/<w:commentRangeStart /g)?.length).toBe(2);
    expect(commentsXml).toContain('Comment the second repeated paragraph only.');
    expect(commentsXml).toContain('Comment the unique paragraph.');
  });

  test('fails without writing when the requested paragraph is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'docx-comments-tool-'));
    const inputPath = join(tempDir, 'source.docx');
    await createDocx(inputPath, [
      '<w:p><w:r><w:t>Only paragraph</w:t></w:r></w:p>',
    ]);
    const beforeBuffer = await readFile(inputPath);

    const result = await addDocxCommentsTool.handler({
      path: inputPath,
      comments: [
        {
          paragraph_index: 3,
          comment_text: 'Missing paragraph comment',
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('Paragraph 3 was not found');

    const afterBuffer = await readFile(inputPath);
    expect(afterBuffer.equals(beforeBuffer)).toBe(true);
  });
});
