import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';

const SAMPLE_WORKSPACE_DIR = resolve(process.cwd(), 'resources/sample-workspace');
const WELCOME_MD_PATH = resolve(SAMPLE_WORKSPACE_DIR, 'Welcome.md');

function extractMarkdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}

function isExternalHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:|data:|blob:|browser:\/\/)/i.test(href);
}

describe('sample workspace welcome links', () => {
  test('uses local relative markdown links (not machine-specific absolute paths)', () => {
    const markdown = readFileSync(WELCOME_MD_PATH, 'utf8');
    const links = extractMarkdownLinks(markdown);

    expect(links.length).toBeGreaterThan(0);

    for (const href of links) {
      expect(href.startsWith('/')).toBe(false);
      expect(href.startsWith('file://')).toBe(false);
      expect(/^[A-Za-z]:[\\/]/.test(href)).toBe(false);
      expect(isExternalHref(href)).toBe(false);
    }
  });

  test('all welcome links resolve to bundled sample workspace files', () => {
    const markdown = readFileSync(WELCOME_MD_PATH, 'utf8');
    const links = extractMarkdownLinks(markdown);

    expect(links.length).toBeGreaterThan(0);

    for (const linkPath of links) {
      const resolvedPath = resolve(SAMPLE_WORKSPACE_DIR, decodeURIComponent(linkPath));

      expect(existsSync(resolvedPath)).toBe(true);

      const rel = relative(SAMPLE_WORKSPACE_DIR, resolvedPath);
      expect(rel.startsWith('..')).toBe(false);
      expect(isAbsolute(rel)).toBe(false);
    }
  });

  test('sample workspace uses demo-oriented paths in visible instructions', async () => {
    const textFiles = [
      'Welcome.md',
      'Notes/Use Cases.md',
      'Notes/The New Knowledge Worker.md',
    ];
    const zippedTextFiles = [
      { path: 'Demos/Fill PDF Form/Vendor Information.docx', entries: ['word/document.xml'] },
      {
        path: 'Demos/Expense Tracker/Expense Tracker.xlsx',
        entries: [
          'xl/worksheets/sheet1.xml',
          'xl/sharedStrings.xml',
        ],
      },
    ];

    const contentParts = textFiles.map((filePath) => (
      readFileSync(resolve(SAMPLE_WORKSPACE_DIR, filePath), 'utf8')
    ));

    for (const { path: filePath, entries } of zippedTextFiles) {
      const zip = await JSZip.loadAsync(readFileSync(resolve(SAMPLE_WORKSPACE_DIR, filePath)));
      for (const entry of entries) {
        const file = zip.file(entry);
        if (file) {
          contentParts.push(await file.async('string'));
        }
      }
    }

    const allContent = contentParts.join('\n');

    expect(existsSync(resolve(SAMPLE_WORKSPACE_DIR, 'Forms'))).toBe(false);
    expect(existsSync(resolve(SAMPLE_WORKSPACE_DIR, 'Finance'))).toBe(false);
    expect(existsSync(resolve(SAMPLE_WORKSPACE_DIR, 'summarize-folder'))).toBe(false);
    expect(existsSync(resolve(SAMPLE_WORKSPACE_DIR, 'Demos/Fill PDF Form/Vendor Registration Form.pdf'))).toBe(true);
    expect(existsSync(resolve(SAMPLE_WORKSPACE_DIR, 'Demos/Fill PDF Form/Vendor Information.docx'))).toBe(true);
    expect(existsSync(resolve(SAMPLE_WORKSPACE_DIR, 'Demos/Expense Tracker/Expense Tracker.xlsx'))).toBe(true);
    expect(existsSync(resolve(SAMPLE_WORKSPACE_DIR, 'Demos/Expense Tracker/receipt.jpg'))).toBe(true);

    expect(allContent).not.toContain('agent on the right');
    expect(allContent).not.toContain('Vendor_Information');
    expect(allContent).not.toContain('Vendor_Registration');
    expect(allContent).not.toContain('@Forms/');
    expect(allContent).not.toContain('@Finance/');
    expect(allContent).not.toContain('@receipt.jpg');
    expect(allContent).not.toContain('Client Intake');
    expect(allContent).not.toContain('summarize-folder');
    expect(allContent).toContain('New agent in sidebar');
    expect(allContent).toContain('@Demos/Expense Tracker/receipt.jpg');
    expect(allContent).toContain('@Demos/Fill PDF Form/Vendor Information.docx');
    expect(allContent).toContain('fill row 9 in this expense tracker');
  });

  test('expense tracker demo row starts empty and formulas include it', async () => {
    const zip = await JSZip.loadAsync(readFileSync(resolve(
      SAMPLE_WORKSPACE_DIR,
      'Demos/Expense Tracker/Expense Tracker.xlsx',
    )));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string');

    expect(sheetXml).toBeTruthy();
    expect(sheetXml).toContain('r="A9"');
    expect(sheetXml).toContain('SUM(E5:E9)');
    expect(sheetXml).toContain('SUMIF(F5:F9');
    expect(sheetXml).toContain('SUMIF(D5:D9');
    expect(sheetXml).not.toContain('<c r="A9" s="6" t="inlineStr">');
    expect(sheetXml).not.toContain('<c r="B9" s="7" t="inlineStr">');
    expect(sheetXml).toContain('mergeCell ref="A13:H14"');
    expect(sheetXml).not.toContain('mergeCell ref="A9:');
  });
});
