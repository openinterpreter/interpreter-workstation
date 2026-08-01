import { realpath } from 'node:fs/promises';
import { extname, join as pathJoin } from 'node:path';
import { FileWatcherManager } from './fileWatcher';
import { broadcastEvent } from './handlers/broadcast';
import { invalidateRunnableProjectDetection } from './utils/runnableProjects';
import { invalidateVaultIndex } from './utils/vaultIndex';

type WorkspaceKey = string;
type FileChangeCallback = Parameters<FileWatcherManager['start']>[0];

interface WorkspaceWatchManager {
  start(callback: FileChangeCallback): Promise<void>;
  stop(): Promise<void>;
  setWorkspaceOverride(path: string | null): void;
}

type WorkspaceWatchManagerFactory = () => WorkspaceWatchManager;
type ThumbnailServiceLike = { invalidate: (path: string) => void };

async function loadWorkspaceWatchThumbnailService(): Promise<ThumbnailServiceLike | null> {
  if (!process.versions.electron) {
    return null;
  }

  try {
    return (await import('./thumbnailService')).thumbnailService;
  } catch {
    return null;
  }
}

interface WorkspaceBinding {
  workspaceKey: WorkspaceKey;
  workspacePath: string;
}

interface WorkspaceWatchEntry {
  manager: WorkspaceWatchManager;
  refCount: number;
  workspacePath: string;
  workspacePaths: Set<string>;
}

const workspaceEntries = new Map<WorkspaceKey, WorkspaceWatchEntry>();
const sessionWorkspaceBindings = new Map<string, WorkspaceBinding>();
let workspaceWatchRegistryQueue: Promise<void> = Promise.resolve();
let createWorkspaceWatchManager: WorkspaceWatchManagerFactory = () => new FileWatcherManager();
let getWorkspaceWatchThumbnailService: () => Promise<ThumbnailServiceLike | null> =
  loadWorkspaceWatchThumbnailService;

function runWorkspaceWatchRegistryOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = workspaceWatchRegistryQueue.then(operation, operation);
  workspaceWatchRegistryQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function toWorkspaceKey(workspacePath: string): WorkspaceKey {
  // NOTE(victor): Deduplicate watches by canonical path and ignore case on
  // non-Linux platforms. That matches the watcher-key strategy VS Code uses so
  // path aliases and Windows/macOS case variants reuse one underlying watcher
  // instead of starting parallel native subscriptions for the same tree.
  // Sources:
  // - https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/watcher/baseWatcher.ts
  // - https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts
  // - https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/test/node/nodejsWatcher.test.ts
  return process.platform === 'linux' ? workspacePath : workspacePath.toLowerCase();
}

async function resolveWorkspaceBinding(workspacePath: string): Promise<WorkspaceBinding> {
  const canonicalWorkspacePath = await realpath(workspacePath).catch(() => workspacePath);
  return {
    workspaceKey: toWorkspaceKey(canonicalWorkspacePath),
    workspacePath,
  };
}

function isWorkspacePathStillBound(targetBinding: WorkspaceBinding): boolean {
  for (const binding of sessionWorkspaceBindings.values()) {
    if (
      binding.workspaceKey === targetBinding.workspaceKey &&
      binding.workspacePath === targetBinding.workspacePath
    ) {
      return true;
    }
  }

  return false;
}

function pruneWorkspaceAlias(entry: WorkspaceWatchEntry, targetBinding: WorkspaceBinding): void {
  if (isWorkspacePathStillBound(targetBinding)) {
    return;
  }

  entry.workspacePaths.delete(targetBinding.workspacePath);
  if (entry.workspacePath !== targetBinding.workspacePath) {
    return;
  }

  const nextWorkspacePath = entry.workspacePaths.values().next().value;
  if (typeof nextWorkspacePath === 'string') {
    entry.workspacePath = nextWorkspacePath;
  }
}

function handleWorkspaceWatchEvent(
  entry: WorkspaceWatchEntry,
  thumbnailService: ThumbnailServiceLike | null,
  eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change',
  relativePath: string,
  mtime?: number,
): void {
  for (const workspacePath of entry.workspacePaths) {
    if (shouldInvalidateVaultIndexForWorkspaceEvent(eventType, relativePath)) {
      invalidateVaultIndex(workspacePath);
    }

    invalidateRunnableProjectDetection(pathJoin(workspacePath, relativePath));
    broadcastEvent('workspace:files-changed', { eventType, path: relativePath, mtime }, { workspacePath });

    if (thumbnailService && (eventType === 'change' || eventType === 'add')) {
      thumbnailService.invalidate(pathJoin(workspacePath, relativePath));
    }
  }
}

export function shouldInvalidateVaultIndexForWorkspaceEvent(
  eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change',
  relativePath: string,
): boolean {
  if (eventType === 'addDir' || eventType === 'unlinkDir') {
    return true;
  }

  const extension = extname(relativePath).toLowerCase();
  return extension === '.md' || extension === '.markdown';
}

