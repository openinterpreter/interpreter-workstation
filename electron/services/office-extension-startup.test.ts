import { describe, expect, mock, test } from 'bun:test';

import { WORKSTATION_SENTRY_DSN } from '../../shared/constants/sentry';
import {
  buildOoEditorsServerEnv,
  ensureOfficeExtensionInstalledInBackground,
  getOoEditorsAppNodeModulesPath,
  isWindowsOoEditorsSpawnPermissionError,
  resolveOoEditorsNodeRuntime,
} from './office-extension-startup';

describe('ensureOfficeExtensionInstalledInBackground', () => {
  test('builds oo-editors env with workstation sentry dsn and packaged-aware node env', () => {
    const appPath = '/Applications/Interpreter.app/Contents/Resources/app.asar';

    expect(buildOoEditorsServerEnv(
      {
        PATH: '/usr/bin',
      },
      {
        appPath,
        isPackaged: false,
        port: 38123,
        fontDataDir: '/tmp/fontdata',
      },
    )).toEqual({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: '/Applications/Interpreter.app/Contents/Resources/app.asar/node_modules',
      NODE_ENV: 'development',
      PORT: '38123',
      FONT_DATA_DIR: '/tmp/fontdata',
      OO_EDITOR_SENTRY_DSN: WORKSTATION_SENTRY_DSN,
    });

    expect(buildOoEditorsServerEnv(
      {},
      {
        appPath,
        isPackaged: true,
        port: 38123,
        fontDataDir: '/tmp/fontdata',
      },
    ).NODE_ENV).toBe('production');
  });

  test('always sets ELECTRON_RUN_AS_NODE for oo-editors', () => {
    const appPath = '/Applications/Interpreter.app/Contents/Resources/app.asar';

    expect(buildOoEditorsServerEnv(
      {
        PATH: '/usr/bin',
      },
      {
        appPath,
        isPackaged: true,
        port: 38123,
        fontDataDir: '/tmp/fontdata',
      },
    )).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      PATH: '/usr/bin',
      NODE_PATH: '/Applications/Interpreter.app/Contents/Resources/app.asar/node_modules',
      NODE_ENV: 'production',
      PORT: '38123',
      FONT_DATA_DIR: '/tmp/fontdata',
      OO_EDITOR_SENTRY_DSN: WORKSTATION_SENTRY_DSN,
    });
  });

  test('points oo-editors NODE_PATH at the app Sentry dependency node_modules directory', () => {
    expect(getOoEditorsAppNodeModulesPath(
      '/Applications/Interpreter.app/Contents/Resources/app.asar',
    )).toBe(
      '/Applications/Interpreter.app/Contents/Resources/app.asar/node_modules',
    );
  });

  test('resolves Windows packaged Sentry dependency paths without mixed separators', () => {
    expect(getOoEditorsAppNodeModulesPath(
      'C:\\Program Files\\Interpreter\\resources\\app.asar',
    )).toBe(
      'C:\\Program Files\\Interpreter\\resources\\app.asar\\node_modules',
    );
  });

  test('overwrites inherited NODE_PATH for the oo-editors child runtime', () => {
    expect(buildOoEditorsServerEnv(
      {
        NODE_PATH: '/tmp/old-node-path',
      },
      {
        appPath: '/Applications/Interpreter.app/Contents/Resources/app.asar',
        isPackaged: true,
        port: 38123,
        fontDataDir: '/tmp/fontdata',
      },
    ).NODE_PATH).toBe('/Applications/Interpreter.app/Contents/Resources/app.asar/node_modules');
  });

  test('runs Electron-as-Node from the executable directory', () => {
    expect(resolveOoEditorsNodeRuntime({
      processExecPath: 'C:\\Program Files\\Interpreter\\Interpreter.exe',
    })).toEqual({
      binaryPath: 'C:\\Program Files\\Interpreter\\Interpreter.exe',
      cwd: 'C:\\Program Files\\Interpreter',
    });
  });

  test('ignores explicit Node overrides because oo-editors runs through the app executable', () => {
    const originalNodeOverride = process.env.INTERPRETER_NODE_BIN;
    process.env.INTERPRETER_NODE_BIN = 'C:\\node\\node.exe';
    try {
      expect(resolveOoEditorsNodeRuntime({
        processExecPath: 'C:\\Program Files\\Interpreter\\Interpreter.exe',
      })).toEqual({
        binaryPath: 'C:\\Program Files\\Interpreter\\Interpreter.exe',
        cwd: 'C:\\Program Files\\Interpreter',
      });
    } finally {
      if (originalNodeOverride === undefined) {
        delete process.env.INTERPRETER_NODE_BIN;
      } else {
        process.env.INTERPRETER_NODE_BIN = originalNodeOverride;
      }
    }
  });

  for (const code of ['EACCES', 'EPERM'] as const) {
    test(`identifies Windows ${code} oo-editors spawn permission errors`, () => {
      const error = Object.assign(
        new Error(`spawn C:\\Program Files\\Interpreter\\Interpreter.exe ${code}`),
        { code },
      );

      expect(isWindowsOoEditorsSpawnPermissionError(error, 'win32')).toBe(true);
    });
  }

  test('identifies support issue 2030 Windows oo-editors EACCES spawn errors', () => {
    const error = Object.assign(
      new Error('spawn C:\\Program Files\\Interpreter\\Interpreter.exe EACCES'),
      { code: 'EACCES' },
    );

    expect(isWindowsOoEditorsSpawnPermissionError(error, 'win32')).toBe(true);
  });

  test('does not treat other process errors as Windows spawn permission errors', () => {
    const error = Object.assign(
      new Error('spawn C:\\Program Files\\Interpreter\\Interpreter.exe ENOENT'),
      { code: 'ENOENT' },
    );

    expect(isWindowsOoEditorsSpawnPermissionError(error, 'win32')).toBe(false);
    expect(isWindowsOoEditorsSpawnPermissionError({ code: 'EACCES' }, 'darwin')).toBe(false);
  });

  test('skips unsupported platforms without importing office extension module', async () => {
    const importOfficeExtension = mock(async () => {
      throw new Error('should not import');
    });
    const logger = {
      error: mock(() => {}),
      log: mock(() => {}),
    };

    await ensureOfficeExtensionInstalledInBackground({
      importOfficeExtension,
      isSupportedPlatform: () => false,
      logger,
      platform: 'linux',
    });

    expect(importOfficeExtension).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      '[OfficeExtension] Skipping background install on unsupported platform: linux',
    );
  });

  test('installs oo-editors in background when supported platform is missing it', async () => {
    const installOoEditors = mock(async () => {});
    const logger = {
      error: mock(() => {}),
      log: mock(() => {}),
    };

    await ensureOfficeExtensionInstalledInBackground({
      importOfficeExtension: async () => ({
        installOoEditors,
        isOoEditorsInstalled: () => false,
      }),
      isSupportedPlatform: () => true,
      logger,
      platform: 'darwin',
    });

    expect(installOoEditors).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      '[OfficeExtension] Not installed, downloading in background...',
    );
  });

  test('does not install when oo-editors is already present', async () => {
    const installOoEditors = mock(async () => {});
    const logger = {
      error: mock(() => {}),
      log: mock(() => {}),
    };

    await ensureOfficeExtensionInstalledInBackground({
      importOfficeExtension: async () => ({
        installOoEditors,
        isOoEditorsInstalled: () => true,
      }),
      isSupportedPlatform: () => true,
      logger,
      platform: 'win32',
    });

    expect(installOoEditors).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalledWith(
      '[OfficeExtension] Not installed, downloading in background...',
    );
  });
});
