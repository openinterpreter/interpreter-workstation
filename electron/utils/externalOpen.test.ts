import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyExternalOpenPath,
  createExternalAskRequest,
  findExternalAskTargetsInArgv,
  findExternalOpenTargetInArgv,
  isSupportedExternalFilePath,
  resolveFolderOpenWindowTarget,
} from './externalOpen';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'interpreter-external-open-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('externalOpen helpers', () => {
  test('detects supported files case-insensitively', () => {
    expect(isSupportedExternalFilePath('/tmp/report.PDF')).toBe(true);
    expect(isSupportedExternalFilePath('/tmp/report.txt')).toBe(false);
  });

  test('classifies supported files and folders, but ignores unsupported files', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'notes.md');
    const unsupportedPath = join(dir, 'notes.txt');
    const folderPath = join(dir, 'workspace');
    const relativeFilePath = relative(process.cwd(), filePath);

    writeFileSync(filePath, '# notes\n');
    writeFileSync(unsupportedPath, 'plain text\n');
    mkdirSync(folderPath);

    expect(classifyExternalOpenPath(filePath)).toEqual({ kind: 'file', path: filePath });
    expect(classifyExternalOpenPath(folderPath)).toEqual({ kind: 'folder', path: folderPath });
    expect(classifyExternalOpenPath(relativeFilePath)).toEqual({ kind: 'file', path: filePath });
    expect(classifyExternalOpenPath(unsupportedPath)).toBeNull();
  });

  test('finds the first supported external open target in argv', () => {
    const dir = makeTempDir();
    const folderPath = join(dir, 'workspace');
    mkdirSync(folderPath);

    expect(findExternalOpenTargetInArgv(['--flag', 'workstation://oauth', folderPath])).toEqual({
      kind: 'folder',
      path: folderPath,
    });
  });

  test('finds external ask targets after the ask flag', () => {
    expect(findExternalAskTargetsInArgv([
      '--some-electron-flag',
      '--ask',
      '/workspace/a.txt',
      'workstation://oauth',
      '--not-a-path',
      '/workspace/b.txt',
    ])).toEqual(['/workspace/a.txt', '/workspace/b.txt']);
  });

  test('creates an external ask request with a common parent workspace and friendly file labels', () => {
    const dir = makeTempDir();
    const folderPath = join(dir, 'project');
    const nestedFolderPath = join(folderPath, 'docs');
    const filePath = join(folderPath, 'notes.pdf');
    const nestedFilePath = join(nestedFolderPath, 'brief.pdf');

    mkdirSync(nestedFolderPath, { recursive: true });
    writeFileSync(filePath, 'notes\n');
    writeFileSync(nestedFilePath, 'pdf-ish\n');

    const request = createExternalAskRequest([filePath, nestedFilePath, nestedFolderPath]);

    expect(request?.workspacePath).toBe(folderPath);
    expect(request?.targets).toEqual([
      { kind: 'file', path: filePath },
      { kind: 'file', path: nestedFilePath },
      { kind: 'folder', path: nestedFolderPath },
    ]);
    expect(request?.prompt).toContain('Please help me edit these files and folders');
    expect(request?.prompt).toContain(`[notes.pdf](${filePath})`);
    expect(request?.prompt).toContain(`[brief.pdf](${nestedFilePath})`);
    expect(request?.prompt).toContain(`[docs](${nestedFolderPath})`);
  });

  test('uses a selected folder itself as the workspace for external ask', () => {
    const dir = makeTempDir();
    const folderPath = join(dir, 'project');

    mkdirSync(folderPath);

    expect(createExternalAskRequest([folderPath])?.workspacePath).toBe(folderPath);
  });

  test('describes homogeneous selections with user-facing nouns', () => {
    const dir = makeTempDir();
    const pdfA = join(dir, 'a.pdf');
    const pdfB = join(dir, 'b.pdf');
    const folderPath = join(dir, 'folder');
    writeFileSync(pdfA, 'a\n');
    writeFileSync(pdfB, 'b\n');
    mkdirSync(folderPath);

    expect(createExternalAskRequest([pdfA, pdfB])?.prompt).toContain('Please help me edit these PDFs');
    expect(createExternalAskRequest([pdfA])?.prompt).toContain('Please help me edit this PDF');
    expect(createExternalAskRequest([folderPath])?.prompt).toContain('Please help me edit this folder');
  });

  test('prefers the focused Interpreter window for folder opens when available', () => {
    expect(resolveFolderOpenWindowTarget({
      workspacePath: '/workspace/wiki',
      focusedWindowId: 42,
      windowSessions: [
        { windowId: 7, workspacePath: '/workspace/wiki' },
      ],
    })).toEqual({
      kind: 'focused-window',
      windowId: 42,
    });
  });

  test('reuses an existing window for the same workspace when no window is focused', () => {
    expect(resolveFolderOpenWindowTarget({
      workspacePath: '/workspace/wiki',
      focusedWindowId: null,
      windowSessions: [
        { windowId: 7, workspacePath: '/workspace/notes' },
        { windowId: 9, workspacePath: '/workspace/wiki' },
      ],
    })).toEqual({
      kind: 'existing-workspace-window',
      windowId: 9,
    });
  });

  test('opens a new window when no focused window or workspace match exists', () => {
    expect(resolveFolderOpenWindowTarget({
      workspacePath: '/workspace/wiki',
      focusedWindowId: null,
      windowSessions: [
        { windowId: 7, workspacePath: '/workspace/notes' },
      ],
    })).toEqual({
      kind: 'new-window',
    });
  });
});
