import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertSimpleProjectChildPath, getActiveSimpleProject } from '../simpleProjects';

const MAX_STATE_BYTES = 512 * 1024;
const MAX_UI_STATE_BYTES = 256 * 1024;

export type SimpleAppStatus = {
  revision: string;
  sourceRevision: string;
  diagnostic: string | null;
  ready: boolean;
  runtimeUrl?: string | null;
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
