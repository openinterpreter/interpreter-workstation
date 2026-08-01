import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type OixPlatformConfig = {
  target: string;
  interpreterPath: string;
};

type OixDownloadModule = {
  OIX_PLATFORMS: Record<string, OixPlatformConfig>;
};

async function loadOixDownloadModule(): Promise<OixDownloadModule> {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), 'scripts', 'download-oix.mjs')).href;
  return await import(moduleUrl) as OixDownloadModule;
}

describe('OIX bundled public package manifest', () => {
  test('downloads the unified interpreter CLI for every supported platform', async () => {
    const { OIX_PLATFORMS } = await loadOixDownloadModule();
    const platforms = Object.keys(OIX_PLATFORMS).sort();

    expect(platforms).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);

    for (const [platform, config] of Object.entries(OIX_PLATFORMS)) {
      const suffix = platform.startsWith('win32') ? '.exe' : '';
      expect(config.interpreterPath).toBe(`bin/interpreter${suffix}`);
    }
  });

  test('electron-builder packages the complete OIX package directory', async () => {
    const config = readFileSync(path.join(process.cwd(), 'electron-builder.yml'), 'utf8');

    for (const section of ['darwin-${arch}', 'win32-${arch}', 'linux-${arch}']) {
      expect(config).toContain(`from: resources/oix/${section}`);
      expect(config).toContain('to: oix');
    }
  });

  test('unit test runner invokes the interpreter MCP smoke and not the old codex smoke', () => {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const unitRunner = readFileSync(path.join(process.cwd(), 'scripts', 'run-unit-tests.mjs'), 'utf8');

    expect(packageJson.scripts['test:interpreter:smoke']).toBe('node scripts/check-interpreter-cli-smoke.mjs');
    expect(packageJson.scripts['test:codex:smoke']).toBeUndefined();
    expect(unitRunner).toContain("['run', 'test:interpreter:smoke']");
    expect(unitRunner).not.toContain('test:codex:smoke');
  });
});
