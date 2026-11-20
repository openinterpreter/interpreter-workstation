import { describe, expect, test } from 'bun:test';
import {
  IPC_UNAVAILABLE_CODE,
  IpcUnavailableError,
  isIpcUnavailableError,
  isIpcUnavailableResponse,
} from './ipcAvailability';

describe('IPC availability', () => {
  test('an unknown namespace or method reported by the router is unavailable', () => {
    expect(isIpcUnavailableResponse(404, { error: 'Unknown method: topNotices.list', code: IPC_UNAVAILABLE_CODE })).toBe(true);
  });

  test('a host without the IPC endpoint is unavailable', () => {
    expect(isIpcUnavailableResponse(404, null)).toBe(true);
    expect(isIpcUnavailableResponse(405, null)).toBe(true);
  });

  test('handler failures remain failures', () => {
    expect(isIpcUnavailableResponse(500, { error: 'disk full' })).toBe(false);
    expect(isIpcUnavailableResponse(404, { error: 'Thread not found' })).toBe(false);
    expect(isIpcUnavailableResponse(403, { error: 'This Workstation connection is read-only.' })).toBe(false);
    expect(isIpcUnavailableResponse(401, null)).toBe(false);
    expect(isIpcUnavailableResponse(500, null)).toBe(false);
    expect(isIpcUnavailableResponse(500, { code: IPC_UNAVAILABLE_CODE })).toBe(false);
  });

  test('the error names its operation and is recognised only by type', () => {
    const error = new IpcUnavailableError('skills.list');
    expect(error.operation).toBe('skills.list');
    expect(error.name).toBe('IpcUnavailableError');
    expect(isIpcUnavailableError(error)).toBe(true);
    expect(isIpcUnavailableError(new Error('skills.list is not available in this environment.'))).toBe(false);
    expect(isIpcUnavailableError(undefined)).toBe(false);
  });
});
