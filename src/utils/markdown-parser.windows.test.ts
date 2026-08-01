import { beforeAll, describe, expect, test } from 'bun:test';

let markdownToTiptap: (markdown: string, baseDir?: string) => { type: 'doc'; content: Array<any> };

beforeAll(async () => {
  const globalObject = globalThis as any;
  globalObject.window = globalObject.window ?? {};
  globalObject.window.electron = globalObject.window.electron ?? undefined;

  const module = await import('./markdown-parser');
  markdownToTiptap = module.markdownToTiptap;
});

function getFirstMentionId(markdown: string, baseDir: string): string {
  const doc = markdownToTiptap(markdown, baseDir);
  const firstNode = doc.content[0];
  const mention = firstNode?.content?.[0];
  return String(mention?.attrs?.id ?? '');
}

function hasMixedSeparators(path: string): boolean {
  return path.includes('/') && path.includes('\\');
}

function hasDuplicatedDrivePrefix(path: string): boolean {
  return /^[A-Za-z]:[\\/][A-Za-z]:[\\/]/.test(path);
}

describe('markdownToTiptap windows path handling', () => {
  test('preserves Windows drive path when resolving parent directory segments', () => {
    const id = getFirstMentionId('[Readme](../README.md)', 'C:\\Users\\victor\\workspace\\docs');

    expect(id.startsWith('C:')).toBe(true);
    expect(id.includes('workspace')).toBe(true);
    expect(id.endsWith('README.md')).toBe(true);
    expect(hasMixedSeparators(id)).toBe(false);
    expect(hasDuplicatedDrivePrefix(id)).toBe(false);
  });

  test('does not prepend baseDir to absolute Windows paths', () => {
    const id = getFirstMentionId(
      '[Todo](C:\\Users\\victor\\notes\\todo.md)',
      'D:\\work\\project',
    );

    expect(id.startsWith('C:')).toBe(true);
    expect(id.includes('D:')).toBe(false);
    expect(id.endsWith('todo.md')).toBe(true);
    expect(hasMixedSeparators(id)).toBe(false);
    expect(hasDuplicatedDrivePrefix(id)).toBe(false);
  });

  test('parses CRLF markdown headings and task lists as rich nodes', () => {
    const doc = markdownToTiptap('# Heading\r\n\r\n- [ ] first task\r\n');

    expect(doc.content[0]?.type).toBe('heading');
    expect(doc.content[0]?.content?.[0]?.text).toBe('Heading');
    expect(doc.content[2]?.type).toBe('taskList');
    expect(doc.content[2]?.content?.[0]?.type).toBe('taskItem');
    expect(doc.content[2]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('first task');
  });
});
