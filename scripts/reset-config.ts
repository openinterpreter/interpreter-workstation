/**
 * Reset config to simulate onboarding, but preserve MCP servers.
 * Also deletes any default workspace folders (My Workspace, My Workspace (1), etc.)
 *
 * Usage:
 *   pnpm reset-config          Soft reset: preserves MCPs, resets config to defaults
 *   pnpm reset-config --hard   Hard reset: deletes the legacy + app user data folders (clean install)
 */

import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  resolveInterpreterConfigFile,
  resolveInterpreterDataDir,
  resolveLegacyInterpreterConfigDir,
  resolveLegacyInterpreterConfigFile,
} from '../shared/interpreterConfigPaths';

const LEGACY_CONFIG_DIR = resolveLegacyInterpreterConfigDir();
const USER_DATA_DIR = resolveInterpreterDataDir();
const CONFIG_FILE = resolveInterpreterConfigFile();
const LEGACY_CONFIG_FILE = resolveLegacyInterpreterConfigFile();
const DOCUMENTS_DIR = join(homedir(), 'Documents');
const DEFAULT_WORKSPACE_BASE = 'My Workspace';

const isHardReset = process.argv.includes('--hard');
const execFile = promisify(execFileCallback);
const HARD_RESET_DELETE_RETRY_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);
const HARD_RESET_DELETE_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 3000];

// Import builtin definitions
import { BUILTIN_PROVIDERS } from '../shared/types/provider';
import { BUILTIN_PROFILES } from '../shared/types/profile';

export type RunningProcess = {
  pid: number;
  command: string;
};

type ProductConfig = {
  darwinBundleIdentifier?: unknown;
};

export function isDirectScriptExecution(importMetaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) {
    return false;
  }

  return fileURLToPath(importMetaUrl) === resolve(argvEntry);
}

/**
 * Prompt the user for confirmation
 */
async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeProcessMatchValue(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return value.toLowerCase().replaceAll('/', '\\');
  }
  return value;
}

export function findProcessesUsingPaths(
  processListing: string,
  targetPaths: string[],
  platform: NodeJS.Platform = process.platform,
): RunningProcess[] {
  const matchValues = targetPaths
    .filter(Boolean)
    .map((value) => normalizeProcessMatchValue(value, platform));
  const matches: RunningProcess[] = [];

  for (const line of processListing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!parsed) {
      continue;
    }

    const pid = Number(parsed[1]);
    const command = parsed[2];
    const normalizedCommand = normalizeProcessMatchValue(command, platform);

    if (matchValues.some((value) => normalizedCommand.includes(value))) {
      matches.push({ pid, command });
    }
  }

  return matches;
}

function filterCurrentProcessTree(processes: RunningProcess[]): RunningProcess[] {
  return processes.filter((entry) => entry.pid !== process.pid && entry.pid !== process.ppid);
}

async function listPosixProcessesUsingPaths(targetPaths: string[]): Promise<RunningProcess[]> {
  const { stdout } = await execFile('ps', ['-axo', 'pid=,command=']);
  return findProcessesUsingPaths(stdout, targetPaths, process.platform);
}

type WindowsProcessRecord = {
  ProcessId?: number | string | null;
  CommandLine?: string | null;
};

function filterWindowsProcessesUsingPaths(
  records: WindowsProcessRecord[],
  targetPaths: string[],
): RunningProcess[] {
  const matchValues = targetPaths
    .filter(Boolean)
    .map((value) => normalizeProcessMatchValue(value, 'win32'));

  return records
    .map((record) => {
      const pid = Number(record.ProcessId);
      const command = typeof record.CommandLine === 'string' ? record.CommandLine : '';
      return Number.isFinite(pid) && command
        ? { pid, command }
        : null;
    })
    .filter((entry): entry is RunningProcess => Boolean(entry))
    .filter((entry) => matchValues.some((value) => normalizeProcessMatchValue(entry.command, 'win32').includes(value)));
}

