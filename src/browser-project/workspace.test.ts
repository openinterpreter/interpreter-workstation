import { expect, test } from 'bun:test';
import { resolveBrowserProjectWorkspace } from './workspace';
import { projectFilesWorkspaceCapability } from './workspace';
import { MemoryProjectFiles } from './project';

test('browser project directory is checked against the real bound ProjectFiles capability', async () => {
  const calls: string[] = [];
  const host = { workspacePath: 'browser-project:project_a', projectFiles: {
    isDirectory: async (path: string) => { calls.push(path); return true; },
  } };
  expect(await resolveBrowserProjectWorkspace(host, 'browser-project:project_a'))
    .toBe('browser-project:project_a');
  expect(calls).toEqual(['browser-project:project_a']);
  await expect(resolveBrowserProjectWorkspace(host, 'browser-project:other')).rejects.toThrow('does not match');
  await expect(resolveBrowserProjectWorkspace(host, '/tmp/native')).rejects.toThrow('does not match');
  expect(calls).toHaveLength(1);
});

test('missing OPFS project is not silently accepted or redirected to a native folder picker', async () => {
  const host = { workspacePath: 'browser-project:project_a', projectFiles: {
    isDirectory: async () => false,
  } };
  await expect(resolveBrowserProjectWorkspace(host, host.workspacePath)).rejects.toThrow('unavailable');
  await expect(resolveBrowserProjectWorkspace(host, null)).rejects.toThrow('does not match');
});

test('bound ProjectFiles adapter performs real project listing and denies another project', async () => {
  const files = new MemoryProjectFiles();
  let calls = 0;
  const list = files.list.bind(files);
  files.list = async () => { calls++; return list(); };
  const host = { workspacePath: 'browser-project:project_a',
    projectFiles: projectFilesWorkspaceCapability('project_a', files) };
  expect(await resolveBrowserProjectWorkspace(host, host.workspacePath)).toBe(host.workspacePath);
  expect(calls).toBe(1);
  expect(await host.projectFiles.isDirectory('browser-project:another')).toBe(false);
  expect(calls).toBe(1);
  files.list = async () => { throw new Error('Project storage unavailable'); };
  await expect(resolveBrowserProjectWorkspace(host, host.workspacePath)).rejects.toThrow('storage unavailable');
});
