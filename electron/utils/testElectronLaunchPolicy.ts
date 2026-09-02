export const PLAYWRIGHT_ELECTRON_DESKTOP_CAPTURABLE_ENV =
  "PLAYWRIGHT_ELECTRON_DESKTOP_CAPTURABLE";

export interface TestElectronLaunchPolicyInput {
  platform: NodeJS.Platform;
  desktopCapturable: boolean;
}

/**
 * Keeps the normal test renderer safeguards unless a Windows desktop recording
 * explicitly opts into hardware-backed compositing.
 */
export function buildTestElectronLaunchArgs({
  platform,
  desktopCapturable,
}: TestElectronLaunchPolicyInput): string[] {
  const useDesktopCapturableRendering =
    platform === "win32" && desktopCapturable;

  return [
    "--no-sandbox",
    ...(!useDesktopCapturableRendering ? ["--disable-gpu"] : []),
    "--disable-dev-shm-usage",
    ...(!useDesktopCapturableRendering
      ? ["--disable-software-rasterizer"]
      : []),
    "--disable-setuid-sandbox",
    "--disable-extensions",
  ];
}
