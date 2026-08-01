import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
  buildInterpreterCliServerConnection,
  ensureInterpreterCliLauncher,
  INTERPRETER_CALLER_TOKEN_ENV,
  INTERPRETER_CLI_SERVER_CONNECTION_ENV,
} from '../server/utils/interpreterCliRuntime';

const execFile = promisify(execFileCallback);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SYSTEM_APPLICATIONS_DIR = path.join(path.sep, 'Applications');
const DEFAULT_APP_PATHS = [
  path.join(SYSTEM_APPLICATIONS_DIR, 'Interpreter.app'),
  path.join(homedir(), 'Applications', 'Interpreter.app'),
];

type Args = {
  app?: string;
  timeoutMs: number;
  yes: boolean;
};

type ToolContent = {
  type?: string;
  text?: string;
};

type ToolResponse = {
  content?: ToolContent[];
  isError?: boolean;
};

type ToolContext = {
  cliPath: string;
  env: NodeJS.ProcessEnv;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { timeoutMs: DEFAULT_TIMEOUT_MS, yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--yes' || arg === '-y') {
      args.yes = true;
      continue;
    }
    if (arg === '--app') {
      const value = argv[index + 1];
      if (!value) throw new Error('--app requires an Interpreter.app path');
      args.app = path.resolve(value);
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
  console.log(`Usage: pnpm run test:mac-installed-desktop-permissions -- [--yes] [--app <Interpreter.app>] [--timeout-ms <ms>]

Resets macOS TCC grants for the installed Interpreter.app, launches the real
Electron app, calls builtin-cua-driver through the installed app's interpreter-app
bridge, waits for the native permission flow to complete, verifies the grant,
and quits the app.

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

function resolveInstalledApp(args: Args): string {
  if (args.app) {
    if (!existsSync(args.app)) throw new Error(`Interpreter.app not found: ${args.app}`);
    return args.app;
  }

  const appPath = DEFAULT_APP_PATHS.find((candidate) => existsSync(candidate));
  if (!appPath) {
    throw new Error(
      `Unable to find installed Interpreter.app. Checked: ${DEFAULT_APP_PATHS.join(', ')}. Pass --app.`,
    );
  }
  return appPath;
}

function executableForApp(appPath: string): string {
  return path.join(appPath, 'Contents', 'MacOS', 'Interpreter');
}

function bundledDesktopHelperForApp(appPath: string): string {
  return path.join(appPath, 'Contents', 'Resources', 'cua-driver', 'cua-driver');
}

async function readBundleIdentifier(appPath: string): Promise<string> {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const { stdout } = await execFile('/usr/bin/plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    infoPlistPath,
  ]);
  const bundleId = stdout.trim();
  if (!bundleId) throw new Error(`No CFBundleIdentifier in ${infoPlistPath}`);
  return bundleId;
}

async function readBundleIdentifierIfPresent(bundlePath: string): Promise<string | null> {
  const infoPlistPath = path.join(bundlePath, 'Contents', 'Info.plist');
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

async function collectTccBundleIdentifiers(appPath: string): Promise<string[]> {
  const candidates = [
    appPath,
    path.join(appPath, 'Contents', 'Frameworks', 'Interpreter Helper.app'),
    path.join(appPath, 'Contents', 'Frameworks', 'Interpreter Helper (Renderer).app'),
    path.join(appPath, 'Contents', 'Frameworks', 'Interpreter Helper (GPU).app'),
    path.join(appPath, 'Contents', 'Frameworks', 'Interpreter Helper (Plugin).app'),
  ];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const bundleId = await readBundleIdentifierIfPresent(candidate);
    if (bundleId) ids.add(bundleId);
  }
  return [...ids];
}

async function registerBundle(appPath: string): Promise<void> {
  await execFile(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', appPath],
  );
}

async function resetTcc(bundleId: string): Promise<void> {
  console.log(`[mac-installed-desktop-permissions] tccutil reset All ${bundleId}`);
  await execFile('tccutil', ['reset', 'All', bundleId]);
  for (const service of ['Accessibility', 'ScreenCapture']) {
    console.log(`[mac-installed-desktop-permissions] tccutil reset ${service} ${bundleId}`);
    await execFile('tccutil', ['reset', service, bundleId]);
  }
}

async function resetTccForBundleIdentifiers(bundleIds: string[]): Promise<void> {
  for (const bundleId of bundleIds) {
    await resetTcc(bundleId);
  }
}

async function stopDesktopHelper(binary: string): Promise<void> {
  if (!existsSync(binary)) return;
  await new Promise<void>((resolve) => {
    const child = spawn(binary, ['stop'], { stdio: 'ignore' });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
    setTimeout(() => {
      child.kill('SIGTERM');
      resolve();
    }, 5_000);
  });
}

async function quitInterpreterApp(): Promise<void> {
  await execFile('/usr/bin/osascript', ['-e', 'tell application "Interpreter" to quit'])
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

async function killAppProcesses(appPath: string): Promise<void> {
  const executablePath = executableForApp(appPath);
  await execFile('/usr/bin/pkill', ['-f', executablePath]).catch(() => undefined);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { stdout } = await execFile('/usr/bin/pgrep', ['-f', executablePath]).catch(() => ({ stdout: '' }));
    if (!stdout.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for existing Interpreter process to exit: ${executablePath}`);
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function showInstruction(message: string): Promise<void> {
  await execFile('/usr/bin/osascript', [
    '-e',
    `display dialog ${appleScriptString(message)} with title "Interpreter Desktop Access Test" buttons {"OK"} default button "OK"`,
  ]);
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

async function waitForAppServerByPolling(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let port = 5177; port <= 5186; port += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/server/info`, {
          signal: AbortSignal.timeout(750),
        });
        if (response.ok) return port;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for installed Interpreter app server after ${timeoutMs}ms.`);
}

async function launchInstalledApp(
  appPath: string,
  timeoutMs: number,
): Promise<{ child: ChildProcessWithoutNullStreams | null; port: number }> {
  console.log('[mac-installed-desktop-permissions] Launching installed Interpreter.app.');
  await execFile('/usr/bin/open', ['-n', appPath], {
    env: {
      ...process.env,
      INTERPRETER_DESKTOP_PERMISSION_TEST_STATUS: '',
      INTERPRETER_DESKTOP_PERMISSION_TEST_SEQUENCE: '',
    },
  });
  const port = await waitForAppServerByPolling(timeoutMs);
  console.log(`[mac-installed-desktop-permissions] app server ready on ${port}`);
  return { child: null, port };
}

async function stopInstalledApp(
  child: ChildProcessWithoutNullStreams | null,
  helperPath: string,
): Promise<void> {
  if (child && !child.killed) child.kill('SIGTERM');
  await quitInterpreterApp();
  await stopDesktopHelper(helperPath);
}

async function registerCliCaller(port: number): Promise<ToolContext> {
  const callerToken = `agtok_mac_installed_permissions_${process.pid}_${Date.now()}`;
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc/agentTabs/registerThread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      agentId: 'mac-installed-desktop-permissions-smoke',
      threadId: `mac-installed-desktop-permissions-smoke-${Date.now()}`,
      callerToken,
      workspacePath: process.cwd(),
    }]),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(`Failed to register installed app CLI caller: HTTP ${response.status} ${JSON.stringify(payload)}`);
  }

  return {
    cliPath: ensureInterpreterCliLauncher('darwin'),
    env: {
      ...process.env,
      [INTERPRETER_CALLER_TOKEN_ENV]: callerToken,
      [INTERPRETER_CLI_SERVER_CONNECTION_ENV]: buildInterpreterCliServerConnection(port, {
        platform: 'darwin',
        transport: 'http',
      }),
    },
  };
}

