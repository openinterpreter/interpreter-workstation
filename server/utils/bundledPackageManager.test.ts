import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { getBundledPnpmCommand, resolveBundledPnpmCli } from './bundledPackageManager';

describe('bundled project package manager', () => {
  test('resolves pnpm from Workstation instead of PATH', () => {
    const cli = resolveBundledPnpmCli();
    expect(path.basename(cli)).toBe('pnpm.cjs');
    expect(cli).toContain(`${path.sep}node_modules${path.sep}`);
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
  });
});
