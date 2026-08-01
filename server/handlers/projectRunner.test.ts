import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setElectronBroadcaster } from './broadcast';
import {
  formatProjectRunnerSpawnErrorForTest,
  getPnpmSpawnOptionsForTest,
  getProjectRunnerExitCleanupHandlerForTest,
  getProjectStatus,
  startProject,
  stopProject,
} from './projectRunner';
import { runWithWindowSessionOverride } from '../utils/windowSessions';
import { runWithWorkspaceOverride } from '../utils/workspace';

const tempDirs: string[] = [];

afterEach(async () => {
  setElectronBroadcaster(() => {});

  await Promise.all(tempDirs.splice(0).map(async (dirPath) => {
    await stopProject(dirPath).catch(() => undefined);

    const childPidPath = path.join(dirPath, 'child.pid');
    const launcherPidPath = path.join(dirPath, 'launcher.pid');
    await Promise.all([childPidPath, launcherPidPath].map(async (pidPath) => {
      const pid = await readPidFile(pidPath);
      if (pid !== null) {
        killPid(pid);
      }
    }));

    await rm(dirPath, { recursive: true, force: true });
  }));
});

async function createRunnableProject(options?: {
  launcher?: boolean;
}): Promise<string> {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'interpreter-project-runner-'));
  tempDirs.push(projectDir);

  await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'graph-app',
    private: true,
    scripts: {
      start: options?.launcher ? 'node launcher.mjs' : 'node server.mjs',
    },
  }, null, 2));

  await writeFile(path.join(projectDir, 'server.mjs'), `
import http from 'node:http';

const port = Number(process.env.PORT);
const server = http.createServer((_request, response) => {
  response.statusCode = 200;
  response.end('ok');
});

server.listen(port, '127.0.0.1');
`, 'utf-8');

  if (options?.launcher) {
    await writeFile(path.join(projectDir, 'launcher.mjs'), `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(projectDir, 'launcher.pid'), String(process.pid));

const child = spawn(process.execPath, [path.join(projectDir, 'server.mjs')], {
  cwd: projectDir,
  env: process.env,
  stdio: 'ignore',
});

if (!child.pid) {
  throw new Error('child pid missing');
}

writeFileSync(path.join(projectDir, 'child.pid'), String(child.pid));
setInterval(() => {}, 1000);
`, 'utf-8');
  }

  return projectDir;
}

async function readPidFile(filePath: string): Promise<number | null> {
  try {
    const rawValue = await readFile(filePath, 'utf-8');
    const pid = Number(rawValue.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function isServerReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.status === 200;
  } catch {
    return false;
  }
}

describe('projectRunner', () => {
  test('starts projects from cwd and uses the shell only on Windows', () => {
    expect(getPnpmSpawnOptionsForTest('dev', 'win32')).toEqual({
      command: 'pnpm',
      args: ['run', 'dev'],
      shell: true,
    });
    expect(getPnpmSpawnOptionsForTest('start', 'linux')).toEqual({
      command: 'pnpm',
      args: ['run', 'start'],
      shell: false,
    });
  });

  test('formats pnpm launcher spawn failures', () => {
    const message = formatProjectRunnerSpawnErrorForTest(
      Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }),
    );

    expect(message).toBe('Could not start the project because pnpm could not be launched.');
  });

  test('kills the detached process group from the exit cleanup hook', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const projectDir = await createRunnableProject({ launcher: true });
    const start = await startProject(projectDir);
    expect(start.success).toBe(true);
    expect(start.state.status).toBe('running');
    expect(start.state.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const cleanupHandler = getProjectRunnerExitCleanupHandlerForTest();
    expect(cleanupHandler).toBeDefined();

    await waitForCondition(async () => {
      return await isServerReachable(start.state.url!);
    });

    (cleanupHandler as (code?: number) => void)(0);

    await waitForCondition(async () => {
      return !(await isServerReachable(start.state.url!));
    });
  });

  test('broadcasts project runner updates to every window for the current workspace', async () => {
    const projectDir = await createRunnableProject();
    const broadcasts: Array<{ channel: string; data: unknown; scope: unknown }> = [];
    const expectedScope = { workspacePath: projectDir };
    setElectronBroadcaster((channel, data, scope) => {
      broadcasts.push({ channel, data, scope });
    });

    const start = await runWithWorkspaceOverride(projectDir, async () => {
      return await runWithWindowSessionOverride('window-session-a', async () => {
        return await startProject(projectDir);
      });
    });

    expect(start.success).toBe(true);

    const stop = await runWithWorkspaceOverride(projectDir, async () => {
      return await runWithWindowSessionOverride('window-session-b', async () => {
        return await stopProject(projectDir);
      });
    });

    expect(stop.success).toBe(true);

    await waitForCondition(async () => {
      const projectRunnerBroadcasts = broadcasts.filter(({ channel }) => channel === 'projectRunner:changed');
      return projectRunnerBroadcasts.some(({ data, scope }) => (
        JSON.stringify(scope) === JSON.stringify(expectedScope)
        && JSON.stringify(data) === JSON.stringify({
          state: {
            projectPath: projectDir,
            status: 'stopped',
          },
        })
      ));
    });

    const projectRunnerBroadcasts = broadcasts.filter(({ channel }) => channel === 'projectRunner:changed');
    const scopedProjectRunnerBroadcasts = projectRunnerBroadcasts.filter(({ scope }) => (
      JSON.stringify(scope) === JSON.stringify(expectedScope)
    ));

    expect(scopedProjectRunnerBroadcasts.length).toBeGreaterThanOrEqual(2);
    expect(scopedProjectRunnerBroadcasts.some(({ data }) => {
      const state = (data as { state?: { projectPath?: string; status?: string; url?: string } }).state;
      return state?.projectPath === projectDir
        && (state.status === 'starting' || (state.status === 'running' && state.url === start.state.url));
    })).toBe(true);
    expect(scopedProjectRunnerBroadcasts.some(({ data }) => {
      const state = (data as { state?: { projectPath?: string; status?: string } }).state;
      return state?.projectPath === projectDir && state.status === 'stopped';
    })).toBe(true);
  });

  test('starts and stops runnable node web apps', async () => {
    const projectDir = await createRunnableProject();

    const start = await startProject(projectDir);
    expect(start.success).toBe(true);
    expect(start.state.status).toBe('running');
    expect(start.state.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(start.state.url!);
    expect(response.status).toBe(200);

    const status = await getProjectStatus(projectDir);
    expect(status.state.status).toBe('running');
    expect(status.state.url).toBe(start.state.url);

    const stop = await stopProject(projectDir);
    expect(stop.success).toBe(true);
    expect(stop.state.status).toBe('stopped');

    const statusAfterStop = await getProjectStatus(projectDir);
    expect(statusAfterStop.state.status).toBe('stopped');
  });
});
