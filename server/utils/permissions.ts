// Permission resolution logic for file system access
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { globalFileAccessResolver } from '../globalFileAccessResolver';
import { getCurrentWorkspace } from './workspace';
import { FileAccessPolicy, toRuntimeFileAccessPolicy } from '../../shared/types/permissions';
import { resolveUnicodePath } from './unicodePath';
import { shouldPromptForWorkspaceWriteSync } from './agentFilePermissions';
import { normalizeFileUrlPathname } from './fileUrlPathname';

export type { FileAccessPolicy };

/**
 * Converts WSL or Unix-style Windows paths to Windows format
 * @param p The path to convert
 * @returns Converted Windows path
 */
function convertToWindowsPath(p: string): string {
  // Handle WSL paths (/mnt/c/...)
  // NEVER convert WSL paths - they are valid Linux paths that work with Node.js fs operations in WSL
  // Converting them to Windows format (C:\...) breaks fs operations inside WSL
  if (p.startsWith('/mnt/')) {
    return p; // Leave WSL paths unchanged
  }

  // Handle Unix-style Windows paths (/c/...)
  // Only convert when running on Windows
  if (p.match(/^\/[a-zA-Z]\//) && process.platform === 'win32') {
    const driveLetter = p.charAt(1).toUpperCase();
    const pathPart = p.slice(2).replace(/\//g, '\\');
    return `${driveLetter}:${pathPart}`;
  }

  // Handle standard Windows paths, ensuring backslashes
  if (p.match(/^[a-zA-Z]:/)) {
    return p.replace(/\//g, '\\');
  }

  // Leave non-Windows paths unchanged
  return p;
}

/**
 * Expands home directory tildes in paths
 * @param filepath The path to expand
 * @returns Expanded path
 */
function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

/**
 * Normalize Unicode characters in paths to ASCII equivalents.
 * This handles cases where file names contain "smart" characters that
 * look similar to ASCII but are actually different Unicode codepoints.
 *
 * Common examples:
 * - Smart quotes: ' ' " " → ' "
 * - Em/En dashes: — – → -
 * - Ellipsis: … → ...
 * - Non-breaking space: \u00A0 → regular space
 */
function normalizeUnicodeChars(filepath: string): string {
  return filepath
    // Smart single quotes (U+2018, U+2019) → ASCII apostrophe
    .replace(/[\u2018\u2019]/g, "'")
    // Smart double quotes (U+201C, U+201D) → ASCII double quote
    .replace(/[\u201C\u201D]/g, '"')
    // Em dash (U+2014), En dash (U+2013) → ASCII hyphen-minus
    .replace(/[\u2013\u2014]/g, '-')
    // Horizontal ellipsis (U+2026) → three periods
    .replace(/\u2026/g, '...')
    // Non-breaking space (U+00A0) → regular space
    .replace(/\u00A0/g, ' ')
    // Figure dash (U+2012), minus sign (U+2212) → ASCII hyphen-minus
    .replace(/[\u2012\u2212]/g, '-');
}

/**
 * Normalize a file path by:
 * - Removing surrounding quotes and whitespace
 * - Normalizing Unicode characters (smart quotes, em-dashes, etc.) to ASCII
 * - Expanding ~ to home directory (Unix/Mac/Windows)
 * - Preserving WSL paths (/mnt/c/...) - NEVER convert these
 * - Handling UNC paths (\\server\share)
 * - Converting Unix-style Windows paths (/c/Users) to C:\Users on Windows
 * - Capitalizing drive letters (c: -> C:)
 * - Normalizing separators based on platform
 * - Handling multiple consecutive separators
 *
 * This ensures consistent path handling across platforms while preserving
 * platform-specific paths like WSL mounts.
 */
export function normalizePath(inputPath: string): string {
  // Type check - must be a non-empty string
  if (!inputPath || typeof inputPath !== 'string') {
    return inputPath || '';
  }

  // Security: Reject null bytes (forbidden in paths)
  if (inputPath.includes('\x00')) {
    throw new Error('Path contains null byte');
  }

  // Remove any surrounding quotes and whitespace
  let p = inputPath.trim().replace(/^["']|["']$/g, '');

  // Early return for empty paths after trimming
  if (!p) {
    return '';
  }

  // Normalize Unicode look-alike characters to ASCII equivalents
  // This handles cases like smart quotes in directory names (e.g., "Kiman's" vs "Kiman's")
  p = normalizeUnicodeChars(p);

  // Expand home directory before other processing
  p = expandHome(p);

  p = normalizeFileUrlPathname(p);

  // Check if this is a Unix path that should not be converted
  // WSL paths (/mnt/) should ALWAYS be preserved as they work correctly in WSL with Node.js fs
  // Regular Unix paths should also be preserved
  const isUnixPath = p.startsWith('/') && (
    // Always preserve WSL paths (/mnt/c/, /mnt/d/, etc.)
    p.match(/^\/mnt\/[a-z]\//i) ||
    // On non-Windows platforms, treat all absolute paths as Unix paths
    (process.platform !== 'win32') ||
    // On Windows, preserve Unix paths that aren't Unix-style Windows paths (/c/, /d/, etc.)
    (process.platform === 'win32' && !p.match(/^\/[a-zA-Z]\//))
  );

  if (isUnixPath) {
    // For Unix paths, just normalize without converting to Windows format
    // Replace multiple consecutive slashes with single slashes and remove trailing slashes
    return p.replace(/\/+/g, '/').replace(/(?<!^)\/$/, '');
  }

  // Convert Unix-style Windows paths (/c/, /d/) to Windows format if on Windows
  // This function will leave /mnt/ paths unchanged
  p = convertToWindowsPath(p);

  // Handle double backslashes, preserving leading UNC \\
  if (p.startsWith('\\\\')) {
    // For UNC paths, first normalize any excessive leading backslashes to exactly \\
    // Then normalize double backslashes in the rest of the path
    let uncPath = p;
    // Replace multiple leading backslashes with exactly two
    uncPath = uncPath.replace(/^\\{2,}/, '\\\\');
    // Now normalize any remaining double backslashes in the rest of the path
    const restOfPath = uncPath.substring(2).replace(/\\\\/g, '\\');
    p = '\\\\' + restOfPath;
  } else {
    // For non-UNC paths, normalize all double backslashes
    p = p.replace(/\\\\/g, '\\');
  }

  // Use Node's path normalization, which handles . and .. segments
  let normalized = path.normalize(p);

  // Fix UNC paths after normalization (path.normalize can remove a leading backslash)
  if (p.startsWith('\\\\') && !normalized.startsWith('\\\\')) {
    normalized = '\\' + normalized;
  }

  // Handle Windows paths: convert slashes and ensure drive letter is capitalized
  if (normalized.match(/^[a-zA-Z]:/)) {
    let result = normalized.replace(/\//g, '\\');
    // Capitalize drive letter if present
    if (/^[a-z]:/.test(result)) {
      result = result.charAt(0).toUpperCase() + result.slice(1);
    }
    return result;
  }

  // On Windows, convert forward slashes to backslashes for relative paths
  // On Linux/Unix, preserve forward slashes
  if (process.platform === 'win32') {
    return normalized.replace(/\//g, '\\');
  }

  // On non-Windows platforms, keep the normalized path as-is
  return normalized;
}

/**
 * Resolve a path that may be workspace-relative or absolute.
 * - If path is absolute (starts with / or ~), use normalizePath
 * - If path is relative, join with workspace path first
 * - Handles Windows drive letters (C:\, etc.), WSL paths (/mnt/c/), and UNC paths (\\server\share)
 */
export function resolvePathWithWorkspace(inputPath: string, workspacePath: string | null): string {
  // Type check
  if (!inputPath || typeof inputPath !== 'string') {
    return inputPath || '';
  }

  // Trim and remove quotes
  const trimmedPath = inputPath.trim().replace(/^["']|["']$/g, '');

  // Check if path is absolute
  const isAbsolute =
    trimmedPath.startsWith('/') ||           // Unix absolute or WSL (/mnt/c/)
    trimmedPath.startsWith('~') ||           // Home directory
    trimmedPath.startsWith('\\\\') ||        // UNC path (\\server\share)
    /^[a-zA-Z]:[\\/]/.test(trimmedPath);     // Windows drive letter (C:\ or C:/)

  if (isAbsolute) {
    // Absolute path - just normalize it
    return normalizePath(trimmedPath);
  }

  // Relative path - need workspace
  if (!workspacePath) {
    // No workspace set - cannot resolve relative paths
    // Tools should call getCurrentWorkspace() and handle null case before calling this
    console.warn('[resolvePathWithWorkspace] No workspace set for relative path:', inputPath);
    throw new Error(`Cannot resolve relative path "${inputPath}" without a workspace. Set a workspace first.`);
  }

  // Join with workspace and then normalize
  const workspaceResolved = normalizePath(workspacePath);
  const joined = path.join(workspaceResolved, trimmedPath);
  return normalizePath(joined);
}

/**
 * Resolve the deepest existing ancestor with realpath and then re-append the
 * missing suffix. This preserves canonical roots for comparison while still
 * supporting paths that do not exist yet.
 */
export async function resolvePathForSecurityCheck(inputPath: string): Promise<string> {
  const normalizedPath = normalizePath(inputPath);
  const missingSegments: string[] = [];
  let currentPath = normalizedPath;
  const maxDepth = 64;

  for (let i = 0; i < maxDepth; i += 1) {
    const resolvedPath = await resolveUnicodePath(currentPath);

    try {
      const realPath = normalizePath(await fs.realpath(resolvedPath));
      if (missingSegments.length === 0) {
        return realPath;
      }
      return normalizePath(path.join(realPath, ...missingSegments.reverse()));
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return normalizedPath;
      }

      missingSegments.push(path.basename(currentPath));
      currentPath = parentPath;
    }
  }

  return normalizedPath;
}

/**
 * Synchronous version of canAccess for internal use (no symlink resolution)
 * Used by resolveAndValidatePath to avoid infinite recursion
 */
function canAccessSync(
  normalizedPath: string,
  mode: 'read' | 'write',
  permissions: FileAccessPolicy,
  workspacePath: string | null
): boolean {
  // 1. Check custom paths first (most specific - can blacklist!)
  for (const [customPath, access] of Array.from(permissions.customPaths.entries())) {
    const normalizedCustomPath = normalizePath(customPath);
    if (isSamePathOrDescendant(normalizedPath, normalizedCustomPath)) {
      if (access === 'none') return false;
      return access === 'write' || (access === 'read' && mode === 'read');
    }
  }

  // 2. Check workspace (if set and path is within it)
  if (workspacePath) {
    const normalizedWorkspace = normalizePath(workspacePath);
    if (isSamePathOrDescendant(normalizedPath, normalizedWorkspace)) {
      const access = permissions.workspace;
      if (access === 'none') return false;
      return access === 'write' || (access === 'read' && mode === 'read');
    }
  }

  // 3. Fall back to system-wide
  const access = permissions.system;
  if (access === 'none') return false;
  return access === 'write' || (access === 'read' && mode === 'read');
}

function getPathModuleForContainment(candidatePath: string, rootPath: string): typeof path.win32 | typeof path.posix {
  const looksWindowsLike = (value: string): boolean =>
    value.includes('\\') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');

  return looksWindowsLike(candidatePath) || looksWindowsLike(rootPath)
    ? path.win32
    : path.posix;
}

export function isSamePathOrDescendant(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = normalizePath(candidatePath);
  const normalizedRoot = normalizePath(rootPath);

  if (normalizedCandidate === normalizedRoot) {
    return true;
  }

  const pathImpl = getPathModuleForContainment(normalizedCandidate, normalizedRoot);
  const relative = pathImpl.relative(normalizedRoot, normalizedCandidate);
  return relative !== '' && !relative.startsWith('..') && !pathImpl.isAbsolute(relative);
}

/**
 * Check if an agent has permission to access a file path (synchronous, no symlink resolution)
 * Precedence: sandbox (always read/write) -> customPaths (most specific) -> workspace -> system
 *
 * WARNING: This does NOT resolve symlinks. For security-critical operations, use canAccessAsync instead.
 */
export function canAccess(
  inputPath: string,
  mode: 'read' | 'write',
  permissions: FileAccessPolicy,
  workspacePath: string | null
): boolean {
  // Resolve the path with workspace context (handles workspace-relative paths)
  const normalizedPath = resolvePathWithWorkspace(inputPath, workspacePath);

  console.log('[canAccess] Resolving path:', {
    inputPath,
    workspacePath,
    normalizedPath
  });

  return canAccessSync(normalizedPath, mode, permissions, workspacePath);
}

/**
 * Async version that resolves symlinks before checking permissions
 * This is the SECURE version - use this for all file operations
 */
export async function canAccessAsync(
  inputPath: string,
  mode: 'read' | 'write',
  permissions: FileAccessPolicy,
  workspacePath: string | null
): Promise<boolean> {
  // Resolve the path with workspace context (handles workspace-relative paths)
  const normalizedPath = resolvePathWithWorkspace(inputPath, workspacePath);

  console.log('[canAccessAsync] Resolving path:', {
    inputPath,
    workspacePath,
    normalizedPath
  });

  const resolvedWorkspacePath = workspacePath
    ? await resolvePathForSecurityCheck(workspacePath)
    : null;

  const resolvedPermissions: FileAccessPolicy = {
    system: permissions.system,
    workspace: permissions.workspace,
    customPaths: new Map(),
  };

  for (const [customPath, access] of permissions.customPaths.entries()) {
    resolvedPermissions.customPaths.set(
      await resolvePathForSecurityCheck(customPath),
      access,
    );
  }

  const realPath = await resolvePathForSecurityCheck(normalizedPath);
  const allowed = canAccessSync(realPath, mode, resolvedPermissions, resolvedWorkspacePath);

  console.log('[canAccessAsync] Symlink resolution result:', {
    normalizedPath,
    realPath,
    allowed
  });

  return allowed;
}

/**
 * Simple helper to check whether a requester is allowed to access a path.
 * Abstracts away all the complexity of resolving the current global
 * file-access policy and workspace.
 *
 * WARNING: This is synchronous and does NOT resolve symlinks.
 * For security-critical operations, use checkFileAccessPermissionAsync instead.
 */
export function checkFileAccessPermission(
  requesterId: string,
  path: string,
  mode: 'read' | 'write',
  workspaceOverride?: string | null
): boolean {
  const permissionsData = globalFileAccessResolver.resolveForRequester(requesterId);
  const workspace = workspaceOverride ?? getCurrentWorkspace();

  // Convert storage format (Record) to runtime format (Map)
  const permissions = toRuntimeFileAccessPolicy(permissionsData);

  return canAccess(path, mode, permissions, workspace);
}

/**
 * Build a user-facing permission denial message tied to current settings.
 * This should be used when a tool has already determined access is denied.
 */
export function getFileAccessDeniedMessage(
  requesterId: string,
  inputPath: string,
  mode: 'read' | 'write',
  workspaceOverride?: string | null
): string {
  const permissionsData = globalFileAccessResolver.resolveForRequester(requesterId);
  const permissions = toRuntimeFileAccessPolicy(permissionsData);
  const workspace = workspaceOverride ?? getCurrentWorkspace();

  let resolvedPath = inputPath;
  try {
    resolvedPath = resolvePathWithWorkspace(inputPath, workspace);
  } catch {
    resolvedPath = normalizePath(inputPath);
  }

  let inWorkspace = false;
  if (workspace) {
    const normalizedWorkspace = normalizePath(workspace);
    const normalizedPath = normalizePath(resolvedPath);
    inWorkspace = isSamePathOrDescendant(normalizedPath, normalizedWorkspace);
  }

  if (mode === 'read' && !inWorkspace && permissions.system === 'none') {
    return `Permission denied: this agent can only view files inside its workspace.\n\nWorkspace: ${workspace ?? 'none'}\nPath: ${resolvedPath}`;
  }

  if (mode === 'write' && inWorkspace && permissions.workspace !== 'write') {
    if (shouldPromptForWorkspaceWriteSync()) {
      return `Permission denied: this agent is set to ask before changing files in its workspace.\n\nWorkspace: ${workspace ?? 'none'}\nPath: ${resolvedPath}`;
    }
    return `Permission denied: this agent cannot change files in its workspace under the current global settings.\n\nWorkspace: ${workspace ?? 'none'}\nPath: ${resolvedPath}`;
  }

  if (mode === 'write' && !inWorkspace) {
    return `Permission denied: this agent cannot change files outside its workspace.\n\nWorkspace: ${workspace ?? 'none'}\nPath: ${resolvedPath}`;
  }

  return `Permission denied: ${mode} access to ${resolvedPath} is not allowed`;
}

/**
 * Async version that resolves symlinks before checking permissions
 * This is the SECURE version - use this for all file operations to prevent symlink attacks
 */
export async function checkFileAccessPermissionAsync(
  requesterId: string,
  filePath: string,
  mode: 'read' | 'write',
  workspaceOverride?: string | null
): Promise<boolean> {
  const permissionsData = globalFileAccessResolver.resolveForRequester(requesterId);
  const workspace = workspaceOverride ?? getCurrentWorkspace();

  // Convert storage format (Record) to runtime format (Map)
  const permissions = toRuntimeFileAccessPolicy(permissionsData);

  return canAccessAsync(filePath, mode, permissions, workspace);
}

/**
 * Get the directories allowed by the current global file-access policy.
 */
export function getAllowedFileAccessDirectories(
  requesterId: string
): {
  systemAccess: 'none' | 'read' | 'write';
  directories: Array<{ path: string; access: 'read' | 'write' }>;
} {
  const permissions = globalFileAccessResolver.resolveForRequester(requesterId);
  const workspacePath = getCurrentWorkspace();
  const directories: Array<{ path: string; access: 'read' | 'write' }> = [];

  // Add workspace if allowed
  if (workspacePath && permissions.workspace !== 'none') {
    directories.push({
      path: normalizePath(workspacePath),
      access: permissions.workspace as 'read' | 'write'
    });
  }

  // Add custom paths if allowed
  for (const [customPath, access] of Object.entries(permissions.customPaths)) {
    if (access !== 'none') {
      directories.push({
        path: normalizePath(customPath),
        access: access as 'read' | 'write'
      });
    }
  }

  return {
    systemAccess: permissions.system,
    directories
  };
}
