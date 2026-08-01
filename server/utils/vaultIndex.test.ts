import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyPreparedVaultRename,
  getVaultLintReport,
  getVaultNoteContext,
  getVaultSnapshot,
  getVaultTagSummaries,
  prepareVaultRename,
  resolveVaultWikilinkPath,
  searchVaultNotes,
} from './vaultIndex';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe('vaultIndex', () => {
  test('builds note context with tags, backlinks, and broken links', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-index-'));
    tempDirs.push(workspacePath);

    await mkdir(join(workspacePath, 'wiki'), { recursive: true });

    const alphaPath = join(workspacePath, 'Alpha Note.md');
    const betaPath = join(workspacePath, 'wiki', 'Beta Note.markdown');

    await writeFile(alphaPath, `---
title: Alpha Note
aliases:
  - Alpha
tags:
  - research
---

# Alpha Note

Links to [[wiki/Beta Note]] and [[Missing Page]].

#deep-work
`, 'utf-8');

    await writeFile(betaPath, '# Beta Note\n', 'utf-8');

    const snapshot = await getVaultSnapshot(workspacePath);
    expect(snapshot.noteCount).toBe(2);
    expect(snapshot.tagCount).toBe(2);

    const alpha = snapshot.notes.find((note) => note.path === alphaPath);
    const beta = snapshot.notes.find((note) => note.path === betaPath);

    expect(alpha?.aliases).toEqual(['Alpha']);
    expect(alpha?.tags).toEqual(['deep-work', 'research']);
    expect(alpha?.outgoingLinks).toEqual([
      {
        target: 'wiki/Beta Note',
        fragment: null,
        display: null,
        resolvedPath: betaPath,
        resolvedLabel: 'Beta Note',
        resolvedRelativePath: 'wiki/Beta Note.markdown',
      },
    ]);
    expect(alpha?.brokenLinks).toEqual([
      {
        target: 'Missing Page',
        fragment: null,
        display: null,
      },
    ]);

    expect(beta?.backlinks).toEqual([
      {
        path: alphaPath,
        title: 'Alpha Note',
        relativePath: 'Alpha Note.md',
      },
    ]);
  });

  test('searches notes by alias and title', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-index-search-'));
    tempDirs.push(workspacePath);

    const notePath = join(workspacePath, 'Persistent Wiki.md');
    await writeFile(notePath, `---
aliases:
  - PKB
---

# Persistent Wiki
#notes
`, 'utf-8');

    const byAlias = await searchVaultNotes('pkb', { workspacePath });
    expect(byAlias.results[0]?.path).toBe(notePath);

    expect(await resolveVaultWikilinkPath('PKB', workspacePath)).toBe(notePath);

    const byTitle = await searchVaultNotes('persistent', { workspacePath });
    expect(byTitle.results[0]?.path).toBe(notePath);

    const byTag = await searchVaultNotes('tag:notes', { workspacePath });
    expect(byTag.results[0]?.path).toBe(notePath);

    const context = await getVaultNoteContext(notePath, workspacePath);
    expect(context.note?.title).toBe('Persistent Wiki');
  });

  test('builds tag summaries and lint report', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-index-lint-'));
    tempDirs.push(workspacePath);

    await writeFile(join(workspacePath, 'Alpha.md'), '# Alpha\n#research\n[[Missing Page]]\n', 'utf-8');
    await writeFile(join(workspacePath, 'Beta.md'), '# Beta\n#research\n', 'utf-8');

    const tags = await getVaultTagSummaries({ workspacePath });
    expect(tags.tags[0]).toMatchObject({
      tag: 'research',
      noteCount: 2,
    });

    const report = await getVaultLintReport({ workspacePath });
    expect(report.orphanNotes).toHaveLength(2);
    expect(report.danglingLinks[0]?.target).toBe('Missing Page');
    expect(report.tags[0]).toMatchObject({
      tag: 'research',
      noteCount: 2,
    });
  });

  test('rewrites the moved note relative markdown links after a cross-folder move', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-index-move-'));
    tempDirs.push(workspacePath);

    await mkdir(join(workspacePath, 'docs'), { recursive: true });
    await mkdir(join(workspacePath, 'wiki'), { recursive: true });

    const sourcePath = join(workspacePath, 'docs', 'A.md');
    const destinationPath = join(workspacePath, 'wiki', 'A.md');
    await writeFile(join(workspacePath, 'docs', 'b.md'), '# B\n', 'utf-8');
    await writeFile(sourcePath, '# A\n\n[B](b.md)\n', 'utf-8');

    const preparedRename = await prepareVaultRename(sourcePath, workspacePath);
    await writeFile(destinationPath, '# A\n\n[B](b.md)\n', 'utf-8');

    await applyPreparedVaultRename(preparedRename, destinationPath);

    const updated = await readFile(destinationPath, 'utf-8');
    expect(updated).toContain('[B](../docs/b.md)');
  });

  test('prepareVaultRename reuses cached note references without rereading unrelated notes', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-index-rename-'));
    tempDirs.push(workspacePath);

    const sourcePath = join(workspacePath, 'Alpha.md');
    const referrerPath = join(workspacePath, 'Referrer.md');
    const unrelatedPath = join(workspacePath, 'Unrelated.md');

    await writeFile(sourcePath, '# Alpha\n\n[Self](Alpha.md)\n', 'utf-8');
    await writeFile(referrerPath, '# Referrer\n\n[[Alpha]]\n\n[Alpha](Alpha.md)\n', 'utf-8');
    await writeFile(unrelatedPath, '# Unrelated\n', 'utf-8');

    await getVaultSnapshot(workspacePath);
    await chmod(unrelatedPath, 0o000);

    try {
      const preparedRename = await prepareVaultRename(sourcePath, workspacePath);
      expect(preparedRename).not.toBeNull();
      expect(preparedRename?.rewriteDestinationPath).toBe(true);
      expect(preparedRename?.referringPaths).toEqual([referrerPath]);
    } finally {
      await chmod(unrelatedPath, 0o644).catch(() => {});
    }
  });
});
