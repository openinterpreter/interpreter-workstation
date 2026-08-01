import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import getPort from 'get-port';
import type { BroadcastScope } from './broadcast';
import { broadcastEvent } from './broadcast';
import { resolvePathWithWorkspace } from '../utils/permissions';
import { detectRunnableProject } from '../utils/runnableProjects';
import { getCurrentWorkspace } from '../utils/workspace';
import type {
  ProjectRunnerState,
  RunnableProjectRunScript,
} from '../../shared/types/projectRunner';

const execFileAsync = promisify(execFile);
const PROJECT_STARTUP_TIMEOUT_MS = 60000;
const PROJECT_TERMINATE_TIMEOUT_MS = 3000;
const PROJECT_KILL_TIMEOUT_MS = 2000;
const PROJECT_PORT_CANDIDATES = Array.from({ length: 200 }, (_value, index) => 43800 + index);

interface ProjectRuntime {
  child: ChildProcess;
  projectPath: string;
  runScript: RunnableProjectRunScript;
  port: number;
  url: string;
  status: 'starting' | 'running';
  logs: string[];
  finalized: boolean;
  broadcastScope?: BroadcastScope;
  spawnError?: string;
  expectedExitState?: ProjectRunnerState;
  startupPromise?: Promise<ProjectRunnerState>;
}

const runtimes = new Map<string, ProjectRuntime>();
let didRegisterProcessCleanup = false;
let projectRunnerExitCleanupHandler: ((code?: number) => void) | null = null;

function normalizeProjectKey(projectPath: string): string {
  return path.resolve(projectPath);
}

function trimLogLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= 1000) {
    return trimmed;
  }
  return `${trimmed.slice(0, 1000)}...[truncated]`;
}

function pushRuntimeLog(runtime: ProjectRuntime, chunk: string): void {
  const line = trimLogLine(chunk);
  if (!line) {
    return;
  }

  runtime.logs.push(line);
  if (runtime.logs.length > 120) {
    runtime.logs.shift();
  }
}

function getRuntimeError(runtime: ProjectRuntime): string {
  if (runtime.spawnError) {
    return runtime.spawnError;
  }

  if (runtime.logs.length === 0) {
    return 'The project failed to start.';
  }

  return runtime.logs.slice(-8).join('\n');
}

function getPnpmSpawnOptions(
  runScript: RunnableProjectRunScript,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  return {
    command: 'pnpm',
    args: ['run', runScript],
    shell: platform === 'win32',
  };
}

function formatSpawnError(error: NodeJS.ErrnoException): string {
  if (error.code === 'ENOENT' || error.code === 'EINVAL') {
    return 'Could not start the project because pnpm could not be launched.';
  }

  return error.message || String(error);
}

export const getPnpmSpawnOptionsForTest = getPnpmSpawnOptions;
export const formatProjectRunnerSpawnErrorForTest = formatSpawnError;

function toProjectRunnerState(
  runtime: ProjectRuntime,
  overrides?: Partial<ProjectRunnerState>,
): ProjectRunnerState {
  return {
    projectPath: runtime.projectPath,
    status: runtime.status,
    url: runtime.status === 'running' ? runtime.url : undefined,
    ...overrides,
  };
}

function emitProjectRunnerChanged(state: ProjectRunnerState, scope?: BroadcastScope): void {
  broadcastEvent('projectRunner:changed', { state }, scope);
}

function finalizeRuntime(runtime: ProjectRuntime, state: ProjectRunnerState): void {
  if (runtime.finalized) {
    return;
  }

  runtime.finalized = true;
  if (runtimes.get(runtime.projectPath) === runtime) {
    runtimes.delete(runtime.projectPath);
  }
  emitProjectRunnerChanged(state, runtime.broadcastScope);
}

function getBroadcastScope(): BroadcastScope | undefined {
  const workspacePath = getCurrentWorkspace();
  if (workspacePath === null) {
    return undefined;
  }

  return { workspacePath };
}

