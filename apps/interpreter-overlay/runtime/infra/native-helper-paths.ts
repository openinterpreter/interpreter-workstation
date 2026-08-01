import path from 'node:path';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(process.execPath);

export type InterpreterOverlayNativeHelperName =
  | 'accessibility-tree'
  | 'ax-set-focused-text'
  | 'file-drag-context'
  | 'focus-window'
  | 'keyboard-monitor'
  | 'progressive-blur'
  | 'selected-file-context'
  | 'speech-recognizer'
  | 'verified-point'
  | 'window-tracker';

export function getInterpreterOverlayNativeHelperPath(
  helperName: InterpreterOverlayNativeHelperName,
): string {
  if (!process.versions.electron) {
    throw new Error('Interpreter overlay native helpers are unavailable outside Electron runtime.');
  }

  const { app } = require('electron') as typeof import('electron');
  if (process.platform === 'win32' && helperName === 'accessibility-tree') {
    return process.execPath;
  }

  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'interpreter-overlay'),
      ]
    : [
        path.join(app.getAppPath(), 'dist-electron', 'interpreter-overlay'),
        path.join(app.getAppPath(), 'interpreter-overlay'),
        path.join(process.cwd(), 'dist-electron', 'interpreter-overlay'),
      ];

  for (const basePath of candidates) {
    const candidate = path.join(basePath, helperName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(candidates[0] ?? process.cwd(), helperName);
}
