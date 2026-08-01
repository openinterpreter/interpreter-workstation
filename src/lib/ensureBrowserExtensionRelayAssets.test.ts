import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  getBundledRelayRuntimeValidationIssues,
} = await import('../../scripts/ensure-browser-extension-relay-assets.mjs');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ensure-browser-extension-relay-assets-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, contents: string = 'ok'): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeBundledRelayRuntime(targetDir: string, options?: { manifestVersion?: string; relayId?: string }): void {
  const manifestVersion = options?.manifestVersion ?? '0.0.88';
  const relayId = options?.relayId ?? 'bboaaphdpllilofamfpommlbafpellnb';

  writeFile(path.join(targetDir, 'package.json'), JSON.stringify({ version: '0.0.105' }));
  writeFile(path.join(targetDir, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    packageVersion: '0.0.105',
    fileCount: 0,
    totalBytes: 0,
    treeSha256: '0'.repeat(64),
  }));
  writeFile(path.join(targetDir, 'dist', 'start-relay-server.js'));
  writeFile(path.join(targetDir, 'dist', 'utils.js'), `const OUR_EXTENSION_IDS = ['${relayId}'];`);
  writeFile(
    path.join(targetDir, 'dist', 'extension', 'manifest.json'),
    JSON.stringify({ manifest_version: 3, version: manifestVersion }),
  );
  writeFile(
    path.join(targetDir, 'dist', 'extension', 'background.js'),
    `const OUR_EXTENSION_IDS = ['${relayId}'];`,
  );
  writeFile(path.join(targetDir, 'GENERATED-DO-NOT-EDIT.txt'));
  writeFile(path.join(targetDir, 'node_modules', '.modules.yaml'));
  mkdirSync(path.join(targetDir, 'node_modules', 'hono'), { recursive: true });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('getBundledRelayRuntimeValidationIssues', () => {
  test('flags staged runtimes that still reference the legacy production extension id', () => {
    const targetDir = makeTempDir();
    writeBundledRelayRuntime(targetDir, {
      relayId: 'jfeammnjpkecdekppnclgkkffahnhfhe',
    });

    const issues = getBundledRelayRuntimeValidationIssues({ targetDir });

    expect(issues).toEqual([
      `Bundled relay runtime still references legacy production extension ids in ${path.join(targetDir, 'dist', 'utils.js')}`,
      `Bundled relay runtime is missing the current production extension id in ${path.join(targetDir, 'dist', 'utils.js')}`,
      `Bundled relay runtime still references legacy production extension ids in ${path.join(targetDir, 'dist', 'extension', 'background.js')}`,
      `Bundled relay runtime is missing the current production extension id in ${path.join(targetDir, 'dist', 'extension', 'background.js')}`,
    ]);
  });

  test('flags staged extension manifest drift when source is newer', () => {
    const targetDir = makeTempDir();
    const sourceManifestPath = path.join(makeTempDir(), 'extension', 'manifest.json');

    writeBundledRelayRuntime(targetDir, {
      manifestVersion: '0.0.80',
    });
    writeFile(sourceManifestPath, JSON.stringify({ manifest_version: 3, version: '0.0.88' }));

    const issues = getBundledRelayRuntimeValidationIssues({ targetDir, sourceExtensionManifestPath: sourceManifestPath });

    expect(issues).toContain(
      `Bundled extension manifest version 0.0.80 does not match source version 0.0.88`,
    );
  });

  test('accepts a staged runtime with the current production id and matching source manifest version', () => {
    const targetDir = makeTempDir();
    const sourceManifestPath = path.join(makeTempDir(), 'extension', 'manifest.json');

    writeBundledRelayRuntime(targetDir, {
      manifestVersion: '0.0.88',
      relayId: 'bboaaphdpllilofamfpommlbafpellnb',
    });
    writeFile(sourceManifestPath, JSON.stringify({ manifest_version: 3, version: '0.0.88' }));

    expect(
      getBundledRelayRuntimeValidationIssues({ targetDir, sourceExtensionManifestPath: sourceManifestPath }),
    ).toEqual([]);
  });
});
