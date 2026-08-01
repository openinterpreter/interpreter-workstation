import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { clearFileCache, setFileCache } from '../stores/fileStore';
import { resetWorkspaceStoreForTests, setWorkspacePathSnapshot } from '../stores/workspaceStore';

let resolveWikilinkTarget: (target: string) => { path: string; label: string; found: boolean };
let previousWindow: unknown;

beforeAll(async () => {
  const globalObject = globalThis as any;
  previousWindow = globalObject.window;
  globalObject.window = globalObject.window ?? new EventTarget();
  globalObject.window.electron = globalObject.window.electron ?? undefined;

  const module = await import('./wikilinkTargetResolver');
  resolveWikilinkTarget = module.resolveWikilinkTarget;
});

afterAll(() => {
  resetWorkspaceStoreForTests();
  (globalThis as any).window = previousWindow;
});

beforeEach(() => {
  clearFileCache();
  resetWorkspaceStoreForTests();
  setWorkspacePathSnapshot('/workspace');
});

describe('resolveWikilinkTarget', () => {
  test('returns a synthetic fallback path when no workspace is available', () => {
    setWorkspacePathSnapshot(null);

    expect(resolveWikilinkTarget('README')).toEqual({
      path: 'README.md',
      label: 'README',
      found: false,
    });
  });

  test('matches nested workspace-relative wikilinks without hardcoded separators', () => {
    setFileCache([
      {
        path: '/workspace/wiki/costs/cost_model.md',
        name: 'cost_model.md',
        type: 'file',
      },
    ]);

    expect(resolveWikilinkTarget('wiki/costs/cost_model')).toEqual({
      path: '/workspace/wiki/costs/cost_model.md',
      label: 'cost_model',
      found: true,
    });
  });

  test('matches .markdown files for relative wikilinks', () => {
    setFileCache([
      {
        path: '/workspace/wiki/costs/cost_model.markdown',
        name: 'cost_model.markdown',
        type: 'file',
      },
    ]);

    expect(resolveWikilinkTarget('wiki/costs/cost_model')).toEqual({
      path: '/workspace/wiki/costs/cost_model.markdown',
      label: 'cost_model',
      found: true,
    });
  });

  test('matches human-readable wikilinks to hyphen-case markdown filenames', () => {
    setFileCache([
      {
        path: '/workspace/wiki/concepts/persistent-wiki.md',
        name: 'persistent-wiki.md',
        type: 'file',
      },
    ]);

    expect(resolveWikilinkTarget('Persistent Wiki')).toEqual({
      path: '/workspace/wiki/concepts/persistent-wiki.md',
      label: 'Persistent Wiki',
      found: true,
    });
  });

  test('matches Windows-style relative paths through the browser fallback path helpers', () => {
    setWorkspacePathSnapshot('C:\\workspace');
    setFileCache([
      {
        path: 'C:\\workspace\\wiki\\costs\\cost_model.md',
        name: 'cost_model.md',
        type: 'file',
      },
    ]);

    expect(resolveWikilinkTarget('wiki/costs/cost_model')).toEqual({
      path: 'C:\\workspace\\wiki\\costs\\cost_model.md',
      label: 'cost_model',
      found: true,
    });
  });

  test('prefers relative path intent when spaces map onto hyphen-case segments', () => {
    setFileCache([
      {
        path: '/workspace/archive/Persistent Wiki.md',
        name: 'Persistent Wiki.md',
        type: 'file',
      },
      {
        path: '/workspace/wiki/concepts/persistent-wiki.md',
        name: 'persistent-wiki.md',
        type: 'file',
      },
    ]);

    expect(resolveWikilinkTarget('wiki/concepts/Persistent Wiki')).toEqual({
      path: '/workspace/wiki/concepts/persistent-wiki.md',
      label: 'Persistent Wiki',
      found: true,
    });
  });
});