async function listWindowsProcessesUsingPaths(targetPaths: string[]): Promise<RunningProcess[]> {
  const { stdout } = await execFile('powershell', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
  ]);
  const parsed = JSON.parse(stdout.trim() || '[]') as WindowsProcessRecord | WindowsProcessRecord[];
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return filterWindowsProcessesUsingPaths(records, targetPaths);
}

async function listProcessesUsingPaths(targetPaths: string[]): Promise<RunningProcess[]> {
  if (process.platform === 'win32') {
    return filterCurrentProcessTree(await listWindowsProcessesUsingPaths(targetPaths));
  }
  return filterCurrentProcessTree(await listPosixProcessesUsingPaths(targetPaths));
}

async function terminateProcesses(processes: RunningProcess[]): Promise<void> {
  if (processes.length === 0) {
    return;
  }

  if (process.platform === 'win32') {
    for (const entry of processes) {
      try {
        await execFile('taskkill', ['/PID', String(entry.pid), '/T', '/F']);
      } catch {
        // Ignore per-process failures and rely on the later delete retry.
      }
    }
    await sleep(750);
    return;
  }

  for (const entry of processes) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // Process may have exited between listing and termination.
    }
  }

  await sleep(1000);

  for (const entry of processes) {
    try {
      process.kill(entry.pid, 0);
      process.kill(entry.pid, 'SIGKILL');
    } catch {
      // Already gone or inaccessible.
    }
  }

  await sleep(250);
}

async function stopRunningInterpreterProcesses(targetPaths: string[]): Promise<void> {
  const processes = await listProcessesUsingPaths(targetPaths);
  if (processes.length === 0) {
    return;
  }

  console.log(
    `Stopping ${processes.length} running Interpreter process(es) using reset state...`,
  );
  await terminateProcesses(processes);
}

function shouldRetryDelete(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  return HARD_RESET_DELETE_RETRY_CODES.has(code);
}

export async function deletePathWithRetries(
  targetPath: string,
  options: {
    rmImpl?: typeof rm;
    sleepImpl?: typeof sleep;
    retryDelaysMs?: number[];
  } = {},
): Promise<void> {
  const rmImpl = options.rmImpl ?? rm;
  const sleepImpl = options.sleepImpl ?? sleep;
  const retryDelaysMs = options.retryDelaysMs ?? HARD_RESET_DELETE_RETRY_DELAYS_MS;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rmImpl(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!shouldRetryDelete(error) || attempt >= retryDelaysMs.length) {
        throw error;
      }
      await sleepImpl(retryDelaysMs[attempt]);
    }
  }
}

/**
 * Find any default workspace folders (My Workspace, My Workspace (1), etc.)
 * Also includes legacy "My Workstation" folder if it exists
 */
async function findDefaultWorkspaces(): Promise<string[]> {
  try {
    const entries = await readdir(DOCUMENTS_DIR);
    const workspaces: string[] = [];

    for (const entry of entries) {
      // Match "My Workspace" or "My Workspace (N)" or legacy "My Workstation"
      if (
        entry === DEFAULT_WORKSPACE_BASE ||
        entry === 'My Workstation' ||
        entry.match(/^My Workspace \(\d+\)$/)
      ) {
        workspaces.push(entry);
      }
    }

    return workspaces;
  } catch {
    return [];
  }
}

/**
 * Delete workspace folders after confirmation
 */
