import { afterEach, describe, expect, test, vi } from 'vitest';
import { skills, topNotices } from '@/ipc';
import { IpcUnavailableError, isIpcUnavailableError } from '../shared/ipcAvailability';

// jsdom has no Electron preload, so these calls use the browser HTTP bridge.
function respondWith(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser IPC bridge availability', () => {
  test('calls the HTTP equivalent endpoint', async () => {
    const fetchMock = respondWith(Response.json({ notices: [] }));
    await expect(topNotices.list()).resolves.toEqual({ notices: [] });
    expect(fetchMock).toHaveBeenCalledWith('/api/ipc/topNotices/list', expect.objectContaining({ method: 'POST' }));
  });

  test('a host whose router lacks the operation rejects with IpcUnavailableError', async () => {
    respondWith(Response.json({ error: 'Unknown namespace: topNotices', code: 'ipc_unavailable' }, { status: 404 }));
    const error = await topNotices.list().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(IpcUnavailableError);
    expect((error as IpcUnavailableError).operation).toBe('topNotices.list');
  });

  test('a page without the IPC endpoint rejects with IpcUnavailableError', async () => {
    respondWith(new Response('<!doctype html><title>Not Found</title>', { status: 404, headers: { 'Content-Type': 'text/html' } }));
    const error = await skills.list({ workspacePath: null }).catch((reason: unknown) => reason);
    expect(isIpcUnavailableError(error)).toBe(true);
  });

  test('a handler failure keeps its message and is not treated as unavailable', async () => {
    respondWith(Response.json({ error: 'Could not read skills folder' }, { status: 500 }));
    const error = await skills.list({ workspacePath: null }).catch((reason: unknown) => reason);
    expect(isIpcUnavailableError(error)).toBe(false);
    expect((error as Error).message).toBe('Could not read skills folder');
  });

  test('access refusals remain failures', async () => {
    respondWith(Response.json({ error: 'Authentication required.' }, { status: 401 }));
    const error = await topNotices.list().catch((reason: unknown) => reason);
    expect(isIpcUnavailableError(error)).toBe(false);
    expect((error as Error).message).toBe('Authentication required.');
  });
});
