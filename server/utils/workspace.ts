/**
 * Workspace utilities
 * Separated from server.ts to avoid circular dependencies with builtin tools
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { initializeGlobalWorkspaceWatch } from '../workspaceWatchRegistry';

// Workspace state - will be set by server.ts
let currentWorkspace: string | null = null;
let workspaceStateVersion = 0;
const workspaceOverrideStorage = new AsyncLocalStorage<{ workspace: string | null }>();

export function setCurrentWorkspace(workspace: string | null): void {
  currentWorkspace = workspace;
  workspaceStateVersion += 1;
}

export function getCurrentWorkspace(): string | null {
  const override = workspaceOverrideStorage.getStore();
  if (override) {
    return override.workspace;
  }
  return currentWorkspace;
}

export function getWorkspaceStateVersion(): number {
  return workspaceStateVersion;
}

export function enterWorkspaceOverride(workspace: string | null): void {
  workspaceOverrideStorage.enterWith({ workspace });
}

export async function runWithWorkspaceOverride<T>(
  workspace: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return await workspaceOverrideStorage.run({ workspace }, fn);
}

export function resolveWorkspacePath(workspacePath: string): string {
  if (!workspacePath) {
    throw new Error('Workspace path is required');
  }

  // Resolve to absolute path (expand relative paths)
  // NOTE: Do NOT use normalizePath here — it converts Unicode characters (smart quotes,
  // em dashes, etc.) to ASCII, which breaks folder names that contain those characters.
  let resolvedPath = workspacePath;
  if (resolvedPath.startsWith('~')) {
    resolvedPath = resolvedPath.replace(/^~/, homedir());
  }
  resolvedPath = pathResolve(resolvedPath);

  // Verify the path exists and is a directory
  if (!existsSync(resolvedPath)) {
    throw new Error('Workspace path does not exist');
  }

  const stats = statSync(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error('Workspace path must be a directory');
  }

  return resolvedPath;
}

export function requireExistingWorkspacePath(
  workspacePath: string | null | undefined,
): string {
  if (!workspacePath) {
    throw new Error('No workspace set. Open a folder first.');
  }

  try {
    return resolveWorkspacePath(workspacePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown workspace error';
    if (message === 'Workspace path does not exist') {
      throw new Error('The selected folder no longer exists. Pick a new folder and try again.');
    }
    if (message === 'Workspace path must be a directory') {
      throw new Error('The selected folder is not a directory. Pick a new folder and try again.');
    }
    throw error;
  }
}

/**
 * Validate and set the workspace path
 * Throws an error if the path is invalid
 */
export function setWorkspace(workspacePath: string): void {
  setCurrentWorkspace(resolveWorkspacePath(workspacePath));
}

/**
 * Restart file watcher for the current workspace and emit events
 * Called from both server routes and Electron menu
 */
export async function restartFileWatcher(): Promise<void> {
  try {
    const workspace = getCurrentWorkspace();
    await initializeGlobalWorkspaceWatch(workspace);
  } catch (error) {
    // File watcher might not be available (e.g., in tests)
    console.log('[Workspace] Could not restart file watcher:', error);
  }
}
