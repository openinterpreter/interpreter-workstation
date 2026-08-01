import { createRequire } from 'node:module';

const requireTarget =
  typeof __filename === 'string' && __filename.length > 0
    ? __filename
    : import.meta.url;
const require = createRequire(requireTarget);
const electron = require('electron') as typeof import('electron');

export const app = electron.app;
export const BrowserWindow = electron.BrowserWindow;
