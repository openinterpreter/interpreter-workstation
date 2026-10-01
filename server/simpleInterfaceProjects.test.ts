import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SimpleInterfaceProjects } from './simpleInterfaceProjects';

const WINDOW_A = 'e789617d-032e-4412-87cc-99fbcf0953cb';
const WINDOW_B = '8b998041-3299-43c3-8cc0-49486998e6aa';
let scratch = '';
let control = '';
let projects: SimpleInterfaceProjects;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'simple-projects-'));
  control = join(scratch, 'control');
  await mkdir(control);
  projects = new SimpleInterfaceProjects(join(scratch, 'registry'), async () => control);
});
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

describe('ordinary standalone interface projects', () => {
  test('new, close and reopen preserve independent disk files and per-window project identity', async () => {
    const first = await projects.create(scratch, 'First', WINDOW_A);
    const second = await projects.create(scratch, 'Second', WINDOW_B);
    expect(first.path).not.toBe(second.path);
    expect(await projects.active(WINDOW_A)).toEqual(first);
    expect(await projects.active(WINDOW_B)).toEqual(second);
    expect(await readFile(join(first.path, 'src', 'main.tsx'), 'utf8')).toContain('createRoot');
    expect(await readFile(join(first.path, 'AGENTS.md'), 'utf8')).toContain('last working');
    await projects.close(WINDOW_A);
    expect(await projects.active(WINDOW_A)).toBeNull();
    const reopened = new SimpleInterfaceProjects(join(scratch, 'registry'), async () => control);
    expect(await reopened.open(first.path, WINDOW_A)).toEqual(first);
    expect(await reopened.active(WINDOW_A)).toEqual(first);
    expect(await reopened.active(WINDOW_B)).toEqual(second);
  });

  test('refuses the control workspace, nested projects, collisions and non-project folders', async () => {
    await expect(projects.create(control, 'Nested', WINDOW_A)).rejects.toThrow();
    const first = await projects.create(scratch, 'First', WINDOW_A);
    await expect(projects.create(first.path, 'Nested', WINDOW_B)).rejects.toThrow();
    await expect(projects.create(scratch, 'First', WINDOW_B)).rejects.toThrow();
    await expect(projects.open(control, WINDOW_B)).rejects.toThrow();
    await expect(projects.open(scratch, WINDOW_B)).rejects.toThrow();
  });

  test('refuses symlinks and stale or tampered project identities', async () => {
    const first = await projects.create(scratch, 'First', WINDOW_A);
    await symlink(first.path, join(scratch, 'alias'));
    await expect(projects.open(join(scratch, 'alias'), WINDOW_B)).rejects.toThrow('symlinks');
    await rm(join(first.path, '.interpreter-project.json'));
    await symlink(join(control, 'missing'), join(first.path, '.interpreter-project.json'));
    expect(await projects.resolve(first.id)).toBeNull();
    await expect(projects.open(first.path, WINDOW_B)).rejects.toThrow();
  });

  test('window identities must be opaque IDs, never object keys or paths', async () => {
    await expect(projects.create(scratch, 'First', '__proto__')).rejects.toThrow('window identity');
    await expect(projects.active('../../etc')).rejects.toThrow('window identity');
  });
});
