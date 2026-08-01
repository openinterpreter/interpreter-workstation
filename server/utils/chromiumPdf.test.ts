import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const ELECTRON_TEST_OVERRIDE_KEY = '__chromiumPdfElectronForTest';

let tempDirForTest: string | null = null;

afterEach(async () => {
  mock.restore();
  delete (globalThis as Record<string, unknown>)[ELECTRON_TEST_OVERRIDE_KEY];

  if (tempDirForTest) {
    await rm(tempDirForTest, { recursive: true, force: true });
    tempDirForTest = null;
  }
});

describe('chromiumPdf', () => {
  test('throws when not running in Electron', async () => {
    const { renderHtmlFileToPdf } = await import('./chromiumPdf');

    await expect(renderHtmlFileToPdf('/tmp/input.html', '/tmp/output.pdf')).rejects.toThrow(
      'Chromium PDF rendering requires Electron.'
    );
  });

  test('renders HTML to PDF using BrowserWindow.printToPDF', async () => {
    const generatedPdf = Buffer.from('%PDF-1.4\nfake-pdf\n', 'utf8');
    const calls: {
      loadedUrl?: string;
      executedScript?: string;
      printOptions?: Record<string, unknown>;
      destroyed: boolean;
    } = { destroyed: false };

    class FakeBrowserWindow {
      private destroyed = false;
      webContents = {
        loadURL: async (url: string) => {
          calls.loadedUrl = url;
        },
        executeJavaScript: async (script: string) => {
          calls.executedScript = script;
        },
        printToPDF: async (options: Record<string, unknown>) => {
          calls.printOptions = options;
          return generatedPdf;
        },
      };

      constructor(_options: unknown) {}

      isDestroyed(): boolean {
        return this.destroyed;
      }

      destroy(): void {
        this.destroyed = true;
        calls.destroyed = true;
      }
    }

    (globalThis as Record<string, unknown>)[ELECTRON_TEST_OVERRIDE_KEY] = {
      BrowserWindow: FakeBrowserWindow,
    };

    const { renderHtmlFileToPdf } = await import('./chromiumPdf');

    tempDirForTest = await mkdtemp(join(tmpdir(), 'chromium-pdf-test-'));
    const htmlPath = join(tempDirForTest, 'input.html');
    const outputPath = join(tempDirForTest, 'output.pdf');
    await writeFile(htmlPath, '<html><body><h1>Hello PDF</h1></body></html>', 'utf8');

    await renderHtmlFileToPdf(htmlPath, outputPath);

    const writtenPdf = await readFile(outputPath);
    expect(writtenPdf.equals(generatedPdf)).toBe(true);
    expect(calls.loadedUrl).toBe(pathToFileURL(htmlPath).toString());
    expect(calls.executedScript).toContain('document.readyState');
    expect(calls.printOptions).toMatchObject({
      printBackground: true,
      preferCSSPageSize: false,
      landscape: false,
      pageSize: 'Letter',
    });
    expect(calls.destroyed).toBe(true);
  });

  test('passes advanced print options through to Chromium', async () => {
    const generatedPdf = Buffer.from('%PDF-1.4\nfake-advanced\n', 'utf8');
    let capturedPrintOptions: Record<string, unknown> | undefined;

    class FakeBrowserWindow {
      private destroyed = false;
      webContents = {
        loadURL: async (_url: string) => {},
        executeJavaScript: async (_script: string) => {},
        printToPDF: async (options: Record<string, unknown>) => {
          capturedPrintOptions = options;
          return generatedPdf;
        },
      };

      constructor(_options: unknown) {}

      isDestroyed(): boolean {
        return this.destroyed;
      }

      destroy(): void {
        this.destroyed = true;
      }
    }

    (globalThis as Record<string, unknown>)[ELECTRON_TEST_OVERRIDE_KEY] = {
      BrowserWindow: FakeBrowserWindow,
    };

    const { renderHtmlFileToPdf } = await import('./chromiumPdf');

    tempDirForTest = await mkdtemp(join(tmpdir(), 'chromium-pdf-test-'));
    const htmlPath = join(tempDirForTest, 'input-advanced.html');
    const outputPath = join(tempDirForTest, 'output-advanced.pdf');
    await writeFile(htmlPath, '<html><body><p>Advanced options</p></body></html>', 'utf8');

    await renderHtmlFileToPdf(htmlPath, outputPath, {
      landscape: true,
      pageSize: { width: 11, height: 8.5 },
      preferCSSPageSize: false,
      printBackground: false,
      scale: 0.9,
      margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
      displayHeaderFooter: true,
      headerTemplate: '<span class="title"></span>',
      footerTemplate: '<span class="pageNumber"></span>/<span class="totalPages"></span>',
      pageRanges: '1-2',
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    });

    const writtenPdf = await readFile(outputPath);
    expect(writtenPdf.equals(generatedPdf)).toBe(true);
    expect(capturedPrintOptions).toMatchObject({
      landscape: true,
      pageSize: { width: 11, height: 8.5 },
      preferCSSPageSize: false,
      printBackground: false,
      scale: 0.9,
      margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
      displayHeaderFooter: true,
      headerTemplate: '<span class="title"></span>',
      footerTemplate: '<span class="pageNumber"></span>/<span class="totalPages"></span>',
      pageRanges: '1-2',
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    });
  });
});