async function startWorkspaceWatch(entry: WorkspaceWatchEntry): Promise<void> {
  entry.manager.setWorkspaceOverride(entry.workspacePath);
  const thumbnailService = await getWorkspaceWatchThumbnailService();

  await entry.manager.start((eventType, relativePath, mtime) => {
    handleWorkspaceWatchEvent(entry, thumbnailService, eventType, relativePath, mtime);
  });
}

async function retainWorkspaceWatch(binding: WorkspaceBinding): Promise<void> {
  const existingEntry = workspaceEntries.get(binding.workspaceKey);
  if (existingEntry) {
    existingEntry.refCount += 1;
    existingEntry.workspacePaths.add(binding.workspacePath);
    return;
  }

  const entry: WorkspaceWatchEntry = {
    manager: createWorkspaceWatchManager(),
    refCount: 1,
    workspacePath: binding.workspacePath,
    workspacePaths: new Set([binding.workspacePath]),
  };
  workspaceEntries.set(binding.workspaceKey, entry);
  await startWorkspaceWatch(entry);
}

async function updateWorkspaceWatchBinding(
  previousBinding: WorkspaceBinding,
  nextBinding: WorkspaceBinding,
): Promise<void> {
  const entry = workspaceEntries.get(nextBinding.workspaceKey);
  if (!entry) {
    await retainWorkspaceWatch(nextBinding);
    return;
  }

  entry.workspacePaths.add(nextBinding.workspacePath);
  pruneWorkspaceAlias(entry, previousBinding);
}

async function releaseWorkspaceWatch(binding: WorkspaceBinding): Promise<void> {
  const existingEntry = workspaceEntries.get(binding.workspaceKey);
  if (!existingEntry) {
    return;
  }

  existingEntry.refCount -= 1;
  pruneWorkspaceAlias(existingEntry, binding);
  if (existingEntry.refCount > 0) {
    return;
  }

  workspaceEntries.delete(binding.workspaceKey);
  await existingEntry.manager.stop();
}

async function bindWindowSessionWorkspaceInternal(
  sessionKey: string,
  workspacePath: string | null,
): Promise<void> {
  const previousBinding = sessionWorkspaceBindings.get(sessionKey) ?? null;
  const nextBinding = workspacePath ? await resolveWorkspaceBinding(workspacePath) : null;

  if (
    previousBinding?.workspaceKey === nextBinding?.workspaceKey &&
    previousBinding?.workspacePath === nextBinding?.workspacePath
  ) {
    return;
  }

  if (!nextBinding) {
    sessionWorkspaceBindings.delete(sessionKey);
  } else {
    sessionWorkspaceBindings.set(sessionKey, nextBinding);
  }

  if (previousBinding && nextBinding && previousBinding.workspaceKey === nextBinding.workspaceKey) {
    await updateWorkspaceWatchBinding(previousBinding, nextBinding);
    return;
  }

  if (previousBinding) {
    await releaseWorkspaceWatch(previousBinding);
  }
  if (nextBinding) {
    await retainWorkspaceWatch(nextBinding);
  }
}

async function unbindWindowSessionWorkspaceInternal(sessionKey: string): Promise<void> {
  const previousBinding = sessionWorkspaceBindings.get(sessionKey) ?? null;
  sessionWorkspaceBindings.delete(sessionKey);

  if (previousBinding) {
    await releaseWorkspaceWatch(previousBinding);
  }
}

export async function bindWindowSessionWorkspace(
  sessionKey: string,
  workspacePath: string | null,
): Promise<void> {
  await runWorkspaceWatchRegistryOperation(async () => {
    await bindWindowSessionWorkspaceInternal(sessionKey, workspacePath);
  });
}

export async function unbindWindowSessionWorkspace(sessionKey: string): Promise<void> {
  await runWorkspaceWatchRegistryOperation(async () => {
    await unbindWindowSessionWorkspaceInternal(sessionKey);
  });
}

export async function initializeGlobalWorkspaceWatch(workspacePath: string | null): Promise<void> {
  await bindWindowSessionWorkspace('__global__', workspacePath);
}

export async function clearGlobalWorkspaceWatch(): Promise<void> {
  await unbindWindowSessionWorkspace('__global__');
}

export async function stopAllWorkspaceWatches(): Promise<void> {
  await runWorkspaceWatchRegistryOperation(async () => {
    const activeSessionKeys = Array.from(sessionWorkspaceBindings.keys());
    for (const sessionKey of activeSessionKeys) {
      await unbindWindowSessionWorkspaceInternal(sessionKey);
    }

    const remainingEntries = Array.from(workspaceEntries.values());
    workspaceEntries.clear();
    for (const entry of remainingEntries) {
      await entry.manager.stop();
    }
  });
}

export function setWorkspaceWatchManagerFactoryForTests(
  factory: WorkspaceWatchManagerFactory | null
): void {
  // NOTE(victor): Test-only seam. Bun module mocks are process-wide in the
  // shared unit runner, so registry tests inject managers here instead of
  // replacing ./fileWatcher for every test file in the process.
  createWorkspaceWatchManager = factory ?? (() => new FileWatcherManager());
}

export function setWorkspaceWatchThumbnailServiceForTests(
  service: ThumbnailServiceLike | null
): void {
  getWorkspaceWatchThumbnailService = service
    ? async () => service
    : loadWorkspaceWatchThumbnailService;
}