async function deleteDefaultWorkspaces(): Promise<void> {
  const workspacesToDelete = await findDefaultWorkspaces();

  if (workspacesToDelete.length === 0) {
    console.log('No default workspace folders to delete');
    return;
  }

  // Show warning with folders that will be deleted
  console.log('\n⚠️  WARNING: The following folders will be PERMANENTLY DELETED:');
  for (const folder of workspacesToDelete) {
    const folderPath = join(DOCUMENTS_DIR, folder);
    console.log(`   - ${folderPath}`);
  }
  console.log('');

  const confirmed = await confirm('Would you like to continue?');

  if (!confirmed) {
    console.log('Aborted. No folders were deleted.');
    return;
  }

  // Delete the folders
  for (const folder of workspacesToDelete) {
    const folderPath = join(DOCUMENTS_DIR, folder);
    console.log(`Deleting: ${folderPath}`);
    await rm(folderPath, { recursive: true, force: true });
  }

  console.log(`Deleted ${workspacesToDelete.length} workspace folder(s)`);
}

export function resolveDarwinTccBundleIds(productConfig: ProductConfig | null): string[] {
  const candidates = new Set<string>();

  if (typeof productConfig?.darwinBundleIdentifier === 'string' && productConfig.darwinBundleIdentifier.trim()) {
    candidates.add(productConfig.darwinBundleIdentifier.trim());
  }

  // Known local/dev bundle identifiers used by source-built Interpreter apps.
  candidates.add('com.interpreter.dev');
  candidates.add('com.openinterpreter.interpreter.dev');
  candidates.add('com.openinterpreter.interpreter-internal.dev');

  return [...candidates];
}

export function resolveDarwinBundleRegistrationPaths(homeDir = homedir()): string[] {
  return [...new Set([
    join(homeDir, 'Applications', 'Interpreter.app'),
    '/Applications/Interpreter.app',
    new URL('../node_modules/electron/dist/Electron.app', import.meta.url).pathname,
    new URL('../.cache/dev-electron-bundles/Interpreter.app', import.meta.url).pathname,
    new URL('../.cache/dev-electron-bundles/Interpreter Internal.app', import.meta.url).pathname,
    new URL('../.cache/dev-electron-bundles/Interpreter-Internal.app', import.meta.url).pathname,
  ])];
}

async function readProductConfig(): Promise<ProductConfig | null> {
  try {
    const productConfigUrl = new URL('../product.json', import.meta.url);
    const data = await readFile(productConfigUrl, 'utf8');
    return JSON.parse(data) as ProductConfig;
  } catch {
    return null;
  }
}

async function registerDarwinBundle(bundlePath: string): Promise<boolean> {
  try {
    await access(bundlePath);
  } catch {
    return false;
  }

  await execFile(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', bundlePath],
  );
  return true;
}

