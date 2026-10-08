import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build, type Plugin } from 'esbuild';
import { assertSimpleProjectChildPath, getActiveSimpleProject } from '../simpleProjects';
import {
  SIMPLE_INTERFACE_COMPONENT_CSS,
  SIMPLE_INTERFACE_RUNTIME_MODULE,
} from '../simpleInterfaceRuntime';
import { SIMPLE_INTERFACE_MOTION_MODULE } from '../simpleInterfaceMotionRuntime';
import { broadcastEvent } from './broadcast';

const MAX_SOURCE_FILES = 200;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 512 * 1024;
const MAX_UI_STATE_BYTES = 256 * 1024;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
const RUNTIME_MODULE = '@interpreter/interface';
const MOTION_RUNTIME_MODULE = '@interpreter/motion';
const ASAR_MODULE_NAMESPACE = 'interpreter-asar-module';

type SimpleRuntimePackage =
  | 'react'
  | 'react-dom'
  | 'react-dom/client'
  | 'react/jsx-runtime'
  | 'react-markdown'
  | 'remark-gfm'
  | 'motion/react';

let simpleRuntimePackagePaths: Record<SimpleRuntimePackage, string> | null = null;

/** esbuild's platform package owns the native executable; esbuild/bin/esbuild
 * is a JavaScript launcher on Windows and must never be used as its binary.
 */
