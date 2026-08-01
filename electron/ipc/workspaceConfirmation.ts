/**
 * Workspace Confirmation
 *
 * Single source of truth for workspace changes with renderer-driven confirmation.
 * Both the menu and IPC handler call this function.
 */

import { app, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runWithWorkspaceOverride } from '../../server/utils/workspace';
import {
  getWindowSessionKeyForWindowId,
  getWindowSessionWorkspace,
  runWithWindowSessionOverride,
} from '../../server/utils/windowSessions';
import { emitWorkspaceConfirmationRequested } from './events';
import type { WorkspaceConfirmationRequestedEvent } from './registry';
import { resolveSpecialFolderAlias } from './workspacePathAliases';

type PendingWorkspaceConfirmation = {
  resolve: (approved: boolean) => void;
  targetWindow: BrowserWindow;
  handleWindowClosed: () => void;
};

const pendingWorkspaceConfirmations = new Map<string, PendingWorkspaceConfirmation>();

/**
 * Expand special folder names (desktop, documents, downloads) to full paths.
 * Uses Electron's app.getPath() for proper cross-platform support.
 */
function expandSpecialFolderPath(inputPath: string): string {
  const specialFolderAlias = resolveSpecialFolderAlias(inputPath);
  if (specialFolderAlias) {
    return app.getPath(specialFolderAlias);
  }
  return inputPath;
}

/**
 * Build the workspace confirmation payload shown in the renderer modal.
 */
function buildWorkspaceConfirmationEvent(workspacePath: string): WorkspaceConfirmationRequestedEvent {
  return {
    requestId: randomUUID(),
    workspacePath,
    title: 'Change Workspace',
    message: 'Are you sure you want to change to this workspace?',
    permissionNote: 'Interpreter will have the ability to modify and delete files in:',
    backupNote: 'Please make sure your files are backed up before proceeding.',
    confirmLabel: 'Open Workspace',
    cancelLabel: 'Cancel',
  };
}

function buildWorkspaceBlockedEvent(
  workspacePath: string,
  blockers: Array<{ workspacePath: string }>,
): WorkspaceConfirmationRequestedEvent {
  const blockerWorkspaces = Array.from(
    new Set(blockers.map((blocker) => blocker.workspacePath)),
  );

  return {
    requestId: randomUUID(),
    workspacePath,
    title: 'Workspace Is Locked',
    message: 'Close or reset active Interpreter agent chats before changing workspaces.',
    permissionNote: 'Current agent chats are still bound to:',
    backupNote: 'This prevents the app from showing one workspace while the agent continues running commands in another.',
    confirmLabel: 'OK',
    cancelLabel: 'Cancel',
    variant: 'notice',
    detailItemsLabel: blockerWorkspaces.length === 1 ? 'Bound workspace' : 'Bound workspaces',
    detailItems: blockerWorkspaces,
  };
}

function getTargetWindow(windowId?: number | null): BrowserWindow | null {
  if (windowId) {
    const explicitWindow = BrowserWindow.fromId(windowId);
    if (explicitWindow && !explicitWindow.isDestroyed()) {
      return explicitWindow;
    }
  }

  return BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
    ?? null;
}

function requestWorkspaceConfirmation(
  targetWindow: BrowserWindow,
  confirmationEvent: WorkspaceConfirmationRequestedEvent,
): Promise<boolean> {
  return new Promise((resolve) => {
    const resolveAndCleanup = (approved: boolean) => {
      const pending = pendingWorkspaceConfirmations.get(confirmationEvent.requestId);
      if (!pending) {
        resolve(approved);
        return;
      }

      pending.targetWindow.removeListener('closed', pending.handleWindowClosed);
      pendingWorkspaceConfirmations.delete(confirmationEvent.requestId);
      resolve(approved);
    };

    const handleWindowClosed = () => {
      resolveAndCleanup(false);
    };

    pendingWorkspaceConfirmations.set(confirmationEvent.requestId, {
      resolve: resolveAndCleanup,
      targetWindow,
      handleWindowClosed,
    });
    targetWindow.once('closed', handleWindowClosed);

    const sent = emitWorkspaceConfirmationRequested(targetWindow, confirmationEvent);
    if (!sent) {
      resolveAndCleanup(false);
    }
  });
}

export async function requestWorkspaceScopedConfirmation(
  confirmationEvent: WorkspaceConfirmationRequestedEvent,
  options?: { windowId?: number | null },
): Promise<boolean> {
  const targetWindow = getTargetWindow(options?.windowId);
  if (!targetWindow) {
    console.warn('[Workspace] No window available for scoped confirmation:', confirmationEvent.workspacePath);
    return false;
  }

  return requestWorkspaceConfirmation(targetWindow, confirmationEvent);
}

/**
 * Request confirmation in the renderer and set workspace if approved.
 * This is the ONE place that handles workspace changes with confirmation.
 *
 * @param workspacePath - The path to set as the new workspace
 * @returns true if workspace was changed, false if user cancelled
 */
