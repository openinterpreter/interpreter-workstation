import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveBundledResourceCandidates } from '../utils/bundledRuntimePaths';
import { assertSimpleProjectChildPath, getActiveSimpleProject } from '../simpleProjects';
import {
  SIMPLE_INTERFACE_COMPONENT_CSS,
  SIMPLE_INTERFACE_RUNTIME_MODULE,
} from '../simpleInterfaceRuntime';
import { SIMPLE_INTERFACE_MOTION_MODULE } from '../simpleInterfaceMotionRuntime';
import { seedSimpleApp, type SimpleAppStatus } from './simpleApp';
import { trustedProjectRunner } from './projectRunner';
import { getSimpleAssetRevision } from './simpleAssetRevision';
import { agentTabManager } from '../agentTabManager';
import { getCurrentWindowSessionKey } from '../utils/windowSessions';
import { prefixToolName } from '../../shared/utils/mcpToolName';
import { INTERPRETER_CALLER_TOKEN_ENV, INTERPRETER_CLI_SERVER_CONNECTION_ENV } from '../utils/interpreterCliRuntime';
import { WORKSTATION_NODE_PACKAGE, WORKSTATION_NODE_PACKAGE_MANIFEST } from './simpleWorkstationNodePackage';

const CORE_DEPENDENCIES: Record<string, string> = {
  '@interpreter/interface': 'file:.interpreter/packages/interface',
  '@interpreter/motion': 'file:.interpreter/packages/motion',
  '@interpreter/workstation': 'file:.interpreter/packages/workstation',
  motion: '12.23.26',
  next: '16.4.3',
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
const projectRuntimeTokens = new Map<string, string>();

const PROJECT_TOOL_NAMES = [
  'interpreter_whole_computer_state_get',
  'interpreter_browser_tab_activate',
  'interpreter_browser_page_inspect',
  'interpreter_browser_page_trace',
  'interpreter_browser_page_click',
  'interpreter_browser_page_type',
  'interpreter_browser_page_select',
  'interpreter_browser_page_scroll',
];

function projectRuntimeToken(projectPath: string): string {
  let token = projectRuntimeTokens.get(projectPath);
  if (!token) {
    token = `agtok_project_${randomBytes(32).toString('hex')}`;
    projectRuntimeTokens.set(projectPath, token);
    agentTabManager.registerAgentRuntime({
      agentId: `simple-project:${createHash('sha256').update(projectPath).digest('hex').slice(0, 24)}`,
      callerToken: token,
      workspacePath: projectPath,
      windowSessionKey: getCurrentWindowSessionKey(),
      allowedToolNames: PROJECT_TOOL_NAMES.map((name) => prefixToolName('builtin-interpreter', name)),
    });
  }
  return token;
}

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
  // This exact older pin was written by Workstation's own scaffold. Preserve
  // user-selected versions while upgrading projects we generated before the
  // patched runtime was bundled.
  if (dependencies.next === '16.4.0') dependencies.next = CORE_DEPENDENCIES.next;
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
  const workstationPath = assertSimpleProjectChildPath(projectPath, path.join(projectPath, '.interpreter', 'packages', 'workstation'));
  await mkdir(appPath, { recursive: true });
  await mkdir(interfacePath, { recursive: true });
  await mkdir(motionPath, { recursive: true });
  await mkdir(workstationPath, { recursive: true });
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
  await writeManaged(path.join(workstationPath, 'package.json'), WORKSTATION_NODE_PACKAGE_MANIFEST);
  await writeManaged(path.join(workstationPath, 'index.mjs'), WORKSTATION_NODE_PACKAGE);
  const manifest = await ensureManifest(projectPath);
  return createHash('sha256')
    .update(manifest)
    .update(DEFAULT_NEXT_CONFIG)
    .update(INTERFACE_PACKAGE)
    .update(SIMPLE_INTERFACE_RUNTIME_MODULE)
    .update(SIMPLE_INTERFACE_COMPONENT_CSS)
    .update(MOTION_PACKAGE)
    .update(SIMPLE_INTERFACE_MOTION_MODULE)
    .update(WORKSTATION_NODE_PACKAGE_MANIFEST)
    .update(WORKSTATION_NODE_PACKAGE)
    .digest('hex');
}

async function readInstallMarker(projectPath: string): Promise<string> {
  try { return (await readFile(path.join(projectPath, '.interpreter', 'runtime', 'dependencies.sha256'), 'utf8')).trim(); }
  catch { return ''; }
}

