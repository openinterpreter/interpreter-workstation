import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as configStore from '../configStore';
import * as broadcast from './broadcast';
import * as ipcBridge from '../utils/ipcBridge';
import { setToolManager } from '../tools/toolManagerAccessor';
import { setGlobalToolEnabled } from './globalTools';

// NOTE(victor): bun shares one module cache across all test files (bun #6024).
// mock.module() leaks globally and cannot be undone. Use setToolManager() and
// spyOn() instead -- they mutate in-place and are restorable.

describe('globalTools handler', () => {
  const mockListToolServerSnapshot = mock(async () => ([
    {
      id: 'sentry',
      name: 'Sentry',
      state: { status: 'disconnected' as const },
      globallyDisabled: true,
    },
  ]));

  let configSpy: ReturnType<typeof spyOn>;
  let broadcastSpy: ReturnType<typeof spyOn>;
  let ipcSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    configSpy = spyOn(configStore, 'setBuiltinToolEnabled').mockResolvedValue(undefined as never);
    broadcastSpy = spyOn(broadcast, 'broadcastEvent').mockImplementation(() => {});
    ipcSpy = spyOn(ipcBridge, 'emitToolServersChanged').mockImplementation(() => {});
    setToolManager({
      listToolServerSnapshot: mockListToolServerSnapshot,
      listAllToolServers: mock(async () => []),
    } as any);
    mockListToolServerSnapshot.mockClear();
  });

  afterEach(() => {
    configSpy.mockRestore();
    broadcastSpy.mockRestore();
    ipcSpy.mockRestore();
  });

  test('setGlobalToolEnabled broadcasts the fast tool-server snapshot', async () => {
    await setGlobalToolEnabled('sentry', false);

    expect(configSpy).toHaveBeenCalledWith('sentry', false);
    expect(broadcastSpy).toHaveBeenCalledWith('globalTools:changed', {
      serverId: 'sentry',
      enabled: false,
    });
    expect(mockListToolServerSnapshot).toHaveBeenCalledTimes(1);
    expect(ipcSpy).toHaveBeenCalledWith([
      {
        id: 'sentry',
        name: 'Sentry',
        state: { status: 'disconnected' },
        globallyDisabled: true,
      },
    ]);
  });
});
