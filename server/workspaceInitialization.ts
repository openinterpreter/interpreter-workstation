import { resolve as pathResolve } from 'node:path';
import {
  addRecentFolder,
  getCurrentWorkspace,
  getWorkspaceStateVersion,
  loadLastWorkspace,
  setCurrentWorkspace,
} from './workspaceInitializationDeps';

let workspaceInitializationPromise: Promise<string | null> | null = null;
const workspaceInitializedListeners = new Set<
  (workspacePath: string | null) => void | Promise<void>
>();

function notifyWorkspaceInitialized(workspacePath: string | null): void {
  for (const listener of workspaceInitializedListeners) {
    try {
      const result = listener(workspacePath);
      if (result && typeof result.then === 'function') {
        void result.catch((error) => {
          console.error('[Server] Workspace initialization listener failed:', error);
        });
      }
    } catch (error) {
      console.error('[Server] Workspace initialization listener failed:', error);
    }
  }
}

async function initializeWorkspaceState(): Promise<string | null> {
  const workspaceStateVersion = getWorkspaceStateVersion();
  const explicitWorkspace = process.env.WORKSTATION_EXPLICIT_WORKSPACE?.trim();
  const initialWorkspace = explicitWorkspace
    ? pathResolve(explicitWorkspace)
    : await loadLastWorkspace();

  if (getWorkspaceStateVersion() !== workspaceStateVersion) {
    return getCurrentWorkspace();
  }

  setCurrentWorkspace(initialWorkspace);
  notifyWorkspaceInitialized(initialWorkspace);
  return initialWorkspace;
}

function getWorkspaceInitializationPromise(): Promise<string | null> {
  if (!workspaceInitializationPromise) {
    const initializationPromise = initializeWorkspaceState();
    workspaceInitializationPromise = initializationPromise;
    void (async () => {
      const initialWorkspace = await initializationPromise;
      if (!initialWorkspace) {
        return;
      }
      try {
        await addRecentFolder(initialWorkspace);
      } catch (error) {
        console.error('[Server] Failed to add recent folder during workspace init:', error);
      }
    })().catch(() => {
      // Initialization failures belong to the callers awaiting the startup promise.
    });
    void initializationPromise.catch(() => {
      if (workspaceInitializationPromise === initializationPromise) {
        workspaceInitializationPromise = null;
      }
    });
  }
  return workspaceInitializationPromise;
}

export function startWorkspaceInitialization(): void {
  void getWorkspaceInitializationPromise().catch((error) => {
    console.error('[Server] Failed to initialize workspace:', error);
  });
}

export async function ensureWorkspaceInitialized(): Promise<string | null> {
  return await getWorkspaceInitializationPromise();
}

export function onWorkspaceInitialized(
  listener: (workspacePath: string | null) => void | Promise<void>,
): () => void {
  workspaceInitializedListeners.add(listener);
  return () => {
    workspaceInitializedListeners.delete(listener);
  };
}
