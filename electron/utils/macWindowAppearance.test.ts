import { describe, expect, test } from 'bun:test';
import { getGpuStartupPolicy, getMacWindowAppearance, shouldEnableGpuFeatures } from './macWindowAppearance';

const NON_DARWIN_PLATFORMS = [
  'aix',
  'android',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
] as const satisfies readonly Exclude<NodeJS.Platform, 'darwin'>[];

describe('getMacWindowAppearance', () => {
  test('keeps vibrancy enabled for normal macOS launches', () => {
    expect(getMacWindowAppearance({
      platform: 'darwin',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: undefined,
      machineRunDirEnv: undefined,
      shouldUseDarkColors: false,
    })).toEqual({
      transparent: true,
      vibrancy: 'under-window',
      backgroundColor: '#00000000',
    });
  });

  test('disables transparency and uses an opaque background for VM launches', () => {
    expect(getMacWindowAppearance({
      platform: 'darwin',
      disableMacTransparencyEnv: '1',
      forceMacTransparencyEnv: undefined,
      machineRunDirEnv: '/tmp/interpreter-machine-run',
      shouldUseDarkColors: true,
    })).toEqual({
      transparent: false,
      vibrancy: undefined,
      backgroundColor: '#1e1e1e',
    });
  });

  test('can force transparency back on for debugging guest rendering', () => {
    expect(getMacWindowAppearance({
      platform: 'darwin',
      disableMacTransparencyEnv: '1',
      forceMacTransparencyEnv: '1',
      machineRunDirEnv: '/tmp/interpreter-machine-run',
      shouldUseDarkColors: false,
    })).toEqual({
      transparent: true,
      vibrancy: 'under-window',
      backgroundColor: '#00000000',
    });
  });

  test('ignores stale transparency-disable env outside machine launches', () => {
    expect(getMacWindowAppearance({
      platform: 'darwin',
      disableMacTransparencyEnv: '1',
      forceMacTransparencyEnv: undefined,
      machineRunDirEnv: undefined,
      shouldUseDarkColors: false,
    })).toEqual({
      transparent: true,
      vibrancy: 'under-window',
      backgroundColor: '#00000000',
    });
  });

  test('does nothing on non-macOS platforms', () => {
    expect(getMacWindowAppearance({
      platform: 'win32',
      disableMacTransparencyEnv: '1',
      forceMacTransparencyEnv: undefined,
      machineRunDirEnv: '/tmp/interpreter-machine-run',
      shouldUseDarkColors: false,
    })).toEqual({
      transparent: false,
      vibrancy: undefined,
      backgroundColor: undefined,
    });
  });
});

describe('shouldEnableGpuFeatures', () => {
  test('enables forced GPU features only for transparent macOS launches', () => {
    expect(shouldEnableGpuFeatures({
      platform: 'darwin',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: undefined,
      disableForcedGpuFeaturesEnv: undefined,
      machineRunDirEnv: undefined,
    })).toBe(true);
    expect(shouldEnableGpuFeatures({
      platform: 'darwin',
      disableMacTransparencyEnv: '1',
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: undefined,
      disableForcedGpuFeaturesEnv: undefined,
      machineRunDirEnv: '/tmp/interpreter-machine-run',
    })).toBe(false);

    expect(shouldEnableGpuFeatures({
      platform: 'darwin',
      disableMacTransparencyEnv: '1',
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: '1',
      disableForcedGpuFeaturesEnv: undefined,
      machineRunDirEnv: '/tmp/interpreter-machine-run',
    })).toBe(true);

    expect(shouldEnableGpuFeatures({
      platform: 'darwin',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: undefined,
      disableForcedGpuFeaturesEnv: '1',
      machineRunDirEnv: '/tmp/interpreter-machine-run',
    })).toBe(false);

    expect(shouldEnableGpuFeatures({
      platform: 'darwin',
      disableMacTransparencyEnv: '1',
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: undefined,
      disableForcedGpuFeaturesEnv: '1',
      machineRunDirEnv: undefined,
    })).toBe(true);

    for (const platform of NON_DARWIN_PLATFORMS) {
      expect(shouldEnableGpuFeatures({
        platform,
        disableMacTransparencyEnv: undefined,
        forceMacTransparencyEnv: undefined,
        forceGpuFeaturesEnv: undefined,
        disableForcedGpuFeaturesEnv: undefined,
        machineRunDirEnv: undefined,
      })).toBe(false);
      expect(shouldEnableGpuFeatures({
        platform,
        disableMacTransparencyEnv: '1',
        forceMacTransparencyEnv: '1',
        forceGpuFeaturesEnv: '1',
        disableForcedGpuFeaturesEnv: '1',
        machineRunDirEnv: '/tmp/interpreter-machine-run',
      })).toBe(false);
    }
  });
});

