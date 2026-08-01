import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import getPort from 'get-port';

const REMOTION_VERSION = '4.0.434';
const REMOTION_MANIFEST_VERSION = 1;
const REMOTION_MANIFEST_EXTENSION = '.remotion';
const STUDIO_STARTUP_TIMEOUT_MS = 60000;
const STUDIO_PORT_CANDIDATES = Array.from({ length: 200 }, (_value, index) => 39200 + index);

interface RemotionManifest {
  version: number;
  projectDir: string;
  entryPoint: string;
}

interface RemotionStudioRuntime {
  child: ChildProcess;
  port: number;
  logs: string[];
}

const studioRuntimes = new Map<string, RemotionStudioRuntime>();
let didRegisterProcessCleanup = false;

function normalizeManifestKey(manifestPath: string): string {
  return path.normalize(manifestPath);
}

function trimLogLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= 1000) {
    return trimmed;
  }
  return `${trimmed.slice(0, 1000)}...[truncated]`;
}

function pushRuntimeLog(runtime: RemotionStudioRuntime, chunk: string): void {
  const line = trimLogLine(chunk);
  if (!line) {
    return;
  }
  runtime.logs.push(line);
  if (runtime.logs.length > 120) {
    runtime.logs.shift();
  }
}

function getRuntimeError(runtime: RemotionStudioRuntime): string {
  if (runtime.logs.length === 0) {
    return 'Remotion Studio failed to start.';
  }
  return runtime.logs.slice(-8).join('\n');
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForStudio(port: number, child: ChildProcess): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < STUDIO_STARTUP_TIMEOUT_MS) {
    if (child.exitCode !== null || child.killed) {
      return false;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Studio is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

async function runPnpmInstall(projectDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const child = spawn(command, ['install', '--ignore-workspace'], {
      cwd: projectDir,
      env: process.env,
      stdio: 'pipe',
    });

    const logs: string[] = [];
    const onData = (chunk: Buffer) => {
      const line = trimLogLine(chunk.toString('utf-8'));
      if (line) {
        logs.push(line);
        if (logs.length > 80) {
          logs.shift();
        }
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => reject(error));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pnpm install failed (${code ?? 'unknown'}): ${logs.slice(-8).join('\n')}`));
    });
  });
}

async function ensureProjectDependencies(projectDir: string): Promise<void> {
  const remotionDep = path.join(projectDir, 'node_modules', 'remotion');
  const cliDep = path.join(projectDir, 'node_modules', '@remotion', 'cli');
  if (await pathExists(remotionDep) && await pathExists(cliDep)) {
    return;
  }
  await runPnpmInstall(projectDir);
}

function registerCleanup(): void {
  if (didRegisterProcessCleanup) {
    return;
  }
  didRegisterProcessCleanup = true;

  const cleanup = () => {
    for (const runtime of studioRuntimes.values()) {
      runtime.child.kill();
    }
    studioRuntimes.clear();
  };

  process.on('exit', cleanup);
}

async function readManifest(manifestPath: string): Promise<RemotionManifest> {
  const raw = await fs.readFile(manifestPath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<RemotionManifest>;
  if (parsed.version !== REMOTION_MANIFEST_VERSION) {
    throw new Error(`Unsupported Remotion manifest version: ${String(parsed.version)}`);
  }
  if (!parsed.projectDir || typeof parsed.projectDir !== 'string') {
    throw new Error('Invalid Remotion manifest: projectDir is required');
  }
  if (!parsed.entryPoint || typeof parsed.entryPoint !== 'string') {
    throw new Error('Invalid Remotion manifest: entryPoint is required');
  }
  return {
    version: parsed.version,
    projectDir: parsed.projectDir,
    entryPoint: parsed.entryPoint,
  };
}

function getProjectScaffold(projectName: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name: projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-'),
      private: true,
      type: 'module',
      scripts: {
        studio: 'remotion studio src/index.ts',
        render: 'remotion render src/index.ts HelloWorld out/video.mp4',
      },
      dependencies: {
        react: '18.3.1',
        'react-dom': '18.3.1',
        remotion: REMOTION_VERSION,
        zod: '4.3.6',
      },
      devDependencies: {
        '@remotion/cli': REMOTION_VERSION,
        typescript: '5.6.3',
      },
    }, null, 2),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        jsx: 'react-jsx',
      },
      include: ['src'],
    }, null, 2),
    [path.join('src', 'index.ts')]: `import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);
`,
    [path.join('src', 'Root.tsx')]: `import { Composition } from 'remotion';
import { HelloWorld } from './HelloWorld';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="HelloWorld"
      component={HelloWorld}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
`,
    [path.join('src', 'HelloWorld.tsx')]: `import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

export const HelloWorld: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: '#0f172a',
        color: '#f8fafc',
        fontFamily: 'sans-serif',
        fontSize: 96,
        alignItems: 'center',
        justifyContent: 'center',
        opacity,
      }}
    >
      Hello Remotion
    </AbsoluteFill>
  );
};
`,
  };
}

export async function createRemotionProjectFile(parentPath: string): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const baseName = 'Remotion Project';
    let candidateName = baseName;
    let suffix = 1;

    while (true) {
      const candidateContainerDir = path.join(parentPath, candidateName);
      const containerTaken = await pathExists(candidateContainerDir);
      if (!containerTaken) {
        break;
      }
      candidateName = `${baseName} (${suffix})`;
      suffix++;
    }

    const containerDir = path.join(parentPath, candidateName);
    const manifestPath = path.join(containerDir, `${candidateName}${REMOTION_MANIFEST_EXTENSION}`);
    const projectDir = path.join(containerDir, 'project');

    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });

    const scaffold = getProjectScaffold(candidateName);
    await Promise.all(
      Object.entries(scaffold).map(async ([relativePath, content]) => {
        await fs.writeFile(path.join(projectDir, relativePath), content);
      })
    );

    const manifest: RemotionManifest = {
      version: REMOTION_MANIFEST_VERSION,
      projectDir: 'project',
      entryPoint: path.join('src', 'index.ts'),
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    return { success: true, path: manifestPath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export function getStudioPort(manifestPath: string): number | null {
  const key = normalizeManifestKey(manifestPath);
  const runtime = studioRuntimes.get(key);
  if (!runtime || runtime.child.exitCode !== null || runtime.child.killed) {
    return null;
  }
  return runtime.port;
}

export function listRunningStudios(): Array<{ manifestPath: string; port: number }> {
  const result: Array<{ manifestPath: string; port: number }> = [];
  for (const [key, runtime] of studioRuntimes.entries()) {
    if (runtime.child.exitCode === null && !runtime.child.killed) {
      result.push({ manifestPath: key, port: runtime.port });
    }
  }
  return result;
}

export async function openRemotionProject(manifestPath: string): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    registerCleanup();
    const key = normalizeManifestKey(manifestPath);
    const existing = studioRuntimes.get(key);
    if (existing && existing.child.exitCode === null && !existing.child.killed) {
      return { success: true, url: `http://127.0.0.1:${existing.port}` };
    }
    if (existing) {
      studioRuntimes.delete(key);
    }

    const manifest = await readManifest(manifestPath);
    const manifestDir = path.dirname(manifestPath);
    const projectDir = path.resolve(manifestDir, manifest.projectDir);
    const entryPoint = manifest.entryPoint;
    const entryPointPath = path.join(projectDir, entryPoint);
    if (!(await pathExists(entryPointPath))) {
      return { success: false, error: `Remotion entrypoint not found: ${entryPointPath}` };
    }

    await ensureProjectDependencies(projectDir);

    const port = await getPort({ port: STUDIO_PORT_CANDIDATES });
    const cliPath = path.join(projectDir, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
    if (!(await pathExists(cliPath))) {
      return { success: false, error: 'Remotion CLI is not installed in this project' };
    }

    const runtime: RemotionStudioRuntime = {
      child: spawn(process.execPath, [cliPath, 'studio', entryPoint, '--port', String(port)], {
        cwd: projectDir,
        env: {
          ...process.env,
          BROWSER: 'none',
        },
        stdio: 'pipe',
      }),
      port,
      logs: [],
    };

    runtime.child.stdout?.on('data', (chunk: Buffer) => pushRuntimeLog(runtime, chunk.toString('utf-8')));
    runtime.child.stderr?.on('data', (chunk: Buffer) => pushRuntimeLog(runtime, chunk.toString('utf-8')));
    runtime.child.on('exit', () => {
      studioRuntimes.delete(key);
    });

    studioRuntimes.set(key, runtime);

    const ready = await waitForStudio(port, runtime.child);
    if (!ready) {
      runtime.child.kill();
      studioRuntimes.delete(key);
      return { success: false, error: getRuntimeError(runtime) };
    }

    return { success: true, url: `http://127.0.0.1:${port}` };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