export async function setWorkspaceWithConfirmation(
  workspacePath: string,
  options?: { windowId?: number | null },
): Promise<boolean> {
  // Expand special folder names to full paths for display and setting
  const expandedPath = expandSpecialFolderPath(workspacePath);
  console.log('[WorkspaceSwitch] request-received', {
    workspacePath: expandedPath,
    windowId: options?.windowId ?? null,
  });
  const targetWindow = getTargetWindow(options?.windowId);
  if (!targetWindow) {
    console.warn('[Workspace] No window available for workspace confirmation:', expandedPath);
    return false;
  }

  const targetWindowId = targetWindow?.id ?? null;
  const windowSessionKey = getWindowSessionKeyForWindowId(targetWindowId);
  const currentWindowWorkspace = getWindowSessionWorkspace({ windowId: targetWindowId });
  const { agentTabManager } = await import('../../server/agentTabManager');
  const blockers = agentTabManager.getWorkspaceSwitchBlockers({
    windowSessionKey,
    nextWorkspacePath: expandedPath,
  });

  if (blockers.length > 0) {
    console.warn('[WorkspaceSwitch] blocked-active-agent-bindings', {
      workspacePath: expandedPath,
      windowId: targetWindowId,
      blockerCount: blockers.length,
      blockerWorkspaces: Array.from(new Set(blockers.map((blocker) => blocker.workspacePath))),
    });
    await requestWorkspaceScopedConfirmation(
      buildWorkspaceBlockedEvent(expandedPath, blockers),
      { windowId: targetWindowId },
    );
    return false;
  }

  const confirmed = await requestWorkspaceScopedConfirmation(
    buildWorkspaceConfirmationEvent(expandedPath),
    { windowId: targetWindowId },
  );
  console.log('[WorkspaceSwitch] confirmation-resolved', {
    workspacePath: expandedPath,
    confirmed,
    windowId: targetWindowId,
  });
  if (!confirmed) {
    return false;
  }

  // Import handlers lazily to avoid circular dependencies
  const { setWorkspace } = await import('../../server/handlers/workspace');
  const { buildApplicationMenu } = await import('../menu');

  // Set the workspace - handler does validation, persistence, file watcher, and broadcasts event
  await runWithWindowSessionOverride(windowSessionKey, async () => {
    await runWithWorkspaceOverride(currentWindowWorkspace, async () => {
      await setWorkspace(expandedPath);
    });
  });

  // Rebuild menu to update recent folders (Electron-specific)
  await buildApplicationMenu();

  console.log('[WorkspaceSwitch] applied', {
    workspacePath: expandedPath,
    windowId: targetWindowId,
  });
  return true;
}

export function respondToWorkspaceConfirmation(requestId: string, approved: boolean): boolean {
  const pending = pendingWorkspaceConfirmations.get(requestId);
  if (!pending) {
    return false;
  }

  pending.resolve(approved);
  return true;
}

/**
 * Set workspace directly for explicit OS-level open actions (no confirmation dialog).
 * Used when the user intentionally opens a file or folder in Interpreter from the OS shell.
 *
 * @param workspacePath - The workspace path to activate
 * @returns true if workspace was changed, false if already in that workspace
 */
export async function setWorkspaceForExternalOpen(
  workspacePath: string,
  options?: { windowId?: number | null },
): Promise<boolean> {
  const normalizedWorkspacePath = path.resolve(expandSpecialFolderPath(workspacePath));
  const targetWindow = options?.windowId ? BrowserWindow.fromId(options.windowId) : BrowserWindow.getFocusedWindow();
  const targetWindowId = targetWindow?.id ?? null;
  const windowSessionKey = getWindowSessionKeyForWindowId(targetWindowId);
  const currentWindowWorkspace = getWindowSessionWorkspace({ windowId: targetWindowId });

  // Import handlers lazily to avoid circular dependencies
  const { getWorkspace, setWorkspace } = await import('../../server/handlers/workspace');
  const { buildApplicationMenu } = await import('../menu');

  // Check if already in that workspace (skip if so)
  const { workspace } = await runWithWindowSessionOverride(windowSessionKey, async () => {
    return await runWithWorkspaceOverride(currentWindowWorkspace, async () => {
      return await getWorkspace();
    });
  });
  if (workspace === normalizedWorkspacePath) {
    console.log('[Workspace] Already in workspace:', normalizedWorkspacePath);
    return false;
  }

  // Set the workspace directly without confirmation dialog
  await runWithWindowSessionOverride(windowSessionKey, async () => {
    await runWithWorkspaceOverride(currentWindowWorkspace, async () => {
      await setWorkspace(normalizedWorkspacePath);
    });
  });

  // Rebuild menu to update recent folders
  await buildApplicationMenu();

  console.log('[Workspace] Changed to (external open):', normalizedWorkspacePath);
  return true;
}

/**
 * Set workspace for file open operations (no confirmation dialog).
 * Used when opening files from OS file associations (right-click > Open With).
 *
 * @param filePath - The path to the file being opened
 * @returns true if workspace was changed, false if already in that workspace
 */
export async function setWorkspaceForFileOpen(
  filePath: string,
  options?: { windowId?: number | null },
): Promise<boolean> {
  return setWorkspaceForExternalOpen(path.dirname(path.resolve(filePath)), options);
}

export async function clearWorkspaceForWindow(windowId?: number | null): Promise<void> {
  const windowSessionKey = getWindowSessionKeyForWindowId(windowId ?? null);
  const currentWindowWorkspace = getWindowSessionWorkspace({ windowId: windowId ?? null });
  const { clearWorkspace } = await import('../../server/handlers/workspace');
  const { buildApplicationMenu } = await import('../menu');

  await runWithWindowSessionOverride(windowSessionKey, async () => {
    await runWithWorkspaceOverride(currentWindowWorkspace, async () => {
      await clearWorkspace();
    });
  });

  await buildApplicationMenu();
}
