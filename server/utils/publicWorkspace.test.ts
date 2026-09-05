import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  listPublicWorkspace,
  publicWorkspaceMimeType,
  resolvePublicWorkspaceEntry,
  validatePublicWorkspacePath,
} from './publicWorkspace';

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'public-workspace-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('public workspace boundary', () => {
  test('normalizes only relative public paths', () => {
    expect(validatePublicWorkspacePath('papers/00001/')).toBe('papers/00001');
    expect(validatePublicWorkspacePath('')).toBe('');
    expect(() => validatePublicWorkspacePath('../private')).toThrow('Invalid workspace path.');
    expect(() => validatePublicWorkspacePath('/workspace/private')).toThrow('Invalid workspace path.');
  });

  test('returns lazy, relative directory listings with capabilities', async () => {
    await withWorkspace(async (root) => {
      await mkdir(path.join(root, 'papers'));
      await writeFile(path.join(root, 'manifest.json'), '{}');

      const listing = await listPublicWorkspace(root, '', 'Translations');

      expect(listing.name).toBe('Translations');
      expect(listing.capabilities).toEqual(['browse', 'read']);
      expect(listing.entries.map(({ name, path: entryPath, type }) => ({ name, path: entryPath, type }))).toEqual([
        { name: 'papers', path: 'papers', type: 'directory' },
        { name: 'manifest.json', path: 'manifest.json', type: 'file' },
      ]);
    });
  });

  test('does not list symlinks and rejects a direct symlink escape', async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(path.join(tmpdir(), 'public-workspace-outside-'));
      try {
        await writeFile(path.join(outside, 'secret.txt'), 'secret');
        await symlink(outside, path.join(root, 'outside'));

        const listing = await listPublicWorkspace(root, '');
        expect(listing.entries).toEqual([]);
        await expect(resolvePublicWorkspaceEntry(root, 'outside/secret.txt')).rejects.toThrow(
          'Workspace symlinks cannot leave the public root.',
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('uses an allowlisted preview MIME type', () => {
    expect(publicWorkspaceMimeType('translated.PDF')).toBe('application/pdf');
    expect(publicWorkspaceMimeType('notes.md')).toBe('text/markdown; charset=utf-8');
    expect(publicWorkspaceMimeType('page.html')).toBe('application/octet-stream');
  });
});
