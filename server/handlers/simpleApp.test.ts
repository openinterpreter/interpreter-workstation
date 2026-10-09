import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache, setInterpreterHomeDir } from '../configStore';
import { getSimpleWorkspacePath } from '../simpleWorkspace';
import { createSimpleProject, getActiveSimpleProject } from '../simpleProjects';
import {
  packagedEsbuildBinaryPath,
  promoteSimpleApp,
  readSimpleAppRuntime,
  readSimpleAppState,
  readSimpleAppUiState,
  renameSimpleAppTempWithRetry,
  resolveSimpleAppFile,
  updateSimpleAppState,
  writeSimpleAppState,
  writeSimpleAppUiState,
} from './simpleApp';

describe('Windows interface promotion', () => {
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

  test('fails closed after bounded Windows retries and never retries unrelated errors', async () => {
    const locked = Object.assign(new Error('still locked'), { code: 'EACCES' });
    let attempts = 0;
    await expect(renameSimpleAppTempWithRetry('staged', 'last-good', async () => {
      attempts++;
      throw locked;
    }, 'win32', async () => {})).rejects.toBe(locked);
    expect(attempts).toBe(8);
    for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOENT']] as const) {
      let called = 0;
      await expect(renameSimpleAppTempWithRetry('staged', 'last-good', async () => {
        called++;
        throw Object.assign(new Error(code), { code });
      }, platform, async () => {})).rejects.toThrow(code);
      expect(called).toBe(1);
    }
  });
});

describe('packaged Simple compiler executable', () => {
  test('resolves the native platform package, not the esbuild JavaScript launcher', () => {
    expect(packagedEsbuildBinaryPath('/resources', 'win32', 'x64'))
      .toBe(join('/resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'));
    expect(packagedEsbuildBinaryPath('/resources', 'linux', 'x64'))
      .toBe(join('/resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild'));
    expect(packagedEsbuildBinaryPath('/resources', 'darwin', 'arm64'))
      .toBe(join('/resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'));
    expect(packagedEsbuildBinaryPath('/resources', 'freebsd', 'x64')).toBeNull();
  });
});

