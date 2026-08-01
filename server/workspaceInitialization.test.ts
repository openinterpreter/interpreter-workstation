import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { resolve as pathResolve } from 'node:path';

let addRecentFolderImpl: (workspacePath: string) => Promise<void> = async () => {};
let loadLastWorkspaceImpl: () => Promise<string | null> = async () => '/loaded/workspace';
const addRecentFolderMock = mock((workspacePath: string) => addRecentFolderImpl(workspacePath));
const loadLastWorkspaceMock = mock(() => loadLastWorkspaceImpl());
let currentWorkspaceState: string | null = null;
let workspaceStateVersion = 0;
const getCurrentWorkspaceMock = mock(() => currentWorkspaceState);
const getWorkspaceStateVersionMock = mock(() => workspaceStateVersion);
const setCurrentWorkspaceMock = mock((workspacePath: string | null) => {
  currentWorkspaceState = workspacePath;
  workspaceStateVersion += 1;
});

mock.module('./workspaceInitializationDeps', () => ({
  addRecentFolder: addRecentFolderMock,
  getCurrentWorkspace: getCurrentWorkspaceMock,
  getWorkspaceStateVersion: getWorkspaceStateVersionMock,
  loadLastWorkspace: loadLastWorkspaceMock,
  setCurrentWorkspace: setCurrentWorkspaceMock,
}));

async function loadSubject() {
  return await import(`./workspaceInitialization?cacheBust=${Date.now()}-${Math.random()}`);
}

describe('workspaceInitialization', () => {
  beforeEach(() => {
    addRecentFolderImpl = async () => {};
    loadLastWorkspaceImpl = async () => '/loaded/workspace';
    addRecentFolderMock.mockClear();
    loadLastWorkspaceMock.mockClear();
    currentWorkspaceState = null;
    workspaceStateVersion = 0;
    getCurrentWorkspaceMock.mockReset();
    getCurrentWorkspaceMock.mockImplementation(() => currentWorkspaceState);
    getWorkspaceStateVersionMock.mockReset();
    getWorkspaceStateVersionMock.mockImplementation(() => workspaceStateVersion);
    setCurrentWorkspaceMock.mockReset();
    setCurrentWorkspaceMock.mockImplementation((workspacePath: string | null) => {
      currentWorkspaceState = workspacePath;
      workspaceStateVersion += 1;
    });
    delete process.env.WORKSTATION_EXPLICIT_WORKSPACE;
  });

  test('ensureWorkspaceInitialized still resolves when addRecentFolder fails', async () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    addRecentFolderImpl = async () => {
      throw new Error('recent-folders-write-failed');
    };

    const {
      ensureWorkspaceInitialized,
    } = await loadSubject();

    await expect(ensureWorkspaceInitialized()).resolves.toBe('/loaded/workspace');
    await expect(ensureWorkspaceInitialized()).resolves.toBe('/loaded/workspace');

    expect(loadLastWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(setCurrentWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(setCurrentWorkspaceMock).toHaveBeenCalledWith('/loaded/workspace');
    expect(addRecentFolderMock).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  test('ensureWorkspaceInitialized retries after initialization failure', async () => {
    let attempt = 0;
    loadLastWorkspaceImpl = async () => {
      if (attempt++ === 0) throw new Error('config-read-failed');
      return '/loaded/workspace';
    };

    const {
      ensureWorkspaceInitialized,
    } = await loadSubject();

    await expect(ensureWorkspaceInitialized()).rejects.toThrow('config-read-failed');
    await expect(ensureWorkspaceInitialized()).resolves.toBe('/loaded/workspace');

    expect(loadLastWorkspaceMock).toHaveBeenCalledTimes(2);
    expect(setCurrentWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(setCurrentWorkspaceMock).toHaveBeenCalledWith('/loaded/workspace');
  });

  test('notifies listeners when initialization eventually succeeds after retry', async () => {
    let attempt = 0;
    loadLastWorkspaceImpl = async () => {
      if (attempt++ === 0) throw new Error('config-read-failed');
      return '/loaded/workspace';
    };
    const initializedListener = mock((_workspacePath: string | null) => {});

    const {
      ensureWorkspaceInitialized,
      onWorkspaceInitialized,
    } = await loadSubject();

    const unsubscribe = onWorkspaceInitialized(initializedListener);

    await expect(ensureWorkspaceInitialized()).rejects.toThrow('config-read-failed');
    expect(initializedListener).not.toHaveBeenCalled();

    await expect(ensureWorkspaceInitialized()).resolves.toBe('/loaded/workspace');
    expect(initializedListener).toHaveBeenCalledTimes(1);
    expect(initializedListener).toHaveBeenCalledWith('/loaded/workspace');

    unsubscribe();
  });

  test('does not overwrite a workspace selected while initialization is still loading', async () => {
    let resolveWorkspaceLoad: ((workspacePath: string | null) => void) | null = null;
    loadLastWorkspaceImpl = () => new Promise((resolve) => {
      resolveWorkspaceLoad = resolve;
    });

    const {
      ensureWorkspaceInitialized,
    } = await loadSubject();

    const initialization = ensureWorkspaceInitialized();

    setCurrentWorkspaceMock('/manually/selected-workspace');
    setCurrentWorkspaceMock.mockClear();

    resolveWorkspaceLoad?.('/loaded/workspace');

    await expect(initialization).resolves.toBe('/manually/selected-workspace');
    expect(setCurrentWorkspaceMock).not.toHaveBeenCalled();
    expect(getCurrentWorkspaceMock()).toBe('/manually/selected-workspace');
  });

  test('shares one in-flight initialization across concurrent callers', async () => {
    let resolveWorkspaceLoad: ((workspacePath: string | null) => void) | null = null;
    loadLastWorkspaceImpl = () => new Promise((resolve) => {
      resolveWorkspaceLoad = resolve;
    });

    const {
      ensureWorkspaceInitialized,
    } = await loadSubject();

    const firstInitialization = ensureWorkspaceInitialized();
    const secondInitialization = ensureWorkspaceInitialized();

    resolveWorkspaceLoad?.('/loaded/workspace');

    await expect(Promise.all([firstInitialization, secondInitialization])).resolves.toEqual([
      '/loaded/workspace',
      '/loaded/workspace',
    ]);
    expect(loadLastWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(setCurrentWorkspaceMock).toHaveBeenCalledTimes(1);
  });

  test('prefers explicit workspace paths over persisted workspace state', async () => {
    process.env.WORKSTATION_EXPLICIT_WORKSPACE = '../explicit-workspace';

    const {
      ensureWorkspaceInitialized,
    } = await loadSubject();

    await expect(ensureWorkspaceInitialized()).resolves.toBe(pathResolve('../explicit-workspace'));
    expect(loadLastWorkspaceMock).not.toHaveBeenCalled();
    expect(setCurrentWorkspaceMock).toHaveBeenCalledWith(pathResolve('../explicit-workspace'));
  });
});
