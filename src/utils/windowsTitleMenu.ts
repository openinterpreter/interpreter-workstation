import type { ContextMenuItem } from '@/ipc';

export type WindowsTitleMenu = 'file' | 'edit' | 'view' | 'help';

export type WindowsTitleMenuAction =
  | 'new-tab'
  | 'open-folder'
  | 'open-settings'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'toggle-explorer'
  | 'toggle-agent'
  | 'actual-size'
  | 'zoom-in'
  | 'zoom-out'
  | 'learn-more';

export const WINDOWS_TITLE_MENUS: ReadonlyArray<{ id: WindowsTitleMenu; label: string }> = [
  { id: 'file', label: 'File' },
  { id: 'edit', label: 'Edit' },
  { id: 'view', label: 'View' },
  { id: 'help', label: 'Help' },
] as const;

const MENU_ITEMS: Record<WindowsTitleMenu, ContextMenuItem[]> = {
  file: [
    { label: 'New Tab', action: 'new-tab', accelerator: 'Ctrl+T' },
    { label: 'Open Folder...', action: 'open-folder', accelerator: 'Ctrl+O' },
    { separator: true, label: '', action: '' },
    { label: 'Settings', action: 'open-settings', accelerator: 'Ctrl+,' },
  ],
  edit: [
    { label: 'Undo', action: 'undo', accelerator: 'Ctrl+Z' },
    { label: 'Redo', action: 'redo', accelerator: 'Ctrl+Shift+Z' },
    { separator: true, label: '', action: '' },
    { label: 'Cut', action: 'cut', accelerator: 'Ctrl+X' },
    { label: 'Copy', action: 'copy', accelerator: 'Ctrl+C' },
    { label: 'Paste', action: 'paste', accelerator: 'Ctrl+V' },
    { separator: true, label: '', action: '' },
    { label: 'Select All', action: 'select-all', accelerator: 'Ctrl+A' },
  ],
  view: [
    { label: 'Toggle Explorer', action: 'toggle-explorer', accelerator: 'Ctrl+E' },
    { label: 'Toggle Agent Sidebar', action: 'toggle-agent', accelerator: 'Ctrl+L' },
    { separator: true, label: '', action: '' },
    { label: 'Actual Size', action: 'actual-size', accelerator: 'Ctrl+0' },
    { label: 'Zoom In', action: 'zoom-in', accelerator: 'Ctrl++' },
    { label: 'Zoom Out', action: 'zoom-out', accelerator: 'Ctrl+-' },
  ],
  help: [
    { label: 'Learn More', action: 'learn-more' },
  ],
};

export function getWindowsTitleMenuItems(menu: WindowsTitleMenu): ContextMenuItem[] {
  return MENU_ITEMS[menu];
}
