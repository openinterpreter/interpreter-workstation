import { beforeEach, describe, expect, test, vi } from 'vitest';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('@/ipc', () => ({ apiRequest, appendWindowSessionKey: vi.fn(), getApiUrl: vi.fn() }));
vi.mock('../../remote/workstationConnection', () => ({ isWorkstationReadOnly: () => false }));

import { simpleInterfaceClient } from './simpleInterfaceClient';

beforeEach(() => apiRequest.mockReset());

describe('Simple interface request recovery', () => {
  test('retains only a known category, never a private server diagnostic', async () => {
    apiRequest.mockResolvedValue({ ok: false, status: 500, data: {
      error: '/private/alice token=secret', problemKind: 'bundled-runtime-incompatible',
    } });
    await expect(simpleInterfaceClient.refresh()).rejects.toMatchObject({
      problemKind: 'bundled-runtime-incompatible', message: 'Interface request failed',
    });
  });

  test('rejects an arbitrary category as a generic client failure', async () => {
    apiRequest.mockResolvedValue({ ok: false, status: 500, data: {
      error: '/private/alice token=secret', problemKind: '/private/alice',
    } });
    await expect(simpleInterfaceClient.refresh()).rejects.toMatchObject({
      problemKind: null, message: 'Interface request failed',
    });
  });
});
