import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  canUseHostNativeFileManager,
  getBrowserWorkstationConnection,
  getBrowserWorkstationStorageKey,
  isPublicWorkstationPublication,
  isWorkstationReadOnly,
  resolveWorkstationApiUrl,
  workstationFetch,
} from './workstationConnection';

const originalUrl = window.location.href;

afterEach(() => {
  window.history.replaceState({}, '', originalUrl);
  vi.restoreAllMocks();
});

describe('browser Workstation connection', () => {
  test('keeps the ordinary browser bridge local and read-write', () => {
    window.history.replaceState({}, '', '/');
    expect(getBrowserWorkstationConnection()).toMatchObject({
      host: 'local',
      access: 'read-write',
      authentication: 'none',
      endpoint: null,
      publication: false,
    });
    expect(canUseHostNativeFileManager()).toBe(true);
  });

  test('treats target, access, and authentication as independent settings', () => {
    window.history.replaceState(
      {},
      '',
      '/?surface=workstation&endpoint=https%3A%2F%2Fcomputer.example&access=read-only&auth=password',
    );
    expect(getBrowserWorkstationConnection()).toEqual({
      host: 'remote',
      access: 'read-only',
      authentication: 'password',
      endpoint: 'https://computer.example',
      publication: false,
    });
    expect(isWorkstationReadOnly()).toBe(true);
    expect(canUseHostNativeFileManager()).toBe(false);
    expect(isPublicWorkstationPublication()).toBe(false);
    expect(resolveWorkstationApiUrl('/api/agent/threads')).toBe(
      'https://computer.example/api/agent/threads',
    );
    expect(getBrowserWorkstationStorageKey()).toMatch(/^workstation-remote-/);
  });

  test('keeps the legacy public surface explicit and read-only', () => {
    window.history.replaceState(
      {},
      '',
      '/?surface=remote-workstation&endpoint=%2Fapi%2Fscience&access=read-only&auth=none',
    );
    expect(isPublicWorkstationPublication()).toBe(true);
    expect(isWorkstationReadOnly()).toBe(true);
    expect(resolveWorkstationApiUrl('/api/agent/threads')).toBe('/api/agent/threads');
  });

  test('uses the normal Workstation surface for an anonymous read-only backend', () => {
    window.history.replaceState(
      {},
      '',
      '/?surface=workstation&endpoint=%2Fapi%2Fscience&access=read-only&auth=none',
    );
    expect(getBrowserWorkstationConnection()).toMatchObject({
      host: 'remote',
      access: 'read-only',
      authentication: 'none',
      publication: true,
    });
  });

  test('includes the password session on every remote bridge request', async () => {
    window.history.replaceState(
      {},
      '',
      '/?surface=workstation&endpoint=https%3A%2F%2Fcomputer.example',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await workstationFetch('/api/ipc/workspace/get', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://computer.example/api/ipc/workspace/get',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });
});
