const SLASH = '/';
const BACKSLASH = '\\';
const COLON = ':';

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWindowsDriveFileUrlPathname(filePath: string): boolean {
  return filePath.length >= 4
    && filePath[0] === SLASH
    && isAsciiLetterCode(filePath.charCodeAt(1))
    && filePath[2] === COLON
    && (filePath[3] === SLASH || filePath[3] === BACKSLASH);
}

function toWindowsSeparators(filePath: string): string {
  let normalized = '';
  for (const char of filePath) {
    normalized += char === SLASH ? BACKSLASH : char;
  }
  return normalized;
}

export function normalizeFileUrlPathname(filePath: string): string {
  if (process.platform !== 'win32' || !isWindowsDriveFileUrlPathname(filePath)) {
    return filePath;
  }

  // NOTE(victor): Same boundary as VS Code's URI.fsPath: URI pathnames keep `/c:/...`,
  // filesystem calls use `c:\...`.
  // https://github.com/microsoft/vscode/blob/cb297c54fcc51f62fba0b1a3cd692a7cacdce68a/src/vs/base/common/uri.ts#L626-L650
  return `${filePath[1].toUpperCase()}:${toWindowsSeparators(filePath.slice(3))}`;
}
