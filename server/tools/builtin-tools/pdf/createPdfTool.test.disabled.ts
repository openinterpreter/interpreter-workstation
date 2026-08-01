import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setCurrentWorkspace } from '../../../utils/workspace';
import { globalFileAccessResolver } from '../../../globalFileAccessResolver';

const KEEP_TEST_PDFS = process.env.KEEP_TEST_PDFS === '1';
const PERSIST_DIR = join(process.cwd(), 'tmp', 'pdf-test-outputs');
const ELECTRON_TEST_OVERRIDE_KEY = '__chromiumPdfElectronForTest';

let tempDirForTest: string | null = null;
const preservedPdfPaths: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  if (KEEP_TEST_PDFS) {
    await mkdir(PERSIST_DIR, { recursive: true });
    return mkdtemp(join(PERSIST_DIR, `${prefix}-`));
  }
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

afterEach(async () => {
  setCurrentWorkspace(null);
  delete (globalThis as Record<string, unknown>)[ELECTRON_TEST_OVERRIDE_KEY];

  if (tempDirForTest && !KEEP_TEST_PDFS) {
    await rm(tempDirForTest, { recursive: true, force: true });
  }
  tempDirForTest = null;
});

afterAll(() => {
  if (KEEP_TEST_PDFS && preservedPdfPaths.length > 0) {
    console.log('[createPdfTool.test] Preserved PDF outputs:');
    for (const filePath of preservedPdfPaths) {
      console.log(filePath);
    }
  }
});

