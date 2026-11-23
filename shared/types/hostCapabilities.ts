/** Features the current Workstation host can actually provide during setup. */
export interface HostCapabilities {
  onboardingSteps: {
    browserExtension: boolean;
    mcpDiscovery: boolean;
    whatsapp: boolean;
    environmentDetection: boolean;
  };
  modelSetup: {
    hostedAccount: boolean;
    chatgptSignIn: 'redirect' | 'device-code' | 'unavailable';
    apiKeyProviders: boolean;
    customEndpoint: boolean;
    localRuntimeProbes: boolean;
    runtimeLocalModels: boolean;
  };
  workspace: 'filesystem' | 'none';
  nativeContextMenu: boolean;
}

export const DESKTOP_HOST_CAPABILITIES: HostCapabilities = {
  onboardingSteps: { browserExtension: true, mcpDiscovery: true, whatsapp: true,
    environmentDetection: true },
  modelSetup: { hostedAccount: true, chatgptSignIn: 'redirect', apiKeyProviders: true,
    customEndpoint: true, localRuntimeProbes: true, runtimeLocalModels: false },
  workspace: 'filesystem',
  nativeContextMenu: true,
};

export const BROWSER_PROJECT_CAPABILITIES: HostCapabilities = {
  onboardingSteps: { browserExtension: false, mcpDiscovery: false, whatsapp: false,
    environmentDetection: false },
  modelSetup: { hostedAccount: false, chatgptSignIn: 'unavailable', apiKeyProviders: false,
    customEndpoint: false, localRuntimeProbes: false, runtimeLocalModels: true },
  workspace: 'none',
  nativeContextMenu: false,
};
