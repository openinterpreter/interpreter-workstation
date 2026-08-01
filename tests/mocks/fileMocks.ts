/**
 * File Operation Mocks for Testing
 *
 * Utilities for mocking window.electron.files.* operations in Playwright tests.
 * Enables testing drag-drop and file operations without real filesystem changes.
 */

import { Page } from '@playwright/test';
import type { FileMocks } from '@/api/filesService';

export interface MockedFileOperation {
  method: string;
  args: unknown[];
  timestamp: number;
}

export interface FileMockOptions {
  simulateUIUpdate?: boolean;
  delay?: number;
}

declare global {
  interface Window {
    __fileOperationCalls?: MockedFileOperation[];
    __fileMocks?: FileMocks;
  }
}

export async function setupFileMocks(page: Page, options: FileMockOptions = {}) {
  await page.evaluate((opts) => {
    window.__fileOperationCalls = [];

    window.__fileMocks = {
      move: async (source: string, dest: string) => {
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));

        if (opts.simulateUIUpdate) {
          window.dispatchEvent(
            new CustomEvent('workspace:files-changed', {
              detail: { eventType: 'unlink', path: source },
            })
          );
          window.dispatchEvent(
            new CustomEvent('workspace:files-changed', {
              detail: { eventType: 'add', path: dest },
            })
          );
        }

        return { success: true };
      },

      rename: async (path: string, newName: string) => {
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));

        if (opts.simulateUIUpdate) {
          const dir = path.substring(0, path.lastIndexOf('/'));
          const newPath = `${dir}/${newName}`;
          window.dispatchEvent(
            new CustomEvent('workspace:files-changed', {
              detail: { eventType: 'unlink', path },
            })
          );
          window.dispatchEvent(
            new CustomEvent('workspace:files-changed', {
              detail: { eventType: 'add', path: newPath },
            })
          );
        }

        return { success: true };
      },

      delete: async (path: string) => {
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));

        if (opts.simulateUIUpdate) {
          window.dispatchEvent(
            new CustomEvent('workspace:files-changed', {
              detail: { eventType: 'unlink', path },
            })
          );
        }

        return { success: true };
      },

      create: async (type: string, workspace: string) => {
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
        const fakePath = `${workspace}/New-${type}-${Date.now()}.md`;

        if (opts.simulateUIUpdate) {
          window.dispatchEvent(
            new CustomEvent('workspace:files-changed', {
              detail: { eventType: 'add', path: fakePath },
            })
          );
        }

        return { success: true, path: fakePath };
      },

      copyExternal: async (sources: string[], dest: string) => {
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
        const copiedPaths = sources.map((s) => `${dest}/${s.split('/').pop()}`);

        if (opts.simulateUIUpdate) {
          copiedPaths.forEach((p) => {
            window.dispatchEvent(
              new CustomEvent('workspace:files-changed', {
                detail: { eventType: 'add', path: p },
              })
            );
          });
        }

        return { success: true, copiedPaths };
      },

      createBookmark: async (
        _url: string,
        title: string,
        _favicon: string | undefined,
        dest: string
      ) => {
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
        const bookmarkPath = `${dest}/${title.replace(/[^a-z0-9]/gi, '-')}.webloc`;

        if (opts.simulateUIUpdate) {
          window.dispatchEvent(
            new CustomEvent('workspace:files-changed', {
              detail: { eventType: 'add', path: bookmarkPath },
            })
          );
        }

        return { success: true, path: bookmarkPath };
      },
    };
  }, options);
}

export async function clearFileMocks(page: Page) {
  await page.evaluate(() => {
    delete window.__fileMocks;
    window.__fileOperationCalls = [];
  });
}

export async function getFileOperationCalls(page: Page): Promise<MockedFileOperation[]> {
  return page.evaluate(() => window.__fileOperationCalls || []);
}

export async function assertMoveWasCalled(
  page: Page,
  expectedSource?: string,
  expectedDest?: string
): Promise<boolean> {
  const calls = await getFileOperationCalls(page);
  const moveCalls = calls.filter((c) => c.method === 'move');

  if (moveCalls.length === 0) return false;

  if (expectedSource && expectedDest) {
    return moveCalls.some((c) => c.args[0] === expectedSource && c.args[1] === expectedDest);
  }

  return true;
}

export async function getLastMoveCall(
  page: Page
): Promise<{ source: string; dest: string } | null> {
  const calls = await getFileOperationCalls(page);
  const moveCalls = calls.filter((c) => c.method === 'move');

  if (moveCalls.length === 0) return null;

  const last = moveCalls[moveCalls.length - 1];
  return { source: last.args[0] as string, dest: last.args[1] as string };
}

export async function getLastCopyExternalCall(
  page: Page
): Promise<{ sources: string[]; dest: string } | null> {
  const calls = await getFileOperationCalls(page);
  const copyCalls = calls.filter((c) => c.method === 'copyExternal');

  if (copyCalls.length === 0) return null;

  const last = copyCalls[copyCalls.length - 1];
  return { sources: last.args[0] as string[], dest: last.args[1] as string };
}

export async function getLastDeleteCall(page: Page): Promise<{ path: string } | null> {
  const calls = await getFileOperationCalls(page);
  const deleteCalls = calls.filter((c) => c.method === 'delete');

  if (deleteCalls.length === 0) return null;

  const last = deleteCalls[deleteCalls.length - 1];
  return { path: last.args[0] as string };
}

export async function getLastRenameCall(
  page: Page
): Promise<{ path: string; newName: string } | null> {
  const calls = await getFileOperationCalls(page);
  const renameCalls = calls.filter((c) => c.method === 'rename');

  if (renameCalls.length === 0) return null;

  const last = renameCalls[renameCalls.length - 1];
  return { path: last.args[0] as string, newName: last.args[1] as string };
}
