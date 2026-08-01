export function isSelectedFileSourceApp(
  platform: NodeJS.Platform,
  source: { ownerName?: string | null; processName?: string | null },
): boolean {
  if (platform === 'darwin') {
    return source.ownerName === 'Finder';
  }

  if (platform === 'win32') {
    return source.processName === 'explorer';
  }

  return false;
}
