import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emitEventMock = mock(async () => {});

mock.module('../../../utils/ipcBridge', () => ({
  emitEvent: emitEventMock,
  emitAppToast: mock(() => {}),
}));

const { IPC_CHANNELS } = await import('../../../../electron/ipc/registry');
const { setCurrentWorkspace } = await import('../../../utils/workspace');
const { refreshFileTool } = await import('./refreshFileTool');

const tempDirs: string[] = [];

afterEach(async () => {
  emitEventMock.mockClear();
  setCurrentWorkspace(null);
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe('refreshFileTool', () => {
  test('emits FILE_REFRESHED for an existing workspace file', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'refresh-file-tool-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    const filePath = join(workspacePath, 'report.xlsx');
    await writeFile(filePath, 'placeholder', 'utf-8');

    const result = await refreshFileTool.handler({ path: 'report.xlsx' });
    expect(result.isError).toBe(false);
    expect(String(result.content[0]?.text)).toContain(filePath);
    expect(emitEventMock).toHaveBeenCalledWith(IPC_CHANNELS.FILE_REFRESHED, { filePath });
  });

  test('fails cleanly when the target file does not exist', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'refresh-file-tool-missing-'));
    tempDirs.push(workspacePath);
    setCurrentWorkspace(workspacePath);

    const result = await refreshFileTool.handler({ path: 'missing.xlsx' });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('File not found');
    expect(emitEventMock).not.toHaveBeenCalled();
  });

  test('resolves relative paths against the agent workspace context', async () => {
    const globalWorkspacePath = await mkdtemp(join(tmpdir(), 'refresh-file-tool-global-'));
    const agentWorkspacePath = await mkdtemp(join(tmpdir(), 'refresh-file-tool-agent-'));
    tempDirs.push(globalWorkspacePath, agentWorkspacePath);
    setCurrentWorkspace(globalWorkspacePath);

    const globalFilePath = join(globalWorkspacePath, 'report.xlsx');
    const agentFilePath = join(agentWorkspacePath, 'report.xlsx');
    await writeFile(globalFilePath, 'global', 'utf-8');
    await writeFile(agentFilePath, 'agent', 'utf-8');

    const result = await refreshFileTool.handler(
      { path: 'report.xlsx' },
      { workspace: agentWorkspacePath },
    );

    expect(result.isError).toBe(false);
    expect(String(result.content[0]?.text)).toContain(agentFilePath);
    expect(emitEventMock).toHaveBeenCalledWith(IPC_CHANNELS.FILE_REFRESHED, { filePath: agentFilePath });
    expect(emitEventMock).not.toHaveBeenCalledWith(IPC_CHANNELS.FILE_REFRESHED, { filePath: globalFilePath });
  });
});
