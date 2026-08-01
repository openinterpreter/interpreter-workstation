#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';

export const DEFAULT_WINDOWS_VM_NAME = 'Windows 11';
export const DEFAULT_WINDOWS_WORKSPACE_CMD = '%USERPROFILE%\\workstation-app-win';

export function inferMountedWindowsPath(cwd = process.cwd()) {
  const homeDir = path.resolve(os.homedir());
  const resolvedCwd = path.resolve(cwd);
  if (resolvedCwd !== homeDir && !resolvedCwd.startsWith(`${homeDir}${path.sep}`)) {
    return null;
  }

  const relative = path.relative(homeDir, resolvedCwd);
  if (relative.length === 0) {
    return 'C:\\Mac\\Home';
  }

  const windowsRelative = relative.split(path.sep).join('\\');
  return `C:\\Mac\\Home\\${windowsRelative}`;
}

