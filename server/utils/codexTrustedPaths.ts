import os from 'node:os';
import path from 'node:path';

type CodexTrustedPathOptions = {
  platform?: NodeJS.Platform;
  tmpDir?: string;
  tempAccessEnabled?: boolean;
  screenshotAccessEnabled?: boolean;
};

type TrustedPathAccess = 'read' | 'write';

const DARWIN_PLATFORM = 'darwin';
const PRIVATE_PREFIX = '/private';

function normalizeDarwinPath(inputPath: string): string {
  const trimmed = inputPath.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) {
    return '';
  }

  const normalized = path.posix.normalize(trimmed);
  if (normalized === '/') {
    return normalized;
  }

  return normalized.replace(/\/$/, '');
}

function dedupePaths(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const candidate of paths) {
    const normalized = normalizeDarwinPath(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function getDarwinPrivateAliases(candidateRoot: string): string[] {
  const normalizedRoot = normalizeDarwinPath(candidateRoot);
  if (!normalizedRoot) {
    return [];
  }

  const aliases = new Set<string>([normalizedRoot]);

  if (normalizedRoot.startsWith(`${PRIVATE_PREFIX}/`)) {
    aliases.add(normalizedRoot.slice(PRIVATE_PREFIX.length));
  }

  if (
    normalizedRoot === '/tmp'
    || normalizedRoot.startsWith('/tmp/')
    || normalizedRoot === '/var'
    || normalizedRoot.startsWith('/var/')
  ) {
    aliases.add(`${PRIVATE_PREFIX}${normalizedRoot}`);
  }

  return Array.from(aliases);
}

function getDarwinTempRootCandidates(tmpDir?: string): string[] {
  const tmpDirCandidates = tmpDir === undefined
    ? [process.env.TMPDIR, os.tmpdir(), '/tmp']
    : [tmpDir, '/tmp'];

  return dedupePaths(
    tmpDirCandidates.flatMap((candidate) => {
      if (typeof candidate !== 'string' || !candidate.trim()) {
        return [];
      }

      return getDarwinPrivateAliases(candidate);
    }),
  );
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const normalizedPath = normalizeDarwinPath(filePath);
  const normalizedRoot = normalizeDarwinPath(root);
  if (!normalizedPath || !normalizedRoot) {
    return false;
  }

  const relative = path.posix.relative(normalizedRoot, normalizedPath);
  return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
}

export function getCodexMacosTempRoots(
  options: Pick<CodexTrustedPathOptions, 'platform' | 'tmpDir'> = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== DARWIN_PLATFORM) {
    return [];
  }

  return getDarwinTempRootCandidates(options.tmpDir);
}

export function getCodexMacosScreenshotRoots(
  options: Pick<CodexTrustedPathOptions, 'platform' | 'tmpDir'> = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== DARWIN_PLATFORM) {
    return [];
  }

  const tempDirCandidates = options.tmpDir === undefined
    ? [process.env.TMPDIR, os.tmpdir()]
    : [options.tmpDir];

  return dedupePaths(
    tempDirCandidates.flatMap((candidate) => {
      if (typeof candidate !== 'string' || !candidate.trim()) {
        return [];
      }

      return getDarwinPrivateAliases(path.posix.join(candidate, 'TemporaryItems'));
    }),
  );
}

export function getCodexMacosAdditionalReadableRoots(
  options: CodexTrustedPathOptions = {},
): string[] {
  const tempAccessEnabled = options.tempAccessEnabled ?? true;
  const screenshotAccessEnabled = options.screenshotAccessEnabled ?? true;

  if (tempAccessEnabled) {
    return getCodexMacosTempRoots(options);
  }

  if (screenshotAccessEnabled) {
    return getCodexMacosScreenshotRoots(options);
  }

  return [];
}

export function getCodexMacosTrustedCustomPaths(
  options: CodexTrustedPathOptions = {},
): Record<string, TrustedPathAccess> {
  const tempAccessEnabled = options.tempAccessEnabled ?? true;
  const trustedRoots = getCodexMacosAdditionalReadableRoots(options);
  const access: TrustedPathAccess = tempAccessEnabled ? 'write' : 'read';

  return Object.fromEntries(
    trustedRoots.map((trustedRoot) => [trustedRoot, access]),
  );
}

export function isPathInCodexMacosTrustedReadZone(
  filePath: string,
  options: CodexTrustedPathOptions = {},
): boolean {
  return getCodexMacosAdditionalReadableRoots(options).some((trustedRoot) =>
    isPathInsideRoot(filePath, trustedRoot),
  );
}