async function hasCoreDependencies(projectPath: string): Promise<boolean> {
  const manifest = JSON.parse(await readFile(path.join(projectPath, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const [name, version] of Object.entries(CORE_DEPENDENCIES)) {
    try {
      const installed = JSON.parse(await readFile(path.join(projectPath, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string };
      if (version.startsWith('file:')) {
        if (!installed.version) return false;
        continue;
      }
      const requested = manifest.dependencies?.[name] ?? version;
      if (!installed.version) return false;
      if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(requested) && installed.version !== requested) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function syncInternalPackages(projectPath: string): Promise<void> {
  const internalPackages = path.join(projectPath, '.interpreter', 'packages');
  for (const name of ['interface', 'motion', 'workstation']) {
    const destination = path.join(projectPath, 'node_modules', '@interpreter', name);
    await rm(destination, { recursive: true, force: true });
    await cp(path.join(internalPackages, name), destination, { recursive: true, force: true });
  }
}

async function installDependencies(projectPath: string, fingerprint: string): Promise<void> {
  const markerPath = path.join(projectPath, '.interpreter', 'runtime', 'dependencies.sha256');
  if (await readInstallMarker(projectPath) === fingerprint && await hasCoreDependencies(projectPath)) return;
  if (await hasCoreDependencies(projectPath)) {
    await syncInternalPackages(projectPath);
    await writeManaged(markerPath, `${fingerprint}\n`);
    return;
  }

  const runtime = resolveBundledResourceCandidates({
    packagedSegments: ['simple-interface-runtime'],
  }).find((candidate) => existsSync(path.join(candidate, 'runtime-manifest.json'))
    && existsSync(path.join(candidate, 'node_modules', 'next', 'package.json')));
  if (!runtime) throw new Error('The bundled Simple interface runtime is missing. Reinstall or rebuild Interpreter.');
  const manifest = JSON.parse(await readFile(path.join(runtime, 'runtime-manifest.json'), 'utf8')) as {
    platform?: string;
    arch?: string;
  };
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(`The bundled Simple interface runtime is for ${manifest.platform}-${manifest.arch}, not ${process.platform}-${process.arch}.`);
  }
  const projectManifest = JSON.parse(await readFile(path.join(projectPath, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const customCore = Object.entries(CORE_DEPENDENCIES).some(([name, version]) =>
    !version.startsWith('file:') && projectManifest.dependencies?.[name] !== version);
  if (customCore) {
    throw new Error('This project uses custom core package versions. Install its dependencies in the project before starting it.');
  }

  // The bundled tree contains Next, React, and the standard component libraries
  // for this exact OS/architecture. Copy-on-write keeps projects independent;
  // a project can subsequently add or change its own packages.
  await cp(path.join(runtime, 'node_modules'), path.join(projectPath, 'node_modules'), {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  await syncInternalPackages(projectPath);
  if (!await hasCoreDependencies(projectPath)) {
    throw new Error('The bundled Simple interface runtime could not be installed completely.');
  }
  await writeManaged(markerPath, `${fingerprint}\n`);
}

async function refreshProject(workstationOrigin: string): Promise<SimpleAppStatus> {
  const project = await getActiveSimpleProject();
  const fingerprint = await ensureScaffold(project.path);
  const installed = await readInstallMarker(project.path);
  if (installed !== fingerprint || !await hasCoreDependencies(project.path)) {
    await trustedProjectRunner.stop(project.path);
    await installDependencies(project.path, fingerprint);
  }
  const result = await trustedProjectRunner.start(project.path, {
    INTERPRETER_WORKSTATION_ORIGIN: workstationOrigin,
    NEXT_TELEMETRY_DISABLED: '1',
    [INTERPRETER_CLI_SERVER_CONNECTION_ENV]: workstationOrigin,
    [INTERPRETER_CALLER_TOKEN_ENV]: projectRuntimeToken(project.path),
  });
  return {
    revision: project.metadata.id,
    sourceRevision: fingerprint,
    assetRevision: await getSimpleAssetRevision(project.path),
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
    assetRevision: await getSimpleAssetRevision(project.path),
    diagnostic: result.state.status === 'error' ? (result.state.error ?? 'The project dev server failed.') : null,
    ready: result.state.status === 'running' && typeof result.state.url === 'string',
    runtimeUrl: result.state.url ?? null,
  };
}

export async function resetSimpleProjectRuntimeForTest(projectPath: string): Promise<void> {
  pendingRefreshes.delete(projectPath);
  await trustedProjectRunner.stop(projectPath);
  const token = projectRuntimeTokens.get(projectPath);
  if (token) agentTabManager.disposeBinding(token);
  projectRuntimeTokens.delete(projectPath);
  await rm(path.join(projectPath, '.next'), { recursive: true, force: true });
}
