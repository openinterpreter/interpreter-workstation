import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearConfigCache, getSimpleWorkspaceSetting, reloadConfig, setInterpreterHomeDir } from './configStore';
import {
  assertSimpleWorkspaceChildPath,
  getSimpleWorkspacePath,
  setSimpleWorkspacePath,
  validateSimpleWorkspacePath,
} from './simpleWorkspace';

describe('Simple workspace', () => {
  let temp: string;
  let originalHome: string | undefined;
  let originalInterpreterHome: string | undefined;
  let originalUserDataDir: string | undefined;
  let originalCodexHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'interpreter-simple-workspace-'));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    originalInterpreterHome = process.env.INTERPRETER_HOME;
    originalUserDataDir = process.env.INTERPRETER_USER_DATA_DIR;
    originalCodexHome = process.env.CODEX_HOME;
    process.env.HOME = temp;
    setInterpreterHomeDir(join(temp, 'config'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setInterpreterHomeDir(null);
    for (const [key, value] of Object.entries({
      HOME: originalHome,
      INTERPRETER_HOME: originalInterpreterHome,
      INTERPRETER_USER_DATA_DIR: originalUserDataDir,
      CODEX_HOME: originalCodexHome,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearConfigCache();
    rmSync(temp, { recursive: true, force: true });
  });

  test('first launch creates Documents/Interpreter and guidance; relaunch retains it', async () => {
    // Packaged applications can be launched with the user's home as cwd.
    process.chdir(temp);
    const expected = join(temp, 'Documents', 'Interpreter');
    expect(await getSimpleWorkspacePath(temp)).toBe(expected);
    const guidance = readFileSync(join(expected, 'AGENTS.md'), 'utf8');
    expect(guidance).toContain('standalone user-selected folder');
    expect(guidance).toContain('src/main.tsx');
    expect(guidance).toContain('@interpreter/simple-runtime/v1');
    expect(guidance).toContain('.interpreter/events.jsonl');
    expect(await getSimpleWorkspaceSetting()).toBe(expected);

    await reloadConfig();
    expect(await getSimpleWorkspacePath()).toBe(expected);
  });

  test('Settings changes persist, preserve user AGENTS, and keep Advanced selection separate', async () => {
    const first = await getSimpleWorkspacePath();
    const selected = join(temp, 'my projects');
    mkdirSync(selected);
    writeFileSync(join(selected, 'AGENTS.md'), 'keep my guidance\n');
    expect(await setSimpleWorkspacePath(selected)).toBe(selected);
    await reloadConfig();
    expect(await getSimpleWorkspacePath()).toBe(selected);
    expect(readFileSync(join(selected, 'AGENTS.md'), 'utf8')).toBe('keep my guidance\n');
    expect(await getSimpleWorkspaceSetting()).toBe(selected);
    expect(first).not.toBe(selected);
  });

  test('a deleted selected folder recovers to Documents/Interpreter on relaunch', async () => {
    const selected = join(temp, 'removable');
    mkdirSync(selected);
    await setSimpleWorkspacePath(selected);
    rmSync(selected, { recursive: true });
    await reloadConfig();
    const fallback = join(temp, 'Documents', 'Interpreter');
    expect(await getSimpleWorkspacePath(temp)).toBe(fallback);
    expect(await getSimpleWorkspaceSetting()).toBe(fallback);
  });

  test('rejects missing, relative, root, home, and sensitive configuration selections', async () => {
    const selected = join(temp, 'valid');
    mkdirSync(selected);
    await setSimpleWorkspacePath(selected);
    for (const rejected of ['relative', join(temp, 'missing'), temp, resolve('/'), join(temp, 'config')]) {
      await expect(setSimpleWorkspacePath(rejected)).rejects.toThrow();
    }
    expect(await getSimpleWorkspacePath()).toBe(selected);
  });

  test('rejects symlinks and traversal for generated interface files', () => {
    const root = join(temp, 'workspace');
    const elsewhere = join(temp, 'elsewhere');
    mkdirSync(root);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, 'link'));
    symlinkSync(elsewhere, join(temp, 'root-link'));
    symlinkSync(join(temp, 'missing'), join(root, 'dangling'));
    expect(() => validateSimpleWorkspacePath(join(temp, 'root-link'))).toThrow('symlink');
    expect(assertSimpleWorkspaceChildPath(root, 'interface/new.json')).toBe(join(root, 'interface', 'new.json'));
    for (const candidate of ['../outside.json', root, join(root, 'link', 'data.json'), join(root, 'dangling', 'data.json')]) {
      expect(() => assertSimpleWorkspaceChildPath(root, candidate)).toThrow();
    }
  });
});
