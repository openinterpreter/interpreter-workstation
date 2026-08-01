import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectWorkspaceType } from './workspaceTypeDetector';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe('detectWorkspaceType', () => {
  test('counts pdf files separately while still treating them as non-markdown files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-type-'));
    tempDirs.push(root);

    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'notes.md'), '# Notes\n', 'utf-8');
    await writeFile(join(root, 'docs', 'form.pdf'), '%PDF-1.4\n', 'utf-8');
    await writeFile(join(root, 'docs', 'report.pdf'), '%PDF-1.4\n', 'utf-8');
    await writeFile(join(root, 'docs', 'data.json'), '{}\n', 'utf-8');

    const report = detectWorkspaceType(root);

    expect(report.pdfFileCount).toBe(2);
    expect(report.markdownFileCount).toBe(1);
    expect(report.nonMarkdownFileCount).toBe(3);
    expect(report.kind).toBe('general');
  });
});
