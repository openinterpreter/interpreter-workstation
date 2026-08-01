import { beforeEach, describe, expect, mock, test } from 'bun:test';

const resolveWorkspacePathMock = mock((workspacePath: string) => `/resolved${workspacePath}`);
const setCurrentWorkspaceMock = mock((_workspacePath: string | null) => {});
const getCurrentWorkspaceMock = mock(() => null);
const createNewWorkspaceMock = mock(async () => '/created/sample-workspace');
const saveLastWorkspaceMock = mock(async (_workspacePath: string) => {});
const closeWorkspaceMock = mock(async () => {});
const addRecentFolderMock = mock(async (_workspacePath: string) => {});
const broadcastEventMock = mock((_channel: string, _data: unknown, _scope?: unknown) => {});
const getCurrentWindowSessionKeyMock = mock(() => null as string | null);
const listWindowSessionsMock = mock(() => [] as Array<{
  sessionKey: string;
  windowId: number;
  workspacePath: string | null;
  createdAt: number;
}>);
const updateWindowSessionWorkspaceMock = mock((_sessionKey: string, _workspacePath: string | null) => null);
const bindWindowSessionWorkspaceMock = mock(async (_sessionKey: string, _workspacePath: string | null) => {});
const clearGlobalWorkspaceWatchMock = mock(async () => {});
const initializeGlobalWorkspaceWatchMock = mock(async (_workspacePath: string | null) => {});
const onWorkspaceChangedMock = mock(() => {});
const ensureWorkspaceInitializedMock = mock(async () => '/initialized/workspace');

mock.module('./workspaceDeps', () => ({
  addRecentFolder: addRecentFolderMock,
  bindWindowSessionWorkspace: bindWindowSessionWorkspaceMock,
  broadcastEvent: broadcastEventMock,
  clearGlobalWorkspaceWatch: clearGlobalWorkspaceWatchMock,
  closeWorkspace: closeWorkspaceMock,
  createNewWorkspace: createNewWorkspaceMock,
  getCurrentWindowSessionKey: getCurrentWindowSessionKeyMock,
  getCurrentWorkspace: getCurrentWorkspaceMock,
  initializeGlobalWorkspaceWatch: initializeGlobalWorkspaceWatchMock,
  listWindowSessions: listWindowSessionsMock,
  onWorkspaceChanged: onWorkspaceChangedMock,
  resolveWorkspacePath: resolveWorkspacePathMock,
  saveLastWorkspace: saveLastWorkspaceMock,
  setCurrentWorkspace: setCurrentWorkspaceMock,
  updateWindowSessionWorkspace: updateWindowSessionWorkspaceMock,
}));

mock.module('../workspaceInitialization', () => ({
  ensureWorkspaceInitialized: ensureWorkspaceInitializedMock,
}));

const { clearWorkspace, createSampleWorkspace, getWorkspace, setWorkspace } = await import('./workspace');

