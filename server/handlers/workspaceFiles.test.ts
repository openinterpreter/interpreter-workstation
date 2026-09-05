import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setCurrentWorkspace } from '../utils/workspace';
import {
  readWorkspaceTextFile,
  resolveReadableWorkspacePath,
  writeWorkspaceTextFile,
} from './workspaceFiles';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  setCurrentWorkspace(null);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workstation-files-'));
  temporaryDirectories.push(root);
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(workspace, 'inside.md'), 'inside', 'utf8');
  await writeFile(join(outside, 'outside.md'), 'outside', 'utf8');
  setCurrentWorkspace(workspace);
  return { root, workspace, outside };
}

describe('browser workspace file handlers', () => {
  test('reads and writes absolute or relative paths inside the configured workspace', async () => {
    const { workspace } = await fixture();

    expect(await readWorkspaceTextFile('inside.md')).toEqual({ content: 'inside' });
    expect(await readWorkspaceTextFile(join(workspace, 'inside.md'))).toEqual({ content: 'inside' });

    await writeWorkspaceTextFile(join(workspace, 'inside.md'), 'changed');
    expect(await readFile(join(workspace, 'inside.md'), 'utf8')).toBe('changed');
  });

  test('rejects traversal, outside absolute paths, and symlink escapes', async () => {
    const { workspace, outside } = await fixture();
    await symlink(outside, join(workspace, 'escape'));

    expect(() => resolveReadableWorkspacePath(join(outside, 'outside.md'))).toThrow('outside');
    expect(() => resolveReadableWorkspacePath('../outside/outside.md')).toThrow('outside');
    expect(() => resolveReadableWorkspacePath('escape/outside.md')).toThrow('outside');
    await expect(writeWorkspaceTextFile('escape/new.md', 'nope')).rejects.toThrow('outside');
  });
});
