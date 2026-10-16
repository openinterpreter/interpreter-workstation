import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  resolveElectronRunAsNodeBinary,
  usesElectronRunAsNode,
} from './bundledRuntimePaths';

export type BundledPnpmCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell: false;
};

/**
 * Resolve the pnpm CLI from Workstation's own production dependency graph.
 * Interface projects must never depend on a user-installed Node or package
 * manager. Electron supplies Node and Workstation supplies pnpm on every OS.
 */
export function resolveBundledPnpmCli(
  resolver: NodeRequire = createRequire(path.join(__dirname, '..', '..', 'package.json')),
): string {
  const manifestPath = resolver.resolve('pnpm');
  const manifest = resolver(manifestPath) as { bin?: { pnpm?: string } };
  if (typeof manifest.bin?.pnpm !== 'string') {
    throw new Error('Workstation\'s bundled pnpm package does not expose its CLI.');
  }
  return path.join(path.dirname(manifestPath), manifest.bin.pnpm);
}

export function getBundledPnpmCommand(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    runtimeBinary?: string;
    pnpmCli?: string;
  } = {},
): BundledPnpmCommand {
  const command = options.runtimeBinary ?? resolveElectronRunAsNodeBinary();
  const pnpmCli = options.pnpmCli ?? resolveBundledPnpmCli();
  const env = { ...process.env, ...options.env };
  if (usesElectronRunAsNode(command)) env.ELECTRON_RUN_AS_NODE = '1';
  return { command, args: [pnpmCli, ...args], env, shell: false };
}

export function spawnBundledPnpm(
  args: string[],
  options: Omit<SpawnOptions, 'env' | 'shell'> & { env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const command = getBundledPnpmCommand(args, { env: options.env });
  return spawn(command.command, command.args, {
    ...options,
    env: command.env,
    shell: false,
  });
}