async function callPermissionsTool(context: ToolContext, prompt: boolean, timeoutMs: number): Promise<ToolResponse> {
  console.log(`[mac-installed-desktop-permissions] interpreter-app tools builtin-cua-driver check_permissions --json '{"prompt":${prompt}}'`);
  const { stdout, stderr } = await execFile(context.cliPath, [
    'tools',
    'builtin-cua-driver',
    'check_permissions',
    '--json',
    JSON.stringify({ prompt }),
  ], {
    cwd: process.cwd(),
    env: context.env,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8,
  });
  const payload = JSON.parse(stdout) as ToolResponse;
  if (payload.isError) {
    throw new Error(`check_permissions returned isError=true:\n${stdout}\n${stderr}`);
  }
  return payload;
}

function isExpectedPermissionRestartError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('curl: (18) transfer closed with outstanding read data remaining')
    || message.includes('socket hang up')
    || message.includes('ECONNRESET')
    || message.includes('ECONNREFUSED')
  );
}

function textFromToolResponse(response: ToolResponse): string {
  return response.content
    ?.map((item) => item.text ?? '')
    .filter(Boolean)
    .join('\n') ?? '';
}

function assertPermissionsGranted(response: ToolResponse): void {
  const text = textFromToolResponse(response);
  if (
    response.isError
    || !/Accessibility:\s+granted/i.test(text)
    || !/Screen Recording:\s+granted/i.test(text)
  ) {
    throw new Error(`Permission verification failed through installed app tool path.\n${text}`);
  }
}

