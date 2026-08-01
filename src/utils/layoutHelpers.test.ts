import { beforeAll, describe, expect, test } from 'bun:test';

let createFolderTab: typeof import('./layoutHelpers').createFolderTab;
let findFolderTabByPath: typeof import('./layoutHelpers').findFolderTabByPath;
let isValidLayoutState: typeof import('./layoutHelpers').isValidLayoutState;

beforeAll(async () => {
  const globalObject = globalThis as any;
  globalObject.window = globalObject.window ?? {};
  globalObject.window.electron = globalObject.window.electron ?? undefined;

  const module = await import('./layoutHelpers');
  createFolderTab = module.createFolderTab;
  findFolderTabByPath = module.findFolderTabByPath;
  isValidLayoutState = module.isValidLayoutState;
});

describe('layoutHelpers folder tabs', () => {
  test('creates folder tabs with normalized paths and folder type', () => {
    const tab = createFolderTab('/workspace/skills/my-skill/');

    expect(tab.type).toBe('folder');
    expect(tab.path).toBe('/workspace/skills/my-skill');
    expect(tab.label).toBe('my-skill');
  });

  test('finds an existing folder tab even when the incoming path has a trailing separator', () => {
    const tab = createFolderTab('/workspace/skills/my-skill');

    const match = findFolderTabByPath({ [tab.id]: tab }, '/workspace/skills/my-skill/');

    expect(match?.id).toBe(tab.id);
  });

  test('accepts persisted layout state containing folder tabs', () => {
    const folderTab = createFolderTab('/workspace/skills/my-skill');

    expect(isValidLayoutState({
      version: 6,
      tree: {
        kind: 'pane',
        id: 'pane-1',
        tabIds: [folderTab.id],
        activeTabId: folderTab.id,
      },
      tabs: {
        [folderTab.id]: folderTab,
      },
      activePaneId: 'pane-1',
      activeTabRegion: 'main',
      sidebarPane: null,
      sidebarWidth: 320,
      sidebarOpen: false,
      leftSidebar: {
        isOpen: true,
        width: 320,
        activeTab: 'explorer',
      },
      rightSidebar: {
        isOpen: true,
        width: 320,
      },
    })).toBe(true);
  });
});
