import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const COMPONENTS_DIR = join(import.meta.dir, '..', 'components');

function readComponentSource(name: string): string {
  return readFileSync(join(COMPONENTS_DIR, name), 'utf-8');
}

describe('untrusted html rendering contracts', () => {
  test('HtmlViewer uses the sandboxed html frame', () => {
    const source = readComponentSource('HtmlViewer.tsx');
    expect(source).toContain('SandboxedHtmlFrame');
  });

  test('HtmlViewer offers external-open fallback for blocked-preview html', () => {
    const source = readComponentSource('HtmlViewer.tsx');
    expect(source).toContain('htmlContainsBlockedPreviewContent');
    expect(source).toContain('Open in default browser');
  });

  test('EmailView does not inject remote html directly into the app DOM', () => {
    const source = readComponentSource('EmailView.tsx');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).toContain('SandboxedHtmlFrame');
  });
});
