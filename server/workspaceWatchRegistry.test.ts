import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class MockFileWatcherManager {
  private callback: ((eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change', path: string, mtime?: number) => void) | null = null;

  public readonly start = mock(async (callback: unknown) => {
    this.callback = callback as typeof this.callback;
    this.watching = true;
  });

  public readonly stop = mock(async () => {
    this.callback = null;
    this.watching = false;
  });

  public readonly setWorkspaceOverride = mock((_workspacePath: string | null) => {});

  private watching = false;

  constructor() {
    mockManagers.push(this);
  }

  isWatching(): boolean {
    return this.watching;
  }

  emit(
    eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change',
    path: string,
    mtime?: number
  ): void {
    this.callback?.(eventType, path, mtime);
  }
}

const mockManagers: MockFileWatcherManager[] = [];
const invalidateMock = mock((_path: string) => {});

const {
  bindWindowSessionWorkspace,
  shouldInvalidateVaultIndexForWorkspaceEvent,
  setWorkspaceWatchManagerFactoryForTests,
  setWorkspaceWatchThumbnailServiceForTests,
  stopAllWorkspaceWatches,
  unbindWindowSessionWorkspace,
} = await import('./workspaceWatchRegistry');

describe('workspaceWatchRegistry', () => {
  let tempRoot: string;

  beforeEach(async () => {
    await stopAllWorkspaceWatches();
    mockManagers.length = 0;
    invalidateMock.mockClear();
    setWorkspaceWatchManagerFactoryForTests(() => new MockFileWatcherManager());
    setWorkspaceWatchThumbnailServiceForTests({ invalidate: invalidateMock });
    tempRoot = await mkdtemp(join(tmpdir(), 'workspace-watch-registry-'));
  });

  afterEach(async () => {
    await stopAllWorkspaceWatches();
    setWorkspaceWatchManagerFactoryForTests(null);
    setWorkspaceWatchThumbnailServiceForTests(null);
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('re-binding the same workspace is a no-op', async () => {
    await bindWindowSessionWorkspace('session-a', '/workspace');

    expect(mockManagers).toHaveLength(1);
    const manager = mockManagers[0];
    expect(manager.setWorkspaceOverride).toHaveBeenCalledTimes(1);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(0);

    await bindWindowSessionWorkspace('session-a', '/workspace');

    expect(mockManagers).toHaveLength(1);
    expect(manager.setWorkspaceOverride).toHaveBeenCalledTimes(1);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(0);

    await unbindWindowSessionWorkspace('session-a');

    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  test('multiple sessions sharing a workspace keep one watcher until the last session unbinds', async () => {
    await bindWindowSessionWorkspace('session-a', '/workspace');

    expect(mockManagers).toHaveLength(1);
    const manager = mockManagers[0];
    expect(manager.start).toHaveBeenCalledTimes(1);

    await bindWindowSessionWorkspace('session-b', '/workspace');

    expect(mockManagers).toHaveLength(1);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(0);

    await unbindWindowSessionWorkspace('session-a');
    expect(manager.stop).toHaveBeenCalledTimes(0);

    await unbindWindowSessionWorkspace('session-b');
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  test('concurrent binds for the same workspace create one watcher manager', async () => {
    await Promise.all([
      bindWindowSessionWorkspace('session-a', '/workspace'),
      bindWindowSessionWorkspace('session-b', '/workspace'),
    ]);

    expect(mockManagers).toHaveLength(1);
    const manager = mockManagers[0];
    expect(manager.setWorkspaceOverride).toHaveBeenCalledTimes(1);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(0);

    await Promise.all([
      unbindWindowSessionWorkspace('session-a'),
      unbindWindowSessionWorkspace('session-b'),
    ]);
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  test('canonical workspace aliases reuse one watcher manager', async () => {
    const workspacePath = join(tempRoot, 'workspace');
    const workspaceAliasPath = join(tempRoot, 'workspace-alias');
    await mkdir(workspacePath);
    await symlink(workspacePath, workspaceAliasPath, process.platform === 'win32' ? 'junction' : 'dir');

    await bindWindowSessionWorkspace('session-a', workspacePath);
    await bindWindowSessionWorkspace('session-b', workspaceAliasPath);

    expect(mockManagers).toHaveLength(1);
    const manager = mockManagers[0];
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(0);

    await unbindWindowSessionWorkspace('session-a');
    expect(manager.stop).toHaveBeenCalledTimes(0);

    await unbindWindowSessionWorkspace('session-b');
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  test('same-session alias rebind updates binding without refreshing the watcher', async () => {
    const workspacePath = join(tempRoot, 'workspace');
    const workspaceAliasPath = join(tempRoot, 'workspace-alias');
    await mkdir(workspacePath);
    await symlink(workspacePath, workspaceAliasPath, process.platform === 'win32' ? 'junction' : 'dir');

    await bindWindowSessionWorkspace('session-a', workspacePath);

    expect(mockManagers).toHaveLength(1);
    const manager = mockManagers[0];
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(0);

    await bindWindowSessionWorkspace('session-a', workspaceAliasPath);

    expect(mockManagers).toHaveLength(1);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(0);
  });

  test('alias-bound workspaces invalidate thumbnails for each active alias path', async () => {
    const workspacePath = join(tempRoot, 'workspace');
    const workspaceAliasPath = join(tempRoot, 'workspace-alias');
    await mkdir(workspacePath);
    await symlink(workspacePath, workspaceAliasPath, process.platform === 'win32' ? 'junction' : 'dir');

    await bindWindowSessionWorkspace('session-a', workspacePath);
    await bindWindowSessionWorkspace('session-b', workspaceAliasPath);

    expect(mockManagers).toHaveLength(1);
    const manager = mockManagers[0];
    manager.emit('change', 'images/example.png', 123);

    expect(invalidateMock).toHaveBeenCalledTimes(2);
    expect(invalidateMock).toHaveBeenNthCalledWith(1, join(workspacePath, 'images/example.png'));
    expect(invalidateMock).toHaveBeenNthCalledWith(2, join(workspaceAliasPath, 'images/example.png'));
  });

  test('invalidates the vault index only for markdown files and directory events', () => {
    expect(shouldInvalidateVaultIndexForWorkspaceEvent('change', 'notes/example.md')).toBe(true);
    expect(shouldInvalidateVaultIndexForWorkspaceEvent('change', 'images/example.png')).toBe(false);
    expect(shouldInvalidateVaultIndexForWorkspaceEvent('addDir', 'notes')).toBe(true);
    expect(shouldInvalidateVaultIndexForWorkspaceEvent('unlinkDir', 'notes')).toBe(true);
  });
});
