type TabBarClosedPaddingInput = {
  isMac: boolean;
  isWindows: boolean;
  trafficLightsWidth: number;
  unitPadding: number;
  unitElementHeight: number;
  windowsLeftReserve: number;
};

export function getTabBarClosedPadding(input: TabBarClosedPaddingInput): number {
  const baseClosedPadding =
    (input.isMac ? input.trafficLightsWidth : 0) +
    input.unitPadding * 2 +
    input.unitElementHeight;

  if (!input.isWindows) {
    return baseClosedPadding;
  }

  return Math.max(baseClosedPadding, input.windowsLeftReserve);
}

export function getTabBarRightPadding(rightSidebarWidth: number, rightReserve: number): number {
  return Math.max(0, rightReserve - rightSidebarWidth);
}

// NOTE(victor): Linux/Wayland crashes (SIGSEGV in XdgToplevel::SurfaceMove) when custom drag regions are used with native frame. See #976.
export function getDragRegionStyle(platform: string): 'drag' | 'no-drag' {
  return platform === 'linux' ? 'no-drag' : 'drag';
}