describe('workspace handlers', () => {
  beforeEach(() => {
    resolveWorkspacePathMock.mockClear();
    resolveWorkspacePathMock.mockImplementation((workspacePath: string) => `/resolved${workspacePath}`);
    setCurrentWorkspaceMock.mockClear();
    getCurrentWorkspaceMock.mockClear();
    createNewWorkspaceMock.mockClear();
    createNewWorkspaceMock.mockResolvedValue('/created/sample-workspace');
    saveLastWorkspaceMock.mockClear();
    closeWorkspaceMock.mockClear();
    addRecentFolderMock.mockClear();
    broadcastEventMock.mockClear();
    getCurrentWindowSessionKeyMock.mockClear();
    getCurrentWindowSessionKeyMock.mockReturnValue(null);
    listWindowSessionsMock.mockClear();
    listWindowSessionsMock.mockReturnValue([]);
    updateWindowSessionWorkspaceMock.mockClear();
    bindWindowSessionWorkspaceMock.mockClear();
    clearGlobalWorkspaceWatchMock.mockClear();
    initializeGlobalWorkspaceWatchMock.mockClear();
    onWorkspaceChangedMock.mockClear();
    ensureWorkspaceInitializedMock.mockClear();
  });

  test('getWorkspace waits for startup initialization before returning workspace', async () => {
    getCurrentWorkspaceMock.mockReturnValue('/workspace/from-store');

    const result = await getWorkspace();

    expect(ensureWorkspaceInitializedMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ workspace: '/workspace/from-store' });
  });

  test('setWorkspace updates the active session binding when the request is session-scoped', async () => {
    getCurrentWindowSessionKeyMock.mockReturnValue('session-a');

    await setWorkspace('/project');

    expect(setCurrentWorkspaceMock).toHaveBeenCalledWith('/resolved/project');
    expect(updateWindowSessionWorkspaceMock).toHaveBeenCalledWith('session-a', '/resolved/project');
    expect(bindWindowSessionWorkspaceMock).toHaveBeenCalledWith('session-a', '/resolved/project');
    expect(initializeGlobalWorkspaceWatchMock).not.toHaveBeenCalled();
    expect(saveLastWorkspaceMock).toHaveBeenCalledWith('/resolved/project');
    expect(addRecentFolderMock).toHaveBeenCalledWith('/resolved/project');
    expect(broadcastEventMock).toHaveBeenCalledWith(
      'workspace:changed',
      { workspacePath: '/resolved/project' },
      { windowSessionKey: 'session-a' },
    );
    expect(onWorkspaceChangedMock).toHaveBeenCalledTimes(1);
  });

  test('setWorkspace refreshes the global watch when no window sessions exist', async () => {
    await setWorkspace('/project');

    expect(setCurrentWorkspaceMock).toHaveBeenCalledWith('/resolved/project');
    expect(initializeGlobalWorkspaceWatchMock).toHaveBeenCalledWith('/resolved/project');
    expect(bindWindowSessionWorkspaceMock).not.toHaveBeenCalled();
    expect(updateWindowSessionWorkspaceMock).not.toHaveBeenCalled();
    expect(broadcastEventMock).toHaveBeenCalledWith(
      'workspace:changed',
      { workspacePath: '/resolved/project' },
      undefined,
    );
  });

  test('createSampleWorkspace creates and activates a sample workspace', async () => {
    const result = await createSampleWorkspace();

    expect(createNewWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(resolveWorkspacePathMock).toHaveBeenCalledWith('/created/sample-workspace');
    expect(setCurrentWorkspaceMock).toHaveBeenCalledWith('/resolved/created/sample-workspace');
    expect(saveLastWorkspaceMock).toHaveBeenCalledWith('/resolved/created/sample-workspace');
    expect(addRecentFolderMock).toHaveBeenCalledWith('/resolved/created/sample-workspace');
    expect(result).toEqual({
      success: true,
      workspacePath: '/created/sample-workspace',
    });
  });

  test('setWorkspace updates every registered window session for global requests', async () => {
    listWindowSessionsMock.mockReturnValue([
      { sessionKey: 'session-a', windowId: 1, workspacePath: '/one', createdAt: 1 },
      { sessionKey: 'session-b', windowId: 2, workspacePath: '/two', createdAt: 2 },
    ]);

    await setWorkspace('/project');

    expect(updateWindowSessionWorkspaceMock).toHaveBeenCalledTimes(2);
    expect(updateWindowSessionWorkspaceMock).toHaveBeenNthCalledWith(1, 'session-a', '/resolved/project');
    expect(updateWindowSessionWorkspaceMock).toHaveBeenNthCalledWith(2, 'session-b', '/resolved/project');
    expect(bindWindowSessionWorkspaceMock).toHaveBeenCalledTimes(2);
    expect(bindWindowSessionWorkspaceMock).toHaveBeenNthCalledWith(1, 'session-a', '/resolved/project');
    expect(bindWindowSessionWorkspaceMock).toHaveBeenNthCalledWith(2, 'session-b', '/resolved/project');
    expect(initializeGlobalWorkspaceWatchMock).not.toHaveBeenCalled();
    expect(broadcastEventMock).toHaveBeenCalledWith(
      'workspace:changed',
      { workspacePath: '/resolved/project' },
      undefined,
    );
  });

  test('clearWorkspace clears the global watch when there is no window session context', async () => {
    await clearWorkspace();

    expect(setCurrentWorkspaceMock).toHaveBeenCalledWith(null);
    expect(clearGlobalWorkspaceWatchMock).toHaveBeenCalledTimes(1);
    expect(bindWindowSessionWorkspaceMock).not.toHaveBeenCalled();
    expect(closeWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(broadcastEventMock).toHaveBeenCalledWith(
      'workspace:changed',
      { workspacePath: null },
      undefined,
    );
    expect(onWorkspaceChangedMock).toHaveBeenCalledTimes(1);
  });
});
