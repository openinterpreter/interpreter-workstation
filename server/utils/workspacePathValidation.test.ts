import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canWritePathInWorkspace } from './workspacePathValidation';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('canWritePathInWorkspace', () => {
  it('allows existing file writes when workspace and target use different canonical aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-path-check-'));
    tempDirs.push(root);

    const realWorkspace = join(root, 'real-workspace');
    const workspaceAlias = join(root, 'workspace-alias');
    mkdirSync(realWorkspace, { recursive: true });
    symlinkSync(realWorkspace, workspaceAlias);

    const existingFile = join(realWorkspace, 'note.md');
    writeFileSync(existingFile, 'hello');

    expect(canWritePathInWorkspace(existingFile, workspaceAlias)).toBe(true);
  });

  it('allows new file writes under workspace across canonical aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-path-check-'));
    tempDirs.push(root);

    const realWorkspace = join(root, 'real-workspace');
    const workspaceAlias = join(root, 'workspace-alias');
    mkdirSync(realWorkspace, { recursive: true });
    symlinkSync(realWorkspace, workspaceAlias);

    const newFilePath = join(realWorkspace, 'nested', 'deep', 'new.md');
    expect(canWritePathInWorkspace(newFilePath, workspaceAlias)).toBe(true);
  });

  it('allows new file writes via workspace-relative path construction', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-path-check-'));
    tempDirs.push(root);

    const realWorkspace = join(root, 'real-workspace');
    const workspaceAlias = join(root, 'workspace-alias');
    mkdirSync(realWorkspace, { recursive: true });
    symlinkSync(realWorkspace, workspaceAlias);

    const newFilePath = join(workspaceAlias, 'nested', 'deep', 'new.md');
    expect(canWritePathInWorkspace(newFilePath, workspaceAlias)).toBe(true);
  });

  it('denies writes through a symlink inside workspace pointing outside', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-path-check-'));
    tempDirs.push(root);

    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'sensitive');

    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'evil-link'));

    expect(canWritePathInWorkspace(join(workspace, 'evil-link'), workspace)).toBe(false);
  });

  it('denies writes outside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-path-check-'));
    tempDirs.push(root);

    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const outsideFile = join(outside, 'note.md');
    writeFileSync(outsideFile, 'x');

    expect(canWritePathInWorkspace(outsideFile, workspace)).toBe(false);
  });
});

