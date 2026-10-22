import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const script = readFileSync(new URL('./install-windows-deps.ps1', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');

test('Windows native install uses a short, job-local virtual store', () => {
  assert.match(script, /Test-Path -LiteralPath \$env:GITHUB_WORKSPACE -PathType Container/);
  assert.match(script, /GetPathRoot\(\$env:GITHUB_WORKSPACE\)/);
  assert.match(script, /pnpm install --frozen-lockfile --virtual-store-dir \$virtualStore/);
});

test('the dynamic import used by the native package has a declared dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.pnpm.packageExtensions['@oxidezap/baileyrs@0.0.32'].dependencies['music-metadata'], manifest.dependencies['music-metadata']);
});

test('CI and official release select the Windows path without moving non-Windows installs', () => {
  for (const workflow of [ci, release]) {
    assert.match(workflow, /install-windows-deps\.ps1/);
    assert.match(workflow, /pnpm install --frozen-lockfile/);
  }
  assert.match(ci, /if: runner\.os == 'Windows'/);
  assert.match(release, /if: matrix\.os == 'windows'/);
  assert.match(ci, /test:e2e:voice:ci\n\s+env:[\s\S]*?PLAYWRIGHT_ELECTRON_DESKTOP_CAPTURABLE: '1'/);
});

test('Electron fixtures resolve the installed executable only on Windows', () => {
  for (const relativePath of ['../../tests/electron-instance.ts', '../../tests/global-setup.ts']) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /createRequire\(path\.resolve\(process\.cwd\(\), ['"]package\.json['"]\)\)\(['"]electron['"]\)/);
    assert.match(source, /process\.platform === ['"]win32['"]/);
    assert.match(source, /electron\.launch\(\{\s*\.\.\.\(executablePath \? \{ executablePath \} : \{\}\),/);
  }
});
