/**
 * Local Link Detection Utility
 *
 * Classifies link hrefs as local file paths vs external URLs,
 * and parses fragment/line metadata from local links.
 */

import { isAbsolutePath, pathBasename, pathNormalize } from '@/ipc';

export interface ParsedLocalLink {
  path: string;           // File path (may be relative or absolute)
  fragment?: string;      // e.g. "section-heading" from #section-heading
  lineStart?: number;     // from :L10 or :L10-L20
  lineEnd?: number;       // from :L10-L20
}

export type LocalLinkItemType = 'file' | 'directory';
export interface ResolvedLocalLinkTarget {
  path: string;
  itemType: LocalLinkItemType;
  fragment?: string;
  lineStart?: number;
  lineEnd?: number;
}

interface ParsedFileUrl {
  path: string;
  line?: number;
  column?: number;
}

function encodeMdHref(href: string): string {
  return href.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function hasTrailingPathSeparator(value: string): boolean {
  return value.endsWith('/') || value.endsWith('\\');
}

function hasExplicitExtension(filePath: string): boolean {
  const basename = pathBasename(filePath);
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex > 0 && dotIndex < basename.length - 1;
}

function stripTrailingPathSeparators(filePath: string): string {
  if (!filePath) return filePath;

  let end = filePath.length;
  while (end > 1) {
    const char = filePath[end - 1];
    if (char !== '/' && char !== '\\') {
      break;
    }

    const candidate = filePath.slice(0, end - 1);
    if (candidate === '/' || candidate === '\\\\' || isWindowsDriveRoot(candidate)) {
      break;
    }

    end -= 1;
  }

  return filePath.slice(0, end);
}

function isWindowsDriveRoot(value: string): boolean {
  return /^[A-Za-z]:$/.test(value);
}

// Keep file:// parsing here so local link detection no longer depends on the removed CodexView UI tree.
function parseFileUrl(url: string): ParsedFileUrl | null {
  if (!url.startsWith('file://')) return null;

  let pathWithSuffix = url.slice(7);

  // Handle Windows paths like file:///C:/Users/name/file.txt
  if (pathWithSuffix.startsWith('/') && /^\/[A-Za-z]:/.test(pathWithSuffix)) {
    pathWithSuffix = pathWithSuffix.slice(1);
  }

  const lineColumnMatch = pathWithSuffix.match(/:(\d+)(?::(\d+))?$/);
  const rawPath = lineColumnMatch
    ? pathWithSuffix.slice(0, -lineColumnMatch[0].length)
    : pathWithSuffix;

  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }

  const normalizedPath = isAbsolutePath(decodedPath)
    ? pathNormalize(decodedPath)
    : decodedPath;

  return {
    path: normalizedPath,
    ...(lineColumnMatch ? { line: parseInt(lineColumnMatch[1], 10) } : {}),
    ...(lineColumnMatch?.[2] ? { column: parseInt(lineColumnMatch[2], 10) } : {}),
  };
}

/**
 * Determine if a link href refers to a local file (not an external URL).
 *
 * A link is local if:
 * - Starts with file://
 * - Starts with / (absolute path)
 * - Starts with ./ or ../ (relative path)
 * - No protocol (no :// before first /) and doesn't start with #
 *   e.g. notes.md, folder/file.txt
 * - NOT http://, https://, mailto:, tel:, data:, blob:, browser://
 */
export function isLocalFileLink(href: string): boolean {
  if (!href || href.startsWith('#')) return false;

  // Check external protocols
  const externalProtocols = ['http://', 'https://', 'mailto:', 'tel:', 'data:', 'blob:', 'browser://'];
  for (const protocol of externalProtocols) {
    if (href.startsWith(protocol)) return false;
  }

  // file:// protocol is local
  if (href.startsWith('file://')) return true;

  // Absolute path
  if (href.startsWith('/')) return true;

  // Relative paths
  if (href.startsWith('./') || href.startsWith('../')) return true;

  // No protocol — if there's no :// before the first /, treat as local
  const protocolIndex = href.indexOf('://');
  if (protocolIndex === -1) return true;

  // Has some protocol we didn't recognize — treat as external
  return false;
}

/**
 * Parse a local file link into its components: path, fragment, lineStart, lineEnd.
 *
 * Supports:
 * - file:///path/to/file.txt
 * - ./notes.md#heading-slug
 * - /abs/path.md:L10
 * - relative/path.md:L10-L20
 * - notes.md#heading:L5
 */
