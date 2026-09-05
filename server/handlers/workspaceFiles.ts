import { realpathSync } from 'node:fs';
import path from 'node:path';
import { canWritePathInWorkspace } from '../utils/workspacePathValidation';
import { getCurrentWorkspace } from '../utils/workspace';
import {
  createBookmark,
  createFile,
  createFolder,
  duplicateFile,
  getFileStats,
  getFileThumbnails,
  isDirectory,
  listDirectory,
  moveFile,
  readTextFile,
  renameFile,
  trashFile,
  writeTextFile,
} from './files';

class WorkspaceFileAccessError extends Error {
  status = 403;
}

function workspaceRoot(): string {
  const workspace = getCurrentWorkspace();
  if (!workspace) throw new WorkspaceFileAccessError('No workspace is configured.');
  return workspace;
}

function candidatePath(inputPath: string, workspace: string): string {
  return path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(workspace, inputPath);
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function resolveReadableWorkspacePath(inputPath: string): string {
  const workspace = workspaceRoot();
  const candidate = candidatePath(inputPath, workspace);
  try {
    const realWorkspace = realpathSync(workspace);
    const realCandidate = realpathSync(candidate);
    if (!isWithin(realWorkspace, realCandidate)) {
      throw new WorkspaceFileAccessError('File access is outside the configured workspace.');
    }
    return realCandidate;
  } catch (error) {
    if (error instanceof WorkspaceFileAccessError) throw error;
    throw new WorkspaceFileAccessError('File is unavailable in the configured workspace.');
  }
}

export function resolveWritableWorkspacePath(inputPath: string): string {
  const workspace = workspaceRoot();
  const candidate = candidatePath(inputPath, workspace);
  if (!canWritePathInWorkspace(candidate, workspace)) {
    throw new WorkspaceFileAccessError('File access is outside the configured workspace.');
  }
  return candidate;
}

function validateLeafName(name: string): void {
  if (!name || path.basename(name) !== name || name === '.' || name === '..') {
    throw new WorkspaceFileAccessError('File name must be a single path segment.');
  }
}

export async function readWorkspaceTextFile(inputPath: string) {
  return readTextFile(resolveReadableWorkspacePath(inputPath));
}

export async function writeWorkspaceTextFile(inputPath: string, content: string) {
  return writeTextFile(resolveWritableWorkspacePath(inputPath), content);
}

export async function isWorkspaceDirectory(inputPath: string) {
  return { isDirectory: await isDirectory(resolveReadableWorkspacePath(inputPath)) };
}

export async function getWorkspaceFileStats(inputPath: string) {
  return getFileStats(resolveReadableWorkspacePath(inputPath));
}

export async function listWorkspaceDirectory(inputPath: string) {
  return listDirectory(resolveReadableWorkspacePath(inputPath));
}

export async function getWorkspaceFileThumbnails(paths: string[], size?: number) {
  const pairs = paths.map((inputPath) => ({
    inputPath,
    absolutePath: resolveReadableWorkspacePath(inputPath),
  }));
  const result = await getFileThumbnails(
    pairs.map(({ absolutePath }) => absolutePath),
    size,
    workspaceRoot(),
  );
  return {
    thumbnails: Object.fromEntries(
      pairs.flatMap(({ inputPath, absolutePath }) => {
        const thumbnail = result.thumbnails[absolutePath];
        return thumbnail ? [[inputPath, thumbnail]] : [];
      }),
    ),
  };
}

export async function moveWorkspaceFile(sourcePath: string, destinationPath: string) {
  return moveFile(
    resolveReadableWorkspacePath(sourcePath),
    resolveWritableWorkspacePath(destinationPath),
  );
}

export async function renameWorkspaceFile(inputPath: string, newName: string) {
  validateLeafName(newName);
  const sourcePath = resolveReadableWorkspacePath(inputPath);
  resolveWritableWorkspacePath(path.join(path.dirname(sourcePath), newName));
  return renameFile(sourcePath, newName);
}

export async function trashWorkspaceFile(inputPath: string) {
  return trashFile(resolveReadableWorkspacePath(inputPath));
}

export async function duplicateWorkspaceFile(inputPath: string) {
  return duplicateFile(resolveReadableWorkspacePath(inputPath));
}

export async function createWorkspaceFile(type: Parameters<typeof createFile>[0], inputPath: string) {
  return createFile(type, resolveReadableWorkspacePath(inputPath));
}

export async function createWorkspaceFolder(parentPath: string, name?: string) {
  if (name !== undefined) validateLeafName(name);
  return createFolder(resolveReadableWorkspacePath(parentPath), name);
}

export async function createWorkspaceBookmark(
  url: string,
  title: string,
  faviconUrl: string | undefined,
  destinationFolder: string,
) {
  return createBookmark(
    url,
    title,
    faviconUrl,
    resolveReadableWorkspacePath(destinationFolder),
  );
}
