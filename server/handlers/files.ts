/**
 * Files Handlers
 *
 * THE business logic for file operations.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { thumbnailService, type ThumbnailResult } from '../thumbnailService';
import { detectRunnableProject } from '../utils/runnableProjects';
import { normalizeFileUrlPathname } from '../utils/fileUrlPathname';
import { getCurrentWorkspace } from '../utils/workspace';
import {
  applyPreparedVaultRename,
  invalidateVaultIndex,
  type PreparedVaultRename,
  prepareVaultRename,
} from '../utils/vaultIndex';
import type { FolderTreeNode } from '../../shared/types/folder';

// Detect if we're running in Electron
const isElectron = !!process.versions.electron;

// Lazy-load Electron shell API only when in Electron mode
let electronShell: Electron.Shell | null = null;
if (isElectron) {
  try {
    const electron = require('electron');
    electronShell = electron.shell;
  } catch {
    console.warn('[files handler] Failed to load Electron shell API');
  }
}

const WINDOWS_EXTENDED_LENGTH_PREFIX = '\\\\?\\';
const WINDOWS_EXTENDED_LENGTH_UNC_PREFIX = '\\\\?\\UNC\\';
const WINDOWS_DRIVE_ROOT_LENGTH = 'C:\\'.length;

function isWindowsDriveAbsolutePath(filePath: string): boolean {
  const root = path.win32.parse(filePath).root;
  return path.win32.isAbsolute(filePath)
    && root.length === WINDOWS_DRIVE_ROOT_LENGTH
    && root[2] === '\\';
}

// ============================================================================
// File Operations
// ============================================================================

function isWithinWorkspace(workspacePath: string, candidatePath: string): boolean {
  const relativePath = path.relative(workspacePath, candidatePath);
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

export async function moveFile(
  sourcePath: string,
  destPath: string,
  options?: {
    updateReferences?: boolean;
    preparedRename?: PreparedVaultRename | null;
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    const workspacePath = getCurrentWorkspace();
    const sourceStats = await fs.stat(sourcePath);
    const updateReferences = options?.updateReferences !== false;
    const shouldPropagateVaultRename = Boolean(
      updateReferences
      && workspacePath
      && sourceStats.isFile()
      && isWithinWorkspace(workspacePath, sourcePath)
      && isWithinWorkspace(workspacePath, destPath),
    );
    const preparedRename = shouldPropagateVaultRename
      ? (options?.preparedRename ?? await prepareVaultRename(sourcePath, workspacePath))
      : null;

    await fs.rename(sourcePath, destPath);
    await applyPreparedVaultRename(preparedRename, destPath);
    invalidateVaultIndex(workspacePath);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function renameFile(
  filePath: string,
  newName: string,
  options?: {
    updateReferences?: boolean;
    preparedRename?: PreparedVaultRename | null;
  },
): Promise<{ success: boolean; newPath?: string; error?: string }> {
  try {
    const dir = path.dirname(filePath);
    const newPath = path.join(dir, newName);
    const workspacePath = getCurrentWorkspace();
    const updateReferences = options?.updateReferences !== false;
    const preparedRename = updateReferences && workspacePath && isWithinWorkspace(workspacePath, filePath)
      ? (options?.preparedRename ?? await prepareVaultRename(filePath, workspacePath))
      : null;
    await fs.rename(filePath, newPath);
    await applyPreparedVaultRename(preparedRename, newPath);
    invalidateVaultIndex(workspacePath);
    return { success: true, newPath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function trashFile(
  filePath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const trashPath = normalizeTrashPath(filePath);

    if (electronShell) {
      // Use native Electron API (cross-platform, no ESM issues)
      await electronShell.trashItem(trashPath);
    } else {
      // Fallback for non-Electron mode (browser dev)
      // Just delete the file since we can't access system trash
      await fs.rm(trashPath, { recursive: true });
    }
    invalidateVaultIndex(getCurrentWorkspace());
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function duplicateFile(
  filePath: string
): Promise<{ success: boolean; newPath?: string; error?: string }> {
  try {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);

    // Find a unique name: "file copy.txt", "file copy 2.txt", etc.
    let copyNum = 0;
    let newPath: string;
    do {
      const suffix = copyNum === 0 ? ' copy' : ` copy ${copyNum + 1}`;
      newPath = path.join(dir, `${baseName}${suffix}${ext}`);
      copyNum++;
    } while (await fs.access(newPath).then(() => true).catch(() => false));

    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      // For directories, use recursive copy
      await fs.cp(filePath, newPath, { recursive: true });
    } else {
      await fs.copyFile(filePath, newPath);
    }

    return { success: true, newPath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function createFolder(
  parentPath: string,
  name?: string
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const baseName = name || 'Folder';
    let folderPath = path.join(parentPath, baseName);

    // Find unique name: Folder, Folder (1), Folder (2), etc.
    let num = 1;
    while (await fs.access(folderPath).then(() => true).catch(() => false)) {
      folderPath = path.join(parentPath, `${baseName} (${num})`);
      num++;
    }

    await fs.mkdir(folderPath, { recursive: true });
    invalidateVaultIndex(getCurrentWorkspace());
    return { success: true, path: folderPath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function copyPath(
  filePath: string
): Promise<{ success: boolean; path: string }> {
  // Returns the path for clipboard operations
  // In Electron mode, the caller can write to clipboard
  // In browser mode, the UI handles clipboard
  return { success: true, path: filePath };
}

export function normalizeTrashPath(filePath: string): string {
  if (process.platform !== 'win32') {
    return filePath;
  }

  // NOTE(victor): Windows shell trash rejects extended-length namespaces.
  if (filePath.startsWith(WINDOWS_EXTENDED_LENGTH_UNC_PREFIX)) {
    return `\\\\${filePath.slice(WINDOWS_EXTENDED_LENGTH_UNC_PREFIX.length)}`;
  }

  if (filePath.startsWith(WINDOWS_EXTENDED_LENGTH_PREFIX)) {
    const unprefixedPath = filePath.slice(WINDOWS_EXTENDED_LENGTH_PREFIX.length);
    if (isWindowsDriveAbsolutePath(unprefixedPath)) {
      return unprefixedPath;
    }
  }

  return filePath;
}

export async function readTextFile(
  filePath: string
): Promise<{ content: string }> {
  // SECURITY: This helper is used by the Electron-only FILES_READ IPC handler.
  // Do not route browser/HTTP callers here for unrestricted filesystem reads.
  const content = await fs.readFile(normalizeFileUrlPathname(filePath), 'utf-8');
  return { content };
}

export async function readBinaryFile(
  filePath: string,
): Promise<{ buffer: ArrayBuffer }> {
  const content = await fs.readFile(normalizeFileUrlPathname(filePath));
  return {
    buffer: content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer,
  };
}

export async function writeTextFile(
  filePath: string,
  content: string
): Promise<{ success: boolean }> {
  // SECURITY: This helper is used by the Electron-only FILES_WRITE IPC handler.
  // Workspace-boundary enforcement for browser/HTTP writes still lives elsewhere.
  // Let the workspace watcher invalidate vault metadata for on-disk edits.
  // Eager invalidation here forces full vault rebuilds during normal editor save loops.
  await fs.writeFile(normalizeFileUrlPathname(filePath), content, 'utf-8');
  return { success: true };
}

export async function writeBinaryFile(
  filePath: string,
  content: Uint8Array,
): Promise<{ success: boolean }> {
  // SECURITY: This helper is used by the Electron-only FILES_WRITE_BINARY IPC handler.
  // Workspace-boundary enforcement for browser/HTTP writes still lives elsewhere.
  // Binary writes do not need to eagerly invalidate the markdown vault cache here.
  await fs.writeFile(normalizeFileUrlPathname(filePath), content);
  return { success: true };
}

export type FileType = 'note' | 'document' | 'spreadsheet' | 'slides' | 'automation' | 'remotion' | 'movie';

function isPackagedElectronApp(): boolean {
  if (!process.versions.electron) {
    return false;
  }

  try {
    return require('electron').app.isPackaged;
  } catch {
    return true;
  }
}

export async function createFile(
  type: FileType,
  workspacePath: string
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const typeConfig: Record<FileType, { baseName: string; ext: string }> = {
      note: { baseName: 'Note', ext: '.md' },
      document: { baseName: 'Document', ext: '.docx' },
      spreadsheet: { baseName: 'Spreadsheet', ext: '.xlsx' },
      slides: { baseName: 'Slides', ext: '.pptx' },
      automation: { baseName: 'Automation', ext: '.automation' },
      remotion: { baseName: 'Remotion Project', ext: '.remotion' },
      movie: { baseName: 'Movie', ext: '.movie' },
    };

    if (type === 'remotion') {
      // Remotion is dev-only (license does not permit redistribution)
      const isPackaged = process.versions.electron
        ? isPackagedElectronApp()
        : true;
      if (isPackaged) {
        return { success: false, error: 'Remotion projects are only available in development mode' };
      }
      const { createRemotionProjectFile } = await import('./remotion');
      return createRemotionProjectFile(workspacePath);
    }

    if (type === 'movie') {
      if (isPackagedElectronApp()) {
        return { success: false, error: 'Movie projects are only available in development mode' };
      }
      const { createMovieProjectFile } = await import('./movie');
      return createMovieProjectFile(workspacePath);
    }

    const { baseName, ext } = typeConfig[type];
    let filePath = path.join(workspacePath, `${baseName}${ext}`);

    // Find unique name: Note.md, Note (1).md, Note (2).md, etc.
    let num = 1;
    while (await fs.access(filePath).then(() => true).catch(() => false)) {
      filePath = path.join(workspacePath, `${baseName} (${num})${ext}`);
      num++;
    }

    const initialContent = type === 'automation'
      ? JSON.stringify({ version: 1, name: baseName, blocks: [] }, null, 2)
      : '';
    await fs.writeFile(filePath, initialContent);
    invalidateVaultIndex(getCurrentWorkspace());
    return { success: true, path: filePath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function createBookmark(
  url: string,
  title: string,
  _faviconUrl: string | undefined,
  destFolder: string
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const sanitizedTitle = title.replace(/[^a-z0-9]/gi, '_');
    const filename = `${sanitizedTitle}.url`;
    const filePath = path.join(destFolder, filename);
    const content = `[InternetShortcut]\nURL=${url}\n`;
    await fs.writeFile(filePath, content);
    invalidateVaultIndex(getCurrentWorkspace());
    return { success: true, path: filePath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export interface FileStats {
  size: number | null;
  lineCount: number | null;
  itemCount: number | null;
  isDirectory: boolean;
}

export async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'js', 'ts', 'tsx', 'jsx', 'py', 'css', 'html', 'json',
  'yaml', 'yml', 'toml', 'csv', 'xml', 'sh', 'bash', 'zsh', 'c', 'cpp',
  'h', 'hpp', 'java', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala',
  'sql', 'r', 'lua', 'pl', 'pm', 'vue', 'svelte'
]);

// Max file size to count lines (10MB) - skip for huge files
const MAX_LINE_COUNT_SIZE = 10 * 1024 * 1024;

export async function getFileStats(filePath: string): Promise<FileStats> {
  try {
    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      const items = await fs.readdir(filePath);
      const visibleItems = items.filter(name => !name.startsWith('.'));
      return {
        size: null,
        lineCount: null,
        itemCount: visibleItems.length,
        isDirectory: true,
      };
    }

    const size = stat.size;
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    let lineCount: number | null = null;
    if (TEXT_EXTENSIONS.has(ext) && size <= MAX_LINE_COUNT_SIZE) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        lineCount = content.split('\n').length;
      } catch {
        // If we can't read, skip line count
      }
    }

    return {
      size,
      lineCount,
      itemCount: null,
      isDirectory: false,
    };
  } catch {
    return {
      size: null,
      lineCount: null,
      itemCount: null,
      isDirectory: false,
    };
  }
}

function sortFolderNodes(nodes: FolderTreeNode[]): FolderTreeNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }

    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

export async function listDirectory(
  dirPath: string,
): Promise<{ success: boolean; entries?: FolderTreeNode[]; error?: string }> {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const nodes = (await Promise.all(entries.map(async (entry): Promise<FolderTreeNode | null> => {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          const runnableProject = await detectRunnableProject(fullPath);

          return {
            name: entry.name,
            path: fullPath,
            type: 'directory',
            ...(runnableProject ? { runnableProject } : {}),
          };
        }

        const entryStat = await fs.stat(fullPath);
        return {
          name: entry.name,
          path: fullPath,
          type: 'file',
          mtime: entryStat.mtimeMs,
        };
      } catch {
        return null;
      }
    }))).filter((node): node is FolderTreeNode => node !== null);

    return { success: true, entries: sortFolderNodes(nodes) };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getFileThumbnails(
  paths: string[],
  size: number = 64,
  workspacePath: string | null = getCurrentWorkspace()
): Promise<{ thumbnails: Record<string, ThumbnailResult> }> {
  const thumbnailSize = Math.min(Math.max(size, 16), 512);
  const pathMapping = new Map<string, string>();
  const absolutePaths: string[] = [];

  for (const inputPath of paths) {
    let absolutePath: string | null = null;
    if (path.isAbsolute(inputPath)) {
      absolutePath = path.normalize(inputPath);
    } else if (workspacePath) {
      absolutePath = path.normalize(path.join(workspacePath, inputPath));
    }

    if (!absolutePath) {
      continue;
    }

    pathMapping.set(inputPath, absolutePath);
    absolutePaths.push(absolutePath);
  }

  const thumbnails = await thumbnailService.batchGetThumbnails(absolutePaths, undefined, thumbnailSize);
  const result: Record<string, ThumbnailResult> = {};

  for (const [inputPath, absolutePath] of pathMapping.entries()) {
    const thumbnail = thumbnails.get(absolutePath);
    if (thumbnail) {
      result[inputPath] = thumbnail;
    }
  }

  return { thumbnails: result };
}