function killRuntimeChild(runtime: ProjectRuntime, signal: NodeJS.Signals): void {
  const pid = runtime.child.pid;
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to targeting the direct child if the group no longer exists.
    }
  }

  try {
    runtime.child.kill(signal);
  } catch {
    // Ignore cleanup races when the child is already gone.
  }
}

function registerCleanup(): void {
  if (didRegisterProcessCleanup) {
    return;
  }

  didRegisterProcessCleanup = true;
  projectRunnerExitCleanupHandler = () => {
    for (const runtime of runtimes.values()) {
      if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
        killRuntimeChild(runtime, 'SIGKILL');
      }
    }
    runtimes.clear();
  };
  process.on('exit', projectRunnerExitCleanupHandler);
}

export function getProjectRunnerExitCleanupHandlerForTest(): ((code?: number) => void) | null {
  return projectRunnerExitCleanupHandler;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      child.off('exit', onExit);
      clearTimeout(timeoutId);
    };

    const finish = (exited: boolean) => {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();
      resolve(exited);
    };

    const onExit = () => finish(true);
    const timeoutId = setTimeout(() => finish(false), timeoutMs);

    child.once('exit', onExit);
  });
}

async function terminateRuntime(runtime: ProjectRuntime): Promise<boolean> {
  if (runtime.finalized || runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
    return true;
  }

  const pid = runtime.child.pid;
  if (!pid) {
    killRuntimeChild(runtime, 'SIGTERM');
    return await waitForChildExit(runtime.child, PROJECT_TERMINATE_TIMEOUT_MS);
  }

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f']);
    } catch {
      // Ignore taskkill failures; the process may already be gone.
    }
    return await waitForChildExit(runtime.child, PROJECT_KILL_TIMEOUT_MS);
  }

  killRuntimeChild(runtime, 'SIGTERM');

  const exitedAfterTerm = await waitForChildExit(runtime.child, PROJECT_TERMINATE_TIMEOUT_MS);
  if (exitedAfterTerm) {
    return true;
  }

  killRuntimeChild(runtime, 'SIGKILL');

  return await waitForChildExit(runtime.child, PROJECT_KILL_TIMEOUT_MS);
}

async function waitForProject(runtime: ProjectRuntime): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < PROJECT_STARTUP_TIMEOUT_MS) {
    if (runtime.finalized || runtime.spawnError) {
      return false;
    }

    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      return false;
    }

    try {
      const response = await fetch(runtime.url);
      if (response.status === 200) {
        return true;
      }
    } catch {
      // The app is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function assertRunnableProject(projectPath: string): Promise<{
  projectPath: string;
  runScript: RunnableProjectRunScript;
}> {
  const resolvedPath = normalizeProjectKey(projectPath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error('Project path is not a directory.');
  }

  const runnableProject = await detectRunnableProject(resolvedPath);
  if (!runnableProject) {
    throw new Error('This folder is not a runnable Node web app.');
  }

  return {
    projectPath: resolvedPath,
    runScript: runnableProject.runScript,
  };
}

function getStoppedState(projectPath: string): ProjectRunnerState {
  return {
    projectPath,
    status: 'stopped',
  };
}

export async function getProjectStatus(
  projectPath: string,
): Promise<{ success: boolean; state: ProjectRunnerState }> {
  const workspace = getCurrentWorkspace();
  const resolvedPath = normalizeProjectKey(resolvePathWithWorkspace(projectPath, workspace));
  const runtime = runtimes.get(resolvedPath);

  if (!runtime || runtime.finalized) {
    return {
      success: true,
      state: getStoppedState(resolvedPath),
    };
  }

  return {
    success: true,
    state: toProjectRunnerState(runtime),
  };
}

