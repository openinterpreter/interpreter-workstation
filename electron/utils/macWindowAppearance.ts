type Platform = NodeJS.Platform;

type MacWindowAppearanceInput = {
  platform: Platform;
  disableMacTransparencyEnv?: string;
  forceMacTransparencyEnv?: string;
  machineRunDirEnv?: string;
  shouldUseDarkColors: boolean;
};

type GpuFeatureInput = {
  platform: Platform;
  disableMacTransparencyEnv?: string;
  forceMacTransparencyEnv?: string;
  forceGpuFeaturesEnv?: string;
  disableForcedGpuFeaturesEnv?: string;
  machineRunDirEnv?: string;
  playwrightElectronDesktopCapturableEnv?: string;
};

type GpuStartupPolicy = {
  commandLineSwitches: string[];
  disableHardwareAcceleration: boolean;
};

function shouldHonorMachineVisualOverrideEnvs({
  platform,
  machineRunDirEnv,
}: Pick<GpuFeatureInput, 'platform' | 'machineRunDirEnv'>): boolean {
  return platform === 'darwin' && Boolean(machineRunDirEnv?.trim());
}

export function shouldDisableMacTransparency({
  platform,
  disableMacTransparencyEnv,
  forceMacTransparencyEnv,
  machineRunDirEnv,
}: GpuFeatureInput): boolean {
  if (platform !== 'darwin') {
    return false;
  }
  if (forceMacTransparencyEnv === '1') {
    return false;
  }
  if (!shouldHonorMachineVisualOverrideEnvs({ platform, machineRunDirEnv })) {
    return false;
  }
  return disableMacTransparencyEnv === '1';
}

export function shouldEnableGpuFeatures(input: GpuFeatureInput): boolean {
  if (input.platform !== 'darwin') {
    return false;
  }
  if (input.forceGpuFeaturesEnv === '1') {
    return true;
  }
  if (!shouldHonorMachineVisualOverrideEnvs(input)) {
    return true;
  }
  if (input.disableForcedGpuFeaturesEnv === '1') {
    return false;
  }
  return !shouldDisableMacTransparency(input);
}

export function getGpuStartupPolicy(input: GpuFeatureInput): GpuStartupPolicy {
  if (
    input.platform === 'win32'
    && input.playwrightElectronDesktopCapturableEnv === '1'
  ) {
    return {
      commandLineSwitches: [],
      disableHardwareAcceleration: false,
    };
  }

  if (shouldEnableGpuFeatures(input)) {
    return {
      commandLineSwitches: [
        'enable-webgl',
        'ignore-gpu-blocklist',
        'enable-webgl2-compute-context',
      ],
      disableHardwareAcceleration: false,
    };
  }

  const commandLineSwitches = input.platform === 'win32' || input.platform === 'linux'
    ? ['disable-gpu', 'disable-software-rasterizer']
    : [];

  return {
    commandLineSwitches,
    disableHardwareAcceleration: true,
  };
}

export function getMacWindowAppearance({
  platform,
  disableMacTransparencyEnv,
  forceMacTransparencyEnv,
  machineRunDirEnv,
  shouldUseDarkColors,
}: MacWindowAppearanceInput) {
  if (platform !== 'darwin') {
    return {
      transparent: false,
      vibrancy: undefined,
      backgroundColor: undefined,
    };
  }

  if (shouldDisableMacTransparency({
    platform,
    disableMacTransparencyEnv,
    forceMacTransparencyEnv,
    machineRunDirEnv,
  })) {
    return {
      transparent: false,
      vibrancy: undefined,
      backgroundColor: shouldUseDarkColors ? '#1e1e1e' : '#f6f6f6',
    };
  }

  return {
    transparent: true,
    vibrancy: 'under-window' as const,
    backgroundColor: '#00000000',
  };
}
