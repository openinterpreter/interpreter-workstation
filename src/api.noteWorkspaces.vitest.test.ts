import { beforeEach, describe, expect, test, vi } from 'vitest';

const ipcMocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}));

vi.mock('./ipc', () => ({
  apiRequest: ipcMocks.apiRequest,
  files: {},
  getAppServerOrigin: vi.fn(() => 'http://127.0.0.1:3000'),
  isBrowserDevMode: vi.fn(() => false),
  servers: {},
  settings: {},
}));

vi.mock('./demo/marketingDemo', () => ({
  getMarketingDemoDetectedNoteWorkspaces: vi.fn(() => []),
  getMarketingDemoFolderChildren: vi.fn(),
  getMarketingDemoWorkspace: vi.fn(),
  getMarketingDemoWorkspaceFiles: vi.fn(),
  getMarketingDemoWorkspacePath: vi.fn(),
  isMarketingDemoMode: vi.fn(() => false),
  readMarketingDemoFile: vi.fn(),
  writeMarketingDemoFile: vi.fn(),
}));

import { detectNoteWorkspaces, getDetectedNoteWorkspaces } from './api';

describe('note workspace API contract', () => {
  beforeEach(() => {
    ipcMocks.apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { workspaces: [] },
    });
  });

  test('loads saved scan results with a read-only GET', async () => {
    await getDetectedNoteWorkspaces();

    expect(ipcMocks.apiRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/workspace/detect-note-workspaces',
      body: undefined,
    });
  });

  test('starts a filesystem scan only through an explicit POST', async () => {
    await detectNoteWorkspaces();

    expect(ipcMocks.apiRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/workspace/detect-note-workspaces',
      body: undefined,
    });
  });
});
