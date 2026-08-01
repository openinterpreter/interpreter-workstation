import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { moveFile, renameFile } from './files';
import { setCurrentWorkspace } from '../utils/workspace';
import { getVaultNoteContext } from '../utils/vaultIndex';

const tempDirs: string[] = [];

afterEach(async () => {
  setCurrentWorkspace(null);
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe('vault-aware file operations', () => {
  test('renaming a markdown note rewrites incoming wikilinks', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-rename-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    const oldNotePath = join(workspacePath, 'Old Name.md');
    const referrerPath = join(workspacePath, 'Referrer.md');

    await writeFile(oldNotePath, '# Old Name\n', 'utf-8');
    await writeFile(referrerPath, 'Link: [[Old Name]]\n', 'utf-8');

    const result = await renameFile(oldNotePath, 'New Name.md');
    expect(result.success).toBe(true);

    const updatedReferrer = await readFile(referrerPath, 'utf-8');
    expect(updatedReferrer).toBe('Link: [[New Name]]\n');

    const context = await getVaultNoteContext(result.newPath!, workspacePath);
    expect(context.note?.backlinks).toEqual([
      {
        path: referrerPath,
        title: 'Referrer',
        relativePath: 'Referrer.md',
      },
    ]);
  });

  test('moving a markdown note rewrites path-based incoming wikilinks', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-move-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    await mkdir(join(workspacePath, 'wiki'), { recursive: true });
    await mkdir(join(workspacePath, 'archive'), { recursive: true });

    const sourcePath = join(workspacePath, 'wiki', 'topic.md');
    const destinationPath = join(workspacePath, 'archive', 'topic-renamed.md');
    const referrerPath = join(workspacePath, 'Referrer.md');

    await writeFile(sourcePath, '# Topic\n', 'utf-8');
    await writeFile(referrerPath, 'See [[wiki/topic]].\n', 'utf-8');

    const result = await moveFile(sourcePath, destinationPath);
    expect(result.success).toBe(true);

    const updatedReferrer = await readFile(referrerPath, 'utf-8');
    expect(updatedReferrer).toBe('See [[archive/topic-renamed]].\n');
  });

  test('renaming a self-linking markdown note succeeds without reopening the old path', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-self-link-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    const oldNotePath = join(workspacePath, 'Old Name.md');

    await writeFile(oldNotePath, '# Old Name\nSee [[Old Name]].\n', 'utf-8');

    const result = await renameFile(oldNotePath, 'New Name.md');
    expect(result.success).toBe(true);

    const renamedNote = await readFile(result.newPath!, 'utf-8');
    expect(renamedNote).toBe('# Old Name\nSee [[New Name]].\n');
  });

  test('renaming a markdown note rewrites incoming markdown file mentions', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-mention-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    const oldNotePath = join(workspacePath, 'Old Name.md');
    const referrerPath = join(workspacePath, 'Referrer.md');

    await writeFile(oldNotePath, '# Old Name\n', 'utf-8');
    await writeFile(
      referrerPath,
      [
        'Relative: [Old Name](Old Name.md)',
        `Absolute: [Old Name.md](${pathToFileURL(oldNotePath).toString()})`,
        'Custom: [Read this note](Old Name.md)',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await renameFile(oldNotePath, 'New Name.md');
    expect(result.success).toBe(true);

    const updatedReferrer = await readFile(referrerPath, 'utf-8');
    expect(updatedReferrer).toBe(
      [
        'Relative: [New Name](New Name.md)',
        `Absolute: [New Name.md](${pathToFileURL(result.newPath!).toString()})`,
        'Custom: [Read this note](New Name.md)',
        '',
      ].join('\n'),
    );
  });

  test('renaming a markdown note can leave references unchanged when updates are declined', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-decline-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    const oldNotePath = join(workspacePath, 'Old Name.md');
    const referrerPath = join(workspacePath, 'Referrer.md');

    await writeFile(oldNotePath, '# Old Name\n', 'utf-8');
    await writeFile(referrerPath, 'Wiki: [[Old Name]]\nMention: [Old Name](Old Name.md)\n', 'utf-8');

    const result = await renameFile(oldNotePath, 'New Name.md', { updateReferences: false });
    expect(result.success).toBe(true);

    const updatedReferrer = await readFile(referrerPath, 'utf-8');
    expect(updatedReferrer).toBe('Wiki: [[Old Name]]\nMention: [Old Name](Old Name.md)\n');
  });
});
