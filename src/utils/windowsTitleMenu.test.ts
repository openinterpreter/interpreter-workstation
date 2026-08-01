import { describe, expect, test } from 'bun:test';
import { WINDOWS_TITLE_MENUS, getWindowsTitleMenuItems } from './windowsTitleMenu';

describe('windowsTitleMenu', () => {
  test('exposes standard top-level windows menus', () => {
    expect(WINDOWS_TITLE_MENUS).toEqual([
      { id: 'file', label: 'File' },
      { id: 'edit', label: 'Edit' },
      { id: 'view', label: 'View' },
      { id: 'help', label: 'Help' },
    ]);
  });

  test('file menu keeps essential desktop actions', () => {
    const fileMenu = getWindowsTitleMenuItems('file')
      .filter(item => !item.separator)
      .map(item => item.action);

    expect(fileMenu).toEqual(['new-tab', 'open-folder', 'open-settings']);
  });

  test('edit menu includes core text editing commands', () => {
    const editMenu = getWindowsTitleMenuItems('edit')
      .filter(item => !item.separator)
      .map(item => item.action);

    expect(editMenu).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'select-all',
    ]);
  });

  test('view menu includes window controls and interface zoom actions', () => {
    const viewMenu = getWindowsTitleMenuItems('view')
      .filter(item => !item.separator)
      .map(item => item.action);

    expect(viewMenu).toEqual([
      'toggle-explorer',
      'toggle-agent',
      'actual-size',
      'zoom-in',
      'zoom-out',
    ]);
  });
});
