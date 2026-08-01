import express from 'express';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import request from 'supertest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerWorkspaceCoreRoutes } from './workspace';

function createTestHarness() {
  const getWorkspaceHandlerMock = mock(async () => ({ workspace: null as string | null }));
  const setWorkspaceHandlerMock = mock(async (_workspacePath: string) => ({ success: true }));
  const getCurrentWorkspaceMock = mock(() => null as string | null);
  const writeFileTreeCacheMock = mock((_workspacePath: string, _files: unknown) => {});
  const app = express();
  const router = express.Router();
  app.use(express.json());
  registerWorkspaceCoreRoutes(router, {
    getCurrentWorkspace: getCurrentWorkspaceMock,
    getWorkspaceHandler: getWorkspaceHandlerMock,
    setWorkspaceHandler: setWorkspaceHandlerMock,
    writeFileTreeCache: writeFileTreeCacheMock,
  });
  app.use('/', router);
  return {
    app,
    getCurrentWorkspaceMock,
    getWorkspaceHandlerMock,
    setWorkspaceHandlerMock,
    writeFileTreeCacheMock,
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe('workspace router with supertest', () => {
  test('GET / returns handler-backed workspace state', async () => {
    const { app, getCurrentWorkspaceMock, getWorkspaceHandlerMock } = createTestHarness();
    getCurrentWorkspaceMock.mockReturnValue('/workspace/raw-state');
    getWorkspaceHandlerMock.mockResolvedValue({ workspace: '/workspace/from-handler' });

    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ workspace: '/workspace/from-handler' });
    expect(getWorkspaceHandlerMock).toHaveBeenCalledTimes(1);
  });

  test('GET / returns 500 when the workspace handler rejects', async () => {
    const { app, getWorkspaceHandlerMock } = createTestHarness();
    getWorkspaceHandlerMock.mockImplementationOnce(() =>
      Promise.reject(new Error('workspace-read-failed')),
    );

    const response = await request(app)
      .get('/')
      .timeout({ deadline: 250, response: 250 });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'workspace-read-failed' });
  });

  test('GET /files uses handler-backed workspace before reading the tree', async () => {
    const { app, getCurrentWorkspaceMock, getWorkspaceHandlerMock } = createTestHarness();
    const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-supertest-'));
    tempDirs.push(workspacePath);

    await mkdir(join(workspacePath, 'docs'), { recursive: true });
    await writeFile(join(workspacePath, 'README.md'), '# test\n', 'utf-8');

    getCurrentWorkspaceMock.mockReturnValue(null);
    getWorkspaceHandlerMock.mockResolvedValue({ workspace: workspacePath });

    const response = await request(app).get('/files');

    expect(response.status).toBe(200);
    expect(getWorkspaceHandlerMock).toHaveBeenCalledTimes(1);
    expect(response.body.files.map((entry: { path: string }) => entry.path)).toEqual([
      'docs',
      'README.md',
    ]);
  });

  test('GET /files returns 400 when the handler reports no workspace', async () => {
    const { app, getWorkspaceHandlerMock } = createTestHarness();
    getWorkspaceHandlerMock.mockResolvedValue({ workspace: null });

    const response = await request(app).get('/files');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'No workspace set' });
  });

  test('GET /files streams SSE results when requested', async () => {
    const { app, getWorkspaceHandlerMock, writeFileTreeCacheMock } = createTestHarness();
    const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-supertest-stream-'));
    tempDirs.push(workspacePath);

    await mkdir(join(workspacePath, 'docs'), { recursive: true });
    await writeFile(join(workspacePath, 'README.md'), '# stream\n', 'utf-8');
    getWorkspaceHandlerMock.mockResolvedValue({ workspace: workspacePath });

    const response = await request(app).get('/files?stream=true');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    expect(response.text).toContain('"done":true');
    expect(writeFileTreeCacheMock).toHaveBeenCalledTimes(1);
    expect(writeFileTreeCacheMock).toHaveBeenCalledWith(
      workspacePath,
      expect.any(Array),
    );
  });
});
