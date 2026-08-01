import { spawn, execFile as execFileCallback, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const CUA_DRIVER_BUNDLE_ID = 'com.trycua.driver';
const INTERPRETER_BUNDLE_IDS = [
  'com.openinterpreter.interpreter',
  'com.interpreter.dev',
  'com.openinterpreter.interpreter.dev',
  'com.openinterpreter.interpreter-internal.dev',
];
const SYSTEM_APPLICATIONS_DIR = path.join(path.sep, 'Applications');

type Args = {
  binary?: string;
  timeoutMs: number;
  yes: boolean;
};

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { timeoutMs: DEFAULT_TIMEOUT_MS, yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      args.yes = true;
      continue;
    }
    if (arg === '--binary') {
      const value = argv[index + 1];
      if (!value) throw new Error('--binary requires a path');
      args.binary = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--timeout-ms requires a positive number');
      }
      args.timeoutMs = value;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: pnpm run test:mac-desktop-permissions -- [--yes] [--binary <path>] [--timeout-ms <ms>]

Resets macOS TCC grants for Interpreter and the native desktop helper, launches
the real desktop-control daemon, waits for the native permission panel to be granted,
verifies check_permissions through the daemon, then stops the daemon.

This intentionally changes local macOS privacy settings. It is manual smoke
coverage for first-install/restart behavior, not a default CI test.`);
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

function firstExistingPath(candidates: string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveCuaDriverBinary(args: Args): string {
  if (args.binary) {
    if (!existsSync(args.binary)) throw new Error(`native desktop helper binary not found: ${args.binary}`);
    return args.binary;
  }

  const envPath = process.env.CUA_DRIVER_PATH?.trim();
  const candidates = [
    ...(envPath ? [envPath] : []),
    path.join(process.cwd(), 'dist-electron', 'cua-driver', 'cua-driver'),
    path.join(SYSTEM_APPLICATIONS_DIR, 'Interpreter.app', 'Contents', 'Resources', 'cua-driver', 'cua-driver'),
    path.join(homedir(), 'Applications', 'Interpreter.app', 'Contents', 'Resources', 'cua-driver', 'cua-driver'),
    path.join(SYSTEM_APPLICATIONS_DIR, 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver'),
    path.join(homedir(), 'Applications', 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver'),
  ];
  const binary = firstExistingPath(candidates);
  if (!binary) {
    throw new Error(
      `Unable to find native desktop helper binary. Checked: ${candidates.join(', ')}. `
      + 'Run `pnpm run build:electron`, install Interpreter, or pass --binary.',
    );
  }
  return binary;
}

async function run(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function stopDaemon(binary: string): Promise<void> {
  const result = await run(binary, ['stop'], { timeoutMs: 5_000 }).catch((error) => ({
    code: 1,
    signal: null,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  }));
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 && !text.includes('daemon is not running')) {
    console.warn(`[mac-desktop-permissions] warning: failed to stop existing daemon: ${text.trim()}`);
  }
}

async function readBundleIdentifier(appPath: string): Promise<string | null> {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(infoPlistPath)) return null;
  try {
    const { stdout } = await execFile('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      infoPlistPath,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function appBundleAncestors(filePath: string): string[] {
  const apps: string[] = [];
  let current = path.resolve(filePath);
  while (true) {
    if (path.basename(current).endsWith('.app')) apps.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return apps;
}

async function registerBundle(appPath: string): Promise<void> {
  if (!existsSync(appPath)) return;
  await execFile(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', appPath],
  ).catch(() => undefined);
}

async function resetTcc(bundleIds: string[]): Promise<void> {
  const services = ['Accessibility', 'ScreenCapture'];
  for (const bundleId of bundleIds) {
    for (const service of services) {
      console.log(`[mac-desktop-permissions] tccutil reset ${service} ${bundleId}`);
      await execFile('tccutil', ['reset', service, bundleId]).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[mac-desktop-permissions] warning: reset failed for ${service} ${bundleId}: ${message}`);
      });
    }
  }
}

