import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

let markdownToTiptap: (markdown: string, baseDir?: string) => { type: 'doc'; content: Array<any> };
let tiptapToMarkdown: (doc: { type: 'doc'; content: Array<any> }) => string;
let previousWindow: unknown;

beforeAll(async () => {
  const globalObject = globalThis as any;
  previousWindow = globalObject.window;
  globalObject.window = globalObject.window ?? new EventTarget();
  globalObject.window.electron = globalObject.window.electron ?? undefined;

  const module = await import('./markdown-parser');
  markdownToTiptap = module.markdownToTiptap;
  tiptapToMarkdown = module.tiptapToMarkdown;
});

afterAll(() => {
  (globalThis as any).window = previousWindow;
});

describe('markdownToTiptap formatted file links', () => {
  test('converts bold-wrapped file links into file mentions', () => {
    const doc = markdownToTiptap('**[As we may think.pdf](file:///Users/example/Documents/My%20Workspace/As%20we%20may%20think.pdf)**');
    const firstNode = doc.content[0];
    const mention = firstNode?.content?.[0];

    expect(firstNode?.type).toBe('paragraph');
    expect(firstNode?.content).toHaveLength(1);
    expect(mention?.type).toBe('fileMention');
    expect(mention?.attrs?.label).toBe('As we may think.pdf');
    expect(mention?.attrs?.id).toBe('/Users/example/Documents/My Workspace/As we may think.pdf');
  });

  test('converts bold-wrapped file links inside ordered lists into file mentions', () => {
    const doc = markdownToTiptap('1. **[Sierra.jpeg](file:///Users/example/Documents/My%20Workspace/Sierra.jpeg)** (638 KB) - Image file');
    const listItemParagraph = doc.content[0]?.content?.[0]?.content?.[0];
    const mention = listItemParagraph?.content?.[0];
    const trailingText = listItemParagraph?.content?.[1];

    expect(doc.content[0]?.type).toBe('orderedList');
    expect(mention?.type).toBe('fileMention');
    expect(mention?.attrs?.label).toBe('Sierra.jpeg');
    expect(mention?.attrs?.id).toBe('/Users/example/Documents/My Workspace/Sierra.jpeg');
    expect(trailingText?.type).toBe('text');
    expect(trailingText?.text).toBe(' (638 KB) - Image file');
  });

  test('classifies markdown links by href instead of the visible label', () => {
    const doc = markdownToTiptap('[cost_model](cost_model.md)');
    const mention = doc.content[0]?.content?.[0];

    expect(mention?.type).toBe('fileMention');
    expect(mention?.attrs?.label).toBe('cost_model');
    expect(mention?.attrs?.id).toBe('cost_model.md');
    expect(mention?.attrs?.itemType).toBe('file');
  });

  test('serializes directory mentions with an explicit trailing slash for round trips', () => {
    const markdown = tiptapToMarkdown({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'fileMention',
          attrs: {
            id: 'factory/assets',
            label: 'assets',
            itemType: 'directory',
          },
        }],
      }],
    });

    expect(markdown).toBe('[assets](factory/assets/)');

    const roundTripped = markdownToTiptap(markdown);
    const mention = roundTripped.content[0]?.content?.[0];

    expect(mention?.attrs?.itemType).toBe('directory');
    expect(mention?.attrs?.id).toBe('factory/assets');
  });

  test('round-trips empty task list items without dropping or expanding them', () => {
    const markdown = '# Daily\n\n## Tasks\n\n- [ ]\n';
    const doc = markdownToTiptap(markdown);
    const taskList = doc.content.find((node) => node.type === 'taskList');
    const taskItem = taskList?.content?.[0];
    const paragraphContent = taskItem?.content?.[0]?.content;

    expect(taskList?.type).toBe('taskList');
    expect(taskItem?.type).toBe('taskItem');
    expect(paragraphContent).toHaveLength(1);
    expect(paragraphContent?.[0]?.type).toBe('text');

    const roundTripped = tiptapToMarkdown(doc);
    expect(roundTripped).toContain('- [ ]');
    expect(roundTripped).not.toContain('- [ ] ');
  });
});
