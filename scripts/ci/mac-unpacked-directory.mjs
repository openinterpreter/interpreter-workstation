// electron-builder omits the suffix for its default architecture (x64).
// Artifact filenames still include an explicit architecture.
export function macUnpackedDirectory(arch) {
  if (arch === 'x64') return 'mac';
  if (arch === 'arm64') return 'mac-arm64';
  throw new Error(`Unsupported macOS release candidate architecture: ${arch}`);
}
