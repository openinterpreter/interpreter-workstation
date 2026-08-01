import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

import { createDefaultLogPath, resolveDefaultLogDir } from './defaultLogPath';

describe('createDefaultLogPath', () => {
  test('resolves the packaged Electron logs directory through the injected initializer', () => {
    const createDirectory = mock(() => {
      throw new Error('packaged logs path should not be manually created');
    });
    const getPackagedLogDir = mock(() => path.join('/users/davide-brown/AppData/Roaming/interpreter/logs'));

    const logDir = resolveDefaultLogDir({
      createDirectory,
      devDirname: '/repo/dist-electron/electron',
      getPackagedLogDir,
      isPackaged: true,
    });

    expect(getPackagedLogDir).toHaveBeenCalledTimes(1);
    expect(createDirectory).not.toHaveBeenCalled();
    expect(logDir).toBe(path.join('/users/davide-brown/AppData/Roaming/interpreter/logs'));
  });

  test('uses the packaged Electron logs directory without manually creating userData logs', () => {
    const createDirectory = mock(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    const now = new Date('2026-05-15T20:30:52.760Z');

    const logPath = createDefaultLogPath({
      createDirectory,
      devDirname: '/repo/dist-electron/electron',
      getPackagedLogDir: () => path.join('/users/davide-brown/AppData/Roaming/interpreter/logs'),
      isPackaged: true,
      now,
    });

    expect(createDirectory).not.toHaveBeenCalled();
    expect(logPath).toBe(path.join(
      '/users/davide-brown/AppData/Roaming/interpreter/logs',
      'session-2026-05-15T20-30-52.log',
    ));
  });

  test('creates the dev logs directory from the Electron build location', () => {
    const createDirectory = mock(() => undefined);
    const now = new Date('2026-05-15T20:30:52.760Z');

    const logPath = createDefaultLogPath({
      createDirectory,
      devDirname: path.join('/repo/dist-electron/electron'),
      getPackagedLogDir: () => {
        throw new Error('packaged logs path should not be read');
      },
      isPackaged: false,
      now,
    });

    const expectedLogDir = path.resolve('/repo/dist-electron/electron', '../../logs');
    expect(createDirectory.mock.calls).toEqual([
      [expectedLogDir, { recursive: true }],
    ]);
    expect(logPath).toBe(path.join(expectedLogDir, 'session-2026-05-15T20-30-52.log'));
  });
});
