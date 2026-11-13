import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const macos = [
  { id: 'macos-arm64', runner: 'macos-26', os: 'macos', arch: 'arm64' },
  { id: 'macos-x64', runner: 'macos-15-intel', os: 'macos', arch: 'x64' },
];
const windowsLinux = [
  { id: 'windows-x64', runner: 'windows-2025', os: 'windows', arch: 'x64' },
  { id: 'linux-x64', runner: 'ubuntu-24.04', os: 'linux', arch: 'x64' },
];

export function releasePlatformSelection(mode) {
  assert.ok(mode === 'all' || mode === 'windows-linux', 'Unsupported release platform selection');
  return { mode, matrix: { include: mode === 'all' ? [...macos, ...windowsLinux] : windowsLinux } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mode, matrix } = releasePlatformSelection(process.argv[2]);
  process.stdout.write(`mode=${mode}\nmatrix=${JSON.stringify(matrix)}\n`);
}