async function bundleIdsForReset(binary: string): Promise<string[]> {
  const ids = new Set<string>([CUA_DRIVER_BUNDLE_ID, ...INTERPRETER_BUNDLE_IDS]);
  for (const appPath of [
    ...appBundleAncestors(binary),
    path.join(SYSTEM_APPLICATIONS_DIR, 'Interpreter.app'),
    path.join(homedir(), 'Applications', 'Interpreter.app'),
    path.join(SYSTEM_APPLICATIONS_DIR, 'CuaDriver.app'),
    path.join(homedir(), 'Applications', 'CuaDriver.app'),
  ]) {
    await registerBundle(appPath);
    const bundleId = await readBundleIdentifier(appPath);
    if (bundleId) ids.add(bundleId);
  }
  return [...ids].sort();
}

function streamProcess(child: ChildProcessWithoutNullStreams): { output: () => string } {
  let output = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });
  return { output: () => output };
}

function waitForServe(child: ChildProcessWithoutNullStreams, output: () => string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const interval = setInterval(() => {
      const text = output();
      if (
        text.includes('daemon listening on')
        || text.includes('daemon is already running')
      ) {
        finish();
      }
    }, 250);
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for the native desktop helper daemon after ${timeoutMs}ms.\n${output().trim()}`));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      const text = output();
      if (
        text.includes('daemon listening on')
        || text.includes('daemon is already running')
      ) {
        finish();
        return;
      }
      finish(new Error(`Native desktop helper serve exited before permissions were granted (code=${code}, signal=${signal ?? 'none'}).\n${text.trim()}`));
    });
    child.on('error', (error) => finish(error));
  });
}

function parsePermissionCheck(stdout: string): { accessibility: boolean; screenRecording: boolean } {
  // The Rust driver emits the check_permissions structured JSON payload.
  const parsed = JSON.parse(stdout) as { accessibility?: unknown; screen_recording?: unknown };
  return {
    accessibility: parsed.accessibility === true,
    screenRecording: parsed.screen_recording === true,
  };
}

async function verifyPermissions(binary: string): Promise<void> {
  const result = await run(binary, ['call', 'check_permissions', JSON.stringify({ prompt: false })], {
    timeoutMs: 15_000,
  });
  const text = `${result.stdout}\n${result.stderr}`;
  const status = parsePermissionCheck(text);
  if (result.code !== 0 || !status.accessibility || !status.screenRecording) {
    throw new Error(`Permission verification failed.\n${text.trim()}`);
  }
  console.log('[mac-desktop-permissions] verified Accessibility + Screen Recording are granted.');
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('macOS desktop permission flow smoke must run on macOS.');
  }

  const args = parseArgs(process.argv.slice(2));
  const binary = resolveCuaDriverBinary(args);
  const bundleIds = await bundleIdsForReset(binary);

  console.log(`[mac-desktop-permissions] binary: ${binary}`);
  console.log(`[mac-desktop-permissions] resetting TCC for: ${bundleIds.join(', ')}`);
  if (!args.yes) {
    const ok = await confirm(
      'This will reset local macOS Accessibility and Screen Recording grants for Interpreter and the native helper. Continue?',
    );
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  await stopDaemon(binary);
  await resetTcc(bundleIds);

  console.log('');
  console.log('[mac-desktop-permissions] Launching the native desktop helper daemon.');
  console.log('[mac-desktop-permissions] Grant both permissions in the native Interpreter permission window.');
  console.log('');

  const child = spawn(binary, ['serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      INTERPRETER_DESKTOP_PERMISSION_TEST_STATUS: '',
      INTERPRETER_DESKTOP_PERMISSION_TEST_SEQUENCE: '',
    },
  });
  const stream = streamProcess(child);

  try {
    await waitForServe(child, stream.output, args.timeoutMs);
    await verifyPermissions(binary);
  } finally {
    await stopDaemon(binary);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mac-desktop-permissions] failed: ${message}`);
  process.exit(1);
});
