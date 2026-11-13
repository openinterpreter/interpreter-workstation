import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache, setInterpreterHomeDir } from '../configStore';
import { createSimpleProject } from '../simpleProjects';
import {
  readSimpleAppState,
  readSimpleAppUiState,
  renameSimpleAppTempWithRetry,
  resolveSimpleAppFile,
  seedSimpleApp,
  updateSimpleAppState,
  writeSimpleAppState,
  writeSimpleAppUiState,
} from './simpleApp';

describe('Windows project-state writes', () => {
  test('retries a temporary sharing denial without discarding the target', async () => {
    let attempts = 0;
    const waits: number[] = [];
    await renameSimpleAppTempWithRetry('staged', 'last-good', async (source, target) => {
      expect(source).toBe('staged');
      expect(target).toBe('last-good');
      if (++attempts < 3) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
    }, 'win32', async (ms) => { waits.push(ms); });
    expect(attempts).toBe(3);
    expect(waits).toEqual([20, 40]);
  });

  test('fails closed after bounded Windows retries', async () => {
    const locked = Object.assign(new Error('still locked'), { code: 'EACCES' });
    let attempts = 0;
    await expect(renameSimpleAppTempWithRetry('staged', 'last-good', async () => {
      attempts++;
      throw locked;
    }, 'win32', async () => {})).rejects.toBe(locked);
    expect(attempts).toBe(8);
  });
});

describe('durable Simple application state', () => {
  let temp: string;
  let projectPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'interpreter-simple-state-')));
    originalHome = process.env.HOME;
    process.env.HOME = temp;
    setInterpreterHomeDir(join(temp, 'config'));
    projectPath = join(temp, 'Interface');
    mkdirSync(projectPath);
    await createSimpleProject(projectPath);
    await seedSimpleApp();
  });

  afterEach(() => {
    setInterpreterHomeDir(null);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    clearConfigCache();
    rmSync(temp, { recursive: true, force: true });
  });

  test('serializes concurrent domain-state updates to the project directory', async () => {
    await writeSimpleAppState({ notes: 'first' });
    await Promise.all([
      updateSimpleAppState('notes', 'draft'),
      updateSimpleAppState('filters', { open: true }),
      updateSimpleAppState('count', 2),
    ]);

    expect(await readSimpleAppState()).toEqual({ notes: 'draft', filters: { open: true }, count: 2 });
    expect(JSON.parse(readFileSync(join(projectPath, '.interpreter', 'state.json'), 'utf8'))).toEqual({
      notes: 'draft', filters: { open: true }, count: 2,
    });
  });

  test('persists form values, selection, focus, and scroll separately from source edits', async () => {
    const uiState = {
      controls: { notes: { value: 'typing now', selectionStart: 10, selectionEnd: 10 } },
      scroll: { x: 0, y: 180 },
      active: 'notes',
    };
    await writeSimpleAppUiState(uiState);
    writeFileSync(join(projectPath, 'src', 'App.jsx'), 'export default function App(){ return <img alt="new image" />; }');

    expect(await readSimpleAppUiState()).toEqual(uiState);
    expect(JSON.parse(readFileSync(join(projectPath, '.interpreter', 'ui-state.json'), 'utf8'))).toEqual(uiState);
  });

  test('resolves project files inside the application directory', async () => {
    expect((await resolveSimpleAppFile('.')).directory).toBe(true);
    expect((await resolveSimpleAppFile('src/App.jsx')).name).toBe('App.jsx');
  });
});
