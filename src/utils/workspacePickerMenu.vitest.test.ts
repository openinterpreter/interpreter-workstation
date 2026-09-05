import { describe, expect, test, vi } from 'vitest';

vi.mock('@/ipc', () => ({
  pathBasename: (inputPath: string) => inputPath.split('/').pop() || inputPath,
  pathDirname: (inputPath: string) => inputPath.slice(0, inputPath.lastIndexOf('/')) || '/',
}));

import { buildWorkspacePickerMenuItems } from './workspacePickerMenu';

function buildMenu(options?: {
  noteWorkspaces?: Array<{
    path: string;
    name: string;
    source: 'obsidian';
  }>;
  onScanNoteWorkspaces?: () => void;
  includeNativeFileManagerActions?: boolean;
}) {
  return buildWorkspacePickerMenuItems({
    workspacePath: '/Users/test/project',
    recentFolders: [],
    noteWorkspaces: options?.noteWorkspaces ?? [],
    revealWorkspaceLabel: 'Reveal in Finder',
    onRevealWorkspace: vi.fn(),
    onOpenFolder: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onScanNoteWorkspaces: options?.onScanNoteWorkspaces,
    includeNativeFileManagerActions: options?.includeNativeFileManagerActions,
  });
}

describe('workspace picker menu', () => {
  test('offers an explicit scan without starting it while the menu is built', () => {
    const onScanNoteWorkspaces = vi.fn();
    const items = buildMenu({ onScanNoteWorkspaces });

    expect(onScanNoteWorkspaces).not.toHaveBeenCalled();
    const scanItem = items.find((item) => item.label === 'Scan for note workspaces…');
    expect(scanItem).toBeDefined();

    scanItem?.onClick?.();
    expect(onScanNoteWorkspaces).toHaveBeenCalledTimes(1);
  });

  test('labels the explicit action as a rescan after saved results exist', () => {
    const items = buildMenu({
      noteWorkspaces: [{
        path: '/Users/test/Notes',
        name: 'Notes',
        source: 'obsidian',
      }],
      onScanNoteWorkspaces: vi.fn(),
    });

    expect(items.some((item) => item.label === 'Rescan for note workspaces…')).toBe(true);
  });

  test('omits display-device file-manager actions for a remote browser host', () => {
    const items = buildMenu({ includeNativeFileManagerActions: false });

    expect(items.some((item) => item.label === 'Reveal in Finder')).toBe(false);
    expect(items.some((item) => item.label === 'Open folder...')).toBe(false);
    expect(items.some((item) => item.label === 'Open parent folder')).toBe(true);
  });
});
