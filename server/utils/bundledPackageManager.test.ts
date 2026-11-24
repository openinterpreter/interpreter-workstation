import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { getBundledPnpmCommand, resolveBundledPnpmCli } from './bundledPackageManager';

describe('bundled project package manager', () => {
  test('resolves pnpm from Workstation instead of PATH', () => {
    const cli = resolveBundledPnpmCli();
    expect(path.basename(cli)).toBe('pnpm.cjs');
    expect(cli).toContain(`${path.sep}node_modules${path.sep}`);
  });

  test('resolves bundled pnpm under standalone Node ESM', () => {
    const result = spawnSync('node', [
      '--import', 'tsx', '--input-type=module', '-e',
      'const { resolveBundledPnpmCli } = await import("./server/utils/bundledPackageManager.ts"); console.log(resolveBundledPnpmCli())',
    ], {
      cwd: path.resolve(import.meta.dir, '..', '..'),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(path.basename(result.stdout.trim())).toBe('pnpm.cjs');
  });

  test('runs the supplied CLI with the supplied Node-compatible runtime', () => {
    const command = getBundledPnpmCommand(['install'], {
      runtimeBinary: '/Applications/Interpreter.app/Contents/MacOS/Interpreter',
      pnpmCli: '/runtime/pnpm/bin/pnpm.cjs',
      env: { TEST_RUNTIME: '1' },
    });
    expect(command).toMatchObject({
      command: '/Applications/Interpreter.app/Contents/MacOS/Interpreter',
      args: ['/runtime/pnpm/bin/pnpm.cjs', 'install'],
      shell: false,
    });
    expect(command.env.TEST_RUNTIME).toBe('1');
    expect(command.env.npm_config_manage_package_manager_versions).toBe('false');
  });
});
