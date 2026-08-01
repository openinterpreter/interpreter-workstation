import { describe, test, expect } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readPdfStructure } from './pdfStructure';
import { getPdfjs } from './pdfLoader';

describe('readPdfStructure', () => {
  // NOTE(victor): Two full PDF loads (pdfjs + pdf-lib each) can exceed 5s on Windows CI
  test('specificPage filters form fields to that page', async () => {
    const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/workspace-template/pdfs/sample-form.pdf');

    const full = await readPdfStructure(fixturePath);
    const fullFieldPages = new Set(
      full.elements
        .filter((el) => el.type === 'formField')
        .map((el) => el.page)
    );

    // Sanity check this fixture has multi-page fields so the assertion is meaningful.
    expect(fullFieldPages.has(1)).toBe(true);
    expect(fullFieldPages.size).toBeGreaterThan(1);

    const page1 = await readPdfStructure(fixturePath, 1);
    const page1FieldPages = new Set(
      page1.elements
        .filter((el) => el.type === 'formField')
        .map((el) => el.page)
    );

    expect(page1FieldPages.size).toBeGreaterThan(0);
    expect(page1FieldPages.size).toBe(1);
    expect(page1FieldPages.has(1)).toBe(true);
  }, 15_000);

  test('text bbox y uses top-of-text instead of baseline for pdfjs text items', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-structure-test-'));
    const fixturePath = path.join(tempDir, 'baseline-check.pdf');

    try {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText('BaselineCheck', {
        x: 120,
        y: 420,
        size: 24,
        font
      });
      await writeFile(fixturePath, await doc.save());

      const pdfjs = await getPdfjs();
      const pdfBytes = await readFile(fixturePath);
      const pdfProxy = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
      try {
        const pdfPage = await pdfProxy.getPage(1);
        const viewport = pdfPage.getViewport({ scale: 1.0 });
        const textContent = await pdfPage.getTextContent();
        const textItem = (textContent.items as any[]).find((item) => item.str?.includes('BaselineCheck'));

        expect(textItem).toBeTruthy();

        const itemHeight = textItem.height || Math.abs(textItem.transform[3]);
        const expectedTopY = viewport.height - textItem.transform[5] - itemHeight;

        const structure = await readPdfStructure(fixturePath, 1);
        const extracted = structure.elements.find(
          (el) => el.type === 'text' && el.text?.includes('BaselineCheck')
        );

        expect(extracted).toBeTruthy();
        expect(Math.abs((extracted?.bbox.y ?? 0) - expectedTopY)).toBeLessThan(1);
      } finally {
        await pdfProxy.destroy();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});