describe('getGpuStartupPolicy', () => {
  test('fully disables the GPU fallback path on Linux and Windows when forced GPU features are off', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(getGpuStartupPolicy({
        platform,
        disableMacTransparencyEnv: undefined,
        forceMacTransparencyEnv: undefined,
        forceGpuFeaturesEnv: undefined,
        disableForcedGpuFeaturesEnv: undefined,
      })).toEqual({
        commandLineSwitches: ['disable-gpu', 'disable-software-rasterizer'],
        disableHardwareAcceleration: true,
      });
    }
  });

  test('keeps Windows GPU fallback disabled even when GPU feature envs are forced', () => {
    expect(getGpuStartupPolicy({
      platform: 'win32',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: '1',
      forceGpuFeaturesEnv: '1',
      disableForcedGpuFeaturesEnv: undefined,
    })).toEqual({
      commandLineSwitches: ['disable-gpu', 'disable-software-rasterizer'],
      disableHardwareAcceleration: true,
    });
  });

  test('keeps the default Windows GPU safety policy unless desktop capture explicitly opts in', () => {
    expect(getGpuStartupPolicy({
      platform: 'win32',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: undefined,
      disableForcedGpuFeaturesEnv: undefined,
      playwrightElectronDesktopCapturableEnv: undefined,
    })).toEqual({
      commandLineSwitches: ['disable-gpu', 'disable-software-rasterizer'],
      disableHardwareAcceleration: true,
    });

    expect(getGpuStartupPolicy({
      platform: 'win32',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: undefined,
      disableForcedGpuFeaturesEnv: undefined,
      playwrightElectronDesktopCapturableEnv: '1',
    })).toEqual({
      commandLineSwitches: [],
      disableHardwareAcceleration: false,
    });
  });

  test('limits the desktop-capturable opt-in to Windows', () => {
    expect(getGpuStartupPolicy({
      platform: 'linux',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: undefined,
      disableForcedGpuFeaturesEnv: undefined,
      playwrightElectronDesktopCapturableEnv: '1',
    })).toEqual({
      commandLineSwitches: ['disable-gpu', 'disable-software-rasterizer'],
      disableHardwareAcceleration: true,
    });

    expect(getGpuStartupPolicy({
      platform: 'darwin',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: undefined,
      disableForcedGpuFeaturesEnv: undefined,
      playwrightElectronDesktopCapturableEnv: '1',
    })).toEqual({
      commandLineSwitches: [
        'enable-webgl',
        'ignore-gpu-blocklist',
        'enable-webgl2-compute-context',
      ],
      disableHardwareAcceleration: false,
    });
  });

  test('keeps the Linux GPU fallback path disabled when GPU forcing env is stale', () => {
    expect(getGpuStartupPolicy({
      platform: 'linux',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: '1',
      disableForcedGpuFeaturesEnv: undefined,
      machineRunDirEnv: '/tmp/interpreter-machine-run',
    })).toEqual({
      commandLineSwitches: ['disable-gpu', 'disable-software-rasterizer'],
      disableHardwareAcceleration: true,
    });
  });

  test('uses disableHardwareAcceleration without extra switches on other non-macOS platforms', () => {
    for (const platform of NON_DARWIN_PLATFORMS) {
      if (platform === 'linux' || platform === 'win32') {
        continue;
      }

      expect(getGpuStartupPolicy({
        platform,
        disableMacTransparencyEnv: undefined,
        forceMacTransparencyEnv: undefined,
        forceGpuFeaturesEnv: undefined,
        disableForcedGpuFeaturesEnv: undefined,
      })).toEqual({
        commandLineSwitches: [],
        disableHardwareAcceleration: true,
      });
    }
  });

  test('keeps forced GPU features available on macOS', () => {
    expect(getGpuStartupPolicy({
      platform: 'darwin',
      disableMacTransparencyEnv: undefined,
      forceMacTransparencyEnv: undefined,
      forceGpuFeaturesEnv: undefined,
      disableForcedGpuFeaturesEnv: undefined,
    })).toEqual({
      commandLineSwitches: [
        'enable-webgl',
        'ignore-gpu-blocklist',
        'enable-webgl2-compute-context',
      ],
      disableHardwareAcceleration: false,
    });
  });
});
