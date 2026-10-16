import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnBundledPnpm } from '../utils/bundledPackageManager';
import { assertSimpleProjectChildPath, getActiveSimpleProject } from '../simpleProjects';
import {
  SIMPLE_INTERFACE_COMPONENT_CSS,
  SIMPLE_INTERFACE_RUNTIME_MODULE,
} from '../simpleInterfaceRuntime';
import { SIMPLE_INTERFACE_MOTION_MODULE } from '../simpleInterfaceMotionRuntime';
import { seedSimpleApp, type SimpleAppStatus } from './simpleApp';
import { trustedProjectRunner } from './projectRunner';

const CORE_DEPENDENCIES: Record<string, string> = {
  '@interpreter/interface': 'file:.interpreter/packages/interface',
  '@interpreter/motion': 'file:.interpreter/packages/motion',
  motion: '12.23.26',
  next: '16.4.0',
  react: '19.3.0',
  'react-dom': '19.3.0',
  'react-markdown': '10.1.0',
  'remark-gfm': '4.0.1',
};

const DEFAULT_LAYOUT = `import '@interpreter/interface/style.css';
import '../src/styles.css';

export const metadata = { title: 'Interpreter Interface' };

export default function RootLayout({ children }) {
  return <html lang="en"><body><div id="root">{children}</div><script src="/__interpreter/bridge.js" /></body></html>;
}
`;

const DEFAULT_PAGE = `'use client';

export { default } from '../src/App';
`;

const LEGACY_NEXT_CONFIG = `const workstationOrigin = process.env.INTERPRETER_WORKSTATION_ORIGIN;

if (!workstationOrigin) throw new Error('INTERPRETER_WORKSTATION_ORIGIN is required.');

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@interpreter/interface', '@interpreter/motion'],
  async rewrites() {
    return [{ source: '/__interpreter/bridge.js', destination: workstationOrigin + '/api/simple-interface/app/bridge.js' }];
  },
};

export default nextConfig;
`;

const PREVIOUS_DEFAULT_NEXT_CONFIG = `const workstationOrigin = process.env.INTERPRETER_WORKSTATION_ORIGIN;

if (!workstationOrigin) throw new Error('INTERPRETER_WORKSTATION_ORIGIN is required.');

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@interpreter/interface', '@interpreter/motion'],
  async rewrites() {
    return [
      { source: '/__interpreter/bridge.js', destination: workstationOrigin + '/api/simple-interface/app/bridge.js' },
      { source: '/api/simple-interface/assets/:path*', destination: workstationOrigin + '/api/simple-interface/assets/:path*' },
    ];
  },
};

export default nextConfig;
`;

const DEFAULT_NEXT_CONFIG = `const workstationOrigin = process.env.INTERPRETER_WORKSTATION_ORIGIN;

if (!workstationOrigin) throw new Error('INTERPRETER_WORKSTATION_ORIGIN is required.');

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  transpilePackages: ['@interpreter/interface', '@interpreter/motion'],
  async rewrites() {
    return [
      { source: '/__interpreter/bridge.js', destination: workstationOrigin + '/api/simple-interface/app/bridge.js' },
      { source: '/api/simple-interface/assets/:path*', destination: workstationOrigin + '/api/simple-interface/assets/:path*' },
    ];
  },
};

export default nextConfig;
`;

const INTERFACE_PACKAGE = `${JSON.stringify({
  name: '@interpreter/interface',
  private: true,
  version: '0.0.0-workstation',
  type: 'module',
  exports: { '.': './index.jsx', './style.css': './style.css' },
  peerDependencies: { react: '>=19', 'react-dom': '>=19' },
}, null, 2)}\n`;

const MOTION_PACKAGE = `${JSON.stringify({
  name: '@interpreter/motion',
  private: true,
  version: '0.0.0-workstation',
  type: 'module',
  exports: { '.': './index.jsx' },
  peerDependencies: { motion: '>=12', react: '>=19' },
}, null, 2)}\n`;

const pendingRefreshes = new Map<string, Promise<SimpleAppStatus>>();

