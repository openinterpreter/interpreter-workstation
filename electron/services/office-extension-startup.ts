import path from 'node:path';
import pathPosix from 'node:path/posix';
import pathWin32 from 'node:path/win32';
import { WORKSTATION_SENTRY_DSN } from '../../shared/constants/sentry';

type OfficeExtensionStartupLogger = Pick<Console, 'error' | 'log'>;

type OfficeExtensionModule = {
  installOoEditors: () => Promise<void>;
  isOoEditorsInstalled: () => boolean;
};

export type OfficeExtensionStartupDeps = {
  importOfficeExtension: () => Promise<OfficeExtensionModule>;
  isSupportedPlatform: (platform: string) => boolean;
  logger: OfficeExtensionStartupLogger;
  platform: string;
};

type OoEditorsNodeRuntimeOptions = {
  processExecPath?: string;
};

export type OoEditorsNodeRuntime = {
  binaryPath: string;
  cwd: string;
};

/**
 * oo-editors is installed under userData but runs through the packaged
 * Interpreter executable with ELECTRON_RUN_AS_NODE=1. Node resolves
 * require('@sentry/node') from userData/oo-editors/server.js, so it never
 * walks into the app bundle at resources/app.asar/node_modules by itself.
 *
 * app.getAppPath() is the runtime app root in both dev and packaged builds:
 * the repo/app root during development and resources/app.asar in production.
 * Pointing NODE_PATH at appPath/node_modules lets the oo-editors child process
 * load only the dependency copy bundled with the app that spawned it.
 */
export function getOoEditorsAppNodeModulesPath(appPath: string): string {
  const runtimePath = appPath.includes('\\') ? pathWin32 : pathPosix;
  return runtimePath.join(appPath, 'node_modules');
}

export function isWindowsOoEditorsSpawnPermissionError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // NOTE(victor): Windows can deny launching the packaged Interpreter.exe as
  // the oo-editors Node runtime with EACCES/EPERM. The app cannot repair local
  // OS policy or antivirus interference, so these stay visible as warning
  // breadcrumbs without creating Sentry issues.
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return platform === 'win32' && (code === 'EACCES' || code === 'EPERM');
}

export function resolveOoEditorsNodeRuntime({
  processExecPath,
}: OoEditorsNodeRuntimeOptions): OoEditorsNodeRuntime {
  // NOTE(victor): oo-editors is bundled with the desktop app, so production
  // users are not expected to provide Node. Do not honor INTERPRETER_NODE_BIN
  // or PATH lookups here; keep this on the app executable with
  // ELECTRON_RUN_AS_NODE, matching README.md's shipped app-binary runtime
  // contract. The executable cwd matters on Windows: Sentry issues
  // openinterpreter/iworkstation-issues#1758, #1759, and #1760 captured
  // Interpreter.exe launched for oo-editors with the oo-editors cwd, followed
  // by Chromium ICU data fd errors and exit 2147483651.
  const runtimeExecutable = processExecPath ?? process.execPath;
  const runtimeDir = runtimeExecutable.includes('\\')
    ? path.win32.dirname(runtimeExecutable)
    : path.dirname(runtimeExecutable);

  return {
    binaryPath: runtimeExecutable,
    cwd: runtimeDir,
  };
}

export function buildOoEditorsServerEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: {
    appPath: string;
    isPackaged: boolean;
    port: number;
    fontDataDir: string;
  },
): NodeJS.ProcessEnv {
  const {
    ELECTRON_RUN_AS_NODE: _electronRunAsNode,
    NODE_PATH: _nodePath,
    ...restEnv
  } = baseEnv;

  return {
    ...restEnv,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: getOoEditorsAppNodeModulesPath(options.appPath),
    NODE_ENV: options.isPackaged ? 'production' : 'development',
    PORT: String(options.port),
    FONT_DATA_DIR: options.fontDataDir,
    OO_EDITOR_SENTRY_DSN: WORKSTATION_SENTRY_DSN,
  };
}

export async function ensureOfficeExtensionInstalledInBackground(
  deps: OfficeExtensionStartupDeps,
): Promise<void> {
  const {
    importOfficeExtension,
    isSupportedPlatform,
    logger,
    platform,
  } = deps;

  if (!isSupportedPlatform(platform)) {
    logger.log(`[OfficeExtension] Skipping background install on unsupported platform: ${platform}`);
    return;
  }

  try {
    const { installOoEditors, isOoEditorsInstalled } = await importOfficeExtension();

    if (!isOoEditorsInstalled()) {
      logger.log('[OfficeExtension] Not installed, downloading in background...');
      await installOoEditors();
    }
  } catch (error) {
    logger.error('[OfficeExtension] Failed background install check:', error);
  }
}
