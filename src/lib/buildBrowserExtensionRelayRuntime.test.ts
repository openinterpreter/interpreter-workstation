import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  assertNodeModulesLayout,
  assertRelayRuntimeLayout,
  findUnexpectedNodeModulesSymlinks,
  normalizeNestedPlaywriterRuntimeLayout,
  pruneRelayDistArtifacts,
  removeNamedDirsRecursively,
} = await import('../../scripts/build-browser-extension-relay-runtime.mjs');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-runtime-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, 'ok');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('assertRelayRuntimeLayout', () => {
  test('accepts staged relay runtime with bundled hono', () => {
    const stagingDir = makeTempDir();

    for (const relativePath of [
      'dist/start-relay-server.js',
      'dist/extension/manifest.json',
      'node_modules/hono/package.json',
    ]) {
      writeFile(path.join(stagingDir, relativePath));
    }

    expect(() => assertRelayRuntimeLayout(stagingDir)).not.toThrow();
  });

  test('fails when staged relay runtime omits hono', () => {
    const stagingDir = makeTempDir();

    for (const relativePath of [
      'dist/start-relay-server.js',
      'dist/extension/manifest.json',
    ]) {
      writeFile(path.join(stagingDir, relativePath));
    }

    expect(() => assertRelayRuntimeLayout(stagingDir)).toThrow(
      `Missing staged relay runtime file (node_modules/hono/package.json): ${path.join(stagingDir, 'node_modules', 'hono', 'package.json')}`,
    );
  });

  test('promotes nested playwriter runtime into the expected staging layout', () => {
    const stagingDir = makeTempDir();

    writeFile(path.join(stagingDir, 'node_modules', 'hono', 'package.json'));
    writeFile(path.join(stagingDir, 'node_modules', 'mcp-extension', 'node_modules', 'playwriter', 'dist', 'start-relay-server.js'));
    writeFile(path.join(stagingDir, 'node_modules', 'mcp-extension', 'node_modules', 'playwriter', 'dist', 'extension', 'manifest.json'));
    writeFile(path.join(stagingDir, 'node_modules', 'mcp-extension', 'node_modules', 'playwriter', 'package.json'));

    expect(normalizeNestedPlaywriterRuntimeLayout(stagingDir)).toBeTrue();
    expect(existsSync(path.join(stagingDir, 'dist', 'start-relay-server.js'))).toBeTrue();
    expect(existsSync(path.join(stagingDir, 'dist', 'extension', 'manifest.json'))).toBeTrue();
    expect(existsSync(path.join(stagingDir, 'package.json'))).toBeTrue();
    expect(() => assertRelayRuntimeLayout(stagingDir)).not.toThrow();
  });
});

describe('node_modules cleanup helpers', () => {
  test('treats only non-.bin symlinks as unexpected', () => {
    expect(
      findUnexpectedNodeModulesSymlinks([
        path.join('/tmp', 'relay', 'node_modules', '.bin', 'playwright-core'),
        path.join('/tmp', 'relay', 'node_modules', 'mcp-extension', 'node_modules', '.bin', 'playwriter'),
        path.join('/tmp', 'relay', 'node_modules', 'hono'),
      ]),
    ).toEqual([path.join('/tmp', 'relay', 'node_modules', 'hono')]);
  });

  test('removes nested .bin directories recursively', () => {
    const nodeModulesDir = path.join(makeTempDir(), 'node_modules');
    const rootBinDir = path.join(nodeModulesDir, '.bin');
    const nestedBinDir = path.join(nodeModulesDir, 'mcp-extension', 'node_modules', '.bin');

    mkdirSync(rootBinDir, { recursive: true });
    mkdirSync(nestedBinDir, { recursive: true });

    removeNamedDirsRecursively(nodeModulesDir, '.bin');

    expect(() => assertNodeModulesLayout(nodeModulesDir)).not.toThrow();
    expect(existsSync(rootBinDir)).toBeFalse();
    expect(existsSync(nestedBinDir)).toBeFalse();
  });
});

describe('pruneRelayDistArtifacts', () => {
  test('removes validated dev-only relay artifacts and keeps runtime files', () => {
    const distDir = path.join(makeTempDir(), 'dist');

    for (const relativePath of [
      'start-relay-server.js',
      'prompt.md',
      'skill.md',
      'relay-core.test.js',
      'relay-client.d.ts',
      'start-relay-server.js.map',
      'debugger-api.md',
      'extension/background.js',
      'extension/background.js.map',
    ]) {
      writeFile(path.join(distDir, relativePath));
    }

    pruneRelayDistArtifacts(distDir);

    expect(existsSync(path.join(distDir, 'start-relay-server.js'))).toBeTrue();
    expect(existsSync(path.join(distDir, 'prompt.md'))).toBeTrue();
    expect(existsSync(path.join(distDir, 'skill.md'))).toBeTrue();
    expect(existsSync(path.join(distDir, 'relay-core.test.js'))).toBeFalse();
    expect(existsSync(path.join(distDir, 'relay-client.d.ts'))).toBeFalse();
    expect(existsSync(path.join(distDir, 'start-relay-server.js.map'))).toBeFalse();
    expect(existsSync(path.join(distDir, 'debugger-api.md'))).toBeTrue();
    expect(existsSync(path.join(distDir, 'extension/background.js'))).toBeTrue();
    expect(existsSync(path.join(distDir, 'extension/background.js.map'))).toBeFalse();
  });
});
