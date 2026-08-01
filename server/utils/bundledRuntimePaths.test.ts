import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  resolveBundledResourceCandidates,
  resolveElectronRunAsNodeBinary,
  resolveElectronRunAsNodeSandboxReadableRoots,
  usesElectronRunAsNode,
} from './bundledRuntimePaths';

describe('bundledRuntimePaths', () => {
  test('prefers INTERPRETER_NODE_BIN when it exists', () => {
    expect(resolveElectronRunAsNodeBinary({
      envNode: '/tmp/node-from-env',
      pathExists: (candidatePath) => candidatePath === '/tmp/node-from-env',
      findNodeOnPath: () => '/tmp/node-from-path',
      processExecPath: '/tmp/bun',
      processVersions: {} as NodeJS.ProcessVersions,
    })).toBe('/tmp/node-from-env');
  });

  test('reuses the current executable when running inside Electron', () => {
    expect(resolveElectronRunAsNodeBinary({
      processExecPath: '/tmp/Interpreter',
      processVersions: { electron: '37.0.0' } as NodeJS.ProcessVersions,
      pathExists: (candidatePath) => candidatePath === '/tmp/Interpreter',
      findNodeOnPath: () => null,
    })).toBe('/tmp/Interpreter');
  });

  test('falls back to node on PATH for standalone runtimes like bun', () => {
    expect(resolveElectronRunAsNodeBinary({
      processExecPath: '/tmp/bun',
      processVersions: {} as NodeJS.ProcessVersions,
      pathExists: (candidatePath) => candidatePath === '/tmp/bun' || candidatePath === '/tmp/node',
      findNodeOnPath: () => '/tmp/node',
    })).toBe('/tmp/node');
  });

  test('resolves node by scanning PATH when shell lookup is unavailable', () => {
    expect(resolveElectronRunAsNodeBinary({
      processExecPath: '/tmp/bun',
      processVersions: {} as NodeJS.ProcessVersions,
      pathEnv: ['/missing/bin', '/opt/node/bin'].join(':'),
      platform: 'darwin',
      pathExists: (candidatePath) => candidatePath === '/tmp/bun'
        || candidatePath === '/opt/node/bin/node',
    })).toBe('/opt/node/bin/node');
  });

  test('resolves node.exe by scanning Windows PATH entries', () => {
    expect(resolveElectronRunAsNodeBinary({
      processExecPath: 'C:\\Tools\\bun.exe',
      processVersions: {} as NodeJS.ProcessVersions,
      pathEnv: ['C:\\Missing', 'C:\\Node'].join(';'),
      pathExtEnv: '.COM;.EXE;.BAT;.CMD',
      platform: 'win32',
      pathExists: (candidatePath) => candidatePath === 'C:\\Tools\\bun.exe'
        || candidatePath === 'C:\\Node\\node.exe',
    })).toBe('C:\\Node\\node.exe');
  });

  test('ignores Windows node script shims when scanning PATH for execFile-safe node', () => {
    expect(resolveElectronRunAsNodeBinary({
      processExecPath: 'C:\\Tools\\bun.exe',
      processVersions: {} as NodeJS.ProcessVersions,
      pathEnv: ['C:\\Node'].join(';'),
      pathExtEnv: '.CMD;.EXE',
      platform: 'win32',
      pathExists: (candidatePath) => candidatePath === 'C:\\Tools\\bun.exe'
        || candidatePath === 'C:\\Node\\node.cmd'
        || candidatePath === 'C:\\Node\\node.exe',
    })).toBe('C:\\Node\\node.exe');
  });

  test('only enables ELECTRON_RUN_AS_NODE for the Electron executable', () => {
    expect(usesElectronRunAsNode('/tmp/Interpreter', {
      processExecPath: '/tmp/Interpreter',
      processVersions: { electron: '37.0.0' } as NodeJS.ProcessVersions,
    })).toBe(true);

    expect(usesElectronRunAsNode('/tmp/node', {
      processExecPath: '/tmp/bun',
      processVersions: {} as NodeJS.ProcessVersions,
    })).toBe(false);
  });

  test('resolves macOS Electron app contents root for dev Electron-as-Node', () => {
    expect(resolveElectronRunAsNodeSandboxReadableRoots(
      '/repo/node_modules/.pnpm/electron@39.8.9/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      { platform: 'darwin' },
    )).toEqual([
      '/repo/node_modules/.pnpm/electron@39.8.9/node_modules/electron/dist/Electron.app/Contents',
    ]);
  });

  test('resolves macOS Electron app contents root for packaged app Electron-as-Node', () => {
    expect(resolveElectronRunAsNodeSandboxReadableRoots(
      '/Applications/Interpreter.app/Contents/MacOS/Interpreter',
      { platform: 'darwin' },
    )).toEqual([
      '/Applications/Interpreter.app/Contents',
    ]);
  });

  test('does not add Electron app contents roots on non-macOS platforms', () => {
    expect(resolveElectronRunAsNodeSandboxReadableRoots(
      '/Applications/Interpreter.app/Contents/MacOS/Interpreter',
      { platform: 'linux' },
    )).toEqual([]);
  });

  test('does not resolve source resources inside packaged app.asar archives', () => {
    const originalArgvScript = process.argv[1];
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const resourcesRoot = path.resolve(path.sep, 'opt', 'Interpreter', 'resources');

    try {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        writable: true,
        value: resourcesRoot,
      });
      process.argv[1] = path.join(resourcesRoot, 'app.asar', 'dist-electron', 'electron', 'main.cjs');

      const candidates = resolveBundledResourceCandidates({
        packagedSegments: ['interpreter-app-server'],
        sourceSegments: ['oix', 'linux-x64', 'interpreter-app-server'],
      });

      expect(candidates).toContain(path.join(resourcesRoot, 'interpreter-app-server'));
      expect(candidates).not.toContain(
        path.join(resourcesRoot, 'app.asar', 'resources', 'oix', 'linux-x64', 'interpreter-app-server'),
      );
    } finally {
      process.argv[1] = originalArgvScript;
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        writable: true,
        value: originalResourcesPath,
      });
    }
  });

  test('keeps source resource candidates for development app roots', () => {
    const originalArgvScript = process.argv[1];
    const appRoot = path.resolve(path.sep, 'repo', 'app');

    try {
      process.argv[1] = path.join(appRoot, 'dist-electron', 'electron', 'main.cjs');

      const candidates = resolveBundledResourceCandidates({
        packagedSegments: ['interpreter-app-server'],
        sourceSegments: ['oix', 'linux-x64', 'interpreter-app-server'],
      });

      expect(candidates).toContain(path.join(appRoot, 'resources', 'oix', 'linux-x64', 'interpreter-app-server'));
    } finally {
      process.argv[1] = originalArgvScript;
    }
  });

  test('does not resolve cwd source resources inside packaged app.asar archives', () => {
    const originalCwd = process.cwd();
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'interpreter-app-asar-cwd-'));
    const appAsarCwd = path.join(tempRoot, 'resources', 'app.asar');
    mkdirSync(appAsarCwd, { recursive: true });

    try {
      process.chdir(appAsarCwd);

      const candidates = resolveBundledResourceCandidates({
        packagedSegments: ['interpreter-app-server'],
        sourceSegments: ['oix', 'linux-x64', 'interpreter-app-server'],
      });

      expect(candidates.some(
        (candidate) => candidate.includes(`${path.sep}app.asar${path.sep}resources${path.sep}oix${path.sep}`),
      )).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