async function readDarwinBundleIdentifier(bundlePath: string): Promise<string | null> {
  try {
    const infoPlistPath = join(bundlePath, 'Contents', 'Info.plist');
    const { stdout } = await execFile('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      infoPlistPath,
    ]);
    const value = stdout.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

async function readExistingConfig(): Promise<{ path: string; config: Record<string, unknown> } | null> {
  for (const filePath of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    try {
      const data = await readFile(filePath, 'utf-8');
      return {
        path: filePath,
        config: JSON.parse(data) as Record<string, unknown>,
      };
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
  }

  return null;
}

async function resetMacOsInterpreterPermissions(): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }

  const registeredBundleIds = new Set<string>();
  for (const bundlePath of resolveDarwinBundleRegistrationPaths()) {
    try {
      const registered = await registerDarwinBundle(bundlePath);
      if (!registered) {
        continue;
      }
      const bundleId = await readDarwinBundleIdentifier(bundlePath);
      if (bundleId) {
        registeredBundleIds.add(bundleId);
      }
    } catch {
      // Best-effort registration only.
    }
  }

  const fallbackBundleIds = resolveDarwinTccBundleIds(await readProductConfig());
  const bundleIds = registeredBundleIds.size > 0
    ? [...registeredBundleIds]
    : fallbackBundleIds;
  if (bundleIds.length === 0) {
    return;
  }

  console.log('Resetting macOS privacy permissions for Interpreter...');
  for (const bundleId of bundleIds) {
    try {
      await execFile('tccutil', ['reset', 'All', bundleId]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: failed to reset macOS permissions for ${bundleId}: ${message}`);
    }
  }
}

async function mainHard() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  🔴  HARD RESET — this will delete EVERYTHING                 ║');
  console.log('║     legacy ~/.interpreter + workspace folders      ║');
  console.log('║     app user data directory                         ║');
  console.log('║     MCPs, OAuth, skills, config, extensions — all gone         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  for (const directory of new Set([LEGACY_CONFIG_DIR, USER_DATA_DIR])) {
    console.log(`Will delete: ${directory}`);
  }

  const workspacesToDelete = await findDefaultWorkspaces();
  if (workspacesToDelete.length > 0) {
    for (const folder of workspacesToDelete) {
      console.log(`Will delete: ${join(DOCUMENTS_DIR, folder)}`);
    }
  }

  console.log('');
  const confirmed = await confirm('This is irreversible. Continue?');
  if (!confirmed) {
    console.log('Aborted.');
    return;
  }

  await stopRunningInterpreterProcesses([
    LEGACY_CONFIG_DIR,
    USER_DATA_DIR,
    join(USER_DATA_DIR, 'codex-home'),
  ]);

  // Delete workspace folders
  for (const folder of workspacesToDelete) {
    const folderPath = join(DOCUMENTS_DIR, folder);
    console.log(`Deleting: ${folderPath}`);
    await deletePathWithRetries(folderPath);
  }

  // Delete entire config directory
  for (const directory of new Set([LEGACY_CONFIG_DIR, USER_DATA_DIR])) {
    console.log(`Deleting: ${directory}`);
    await deletePathWithRetries(directory);
  }

  await resetMacOsInterpreterPermissions();

  console.log('\nHard reset complete. Everything wiped — next launch will be a clean install.');
}

async function mainSoft() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  ⚠️  To fully simulate the first-user experience,              ║');
  console.log('║     log out in the app first!                                  ║');
  console.log('║                                                                ║');
  console.log('║  Tip: use --hard for a true clean install (deletes everything) ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Delete default workspace folders
  await deleteDefaultWorkspaces();

  // Try to read existing config to preserve mcpServers
  let mcpServers: Record<string, unknown> = {};

  try {
    const existingConfig = await readExistingConfig();
    if (!existingConfig) {
      console.log('No existing config found, creating fresh');
    }
    const existing = existingConfig?.config;
    if (existing?.mcpServers) {
      mcpServers = existing.mcpServers;
      console.log(`Preserving ${Object.keys(mcpServers).length} MCP server(s)`);
    }
  } catch {
    console.log('No existing config found, creating fresh');
  }

  // Build fresh valid config with all builtins
  const providers: Record<string, unknown> = {};
  for (const p of BUILTIN_PROVIDERS) {
    providers[p.id] = p;
  }

  const freshConfig = {
    agents: {},
    primaryColor: 'blue',
    profiles: [...BUILTIN_PROFILES],
    providers,
    // Preserve MCP servers
    mcpServers,
  };


  // Write the config (lastWorkspace is now in config, so it gets cleared automatically)
  await mkdir(USER_DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(freshConfig, null, 2), 'utf-8');
  if (LEGACY_CONFIG_FILE !== CONFIG_FILE) {
    await rm(LEGACY_CONFIG_FILE, { force: true });
  }

  console.log('\nConfig reset successfully!');
  console.log('- Deleted: My Workspace folders in Documents');
  console.log(`- Stored config in: ${CONFIG_FILE}`);
  console.log('- Cleared: defaultProfileId, userName, theme, recentFolders, lastWorkspace');
  console.log('- Preserved: MCP servers');
  console.log('- Reset to: builtin profiles and providers');
}

if (isDirectScriptExecution(import.meta.url, process.argv[1])) {
  (isHardReset ? mainHard() : mainSoft()).catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