export async function startProject(
  projectPath: string,
): Promise<{ success: boolean; state: ProjectRunnerState; error?: string }> {
  registerCleanup();

  const workspace = getCurrentWorkspace();
  const resolvedPath = resolvePathWithWorkspace(projectPath, workspace);
  const normalizedPath = normalizeProjectKey(resolvedPath);

  const existingRuntime = runtimes.get(normalizedPath);
  if (existingRuntime && !existingRuntime.finalized) {
    if (existingRuntime.status === 'running') {
      return {
        success: true,
        state: toProjectRunnerState(existingRuntime),
      };
    }

    if (existingRuntime.startupPromise) {
      try {
        const state = await existingRuntime.startupPromise;
        return { success: true, state };
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          state: {
            projectPath: normalizedPath,
            status: 'error',
            error: message,
          },
          error: message,
        };
      }
    }
  }

  const runnableProject = await assertRunnableProject(normalizedPath);
  const port = await getPort({ port: PROJECT_PORT_CANDIDATES });
  const url = `http://127.0.0.1:${port}`;
  const pnpmSpawn = getPnpmSpawnOptions(runnableProject.runScript);
  const broadcastScope = getBroadcastScope();

  const child = spawn(pnpmSpawn.command, pnpmSpawn.args, {
    cwd: runnableProject.projectPath,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BROWSER: 'none',
    },
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    shell: pnpmSpawn.shell,
  });

  const runtime: ProjectRuntime = {
    child,
    projectPath: runnableProject.projectPath,
    runScript: runnableProject.runScript,
    port,
    url,
    status: 'starting',
    logs: [],
    finalized: false,
    broadcastScope,
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    pushRuntimeLog(runtime, chunk.toString('utf-8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    pushRuntimeLog(runtime, chunk.toString('utf-8'));
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    const message = formatSpawnError(error);
    runtime.spawnError = message;
    pushRuntimeLog(runtime, message);
  });
  child.on('exit', () => {
    if (runtime.finalized) {
      return;
    }

    const nextState = runtime.expectedExitState ?? {
      projectPath: runtime.projectPath,
      status: runtime.status === 'starting' ? 'error' : 'stopped',
      url: runtime.status === 'running' ? runtime.url : undefined,
      error: runtime.status === 'starting' ? getRuntimeError(runtime) : undefined,
    };
    finalizeRuntime(runtime, nextState);
  });

  runtimes.set(runtime.projectPath, runtime);
  emitProjectRunnerChanged(toProjectRunnerState(runtime), broadcastScope);

  runtime.startupPromise = (async () => {
    const ready = await waitForProject(runtime);
    if (!ready) {
      throw new Error(getRuntimeError(runtime));
    }

    if (runtime.finalized) {
      throw new Error('The project stopped before it finished starting.');
    }

    runtime.status = 'running';
    const state = toProjectRunnerState(runtime);
    emitProjectRunnerChanged(state, runtime.broadcastScope);
    return state;
  })();

  try {
    const state = await runtime.startupPromise;
    return { success: true, state };
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    const errorState: ProjectRunnerState = {
      projectPath: runtime.projectPath,
      status: 'error',
      error: message,
    };

    if (!runtime.finalized) {
      runtime.expectedExitState = errorState;
      const terminated = await terminateRuntime(runtime);
      if (!terminated && !runtime.finalized) {
        finalizeRuntime(runtime, errorState);
      }
    }

    return {
      success: false,
      state: errorState,
      error: message,
    };
  } finally {
    runtime.startupPromise = undefined;
  }
}

export async function stopProject(
  projectPath: string,
): Promise<{ success: boolean; state: ProjectRunnerState; error?: string }> {
  const workspace = getCurrentWorkspace();
  const resolvedPath = normalizeProjectKey(resolvePathWithWorkspace(projectPath, workspace));
  const runtime = runtimes.get(resolvedPath);

  if (!runtime || runtime.finalized) {
    return {
      success: true,
      state: getStoppedState(resolvedPath),
    };
  }

  const stoppedState = getStoppedState(resolvedPath);
  runtime.expectedExitState = stoppedState;

  const terminated = await terminateRuntime(runtime);
  if (!terminated && !runtime.finalized) {
    return {
      success: false,
      state: toProjectRunnerState(runtime),
      error: 'Failed to stop the project.',
    };
  }

  if (!runtime.finalized) {
    finalizeRuntime(runtime, stoppedState);
  }

  return {
    success: true,
    state: stoppedState,
  };
}
