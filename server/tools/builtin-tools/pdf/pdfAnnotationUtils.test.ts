import { describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPdfStructure } from '../../../utils/pdfStructure';
import {
  addAnnotationsToPdf,
  addImageAnnotationsToPdf,
  removeAnnotationsFromPdf,
} from './pdfAnnotationUtils';

const SAMPLE_PDF = join(
  process.cwd(),
  'resources',
  'sample-workspace',
  'Demos',
  'Fill PDF Form',
  'Vendor Registration Form.pdf',
);
const SAMPLE_IMAGE = join(process.cwd(), 'resources', 'sample-workspace', 'Demos', 'Expense Tracker', 'receipt.jpg');

function assertTraditionalXref(bytes: Buffer): void {
  const pdfText = bytes.toString('latin1');
  expect(pdfText.includes('/ObjStm')).toBe(false);
  expect(pdfText.includes('/Type/XRef') || pdfText.includes('/Type /XRef')).toBe(false);
  expect(pdfText.includes('\nxref\n')).toBe(true);
}

async function makeTempPdfCopy(): Promise<{ dir: string; pdfPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pdf-annotation-utils-'));
  const pdfPath = join(dir, 'sample.pdf');
  await copyFile(SAMPLE_PDF, pdfPath);
  return { dir, pdfPath };
}

describe('pdfAnnotationUtils save options', () => {
  test('addAnnotationsToPdf writes non-object-stream PDFs and stays readable', async () => {
    const { dir, pdfPath } = await makeTempPdfCopy();
    try {
      const addResult = await addAnnotationsToPdf(pdfPath, [
        {
          page: 1,
          x: 48,
          y: 64,
          text: 'जैसा हम सोच सकते हैं - वैनेवर बुश द्वारा',
          fontSize: 14,
        },
      ]);

      expect(addResult.success).toBe(true);
      expect(addResult.createdIds.length).toBe(1);

      const bytes = await readFile(pdfPath);
      assertTraditionalXref(bytes);

      const structure = await readPdfStructure(pdfPath, 1);
      expect(structure.elements.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('removeAnnotationsFromPdf writes non-object-stream PDFs', async () => {
    const { dir, pdfPath } = await makeTempPdfCopy();
    try {
      const addResult = await addAnnotationsToPdf(pdfPath, [
        { page: 1, x: 48, y: 64, text: 'temporary annotation', fontSize: 12 },
      ]);
      expect(addResult.success).toBe(true);
      expect(addResult.createdIds.length).toBe(1);

      const removeResult = await removeAnnotationsFromPdf(pdfPath, addResult.createdIds);
      expect(removeResult.success).toBe(true);
      expect(removeResult.removedCount).toBe(1);

      const bytes = await readFile(pdfPath);
      assertTraditionalXref(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('addImageAnnotationsToPdf writes non-object-stream PDFs', async () => {
    const { dir, pdfPath } = await makeTempPdfCopy();
    try {
      const addImageResult = await addImageAnnotationsToPdf(pdfPath, [
        {
          page: 1,
          x: 72,
          y: 72,
          width: 64,
          height: 64,
          imagePath: SAMPLE_IMAGE,
        },
      ]);

      expect(addImageResult.success).toBe(true);
      expect(addImageResult.createdIds.length).toBe(1);

      const bytes = await readFile(pdfPath);
      assertTraditionalXref(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
