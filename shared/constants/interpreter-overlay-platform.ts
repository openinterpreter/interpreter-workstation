export function isInterpreterOverlaySupportedPlatform(
  platform: string | null | undefined,
): boolean {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
}

export function isOfficeExtensionSupportedPlatform(
  platform: string | null | undefined,
): boolean {
  return platform === 'darwin' || platform === 'win32';
}
