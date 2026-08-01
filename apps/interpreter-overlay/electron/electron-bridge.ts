import { createRequire } from 'node:module';

const requireTarget =
  typeof __filename === 'string' && __filename.length > 0
    ? __filename
    : import.meta.url;
const require = createRequire(requireTarget);
const electron = require('electron') as typeof import('electron');

export type BrowserWindow = InstanceType<typeof electron.BrowserWindow>;
export const app = electron.app;
export const BrowserWindow = electron.BrowserWindow;
export const clipboard = electron.clipboard;
export const dialog = electron.dialog;
export const globalShortcut = electron.globalShortcut;
export const ipcMain = electron.ipcMain;
export const Notification = electron.Notification;
export const powerSaveBlocker = electron.powerSaveBlocker;
export const screen = electron.screen;
