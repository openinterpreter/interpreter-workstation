import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForNoteWorkspaces } from './noteWorkspaceScanner';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe('scanForNoteWorkspaces', () => {
  test('detects marker-based note workspaces for supported apps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'note-workspaces-'));
    tempDirs.push(root);

    const obsidianVault = join(root, 'obsidian-vault');
    await mkdir(join(obsidianVault, '.obsidian'), { recursive: true });

    const logseqGraph = join(root, 'logseq-graph');
    await mkdir(join(logseqGraph, 'logseq'), { recursive: true });
    await mkdir(join(logseqGraph, 'pages'), { recursive: true });
    await writeFile(join(logseqGraph, 'pages', 'home.md'), '# Home\n', 'utf-8');

    const dendronWorkspace = join(root, 'dendron-space');
    await mkdir(dendronWorkspace, { recursive: true });
    await writeFile(join(dendronWorkspace, 'dendron.yml'), 'version: 1\n', 'utf-8');

    const foamWorkspace = join(root, 'foam-space');
    await mkdir(join(foamWorkspace, '.foam', 'templates'), { recursive: true });
    await writeFile(join(foamWorkspace, 'notes.md'), '# Notes\n', 'utf-8');

    expect(scanForNoteWorkspaces({ candidateRoots: [root] })).toEqual([
      {
        path: obsidianVault,
        name: 'obsidian-vault',
        source: 'obsidian',
      },
      {
        path: logseqGraph,
        name: 'logseq-graph',
        source: 'logseq',
      },
      {
        path: dendronWorkspace,
        name: 'dendron-space',
        source: 'dendron',
      },
      {
        path: foamWorkspace,
        name: 'foam-space',
        source: 'foam',
      },
    ]);
  });

  test('ignores plain markdown folders without a supported app marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'note-workspaces-'));
    tempDirs.push(root);

    const markdownFolder = join(root, 'notes');
    await mkdir(markdownFolder, { recursive: true });
    await writeFile(join(markdownFolder, 'journal.md'), '# Journal\n', 'utf-8');
    await writeFile(join(markdownFolder, 'ideas.md'), '# Ideas\n', 'utf-8');

    expect(scanForNoteWorkspaces({ candidateRoots: [root] })).toEqual([]);
  });
});