export function packagedEsbuildBinaryPath(
  resourcesRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if ((platform !== 'win32' && platform !== 'linux' && platform !== 'darwin') ||
      (arch !== 'x64' && arch !== 'arm64')) return null;
  return join(resourcesRoot, 'app.asar.unpacked', 'node_modules', '@esbuild', `${platform}-${arch}`,
    ...(platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild']));
}

/** Point esbuild at the physical unpacked executable before its service starts. */
function configurePackagedEsbuildBinary(): void {
  if (process.env.ESBUILD_BINARY_PATH || typeof process.resourcesPath !== 'string') return;
  const unpacked = packagedEsbuildBinaryPath(process.resourcesPath);
  if (unpacked && existsSync(unpacked)) process.env.ESBUILD_BINARY_PATH = unpacked;
}

/**
 * Resolve app-shipped packages from the Workstation module graph, not cwd.
 * A packaged macOS application can launch with the user's home directory as
 * cwd, while these dependencies live under app.asar/node_modules.
 */
function getSimpleRuntimePackagePaths(): Record<SimpleRuntimePackage, string> {
  if (!simpleRuntimePackagePaths) {
    const packagedRuntimeManifest = typeof process.resourcesPath === 'string'
      ? join(process.resourcesPath, 'simple-interface-runtime', 'package.json')
      : null;
    const runtimeRequire = packagedRuntimeManifest && existsSync(packagedRuntimeManifest)
      ? createRequire(packagedRuntimeManifest)
      : require;
    simpleRuntimePackagePaths = {
      react: runtimeRequire.resolve('react'),
      'react-dom': runtimeRequire.resolve('react-dom'),
      'react-dom/client': runtimeRequire.resolve('react-dom/client'),
      'react/jsx-runtime': runtimeRequire.resolve('react/jsx-runtime'),
      'react-markdown': runtimeRequire.resolve('react-markdown'),
      'remark-gfm': runtimeRequire.resolve('remark-gfm'),
      'motion/react': runtimeRequire.resolve('motion/react'),
    };
  }
  return simpleRuntimePackagePaths;
}

export type SimpleAppStatus = {
  revision: string;
  sourceRevision: string;
  diagnostic: string | null;
  ready: boolean;
};

const DEFAULT_MAIN = `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
`;

const DEFAULT_APP = `import React from 'react';
import {
  DropZone,
  FileViewer,
  Page,
  Text,
  usePersistentState,
} from '@interpreter/interface';
import { AnimatePresence, motion } from '@interpreter/motion';

export default function App() {
  const [files, setFiles] = usePersistentState('starter-files', []);
  const [activePath, setActivePath] = usePersistentState('starter-active-file', '');
  const addFiles = React.useCallback((incoming) => {
    setFiles((current) => {
      const byPath = new Map(current.map((file) => [file.path, file]));
      incoming.forEach((file) => byPath.set(file.path, file));
      return [...byPath.values()];
    });
    if (incoming[0]?.path) setActivePath(incoming[0].path);
  }, [setFiles, setActivePath]);
  return (
    <Page className="starter-page">
      <DropZone onFiles={addFiles} className="workspace-canvas">
        <AnimatePresence mode="popLayout" initial={false}>
          {activePath ? (
            <motion.div className="active-file" key={activePath} initial={{ opacity: 0, scale: .99 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <FileViewer path={activePath} minHeight={560} />
              {files.length > 1 && <nav className="file-switcher" aria-label="Dropped files">
                {files.map((file) => <button className={file.path === activePath ? 'selected' : ''} key={file.path} onClick={() => setActivePath(file.path)}>{file.name}</button>)}
              </nav>}
            </motion.div>
          ) : (
            <motion.div className="empty" key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <Text>Drop something here, or ask Interpreter.</Text>
            </motion.div>
          )}
        </AnimatePresence>
      </DropZone>
    </Page>
  );
}
`;

const DEFAULT_CSS = `.starter-page { display: grid; min-height: 100dvh; place-items: center; padding: clamp(24px, 4vw, 56px) clamp(20px, 4vw, 64px) 152px; }
.workspace-canvas { width: min(100%, 1120px); }
.empty { min-height: min(62dvh, 560px); display: grid; place-items: center; color: var(--io-ink-tertiary); text-align: center; }
.active-file { position: relative; width: 100%; }
.active-file > .io-file-viewer { height: min(68dvh, 720px); }
.file-switcher { display: flex; max-width: 100%; gap: 4px; justify-content: center; overflow-x: auto; padding: 10px 0 0; }
.file-switcher button { max-width: 180px; overflow: hidden; border: 0; border-radius: 999px; padding: 5px 9px; background: transparent; color: var(--io-ink-tertiary); font: inherit; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.file-switcher button.selected { background: var(--io-inset); color: var(--io-ink-secondary); }
`;

function isChild(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !child.startsWith('/') && !child.startsWith('\\');
}

async function appPaths() {
  const project = await getActiveSimpleProject();
  const projectPath = project.path;
  const sourcePath = assertSimpleProjectChildPath(projectPath, join(projectPath, 'src'));
  const runtimePath = assertSimpleProjectChildPath(projectPath, join(projectPath, project.legacy ? '.runtime' : join('.interpreter', 'runtime')));
  const statePath = assertSimpleProjectChildPath(projectPath, join(projectPath, project.legacy ? 'state.json' : join('.interpreter', 'state.json')));
  const uiStatePath = assertSimpleProjectChildPath(projectPath, join(projectPath, project.legacy ? 'ui-state.json' : join('.interpreter', 'ui-state.json')));
  await mkdir(sourcePath, { recursive: true });
  await mkdir(runtimePath, { recursive: true });
  return { project, projectPath, sourcePath, runtimePath, statePath, uiStatePath };
}

async function writeIfMissing(path: string, contents: string): Promise<void> {
  try { await writeFile(path, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export async function seedSimpleApp(): Promise<void> {
  const { projectPath, sourcePath, statePath, uiStatePath } = await appPaths();
  await writeIfMissing(assertSimpleProjectChildPath(projectPath, join(sourcePath, 'main.jsx')), DEFAULT_MAIN);
  await writeIfMissing(assertSimpleProjectChildPath(projectPath, join(sourcePath, 'App.jsx')), DEFAULT_APP);
  await writeIfMissing(assertSimpleProjectChildPath(projectPath, join(sourcePath, 'styles.css')), DEFAULT_CSS);
  await writeIfMissing(statePath, '{}\n');
  await writeIfMissing(uiStatePath, '{}\n');
}

async function collectSourceFiles(root: string, current = root, result: string[] = []): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = resolve(current, entry.name);
    if (!isChild(root, path)) throw new Error('Interface source escapes its workspace.');
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Symlinks are not allowed in interface source.');
    if (info.isDirectory()) await collectSourceFiles(root, path, result);
    else if (info.isFile() && SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) result.push(path);
    if (result.length > MAX_SOURCE_FILES) throw new Error(`Interface source may contain at most ${MAX_SOURCE_FILES} files.`);
  }
  return result.sort();
}

async function sourceRevision(sourcePath: string): Promise<{ revision: string; files: string[] }> {
  const files = await collectSourceFiles(sourcePath);
  const hash = createHash('sha256');
  hash.update(SIMPLE_INTERFACE_RUNTIME_MODULE);
  hash.update(SIMPLE_INTERFACE_MOTION_MODULE);
  hash.update(SIMPLE_INTERFACE_COMPONENT_CSS);
  let bytes = 0;
  for (const file of files) {
    const contents = await readFile(file);
    bytes += contents.byteLength;
    if (bytes > MAX_SOURCE_BYTES) throw new Error('Interface source exceeds 2 MB.');
    hash.update(relative(sourcePath, file));
    hash.update(contents);
  }
  return { revision: hash.digest('hex'), files };
}

/** Windows scanners and briefly open asset handles can deny replacement of a
 * previously served file. Keep the old file intact and retry only transient
 * sharing errors; never delete the last-good runtime as a rename fallback.
 */
export async function renameSimpleAppTempWithRetry(
  temp: string,
  target: string,
  replace: typeof rename = rename,
  platform: NodeJS.Platform = process.platform,
  pause: (milliseconds: number) => Promise<unknown> = delay,
): Promise<void> {
  const waits = [20, 40, 80, 160, 320, 480, 480];
  for (let attempt = 0; ; attempt++) {
    try {
      await replace(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== 'win32' || !['EACCES', 'EPERM', 'EBUSY'].includes(code ?? '') || attempt >= waits.length) throw error;
      await pause(waits[attempt]);
    }
  }
}

async function atomicWrite(path: string, contents: string | Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
    await renameSimpleAppTempWithRetry(temp, path);
  } finally { await rm(temp, { force: true }); }
}

async function readStatus(runtimePath: string): Promise<SimpleAppStatus> {
  try {
    const parsed = JSON.parse(await readFile(join(runtimePath, 'status.json'), 'utf8')) as SimpleAppStatus;
    return {
      revision: typeof parsed.revision === 'string' ? parsed.revision : '',
      sourceRevision: typeof parsed.sourceRevision === 'string' ? parsed.sourceRevision : '',
      diagnostic: typeof parsed.diagnostic === 'string' ? parsed.diagnostic : null,
      ready: parsed.ready === true,
    };
  } catch { return { revision: '', sourceRevision: '', diagnostic: null, ready: false }; }
}

function sourceBoundaryPlugin(sourcePath: string): Plugin {
  const runtimePackagePaths = getSimpleRuntimePackagePaths();
  return {
    name: 'interpreter-simple-interface-boundary',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/, namespace: ASAR_MODULE_NAMESPACE }, (args) => {
        try {
          return {
            path: createRequire(args.importer).resolve(args.path),
            namespace: ASAR_MODULE_NAMESPACE,
          };
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
      });
      buildApi.onLoad({ filter: /.*/, namespace: ASAR_MODULE_NAMESPACE }, async (args) => {
        const extension = extname(args.path).toLowerCase();
        const loader = extension === '.json'
          ? 'json'
          : extension === '.css'
            ? 'css'
            : extension === '.tsx'
              ? 'tsx'
              : extension === '.ts'
                ? 'ts'
                : extension === '.jsx'
                  ? 'jsx'
                  : 'js';
        return {
          contents: await readFile(args.path),
          loader,
          resolveDir: dirname(args.path),
        };
      });
      buildApi.onResolve({ filter: /^@interpreter\/interface$/ }, () => ({ path: RUNTIME_MODULE, namespace: 'interpreter-runtime' }));
      buildApi.onLoad({ filter: /.*/, namespace: 'interpreter-runtime' }, () => ({ contents: SIMPLE_INTERFACE_RUNTIME_MODULE, loader: 'jsx', resolveDir: process.cwd() }));
      buildApi.onResolve({ filter: /^@interpreter\/motion$/ }, () => ({ path: MOTION_RUNTIME_MODULE, namespace: 'interpreter-motion-runtime' }));
      buildApi.onLoad({ filter: /.*/, namespace: 'interpreter-motion-runtime' }, () => ({ contents: SIMPLE_INTERFACE_MOTION_MODULE, loader: 'jsx', resolveDir: process.cwd() }));
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === RUNTIME_MODULE || args.path === MOTION_RUNTIME_MODULE) return undefined;
        const appPackagePath = runtimePackagePaths[args.path as SimpleRuntimePackage];
        if (appPackagePath) {
          return appPackagePath.includes(`${sep}app.asar${sep}`)
            ? { path: appPackagePath, namespace: ASAR_MODULE_NAMESPACE }
            : { path: appPackagePath };
        }
        // Once an explicitly provided dependency is entered, allow its own
        // internal files and transitive runtime dependencies to resolve.
        if (args.importer.includes(`${sep}node_modules${sep}`)) return undefined;
        if (/^(https?:|node:|data:)/i.test(args.path)) return { errors: [{ text: `External or Node import is not allowed: ${args.path}` }] };
        // esbuild passes the entry point as an absolute filename. On Windows
        // that begins with a drive or UNC root, not a slash; keep it inside
        // the same source boundary instead of mistaking it for a package.
        if (args.path.startsWith('.') || isAbsolute(args.path)) {
          const candidate = resolve(args.resolveDir || sourcePath, args.path);
          if (candidate !== sourcePath && !isChild(sourcePath, candidate)) return { errors: [{ text: `Import leaves interface/src: ${args.path}` }] };
          return undefined;
        }
        return { errors: [{ text: `Package is not provided by Interpreter: ${args.path}` }] };
      });
    },
  };
}