function assertPermissionsDenied(response: ToolResponse): void {
  const text = textFromToolResponse(response);
  if (
    response.isError
    || /Accessibility:\s+granted/i.test(text)
    || /Screen Recording:\s+granted/i.test(text)
  ) {
    throw new Error(
      'TCC reset did not produce a fresh-install permission state. '
      + 'The smoke test would not be testing first-run setup.\n'
      + text,
    );
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Installed Electron desktop permission smoke must run on macOS.');
  }

  const args = parseArgs(process.argv.slice(2));
  const appPath = resolveInstalledApp(args);
  const executablePath = executableForApp(appPath);
  const helperPath = bundledDesktopHelperForApp(appPath);
  if (!existsSync(executablePath)) throw new Error(`Interpreter executable not found: ${executablePath}`);
  if (!existsSync(helperPath)) throw new Error(`Bundled native desktop helper not found: ${helperPath}`);

  await registerBundle(appPath);
  const bundleId = await readBundleIdentifier(appPath);
  const tccBundleIds = await collectTccBundleIdentifiers(appPath);

  console.log(`[mac-installed-desktop-permissions] app: ${appPath}`);
  console.log(`[mac-installed-desktop-permissions] bundleId: ${bundleId}`);
  console.log(`[mac-installed-desktop-permissions] TCC bundleIds: ${tccBundleIds.join(', ')}`);
  console.log(`[mac-installed-desktop-permissions] helper: ${helperPath}`);
  if (!args.yes) {
    const ok = await confirm(
      'This will quit/relaunch Interpreter and reset local macOS Accessibility and Screen Recording grants for the installed app. Continue?',
    );
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  await quitInterpreterApp();
  await killAppProcesses(appPath);
  await stopDesktopHelper(helperPath);
  await resetTccForBundleIdentifiers(tccBundleIds);

  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    const firstLaunch = await launchInstalledApp(appPath, args.timeoutMs);
    child = firstLaunch.child;

    const resetCheckContext = await registerCliCaller(firstLaunch.port);
    const resetCheck = await callPermissionsTool(resetCheckContext, false, 30_000);
    assertPermissionsDenied(resetCheck);

    await showInstruction(
      'Interpreter is about to request desktop access through the installed app. '
      + 'After you click OK, grant Accessibility and Screen Recording when macOS asks. '
      + 'The test will wait until Interpreter can actually use both permissions.',
    );

    console.log('[mac-installed-desktop-permissions] Calling builtin-cua-driver through installed app interpreter-app bridge.');
    const firstToolContext = await registerCliCaller(firstLaunch.port);
    try {
      await callPermissionsTool(firstToolContext, true, args.timeoutMs);
    } catch (error) {
      if (!isExpectedPermissionRestartError(error)) {
        throw error;
      }
      console.log(
        '[mac-installed-desktop-permissions] permission prompt disconnected during macOS restart; '
        + 'continuing with relaunch verification.',
      );
    }

    await showInstruction(
      'The first permission pass completed. The test will now restart Interpreter, '
      + 'then verify the grants still work after relaunch.',
    );

    await stopInstalledApp(child, helperPath);
    child = null;

    const secondLaunch = await launchInstalledApp(appPath, args.timeoutMs);
    child = secondLaunch.child;

    const secondToolContext = await registerCliCaller(secondLaunch.port);
    const verification = await callPermissionsTool(secondToolContext, false, 30_000);
    assertPermissionsGranted(verification);
    console.log('[mac-installed-desktop-permissions] verified through installed Interpreter app after restart.');
  } finally {
    await stopInstalledApp(child, helperPath);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mac-installed-desktop-permissions] failed: ${message}`);
  process.exit(1);
});
