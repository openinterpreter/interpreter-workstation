import { Menu, shell, dialog, BrowserWindow, app, type BaseWindow, type MenuItem } from 'electron';
import {
  emitTabClose,
  emitTabNew,
  emitTabNext,
  emitTabPrevious,
  emitTabGoTo,
  emitQuickOpen,
  emitToggleExplorer,
  emitFocusAgent,
  emitNewSidebarAgent,
  emitOpenInbox,
  emitOpenSettings,
} from './ipc/events';
import { getRecentFolders, setZoomFactor } from '../server/configStore';
import {
  clearWorkspaceForWindow,
  setWorkspaceWithConfirmation,
} from './ipc/workspaceConfirmation';
import { getWindowSessionWorkspace } from '../server/utils/windowSessions';
import { t } from './i18n';
import { checkForUpdatesManually } from './autoUpdater';
import { clampZoomFactor } from './utils/zoom';
import { ACTIVE_BRAND } from '../shared/branding';

const MIN_ZOOM_LEVEL = -6;
const MAX_ZOOM_LEVEL = 9;
let createWindowHandler: (() => Promise<void>) | null = null;

export function setCreateWindowHandler(handler: (() => Promise<void>) | null): void {
  createWindowHandler = handler;
}

function toBrowserWindow(window: BaseWindow | undefined): BrowserWindow | null {
  return window instanceof BrowserWindow ? window : null;
}

async function persistWindowZoom(window: BrowserWindow | null): Promise<void> {
  if (!window || window.isDestroyed()) return;
  await setZoomFactor(clampZoomFactor(window.webContents.getZoomFactor()));
}

async function changeWindowZoom(levelDelta: number): Promise<void> {
  const window = BrowserWindow.getFocusedWindow();
  if (!window || window.isDestroyed()) return;

  const current = window.webContents.getZoomLevel();
  const next = Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, current + levelDelta));
  if (next === current) return;

  window.webContents.setZoomLevel(next);
  await persistWindowZoom(window);
}

async function resetWindowZoom(): Promise<void> {
  const window = BrowserWindow.getFocusedWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.setZoomFactor(1);
  await persistWindowZoom(window);
}

/**
 * Handle opening a folder (from File > Open or File > Open Recent)
 */
async function handleOpenFolder(folderPath?: string): Promise<void> {
  try {
    let selectedPath = folderPath;
    const targetWindow = BrowserWindow.getFocusedWindow();

    // If no path provided, show the folder picker dialog
    if (!selectedPath) {
      const properties: Electron.OpenDialogOptions['properties'] = ['openDirectory'];
      if (process.platform === 'darwin') {
        properties.push('createDirectory');
      }

      const result = await dialog.showOpenDialog({
        properties,
        title: t('menu.dialog.selectWorkspaceFolder'),
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return;
      }

      selectedPath = result.filePaths[0];
    }

    // Use the shared function that handles confirmation + workspace change
    await setWorkspaceWithConfirmation(selectedPath, { windowId: targetWindow?.id ?? null });
  } catch (error) {
    console.error('[Menu] Error opening folder:', error);
    dialog.showErrorBox(t('common.error'), t('menu.dialog.errorOpeningFolder', { error: (error as Error).message }));
  }
}

/**
 * Handle closing the current folder
 */
async function handleCloseFolder(): Promise<void> {
  try {
    const targetWindow = BrowserWindow.getFocusedWindow();
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }

    const workspacePath = getWindowSessionWorkspace({ windowId: targetWindow.id });
    if (!workspacePath) {
      return;
    }

    await clearWorkspaceForWindow(targetWindow.id);

    console.log('[Menu] Folder closed');
  } catch (error) {
    console.error('[Menu] Error closing folder:', error);
  }
}

/**
 * Build and set the application menu
 */
