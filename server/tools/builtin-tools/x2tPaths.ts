import { existsSync } from 'fs';
import path from 'node:path';

export interface X2tPaths {
  x2tBinary: string;
  themesDir: string;
  allFontsPath: string;
  systemFontsDir: string;
}

function resolveAllFontsPath(
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
  pathExists: (candidatePath: string) => boolean = existsSync
): string {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const candidates = [
    platformPath.join(userDataPath, 'office-extension-fontdata', 'AllFonts.js'),
    platformPath.join(userDataPath, 'oo-editors', 'assets', 'onlyoffice-fontdata', 'AllFonts.js'),
    platformPath.join(userDataPath, 'oo-editors', 'editors', 'sdkjs', 'common', 'AllFonts.js'),
  ];

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  // Preserve the primary desktop-fontdata contract when no candidate exists yet.
  return candidates[0];
}

// NOTE(victor): On Windows the installed converter artifact is `x2t.exe`, not
// a bare `x2t` file. This is backed by both source and runtime evidence: the
// oo-editors submodule installer checks for `converter/x2t.exe` on win32 in
// `oo-editors/download-converter.js`, the live Windows VM install under
// `%APPDATA%\\Interpreter\\oo-editors\\converter` contained `x2t.exe` and no
// bare `x2t`, and a real `http://localhost:38123/api/convert` request spawned
// an `x2t.exe` process. oo-editors `server.js` still builds a suffixless
// `converter/x2t` path, which Windows resolves to `.exe` at spawn time, but our
// built-in tools do an explicit file existence check before spawn. That means
// `existsSync(...\\converter\\x2t)` fails on Windows even when oo-editors is
// fully usable, which regresses document creation/conversion to the misleading
// "OfficeExtension editors are not installed" error. Do not "simplify" this
// back to `x2t` or mirror the suffixless oo-editors server string here unless
// the install/runtime contract is changed everywhere that validates the
// converter binary.
export function getX2tBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'x2t.exe' : 'x2t';
}

export function buildX2tPaths(
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
  pathExists: (candidatePath: string) => boolean = existsSync
): X2tPaths {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  return {
    x2tBinary: platformPath.join(userDataPath, 'oo-editors', 'converter', getX2tBinaryName(platform)),
    themesDir: platformPath.join(userDataPath, 'oo-editors', 'editors', 'sdkjs', 'slide', 'themes'),
    allFontsPath: resolveAllFontsPath(userDataPath, platform, pathExists),
    systemFontsDir: platform === 'win32' ? 'C:\\Windows\\Fonts' : '/System/Library/Fonts',
  };
}

export function getX2tPaths(): X2tPaths {
  const { app } = require('electron');
  return buildX2tPaths(app.getPath('userData'));
}
