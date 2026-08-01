import { writeFile } from 'fs/promises';
import { pathToFileURL } from 'url';

const ELECTRON_TEST_OVERRIDE_KEY = '__chromiumPdfElectronForTest';

export interface ChromiumPdfMargins {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface ChromiumPdfPageSize {
  width: number;
  height: number;
}

export interface ChromiumPdfOptions {
  timeoutMs?: number;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
  landscape?: boolean;
  pageSize?: string | ChromiumPdfPageSize;
  scale?: number;
  margins?: ChromiumPdfMargins;
  displayHeaderFooter?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  pageRanges?: string;
  generateTaggedPDF?: boolean;
  generateDocumentOutline?: boolean;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function getElectronForPdf(): { BrowserWindow: any } {
  const override = (globalThis as Record<string, any>)[ELECTRON_TEST_OVERRIDE_KEY];
  if (override && typeof override === 'object') {
    return override;
  }
  return require('electron');
}

export function isChromiumPdfRuntimeAvailable(): boolean {
  const override = (globalThis as Record<string, any>)[ELECTRON_TEST_OVERRIDE_KEY];
  return !!override || !!process.versions.electron;
}

async function waitForDocumentReady(webContents: any, timeoutMs: number): Promise<void> {
  const script = `
    (async () => {
      if (document.readyState === 'loading') {
        await new Promise((resolve) => {
          document.addEventListener('DOMContentLoaded', () => resolve(undefined), { once: true });
        });
      }

      if (document.fonts && document.fonts.ready) {
        try {
          await document.fonts.ready;
        } catch {
          // Ignore font loading failures and continue printing.
        }
      }

      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
      });
    })();
  `;

  await withTimeout(
    webContents.executeJavaScript(script, true),
    timeoutMs,
    'Waiting for HTML render'
  );
}

export async function renderHtmlFileToPdf(
  htmlPath: string,
  outputPdfPath: string,
  options: ChromiumPdfOptions = {}
): Promise<void> {
  if (!isChromiumPdfRuntimeAvailable()) {
    throw new Error('Chromium PDF rendering requires Electron.');
  }

  const { BrowserWindow } = getElectronForPdf();
  const timeoutMs = options.timeoutMs ?? 45_000;

  const printWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1800,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    const fileUrl = pathToFileURL(htmlPath).toString();
    await withTimeout(
      printWindow.webContents.loadURL(fileUrl),
      timeoutMs,
      'Loading HTML for PDF generation'
    );

    await waitForDocumentReady(printWindow.webContents, timeoutMs);

    const printOptions = {
      printBackground: options.printBackground ?? true,
      preferCSSPageSize: options.preferCSSPageSize ?? false,
      landscape: options.landscape ?? false,
      pageSize: options.pageSize ?? 'Letter',
      scale: options.scale,
      margins: options.margins,
      displayHeaderFooter: options.displayHeaderFooter,
      headerTemplate: options.headerTemplate,
      footerTemplate: options.footerTemplate,
      pageRanges: options.pageRanges,
      generateTaggedPDF: options.generateTaggedPDF,
      generateDocumentOutline: options.generateDocumentOutline,
    };

    const pdfBuffer = await withTimeout<Buffer>(
      printWindow.webContents.printToPDF(printOptions) as Promise<Buffer>,
      timeoutMs,
      'Generating PDF'
    );

    await writeFile(outputPdfPath, pdfBuffer);
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.destroy();
    }
  }
}
