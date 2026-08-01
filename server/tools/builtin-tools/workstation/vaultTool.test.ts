import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setCurrentWorkspace } from '../../../utils/workspace';
import { vaultTool } from './vaultTool';

const tempDirs: string[] = [];

afterEach(async () => {
  setCurrentWorkspace(null);
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe('vaultTool', () => {
  test('searches notes by tag and lists matching notes', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-tool-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    await writeFile(join(workspacePath, 'Alpha.md'), '# Alpha\n#research\n', 'utf-8');
    await writeFile(join(workspacePath, 'Beta.md'), '# Beta\n#ops\n', 'utf-8');

    const searchResult = await vaultTool.handler({
      action: 'search_notes',
      query: 'tag:research',
    });
    expect(searchResult.isError).toBe(false);
    const searchPayload = JSON.parse(String(searchResult.content[0]?.text));
    expect(searchPayload.results).toHaveLength(1);
    expect(searchPayload.results[0]?.relativePath).toBe('Alpha.md');

    const taggedResult = await vaultTool.handler({
      action: 'notes_with_tag',
      tag: 'research',
    });
    expect(taggedResult.isError).toBe(false);
    const taggedPayload = JSON.parse(String(taggedResult.content[0]?.text));
    expect(taggedPayload.noteCount).toBe(1);
    expect(taggedPayload.notes[0]?.relativePath).toBe('Alpha.md');
  });

  test('returns a structural lint report for the current workspace', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'vault-tool-lint-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    await mkdir(join(workspacePath, 'wiki'), { recursive: true });
    await writeFile(join(workspacePath, 'Index.md'), 'Links: [[Missing Page]]\n', 'utf-8');
    await writeFile(join(workspacePath, 'wiki', 'Lonely.md'), '# Lonely\n', 'utf-8');

    const result = await vaultTool.handler({ action: 'lint' });
    expect(result.isError).toBe(false);

    const payload = JSON.parse(String(result.content[0]?.text));
    expect(payload.orphanNotes.some((note: { relativePath: string }) => note.relativePath === 'Index.md')).toBe(true);
    expect(payload.isolatedNotes.some((note: { relativePath: string }) => note.relativePath === 'wiki/Lonely.md')).toBe(true);
    expect(payload.danglingLinks[0]?.target).toBe('Missing Page');
    expect(payload.danglingLinks[0]?.referenceCount).toBe(1);
  });
});
