import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const showItemInFolderMock = mock((_path: string) => {});

mock.module('electron', () => ({
  app: {
    isPackaged: true,
  },
  shell: {
    showItemInFolder: showItemInFolderMock,
  },
}));

const { setCurrentWorkspace } = await import('../../../utils/workspace');
const { showInFolderTool } = await import('./showInFolderTool');

const tempDirs: string[] = [];

afterEach(async () => {
  showItemInFolderMock.mockClear();
  setCurrentWorkspace(null);
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe('showInFolderTool', () => {
  test('reveals an existing workspace-relative file', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'show-in-folder-tool-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    const filePath = join(workspacePath, 'report.pdf');
    await writeFile(filePath, 'placeholder', 'utf-8');

    const result = await showInFolderTool.handler({ path: 'report.pdf' });

    expect(result.isError).toBe(false);
    expect(String(result.content[0]?.text)).toContain(filePath);
    expect(showItemInFolderMock).toHaveBeenCalledWith(filePath);
  });

  test('fails cleanly when the target path does not exist', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'show-in-folder-tool-missing-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    const result = await showInFolderTool.handler({ path: 'missing.pdf' });

    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('Path not found');
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  test('reveals an existing workspace-relative folder', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'show-in-folder-tool-folder-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    const result = await showInFolderTool.handler({ path: '.' });

    expect(result.isError).toBe(false);
    expect(String(result.content[0]?.text)).toContain(workspacePath);
    expect(showItemInFolderMock).toHaveBeenCalledWith(workspacePath);
  });

  test('resolves relative paths against the agent workspace context', async () => {
    const globalWorkspacePath = await mkdtemp(join(tmpdir(), 'show-in-folder-tool-global-'));
    const agentWorkspacePath = await mkdtemp(join(tmpdir(), 'show-in-folder-tool-agent-'));
    tempDirs.push(globalWorkspacePath, agentWorkspacePath);
    setCurrentWorkspace(globalWorkspacePath);

    const globalFilePath = join(globalWorkspacePath, 'report.pdf');
    const agentFilePath = join(agentWorkspacePath, 'report.pdf');
    await writeFile(globalFilePath, 'global', 'utf-8');
    await writeFile(agentFilePath, 'agent', 'utf-8');

    const result = await showInFolderTool.handler(
      { path: 'report.pdf' },
      { workspace: agentWorkspacePath },
    );

    expect(result.isError).toBe(false);
    expect(String(result.content[0]?.text)).toContain(agentFilePath);
    expect(showItemInFolderMock).toHaveBeenCalledWith(agentFilePath);
    expect(showItemInFolderMock).not.toHaveBeenCalledWith(globalFilePath);
  });
});
