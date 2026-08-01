/**
 * Workspace Handlers
 *
 * THE business logic for workspace management.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import path from 'path';
import { statSync, realpathSync } from 'fs';
import { IPC_CHANNELS } from '../../electron/ipc/registry';
import { ensureWorkspaceInitialized } from '../workspaceInitialization';
import {
  createNewWorkspace,
  addRecentFolder,
  bindWindowSessionWorkspace,
  broadcastEvent,
  clearGlobalWorkspaceWatch,
  closeWorkspace,
  getCurrentWindowSessionKey,
  getCurrentWorkspace,
  initializeGlobalWorkspaceWatch,
  listWindowSessions,
  onWorkspaceChanged,
  resolveWorkspacePath,
  saveLastWorkspace,
  setCurrentWorkspace,
  updateWindowSessionWorkspace,
} from './workspaceDeps';

// ============================================================================
// Workspace Operations
// ============================================================================

export async function getWorkspace(): Promise<{ workspace: string | null }> {
  await ensureWorkspaceInitialized();
  return { workspace: getCurrentWorkspace() };
}

export async function setWorkspace(workspacePath: string): Promise<{ success: boolean }> {
  // Note: Special folder names ('desktop', 'documents', 'downloads') are expanded
  // by workspaceConfirmation.ts using Electron's app.getPath() BEFORE calling this.
  // This handler receives the full path.

  const normalizedPath = resolveWorkspacePath(workspacePath);
  const currentWindowSessionKey = getCurrentWindowSessionKey();
  const existingWindowSessions = listWindowSessions();

  setCurrentWorkspace(normalizedPath);
  if (currentWindowSessionKey) {
    updateWindowSessionWorkspace(currentWindowSessionKey, normalizedPath);
    await bindWindowSessionWorkspace(currentWindowSessionKey, normalizedPath);
  } else if (existingWindowSessions.length > 0) {
    await Promise.all(existingWindowSessions.map(async (record) => {
      updateWindowSessionWorkspace(record.sessionKey, normalizedPath);
      await bindWindowSessionWorkspace(record.sessionKey, normalizedPath);
    }));
  } else {
    await initializeGlobalWorkspaceWatch(normalizedPath);
  }

  // Save workspace for future sessions
  await saveLastWorkspace(normalizedPath);

  // Add to recent folders
  await addRecentFolder(normalizedPath);

  broadcastEvent(
    IPC_CHANNELS.WORKSPACE_CHANGED,
    { workspacePath: normalizedPath },
    currentWindowSessionKey
      ? { windowSessionKey: currentWindowSessionKey }
      : undefined,
  );

  onWorkspaceChanged();

  return { success: true };
}

export async function createSampleWorkspace(): Promise<{
  success: boolean;
  workspacePath?: string;
  error?: string;
}> {
  const workspacePath = await createNewWorkspace();
  if (!workspacePath) {
    return { success: false, error: 'Failed to create sample workspace.' };
  }

  const result = await setWorkspace(workspacePath);
  if (!result.success) {
    return { success: false, error: 'Failed to activate sample workspace.' };
  }

  return { success: true, workspacePath };
}

export async function clearWorkspace(): Promise<{ success: boolean }> {
  const currentWindowSessionKey = getCurrentWindowSessionKey();
  const existingWindowSessions = listWindowSessions();

  setCurrentWorkspace(null);
  if (currentWindowSessionKey) {
    updateWindowSessionWorkspace(currentWindowSessionKey, null);
    await bindWindowSessionWorkspace(currentWindowSessionKey, null);
  } else if (existingWindowSessions.length > 0) {
    await Promise.all(existingWindowSessions.map(async (record) => {
      updateWindowSessionWorkspace(record.sessionKey, null);
      await bindWindowSessionWorkspace(record.sessionKey, null);
    }));
  } else {
    await clearGlobalWorkspaceWatch();
  }

  await closeWorkspace();

  broadcastEvent(
    IPC_CHANNELS.WORKSPACE_CHANGED,
    { workspacePath: null },
    currentWindowSessionKey
      ? { windowSessionKey: currentWindowSessionKey }
      : undefined,
  );

  onWorkspaceChanged();

  return { success: true };
}

// ============================================================================
// File Watcher Operations
// ============================================================================

/**
 * Add a folder to the file watcher (when expanded in explorer)
 */
export async function addWatch(folderPath: string): Promise<{ success: boolean }> {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return { success: false };
  }

  // Resolve to full path
  const fullPath = path.join(workspace, folderPath);

  try {
    // Verify it's a directory within the workspace
    const realWorkspace = realpathSync(workspace);
    const realPath = realpathSync(fullPath);

    if (realPath !== realWorkspace && !realPath.startsWith(realWorkspace + path.sep)) {
      return { success: false };
    }

    const stats = statSync(realPath);
    if (!stats.isDirectory()) {
      return { success: false };
    }

    return { success: true };
  } catch {
    return { success: false };
  }
}

/**
 * Remove a folder from the file watcher (when collapsed in explorer)
 */
export async function removeWatch(_folderPath: string): Promise<{ success: boolean }> {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return { success: false };
  }

  return { success: true };
}