function formatBuildError(error: unknown): string {
  const value = error as { errors?: Array<{ text?: string; location?: { file?: string; line?: number; column?: number } }> };
  if (Array.isArray(value.errors) && value.errors.length) {
    return value.errors.slice(0, 8).map((item) => {
      const location = item.location?.file ? `${item.location.file}:${item.location.line ?? 0}:${item.location.column ?? 0}: ` : '';
      return `${location}${item.text ?? 'Build error'}`;
    }).join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

export async function promoteSimpleApp(): Promise<SimpleAppStatus> {
  await seedSimpleApp();
  const { sourcePath, runtimePath } = await appPaths();
  const source = await sourceRevision(sourcePath);
  const previous = await readStatus(runtimePath);
  if (previous.ready && previous.sourceRevision === source.revision && !previous.diagnostic) return previous;

  try {
    configurePackagedEsbuildBinary();
    const result = await build({
      entryPoints: [join(sourcePath, 'main.jsx')],
      absWorkingDir: sourcePath,
      bundle: true,
      write: false,
      outdir: 'out',
      entryNames: 'app',
      assetNames: 'asset-[hash]',
      platform: 'browser',
      format: 'iife',
      target: ['chrome120'],
      jsx: 'automatic',
      sourcemap: 'inline',
      legalComments: 'none',
      loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.webp': 'dataurl', '.gif': 'dataurl', '.svg': 'dataurl' },
      plugins: [sourceBoundaryPlugin(sourcePath)],
    });
    const js = result.outputFiles.find((file) => file.path.endsWith('.js'))?.contents;
    const generatedCss = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
    const css = new TextEncoder().encode(`${SIMPLE_INTERFACE_COMPONENT_CSS}\n${generatedCss}`);
    if (!js) throw new Error('The interface build did not produce JavaScript.');
    const revision = createHash('sha256').update(js).update(css).digest('hex');
    await atomicWrite(join(runtimePath, 'app.js'), js);
    await atomicWrite(join(runtimePath, 'app.css'), css);
    const status: SimpleAppStatus = { revision, sourceRevision: source.revision, diagnostic: null, ready: true };
    await atomicWrite(join(runtimePath, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
    await atomicWrite(join(runtimePath, 'diagnostics.json'), `${JSON.stringify({ error: null, checkedAt: new Date().toISOString() }, null, 2)}\n`);
    if (revision !== previous.revision) broadcastEvent('simple-interface:changed', { revision });
    return status;
  } catch (error) {
    const diagnostic = formatBuildError(error);
    const status: SimpleAppStatus = { ...previous, sourceRevision: source.revision, diagnostic, ready: previous.ready };
    await atomicWrite(join(runtimePath, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
    await atomicWrite(join(runtimePath, 'diagnostics.json'), `${JSON.stringify({ error: diagnostic, checkedAt: new Date().toISOString() }, null, 2)}\n`);
    return status;
  }
}

export async function readSimpleAppStatus(): Promise<SimpleAppStatus> {
  const { runtimePath } = await appPaths();
  return readStatus(runtimePath);
}

export async function readSimpleAppRuntime(name: 'app.js' | 'app.css'): Promise<Buffer> {
  const { projectPath, runtimePath } = await appPaths();
  const path = assertSimpleProjectChildPath(projectPath, join(runtimePath, name));
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (info.size > 8 * 1024 * 1024) throw new Error('Compiled interface exceeds 8 MB.');
    return await file.readFile();
  } finally { await file.close(); }
}

function validateState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Interface state must be an object.');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error('Interface state exceeds 512 KB.');
  return JSON.parse(encoded) as Record<string, unknown>;
}

export async function readSimpleAppState(): Promise<Record<string, unknown>> {
  const { statePath: path } = await appPaths();
  try { return validateState(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeSimpleAppState(value: unknown): Promise<{ success: true }> {
  const next = validateState(value);
  const { statePath: path } = await appPaths();
  await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return { success: true };
}

const stateUpdates = new Map<string, Promise<void>>();

export async function updateSimpleAppState(key: unknown, value: unknown): Promise<{ success: true }> {
  if (typeof key !== 'string' || !key.trim() || key.length > 200) throw new Error('Interface state key must be a non-empty string of at most 200 characters.');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new Error('Interface state value must be JSON serializable.');
  const { statePath } = await appPaths();
  const previous = stateUpdates.get(statePath) ?? Promise.resolve();
  const update = previous.catch(() => {}).then(async () => {
    let current: Record<string, unknown> = {};
    try { current = validateState(JSON.parse(await readFile(statePath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const next = validateState({ ...current, [key]: value });
    await atomicWrite(statePath, `${JSON.stringify(next, null, 2)}\n`);
  });
  stateUpdates.set(statePath, update);
  try {
    await update;
    return { success: true };
  } finally {
    if (stateUpdates.get(statePath) === update) stateUpdates.delete(statePath);
  }
}

function validateUiState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Interface UI state must be an object.');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_UI_STATE_BYTES) throw new Error('Interface UI state exceeds 256 KB.');
  return JSON.parse(encoded) as Record<string, unknown>;
}

export async function readSimpleAppUiState(): Promise<Record<string, unknown>> {
  const { uiStatePath } = await appPaths();
  try { return validateUiState(JSON.parse(await readFile(uiStatePath, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeSimpleAppUiState(value: unknown): Promise<{ success: true }> {
  const next = validateUiState(value);
  const { uiStatePath } = await appPaths();
  await atomicWrite(uiStatePath, `${JSON.stringify(next, null, 2)}\n`);
  return { success: true };
}

export async function resolveSimpleAppFile(inputPath: unknown): Promise<{ path: string; name: string; directory: boolean }> {
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('A file path is required.');
  const { projectPath } = await appPaths();
  const requested = resolve(projectPath, inputPath);
  const path = requested === resolve(projectPath)
    ? resolve(projectPath)
    : assertSimpleProjectChildPath(projectPath, requested);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('Symlinks are not allowed in an interface project.');
  if (!info.isFile() && !info.isDirectory()) throw new Error('The interface path is not a file or folder.');
  return { path, name: basename(path), directory: info.isDirectory() };
}

export async function recordSimpleAppRuntimeError(message: unknown): Promise<{ success: true }> {
  const text = String(message ?? 'Interface runtime error').slice(0, 4000);
  const { runtimePath } = await appPaths();
  await atomicWrite(join(runtimePath, 'runtime-error.json'), `${JSON.stringify({ error: text, at: new Date().toISOString() }, null, 2)}\n`);
  return { success: true };
}
