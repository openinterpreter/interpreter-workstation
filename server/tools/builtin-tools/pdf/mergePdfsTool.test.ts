import { describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { PDFDocument } from 'pdf-lib';
import { mergePdfsTool } from './mergePdfsTool';

async function createPdf(path: string, pageCount: number): Promise<void> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    pdf.addPage([612, 792]);
  }
  const bytes = await pdf.save();
  await writeFile(path, bytes);
}

describe('mergePdfsTool', () => {
  test('fileAccess marks inputs as read and output as write', () => {
    expect(mergePdfsTool.fileAccess?.mode).toBe('write');
    expect(mergePdfsTool.fileAccess?.pathArg).toEqual(['input_paths', 'output_path']);
    expect(mergePdfsTool.fileAccess?.pathArgModes).toEqual({
      input_paths: 'read',
      output_path: 'write',
    });
  });

  test('merges input PDFs in order into output PDF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merge-pdfs-tool-'));
    try {
      const inputA = join(dir, 'a.pdf');
      const inputB = join(dir, 'b.pdf');
      const output = join(dir, 'out', 'merged.pdf');
      await mkdir(join(dir, 'out'), { recursive: true });

      await createPdf(inputA, 1);
      await createPdf(inputB, 2);

      const result = await mergePdfsTool.handler({
        input_paths: [inputA, inputB],
        output_path: output,
      });

      expect(result.isError).toBe(false);
      const outputBytes = await readFile(output);
      const mergedPdf = await PDFDocument.load(outputBytes);
      expect(mergedPdf.getPageCount()).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('merges multiple repository sample PDFs into one output file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merge-pdfs-tool-samples-'));
    try {
      const fixtures = [
        {
          sourcePath: join(process.cwd(), 'resources', 'templates', 'sample.pdf'),
          outputName: '1-sample.pdf',
        },
        {
          sourcePath: join(process.cwd(), 'tests', 'fixtures', 'workspace-template', 'pdfs', 'test-pdf-form.pdf'),
          outputName: '2-test-pdf-form.pdf',
        },
        {
          sourcePath: join(process.cwd(), 'resources', 'sample-workspace', 'Demos', 'Fill PDF Form', 'Vendor Registration Form.pdf'),
          outputName: '3-Vendor-Registration-Form.pdf',
        },
      ];
      const inputDir = join(dir, 'inputs');
      const output = join(dir, 'out', 'merged-samples.pdf');
      await mkdir(inputDir, { recursive: true });
      await mkdir(join(dir, 'out'), { recursive: true });

      const inputPaths: string[] = [];
      for (const fixture of fixtures) {
        const inputPath = join(inputDir, fixture.outputName);
        await copyFile(fixture.sourcePath, inputPath);
        inputPaths.push(inputPath);
      }

      let expectedPageTotal = 0;
      for (const inputPath of inputPaths) {
        const sourceBytes = await readFile(inputPath);
        const sourcePdf = await PDFDocument.load(sourceBytes);
        expectedPageTotal += sourcePdf.getPageCount();
      }

      const result = await mergePdfsTool.handler({
        input_paths: inputPaths,
        output_path: output,
      });

      expect(result.isError).toBe(false);
      const outputBytes = await readFile(output);
      const mergedPdf = await PDFDocument.load(outputBytes);
      expect(mergedPdf.getPageCount()).toBe(expectedPageTotal);
      expect(result.content[0].text).toContain('Merged 3 PDFs into:');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns an error when fewer than 2 input PDFs are provided', async () => {
    const result = await mergePdfsTool.handler({
      input_paths: ['one.pdf'],
      output_path: 'merged.pdf',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least 2 PDF paths');
  });

  test('fails when output PDF already exists and does not overwrite it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merge-pdfs-tool-no-overwrite-'));
    try {
      const inputA = join(dir, 'a.pdf');
      const inputB = join(dir, 'b.pdf');
      const output = join(dir, 'out.pdf');

      await createPdf(inputA, 1);
      await createPdf(inputB, 2);
      await createPdf(output, 4);

      const beforeBytes = await readFile(output);
      const beforePdf = await PDFDocument.load(beforeBytes);
      expect(beforePdf.getPageCount()).toBe(4);

      const result = await mergePdfsTool.handler({
        input_paths: [inputA, inputB],
        output_path: output,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Output file already exists');

      const afterBytes = await readFile(output);
      const afterPdf = await PDFDocument.load(afterBytes);
      expect(afterPdf.getPageCount()).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