export async function buildApplicationMenu(): Promise<void> {
  const isMac = process.platform === 'darwin';
  const isDev = !app.isPackaged;

  // Load recent folders from config
  const recentFolders = await getRecentFolders();

  // Build Recent submenu
  const recentSubmenu = recentFolders.length > 0
    ? recentFolders.map(folder => ({
        label: folder.name,
        sublabel: folder.path,
        click: () => handleOpenFolder(folder.path),
      }))
    : [{ label: t('menu.file.noRecentFolders'), enabled: false }];

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: ACTIVE_BRAND.appName,
            submenu: [
              { role: 'about' as const },
              {
                label: t('menu.app.checkForUpdates'),
                click: () => {
                  void checkForUpdatesManually();
                },
              },
              { type: 'separator' as const },
              {
                label: t('menu.app.settings'),
                accelerator: 'CmdOrCtrl+,',
                click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitOpenSettings(toBrowserWindow(browserWindow)),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),

    // File menu
    {
      label: t('menu.file.label'),
      submenu: [
        {
          label: t('menu.file.newWindow'),
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (!createWindowHandler) {
              console.warn('[Menu] New window requested before handler registration');
              return;
            }
            void createWindowHandler().catch((error) => {
              console.error('[Menu] Error creating new window:', error);
              dialog.showErrorBox(t('common.error'), (error as Error).message);
            });
          },
        },
        {
          label: t('menu.file.newAgent'),
          accelerator: 'CmdOrCtrl+T',
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitTabNew(toBrowserWindow(browserWindow)),
        },
        {
          label: t('menu.file.newSidebarAgent'),
          accelerator: 'CmdOrCtrl+Shift+L',
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitNewSidebarAgent(toBrowserWindow(browserWindow)),
        },
        { type: 'separator' },
        {
          label: t('menu.file.openFolder'),
          accelerator: 'CmdOrCtrl+O',
          click: () => handleOpenFolder(),
        },
        {
          label: t('menu.file.openRecent'),
          submenu: recentSubmenu,
        },
        {
          label: t('menu.file.closeFolder'),
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => handleCloseFolder(),
          enabled: true,
        },
        { type: 'separator' },
        {
          label: t('menu.file.quickOpen'),
          accelerator: 'CmdOrCtrl+K',
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitQuickOpen(toBrowserWindow(browserWindow)),
        },
        { type: 'separator' },
        {
          label: t('menu.file.closeTab'),
          accelerator: 'CmdOrCtrl+W',
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitTabClose(toBrowserWindow(browserWindow)),
        },
        ...(isDev
          ? [
              { type: 'separator' as const },
              {
                label: t('menu.file.openExperimentalInbox'),
                click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitOpenInbox(toBrowserWindow(browserWindow)),
              },
            ]
          : []),
        ...(!isMac
          ? [
              { type: 'separator' as const },
              {
                label: t('menu.file.settings'),
                accelerator: 'CmdOrCtrl+,' as const,
                click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitOpenSettings(toBrowserWindow(browserWindow)),
              },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ]
          : []),
      ],
    },

    // Tab menu (Chrome-style tab navigation)
    {
      label: t('menu.tab.label'),
      submenu: [
        {
          label: t('menu.tab.selectNext'),
          accelerator: 'CmdOrCtrl+Shift+]',
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitTabNext(toBrowserWindow(browserWindow)),
        },
        {
          label: t('menu.tab.selectPrevious'),
          accelerator: 'CmdOrCtrl+Shift+[',
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitTabPrevious(toBrowserWindow(browserWindow)),
        },
        { type: 'separator' },
        // Tab 1-8 shortcuts
        ...([1, 2, 3, 4, 5, 6, 7, 8].map(n => ({
          label: t('menu.tab.selectTab', { n }),
          accelerator: `CmdOrCtrl+${n}`,
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitTabGoTo(toBrowserWindow(browserWindow), n - 1),
        }))),
        {
          label: t('menu.tab.selectLast'),
          accelerator: 'CmdOrCtrl+9',
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitTabGoTo(toBrowserWindow(browserWindow), -1), // -1 means last tab
        },
      ],
    },

    // Edit menu
    {
      label: t('menu.edit.label'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const },
              { role: 'delete' as const },
              { role: 'selectAll' as const },
              { type: 'separator' as const },
              {
                label: t('menu.edit.speech'),
                submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }],
              },
            ]
          : [{ role: 'delete' as const }, { type: 'separator' as const }, { role: 'selectAll' as const }]),
      ],
    },

    // View menu
    {
      label: t('menu.view.label'),
      submenu: [
        {
          label: t('menu.view.toggleExplorer'),
          accelerator: 'CmdOrCtrl+E',
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitToggleExplorer(toBrowserWindow(browserWindow)),
        },
        {
          label: t('menu.view.toggleAgent'),
          accelerator: 'CmdOrCtrl+L',
          click: (_menuItem: MenuItem, browserWindow: BaseWindow | undefined) => emitFocusAgent(toBrowserWindow(browserWindow)),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        ...(isDev ? [{ role: 'toggleDevTools' as const }] : []),
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            void resetWindowZoom();
          },
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            void changeWindowZoom(1);
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            void changeWindowZoom(-1);
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // Window menu
    {
      label: t('menu.window.label'),
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }, { type: 'separator' as const }, { role: 'window' as const }]
          : [{ role: 'close' as const }]),
      ],
    },

    // Help menu
    {
      role: 'help',
      submenu: [
        {
          label: t('menu.help.learnMore'),
          click: async () => {
            await shell.openExternal('https://www.openinterpreter.com');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
