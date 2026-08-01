import { beforeEach, describe, expect, mock, test } from 'bun:test';

const moonshineModule = {
  Settings: {
    BASE_ASSET_PATH: {
      MOONSHINE: '',
    },
  },
};

const getAppServerOriginMock = mock(async () => 'http://127.0.0.1:5177');
const getRuntimeSystemInfoMock = mock(() => ({ platform: 'win32' as const }));

mock.module('@moonshine-ai/moonshine-js', () => moonshineModule);

mock.module('../../src/ipc', () => ({
  getAppServerOrigin: getAppServerOriginMock,
  getRuntimeSystemInfo: getRuntimeSystemInfoMock,
}));

const { loadMoonshineModule } = await import('./moonshine');

describe('loadMoonshineModule', () => {
  beforeEach(() => {
    moonshineModule.Settings.BASE_ASSET_PATH.MOONSHINE = '';
    getAppServerOriginMock.mockClear();
    getRuntimeSystemInfoMock.mockClear();
    getRuntimeSystemInfoMock.mockImplementation(() => ({ platform: 'win32' as const }));
  });

  test('uses a clean asset base URL on Windows', async () => {
    const module = await loadMoonshineModule();

    expect(module.Settings.BASE_ASSET_PATH.MOONSHINE).toBe('http://127.0.0.1:5177/api/agent/voice/moonshine-assets/');
    expect(module.Settings.BASE_ASSET_PATH.MOONSHINE.includes('windowSessionKey')).toBe(false);
    expect(getAppServerOriginMock).toHaveBeenCalledTimes(1);
  });

  test('does not rewrite the asset base URL outside Windows', async () => {
    moonshineModule.Settings.BASE_ASSET_PATH.MOONSHINE = 'unchanged';
    getRuntimeSystemInfoMock.mockImplementation(() => ({ platform: 'darwin' as const }));

    const module = await loadMoonshineModule();

    expect(module.Settings.BASE_ASSET_PATH.MOONSHINE).toBe('unchanged');
    expect(getAppServerOriginMock).not.toHaveBeenCalled();
  });
});