describe('createPdfTool', () => {
  test('forwards page layout options to Chromium renderer', async () => {
    const generatedPdfBytes = Buffer.from('%PDF-1.4\nfake-pdf\n', 'utf8');
    const capturedPrintOptions: Array<Record<string, unknown>> = [];
    class FakeBrowserWindow {
      private destroyed = false;
      webContents = {
        loadURL: async (_url: string) => {},
        executeJavaScript: async (_script: string) => {},
        printToPDF: async (options: Record<string, unknown>) => {
          capturedPrintOptions.push(options);
          return generatedPdfBytes;
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

    const { createPdfTool } = await import('./createPdfTool');

    tempDirForTest = await makeTempDir('create-pdf-tool-test');
    setCurrentWorkspace(tempDirForTest);

    const result1 = await createPdfTool.handler({
      path: 'output.pdf',
      content: '<html><body><h1>Hello</h1></body></html>',
      orientation: 'landscape',
      page_size: { width_in: 11, height_in: 8.5 },
      prefer_css_page_size: false,
      print_background: false,
      scale: 0.92,
      margins: { top_in: 0.5, bottom_in: 0.5, left_in: 0.4, right_in: 0.4 },
      display_header_footer: true,
      header_template: '<span class="title"></span>',
      footer_template: '<span class="pageNumber"></span>/<span class="totalPages"></span>',
      page_ranges: '1-2',
    });

    expect(result1.isError).toBe(false);
    expect(capturedPrintOptions[0]).toMatchObject({
      landscape: true,
      pageSize: { width: 11, height: 8.5 },
      preferCSSPageSize: false,
      printBackground: false,
      scale: 0.92,
      margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
      displayHeaderFooter: true,
      headerTemplate: '<span class="title"></span>',
      footerTemplate: '<span class="pageNumber"></span>/<span class="totalPages"></span>',
      pageRanges: '1-2',
    });

    const outputBytes = await readFile(join(tempDirForTest, 'output.pdf'));
    expect(outputBytes.equals(generatedPdfBytes)).toBe(true);
    preservedPdfPaths.push(join(tempDirForTest, 'output.pdf'));

    const result2 = await createPdfTool.handler({
      path: 'named-page-size.pdf',
      content: '<html><body><h1>Named Page Size</h1></body></html>',
      page_size: 'letter',
      header_template: '<span class="title"></span>',
      footer_template: '<span class="pageNumber"></span>/<span class="totalPages"></span>',
    });

    expect(result2.isError).toBe(false);
    expect(capturedPrintOptions[1]).toMatchObject({
      pageSize: 'Letter',
      displayHeaderFooter: true,
      preferCSSPageSize: false,
      printBackground: true,
    });
    const outputBytes2 = await readFile(join(tempDirForTest, 'named-page-size.pdf'));
    expect(outputBytes2.equals(generatedPdfBytes)).toBe(true);
    preservedPdfPaths.push(join(tempDirForTest, 'named-page-size.pdf'));

    const result3 = await createPdfTool.handler({
      path: 'default-standard.pdf',
      content: '<html><body><h1>Defaults</h1></body></html>',
    });

    expect(result3.isError).toBe(false);
    expect(capturedPrintOptions[2]).toMatchObject({
      landscape: false,
      pageSize: 'Letter',
      preferCSSPageSize: false,
      printBackground: true,
    });
    const outputBytes3 = await readFile(join(tempDirForTest, 'default-standard.pdf'));
    expect(outputBytes3.equals(generatedPdfBytes)).toBe(true);
    preservedPdfPaths.push(join(tempDirForTest, 'default-standard.pdf'));
  });

  test('denies writes when the agent lacks permission', async () => {
    class FakeBrowserWindow {
      private destroyed = false;
      webContents = {
        loadURL: async (_url: string) => {},
        executeJavaScript: async (_script: string) => {},
        printToPDF: async (_options: Record<string, unknown>) => {
          throw new Error('printToPDF should not run when permission is denied');
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

    const { createPdfTool } = await import('./createPdfTool');

    tempDirForTest = await makeTempDir('create-pdf-tool-permission-test');
    setCurrentWorkspace(tempDirForTest);

    const originalGetPermissions = globalFileAccessResolver.resolveForRequester.bind(globalFileAccessResolver);
    (globalFileAccessResolver as any).getPermissions = () => ({
      system: 'none',
      workspace: 'none',
      customPaths: {},
    });

    try {
      const result = await createPdfTool.handler(
        {
          path: join(tempDirForTest, 'denied.pdf'),
          content: '<html><body>denied</body></html>',
        },
        {
          agentId: 'agent-test',
          workspace: tempDirForTest,
        }
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type).toBe('text');
      if (result.content[0]?.type === 'text') {
        expect(result.content[0].text).toContain('Permission denied');
      }
    } finally {
      (globalFileAccessResolver as any).getPermissions = originalGetPermissions;
    }
  });

  const validationCases: Array<{
    name: string;
    args: Record<string, unknown>;
    expectedError: string;
  }> = [
    {
      name: 'invalid orientation value',
      args: { orientation: 'diagonal' },
      expectedError: 'Invalid orientation',
    },
    {
      name: 'invalid page size name',
      args: { page_size: 'A7' },
      expectedError: 'Invalid page_size',
    },
    {
      name: 'invalid page size object',
      args: { page_size: { width_in: 0, height_in: 11 } },
      expectedError: 'width_in and height_in must be positive numbers',
    },
    {
      name: 'invalid margins type',
      args: { margins: 'none' },
      expectedError: 'Invalid margins',
    },
    {
      name: 'negative margin',
      args: { margins: { top_in: -1 } },
      expectedError: 'Invalid margins.top_in',
    },
    {
      name: 'invalid prefer_css_page_size type',
      args: { prefer_css_page_size: 'yes' },
      expectedError: 'Invalid prefer_css_page_size',
    },
    {
      name: 'invalid print_background type',
      args: { print_background: 1 },
      expectedError: 'Invalid print_background',
    },
    {
      name: 'invalid display_header_footer type',
      args: { display_header_footer: 'on' },
      expectedError: 'Invalid display_header_footer',
    },
    {
      name: 'invalid scale',
      args: { scale: 0 },
      expectedError: 'Invalid scale',
    },
    {
      name: 'header template wrong type',
      args: { header_template: 123 },
      expectedError: 'header_template must be a string',
    },
    {
      name: 'footer template wrong type',
      args: { footer_template: 456 },
      expectedError: 'footer_template must be a string',
    },
    {
      name: 'page ranges wrong type',
      args: { page_ranges: 9 },
      expectedError: 'page_ranges must be a string',
    },
    {
      name: 'header footer provided while display_header_footer false',
      args: {
        display_header_footer: false,
        header_template: '<span class="title"></span>',
      },
      expectedError: 'header_template/footer_template provided but display_header_footer is false',
    },
  ];

  for (const validationCase of validationCases) {
    test(`returns validation error: ${validationCase.name}`, async () => {
      const { createPdfTool } = await import('./createPdfTool');

      const result = await createPdfTool.handler({
        path: 'output.pdf',
        content: '<html><body>validation</body></html>',
        ...validationCase.args,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type).toBe('text');
      if (result.content[0]?.type === 'text') {
        expect(result.content[0].text).toContain(validationCase.expectedError);
      }
    });
  }
});
