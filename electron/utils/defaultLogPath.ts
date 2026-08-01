import { mkdirSync } from 'node:fs';
import path from 'node:path';

type CreateDirectory = typeof mkdirSync;

export type ResolveDefaultLogDirOptions = {
  createDirectory?: CreateDirectory;
  devDirname: string;
  getPackagedLogDir: () => string;
  isPackaged: boolean;
};

export type CreateDefaultLogPathOptions = ResolveDefaultLogDirOptions & {
  now?: Date;
};

function formatSessionLogTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\..+/, '');
}

export function createDefaultLogPath({
  createDirectory = mkdirSync,
  devDirname,
  getPackagedLogDir,
  isPackaged,
  now = new Date(),
}: CreateDefaultLogPathOptions): string {
  const logDir = resolveDefaultLogDir({
    createDirectory,
    devDirname,
    getPackagedLogDir,
    isPackaged,
  });

  return path.join(logDir, `session-${formatSessionLogTimestamp(now)}.log`);
}

export function resolveDefaultLogDir({
  createDirectory = mkdirSync,
  devDirname,
  getPackagedLogDir,
  isPackaged,
}: ResolveDefaultLogDirOptions): string {
  const logDir = isPackaged
    ? getPackagedLogDir()
    : path.resolve(devDirname, '../../logs');

  // NOTE(victor): VS Code delegates packaged log directory setup to
  // `app.setAppLogsPath()` in `src/main.ts`; avoid manual mkdir before Electron
  // has created the Windows userData parent.
  if (!isPackaged) {
    createDirectory(logDir, { recursive: true });
  }

  return logDir;
}