async function writeIfMissing(filePath: string, contents: string): Promise<void> {
  try {
    await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

async function writeManaged(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  let current = '';
  try { current = await readFile(filePath, 'utf8'); } catch { /* create below */ }
  if (current === contents) return;
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
}

async function writeIfMissingOrKnown(filePath: string, contents: string, known: string[]): Promise<void> {
  let current: string | null = null;
  try { current = await readFile(filePath, 'utf8'); } catch { /* create below */ }
  if (current !== null && !known.includes(current)) return;
  if (current === contents) return;
  await writeManaged(filePath, contents);
}

async function ensureManifest(projectPath: string): Promise<string> {
  const manifestPath = assertSimpleProjectChildPath(projectPath, path.join(projectPath, 'package.json'));
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown> & {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    interpreter?: Record<string, unknown>;
  };
  const scripts = { ...(parsed.scripts ?? {}) };
  if (!scripts.dev || scripts.dev === 'interpreter-interface dev') scripts.dev = 'next dev --hostname 127.0.0.1';
  if (!scripts.start || scripts.start === 'interpreter-interface start') scripts.start = 'next dev --hostname 127.0.0.1';
  if (scripts.build === 'interpreter-interface build') delete scripts.build;
  const dependencies = { ...(parsed.dependencies ?? {}) };
  for (const [name, version] of Object.entries(CORE_DEPENDENCIES)) {
    if (!dependencies[name]) dependencies[name] = version;
  }
  const next = {
    ...parsed,
    private: true,
    scripts,
    dependencies,
    interpreter: { ...(parsed.interpreter ?? {}), runtime: 'next', version: 2 },
  };
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  if (contents !== `${JSON.stringify(parsed, null, 2)}\n`) await writeFile(manifestPath, contents, 'utf8');
  return contents;
}

async function ensureScaffold(projectPath: string): Promise<string> {
  await seedSimpleApp();
  const appPath = assertSimpleProjectChildPath(projectPath, path.join(projectPath, 'app'));
  const interfacePath = assertSimpleProjectChildPath(projectPath, path.join(projectPath, '.interpreter', 'packages', 'interface'));
  const motionPath = assertSimpleProjectChildPath(projectPath, path.join(projectPath, '.interpreter', 'packages', 'motion'));
  await mkdir(appPath, { recursive: true });
  await mkdir(interfacePath, { recursive: true });
  await mkdir(motionPath, { recursive: true });
  await writeIfMissing(path.join(appPath, 'layout.jsx'), DEFAULT_LAYOUT);
  await writeIfMissing(path.join(appPath, 'page.jsx'), DEFAULT_PAGE);
  await writeIfMissingOrKnown(
    path.join(projectPath, 'next.config.mjs'),
    DEFAULT_NEXT_CONFIG,
    [LEGACY_NEXT_CONFIG, PREVIOUS_DEFAULT_NEXT_CONFIG],
  );
  await writeIfMissing(path.join(projectPath, '.gitignore'), '.next/\nnode_modules/\n.interpreter/runtime/\n');
  await writeManaged(path.join(interfacePath, 'package.json'), INTERFACE_PACKAGE);
  await writeManaged(path.join(interfacePath, 'index.jsx'), SIMPLE_INTERFACE_RUNTIME_MODULE);
  await writeManaged(path.join(interfacePath, 'style.css'), SIMPLE_INTERFACE_COMPONENT_CSS);
  await writeManaged(path.join(motionPath, 'package.json'), MOTION_PACKAGE);
  await writeManaged(path.join(motionPath, 'index.jsx'), SIMPLE_INTERFACE_MOTION_MODULE);
  const manifest = await ensureManifest(projectPath);
  return createHash('sha256')
    .update(manifest)
    .update(DEFAULT_NEXT_CONFIG)
    .update(INTERFACE_PACKAGE)
    .update(SIMPLE_INTERFACE_RUNTIME_MODULE)
    .update(SIMPLE_INTERFACE_COMPONENT_CSS)
    .update(MOTION_PACKAGE)
    .update(SIMPLE_INTERFACE_MOTION_MODULE)
    .digest('hex');
}

async function readInstallMarker(projectPath: string): Promise<string> {
  try { return (await readFile(path.join(projectPath, '.interpreter', 'runtime', 'dependencies.sha256'), 'utf8')).trim(); }
  catch { return ''; }
}

async function installDependencies(projectPath: string, fingerprint: string): Promise<void> {
  const markerPath = path.join(projectPath, '.interpreter', 'runtime', 'dependencies.sha256');
  if (await readInstallMarker(projectPath) === fingerprint && existsSync(path.join(projectPath, 'node_modules', 'next', 'package.json'))) return;

  const child = spawnBundledPnpm(['install', '--dir', projectPath, '--config.confirmModulesPurge=false'], {
    cwd: projectPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  const capture = (chunk: Buffer) => {
    output.push(chunk.toString('utf8'));
    if (output.length > 80) output.shift();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (exitCode !== 0) throw new Error(`Project dependency install failed.\n${output.join('').slice(-8000)}`);
  await writeManaged(markerPath, `${fingerprint}\n`);
}

async function refreshProject(workstationOrigin: string): Promise<SimpleAppStatus> {
  const project = await getActiveSimpleProject();
  const fingerprint = await ensureScaffold(project.path);
  const installed = await readInstallMarker(project.path);
  if (installed !== fingerprint || !existsSync(path.join(project.path, 'node_modules', 'next', 'package.json'))) {
    await trustedProjectRunner.stop(project.path);
    await installDependencies(project.path, fingerprint);
  }
  const result = await trustedProjectRunner.start(project.path, {
    INTERPRETER_WORKSTATION_ORIGIN: workstationOrigin,
  });
  return {
    revision: project.metadata.id,
    sourceRevision: fingerprint,
    diagnostic: result.success ? null : (result.error ?? 'The project dev server failed to start.'),
    ready: result.success && result.state.status === 'running' && typeof result.state.url === 'string',
    runtimeUrl: result.state.url ?? null,
  };
}

export async function promoteSimpleProjectApp(workstationOrigin: string): Promise<SimpleAppStatus> {
  const project = await getActiveSimpleProject();
  const existing = pendingRefreshes.get(project.path);
  if (existing) return existing;
  const pending = refreshProject(workstationOrigin).finally(() => pendingRefreshes.delete(project.path));
  pendingRefreshes.set(project.path, pending);
  return pending;
}

export async function readSimpleProjectAppStatus(): Promise<SimpleAppStatus> {
  const project = await getActiveSimpleProject();
  const result = await trustedProjectRunner.status(project.path);
  const fingerprint = await readInstallMarker(project.path);
  return {
    revision: project.metadata.id,
    sourceRevision: fingerprint,
    diagnostic: result.state.status === 'error' ? (result.state.error ?? 'The project dev server failed.') : null,
    ready: result.state.status === 'running' && typeof result.state.url === 'string',
    runtimeUrl: result.state.url ?? null,
  };
}

export async function resetSimpleProjectRuntimeForTest(projectPath: string): Promise<void> {
  pendingRefreshes.delete(projectPath);
  await trustedProjectRunner.stop(projectPath);
  await rm(path.join(projectPath, '.next'), { recursive: true, force: true });
}
