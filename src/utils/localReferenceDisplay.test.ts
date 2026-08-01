import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

let getLocalReferenceDisplayLabel: (options: {
  label: string;
  path?: string | null;
  itemType?: 'file' | 'directory' | 'browser-tab';
}) => string;
let stripMarkdownFileExtension: (name: string) => string;
let previousWindow: unknown;

beforeAll(async () => {
  const globalObject = globalThis as any;
  previousWindow = globalObject.window;
  globalObject.window = globalObject.window ?? new EventTarget();
  globalObject.window.electron = globalObject.window.electron ?? undefined;

  const module = await import('./localReferenceDisplay');
  getLocalReferenceDisplayLabel = module.getLocalReferenceDisplayLabel;
  stripMarkdownFileExtension = module.stripMarkdownFileExtension;
});

afterAll(() => {
  (globalThis as any).window = previousWindow;
});

describe('stripMarkdownFileExtension', () => {
  test('removes .md and .markdown suffixes', () => {
    expect(stripMarkdownFileExtension('Cost Model.md')).toBe('Cost Model');
    expect(stripMarkdownFileExtension('Cost Model.markdown')).toBe('Cost Model');
  });
});

describe('getLocalReferenceDisplayLabel', () => {
  test('normalizes raw markdown note filenames for display', () => {
    expect(getLocalReferenceDisplayLabel({
      label: 'cost_model.md',
      path: '/workspace/notes/cost_model.md',
      itemType: 'file',
    })).toBe('cost_model');
  });

  test('preserves custom aliases for markdown note references', () => {
    expect(getLocalReferenceDisplayLabel({
      label: 'Factory Cost Model',
      path: '/workspace/notes/cost_model.md',
      itemType: 'file',
    })).toBe('Factory Cost Model');
  });

  test('does not alter non-markdown file labels', () => {
    expect(getLocalReferenceDisplayLabel({
      label: 'diagram.png',
      path: '/workspace/assets/diagram.png',
      itemType: 'file',
    })).toBe('diagram.png');
  });
});
