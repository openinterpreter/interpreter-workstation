/**
 * Files Service
 *
 * Mockable wrapper around the `@/ipc` files namespace.
 * In production: calls through the shared frontend IPC abstraction
 * In tests: checks window.__fileMocks first, enabling filesystem-free testing
 */

import { files as ipcFiles } from '@/ipc';
import type {
  FilesMoveResponse,
  FilesRenameResponse,
  FilesDeleteResponse,
  FilesCreateResponse,
  FilesCopyExternalResponse,
  FilesCreateBookmarkResponse,
} from '../../electron/ipc/registry';

export interface FileOperationCall {
  method: string;
  args: unknown[];
  timestamp: number;
}

export interface FileMocks {
  move?: (source: string, dest: string) => Promise<FilesMoveResponse>;
  rename?: (path: string, newName: string) => Promise<FilesRenameResponse>;
  delete?: (path: string) => Promise<FilesDeleteResponse>;
  create?: (
    type: 'note' | 'document' | 'spreadsheet' | 'slides' | 'automation' | 'remotion' | 'movie',
    workspace: string
  ) => Promise<FilesCreateResponse>;
  copyExternal?: (sources: string[], dest: string) => Promise<FilesCopyExternalResponse>;
  createBookmark?: (
    url: string,
    title: string,
    favicon: string | undefined,
    dest: string
  ) => Promise<FilesCreateBookmarkResponse>;
}

declare global {
  interface Window {
    __fileMocks?: FileMocks;
    __fileOperationCalls?: FileOperationCall[];
  }
}

function recordCall(method: string, args: unknown[]) {
  if (typeof window !== 'undefined') {
    if (!window.__fileOperationCalls) {
      window.__fileOperationCalls = [];
    }
    window.__fileOperationCalls.push({ method, args, timestamp: Date.now() });
  }
}

export const filesService = {
  async move(source: string, dest: string): Promise<FilesMoveResponse> {
    recordCall('move', [source, dest]);
    if (window.__fileMocks?.move) {
      return window.__fileMocks.move(source, dest);
    }
    return ipcFiles.move(source, dest);
  },

  async rename(path: string, newName: string): Promise<FilesRenameResponse> {
    recordCall('rename', [path, newName]);
    if (window.__fileMocks?.rename) {
      return window.__fileMocks.rename(path, newName);
    }
    return ipcFiles.rename(path, newName);
  },

  async delete(path: string): Promise<FilesDeleteResponse> {
    recordCall('delete', [path]);
    if (window.__fileMocks?.delete) {
      return window.__fileMocks.delete(path);
    }
    return ipcFiles.delete(path);
  },

  async create(
    type: 'note' | 'document' | 'spreadsheet' | 'slides' | 'automation' | 'remotion' | 'movie',
    workspace: string
  ): Promise<FilesCreateResponse> {
    recordCall('create', [type, workspace]);
    if (window.__fileMocks?.create) {
      return window.__fileMocks.create(type, workspace);
    }
    return ipcFiles.create(type, workspace);
  },

  async copyExternal(sources: string[], dest: string): Promise<FilesCopyExternalResponse> {
    recordCall('copyExternal', [sources, dest]);
    if (window.__fileMocks?.copyExternal) {
      return window.__fileMocks.copyExternal(sources, dest);
    }
    return ipcFiles.copyExternal(sources, dest);
  },

  async createBookmark(
    url: string,
    title: string,
    favicon: string | undefined,
    dest: string
  ): Promise<FilesCreateBookmarkResponse> {
    recordCall('createBookmark', [url, title, favicon, dest]);
    if (window.__fileMocks?.createBookmark) {
      return window.__fileMocks.createBookmark(url, title, favicon, dest);
    }
    return ipcFiles.createBookmark(url, title, favicon, dest);
  },
};
