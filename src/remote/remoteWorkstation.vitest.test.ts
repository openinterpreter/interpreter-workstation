import { afterEach, describe, expect, test, vi } from 'vitest';
import { getRemoteWorkstationFolderChildren } from './remoteWorkstation';

const originalUrl = window.location.href;

const listing = {
  schemaVersion: 1,
  name: 'papers',
  path: 'papers',
  capabilities: ['browse', 'read'],
  entries: [
    { name: '00001', path: 'papers/00001', type: 'directory', modifiedAt: 1 },
  ],
};

afterEach(() => {
  window.history.replaceState({}, '', originalUrl);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('remote Workstation workspace listings', () => {
  test('shares one network request between concurrent folder loads', async () => {
    window.history.replaceState(
      {},
      '',
      '/?surface=workstation&endpoint=%2Fapi%2Fscience&access=read-only&auth=none',
    );
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));

    const first = getRemoteWorkstationFolderChildren('/workspace/papers');
    const second = getRemoteWorkstationFolderChildren('/workspace/papers');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse?.(new Response(JSON.stringify(listing), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('retries a transient failed fetch', async () => {
    vi.useFakeTimers();
    window.history.replaceState(
      {},
      '',
      '/?surface=workstation&endpoint=%2Fapi%2Fscience&access=read-only&auth=none',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify(listing), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const request = getRemoteWorkstationFolderChildren('/workspace/papers');
    await vi.advanceTimersByTimeAsync(200);
    await expect(request).resolves.toMatchObject({ children: [{ name: '00001' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