describe('Simple executable React app', () => {
  let temp: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'interpreter-simple-app-')));
    originalHome = process.env.HOME;
    process.env.HOME = temp;
    setInterpreterHomeDir(join(temp, 'config'));
  });

  afterEach(() => {
    setInterpreterHomeDir(null);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    clearConfigCache();
    rmSync(temp, { recursive: true, force: true });
  });

  test('compiles ordinary React source and preserves the last good app on a broken edit', async () => {
    await getSimpleWorkspacePath(temp);
    const first = await promoteSimpleApp();
    const projectPath = (await getActiveSimpleProject()).path;
    expect(first.ready).toBe(true);
    expect(first.diagnostic).toBeNull();
    expect((await readSimpleAppRuntime('app.js')).byteLength).toBeGreaterThan(1000);
    expect(readFileSync(join(projectPath, 'src', 'App.jsx'), 'utf8')).toContain('Drop something here, or ask Interpreter.');
    expect(readFileSync(join(projectPath, 'src', 'styles.css'), 'utf8')).toContain('min-height: 100dvh');

    writeFileSync(join(projectPath, 'src', 'App.jsx'), 'export default function App( {');
    const broken = await promoteSimpleApp();
    expect(broken.ready).toBe(true);
    expect(broken.revision).toBe(first.revision);
    expect(broken.diagnostic).toContain('Expected identifier');
    expect((await readSimpleAppRuntime('app.js')).byteLength).toBeGreaterThan(1000);
  });

  test('blocks Node imports and keeps interface state on disk', async () => {
    await getSimpleWorkspacePath(temp);
    await promoteSimpleApp();
    const projectPath = (await getActiveSimpleProject()).path;
    writeFileSync(join(projectPath, 'src', 'App.jsx'), "import fs from 'node:fs'; export default function App(){ return <div>{String(fs)}</div>; }");
    const blocked = await promoteSimpleApp();
    expect(blocked.ready).toBe(true);
    expect(blocked.diagnostic).toContain('External or Node import is not allowed');

    await writeSimpleAppState({ score: 12, nested: { theme: 'green' } });
    expect(await readSimpleAppState()).toEqual({ score: 12, nested: { theme: 'green' } });
    expect(JSON.parse(readFileSync(join(projectPath, '.interpreter', 'state.json'), 'utf8'))).toEqual({ score: 12, nested: { theme: 'green' } });
  });

  test('rejects absolute imports outside the project source without losing the last good interface', async () => {
    await getSimpleWorkspacePath(temp);
    const first = await promoteSimpleApp();
    const projectPath = (await getActiveSimpleProject()).path;
    const outside = join(projectPath, 'outside.jsx');
    writeFileSync(outside, 'export default function Outside() { return null; }');
    writeFileSync(join(projectPath, 'src', 'App.jsx'),
      `import Outside from ${JSON.stringify(outside)}; export default Outside;`);
    const blocked = await promoteSimpleApp();
    expect(blocked.ready).toBe(true);
    expect(blocked.revision).toBe(first.revision);
    expect(blocked.diagnostic).toContain('Import leaves interface/src');
  });

  test('serializes independent hook state updates and preserves state through failed revisions', async () => {
    const projectPath = join(temp, 'standalone-interface');
    mkdirSync(projectPath);
    await createSimpleProject(projectPath);
    const first = await promoteSimpleApp();
    expect((await readSimpleAppRuntime('app.js')).toString()).toContain('.state.update');
    await Promise.all([
      updateSimpleAppState('notes', 'draft'),
      updateSimpleAppState('filters', { open: true }),
      updateSimpleAppState('count', 2),
    ]);
    await writeSimpleAppUiState({
      controls: { notes: { value: 'draft', selectionStart: 5, selectionEnd: 5 } },
      scroll: { x: 0, y: 180 },
      active: 'notes',
    });

    writeFileSync(join(projectPath, 'src', 'App.jsx'), 'export default function App( {');
    const broken = await promoteSimpleApp();

    expect(broken.revision).toBe(first.revision);
    expect(await readSimpleAppState()).toEqual({ notes: 'draft', filters: { open: true }, count: 2 });
    expect(await readSimpleAppUiState()).toEqual({
      controls: { notes: { value: 'draft', selectionStart: 5, selectionEnd: 5 } },
      scroll: { x: 0, y: 180 },
      active: 'notes',
    });
    expect(JSON.parse(readFileSync(join(projectPath, '.interpreter', 'state.json'), 'utf8'))).toEqual({ notes: 'draft', filters: { open: true }, count: 2 });
    expect(JSON.parse(readFileSync(join(projectPath, '.interpreter', 'ui-state.json'), 'utf8'))).toEqual({
      controls: { notes: { value: 'draft', selectionStart: 5, selectionEnd: 5 } },
      scroll: { x: 0, y: 180 },
      active: 'notes',
    });
  });

  test('provides maintained React, file, focused-agent, and Motion libraries', async () => {
    await getSimpleWorkspacePath(temp);
    await promoteSimpleApp();
    const projectPath = (await getActiveSimpleProject()).path;
    writeFileSync(join(projectPath, 'src', 'App.jsx'), `
      import React from 'react';
      import { Page, Section, Card, Markdown, Button, FileViewer, Research, sendMessage } from '@interpreter/interface';
      import { AnimatedGroup, TextEffect } from '@interpreter/motion';
      export default function App() {
        return <Page><Section><AnimatedGroup><Card><TextEffect>Hello</TextEffect><Markdown>{'# Hello\\n\\n- one'}</Markdown><FileViewer path="AGENTS.md" /><Research query="Find a useful example" /><Button onClick={() => sendMessage('Continue')}>Continue</Button></Card></AnimatedGroup></Section></Page>;
      }
    `);
    const built = await promoteSimpleApp();
    expect(built.ready).toBe(true);
    expect(built.diagnostic).toBeNull();
    expect((await readSimpleAppRuntime('app.js')).toString()).toContain('react-markdown');
    expect((await readSimpleAppRuntime('app.css')).toString()).toContain('.io-markdown');
    expect((await readSimpleAppRuntime('app.css')).toString()).toContain('.io-card');
    expect((await readSimpleAppRuntime('app.js')).toString()).toContain('agent-run:');
    expect((await readSimpleAppRuntime('app.js')).toString()).toContain('function TextEffect');
    expect((await resolveSimpleAppFile('.')).directory).toBe(true);
  });

  test('compiles with app-shipped packages when the process cwd is outside the app', async () => {
    await getSimpleWorkspacePath(temp);
    const originalCwd = process.cwd();
    process.chdir(temp);
    try {
      const built = await promoteSimpleApp();
      expect(built.ready).toBe(true);
      expect(built.diagnostic).toBeNull();
      expect((await readSimpleAppRuntime('app.js')).byteLength).toBeGreaterThan(1000);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
