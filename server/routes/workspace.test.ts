import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildFileTree,
  buildWorkspaceContentSearchSnippet,
  normalizeWorkspaceContentSearchQuery,
  resolveWikilinkPathInWorkspace,
} from './workspace';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe('buildFileTree', () => {
  test('includes the workspace skills directory in the explorer tree', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-route-'));
    tempDirs.push(workspacePath);

    await mkdir(join(workspacePath, 'skills', 'copywriting'), { recursive: true });
    await mkdir(join(workspacePath, 'docs'), { recursive: true });
    await writeFile(join(workspacePath, 'README.md'), '# test\n', 'utf-8');

    const tree = await buildFileTree(workspacePath, workspacePath, 0, 1, false);

    expect(tree.map((entry) => entry.path)).toEqual([
      'docs',
      'skills',
      'README.md',
    ]);
    expect(tree.find((entry) => entry.path === 'skills')).toEqual({
      name: 'skills',
      path: 'skills',
      type: 'directory',
      children: [
        {
          name: 'copywriting',
          path: 'skills/copywriting',
          type: 'directory',
          children: undefined,
        },
      ],
    });
  });

  test('marks runnable node web app folders in the workspace tree', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-route-'));
    tempDirs.push(workspacePath);

    await mkdir(join(workspacePath, 'graph-app'), { recursive: true });
    await writeFile(join(workspacePath, 'graph-app', 'package.json'), JSON.stringify({
      name: 'graph-app',
      private: true,
      scripts: {
        start: 'node server.mjs',
      },
    }, null, 2), 'utf-8');

    const tree = await buildFileTree(workspacePath, workspacePath, 0, 1, false);

    expect(tree).toEqual([
      {
        name: 'graph-app',
        path: 'graph-app',
        type: 'directory',
        runnableProject: {
          kind: 'node-web-app',
          runScript: 'start',
        },
        children: [
          {
            name: 'package.json',
            path: 'graph-app/package.json',
            type: 'file',
            mtime: expect.any(Number),
          },
        ],
      },
    ]);
  });
});

describe('resolveWikilinkPathInWorkspace', () => {
  test('resolves .markdown notes without requiring the extension', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-route-'));
    tempDirs.push(workspacePath);

    const notePath = join(workspacePath, 'Page.markdown');
    await writeFile(notePath, '# page\n', 'utf-8');

    expect(resolveWikilinkPathInWorkspace(workspacePath, 'Page')).toBe(notePath);
  });

  test('resolves nested .markdown wikilinks with path segments', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-route-'));
    tempDirs.push(workspacePath);

    await mkdir(join(workspacePath, 'wiki', 'costs'), { recursive: true });
    const notePath = join(workspacePath, 'wiki', 'costs', 'cost_model.markdown');
    await writeFile(notePath, '# costs\n', 'utf-8');

    expect(resolveWikilinkPathInWorkspace(workspacePath, 'wiki/costs/cost_model')).toBe(notePath);
  });

  test('resolves human-readable wikilinks to hyphen-case basenames', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-route-'));
    tempDirs.push(workspacePath);

    await mkdir(join(workspacePath, 'wiki', 'concepts'), { recursive: true });
    const notePath = join(workspacePath, 'wiki', 'concepts', 'persistent-wiki.md');
    await writeFile(notePath, '# Persistent Wiki\n', 'utf-8');

    expect(resolveWikilinkPathInWorkspace(workspacePath, 'Persistent Wiki')).toBe(notePath);
  });

  test('prefers the intended relative path when spaces map to hyphen-case segments', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-route-'));
    tempDirs.push(workspacePath);

    await mkdir(join(workspacePath, 'archive'), { recursive: true });
    await writeFile(join(workspacePath, 'archive', 'Persistent Wiki.md'), '# Archive\n', 'utf-8');
    await mkdir(join(workspacePath, 'wiki', 'concepts'), { recursive: true });
    const notePath = join(workspacePath, 'wiki', 'concepts', 'persistent-wiki.md');
    await writeFile(notePath, '# Persistent Wiki\n', 'utf-8');

    expect(resolveWikilinkPathInWorkspace(workspacePath, 'wiki/concepts/Persistent Wiki')).toBe(notePath);
  });
});

describe('normalizeWorkspaceContentSearchQuery', () => {
  test('leaves ordinary content searches unchanged', () => {
    expect(normalizeWorkspaceContentSearchQuery('NotebookLM')).toBe('NotebookLM');
  });

  test('normalizes tag aliases to inline markdown tags', () => {
    expect(normalizeWorkspaceContentSearchQuery('tag:wiki')).toBe('#wiki');
    expect(normalizeWorkspaceContentSearchQuery('tag:#wiki')).toBe('#wiki');
  });
});

describe('buildWorkspaceContentSearchSnippet', () => {
  test('preserves shorter matching lines intact', () => {
    expect(buildWorkspaceContentSearchSnippet('NotebookLM is here', 'NotebookLM', 20)).toBe('NotebookLM is here');
  });

  test('keeps deep matches visible inside long lines', () => {
    const longLine = `${'A'.repeat(420)} NotebookLM ${'B'.repeat(120)}`;
    const snippet = buildWorkspaceContentSearchSnippet(longLine, 'NotebookLM', 80);

    expect(snippet.length).toBeLessThanOrEqual(80);
    expect(snippet).toContain('NotebookLM');
  });
});