export function parseLocalLink(href: string): ParsedLocalLink | null {
  if (!isLocalFileLink(href)) return null;

  // Handle file:// URLs using existing utility
  if (href.startsWith('file://')) {
    const parsed = parseFileUrl(href);
    if (!parsed) return null;
    return {
      path: parsed.path,
      lineStart: parsed.line,
    };
  }

  let remaining = href;
  let fragment: string | undefined;
  let lineStart: number | undefined;
  let lineEnd: number | undefined;

  // Extract line range :L10-L20 or :L10 (check before fragment since fragment could contain :L)
  const lineRangeMatch = remaining.match(/:L(\d+)(?:-L?(\d+))?$/);
  if (lineRangeMatch) {
    lineStart = parseInt(lineRangeMatch[1], 10);
    if (lineRangeMatch[2]) {
      lineEnd = parseInt(lineRangeMatch[2], 10);
    }
    remaining = remaining.slice(0, -lineRangeMatch[0].length);
  }

  // Extract fragment #heading-slug
  const hashIndex = remaining.indexOf('#');
  if (hashIndex !== -1) {
    fragment = remaining.slice(hashIndex + 1);
    remaining = remaining.slice(0, hashIndex);
  }

  let path: string;
  try {
    path = decodeURIComponent(remaining);
  } catch {
    path = remaining;
  }

  if (!path) return null;

  return {
    path,
    ...(fragment ? { fragment } : {}),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
  };
}

/**
 * Infer whether a parsed local link points to a file or directory.
 *
 * Files are the safe default for ambiguous paths. Directory links must be
 * explicit, either via a trailing path separator or a directory-only target
 * like "." / "..". This prevents extensionless note labels from opening
 * folder tabs when the underlying href clearly points to a file.
 */
export function inferLocalLinkItemType(options: {
  href: string;
  path: string;
  fragment?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}): LocalLinkItemType {
  const { href, path, fragment, lineStart, lineEnd } = options;

  if (fragment || lineStart != null || lineEnd != null) {
    return 'file';
  }

  if (path === '.' || path === '..') {
    return 'directory';
  }

  if (hasTrailingPathSeparator(href) || hasTrailingPathSeparator(path)) {
    return 'directory';
  }

  if (hasExplicitExtension(path)) {
    return 'file';
  }

  return 'file';
}

export function canonicalizeLocalLinkPath(
  path: string,
  itemType: LocalLinkItemType,
): string {
  if (itemType !== 'directory') {
    return path;
  }

  return stripTrailingPathSeparators(path);
}

export function resolveLocalLinkTarget(href: string): ResolvedLocalLinkTarget | null {
  const parsed = parseLocalLink(href);
  if (!parsed) {
    return null;
  }

  const itemType = inferLocalLinkItemType({
    href,
    path: parsed.path,
    fragment: parsed.fragment,
    lineStart: parsed.lineStart,
    lineEnd: parsed.lineEnd,
  });

  return {
    path: canonicalizeLocalLinkPath(parsed.path, itemType),
    itemType,
    ...(parsed.fragment ? { fragment: parsed.fragment } : {}),
    ...(parsed.lineStart !== undefined ? { lineStart: parsed.lineStart } : {}),
    ...(parsed.lineEnd !== undefined ? { lineEnd: parsed.lineEnd } : {}),
  };
}

/**
 * Serialize a local file/directory mention to a markdown link href.
 *
 * Directory links carry an explicit trailing slash so they can round-trip
 * without relying on label-based heuristics.
 */
export function serializeLocalLinkHref(options: {
  path: string;
  itemType?: LocalLinkItemType;
  fragment?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}): string {
  const {
    path,
    itemType = 'file',
    fragment,
    lineStart,
    lineEnd,
  } = options;

  let hrefPath = path;
  if (itemType === 'directory' && hrefPath && !hasTrailingPathSeparator(hrefPath)) {
    hrefPath = `${hrefPath}/`;
  }

  let href = encodeMdHref(hrefPath);
  if (fragment) href += `#${fragment}`;
  if (lineStart != null) href += `:L${lineStart}${lineEnd != null ? `-L${lineEnd}` : ''}`;
  return href;
}
