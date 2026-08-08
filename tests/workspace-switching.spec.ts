import { expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test } from './fixtures';
import { waitForAppReady } from './helpers';
import { sel } from './selectors';

const temporaryRoots: string[] = [];

test.afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootPath) => (
    rm(rootPath, { recursive: true, force: true })
  )));
});

async function apiRequest(
  page: import('@playwright/test').Page,
  method: string,
  requestPath: string,
  body?: unknown,
) {
  return await page.evaluate(async (request) => {
    return await (window as any).electron.apiRequest(request);
  }, { method, path: requestPath, body });
}

test('opens the workspace picker with an explicit note-workspace scan action', async ({ page }) => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'interpreter-workspace-picker-'));
  temporaryRoots.push(workspacePath);

  await waitForAppReady(page);
  const initialSet = await apiRequest(page, 'POST', '/api/workspace', { path: workspacePath });
  expect(initialSet.ok).toBe(true);

  await page.evaluate((selector) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (!button) {
      throw new Error('Workspace picker button is not mounted.');
    }
    button.click();
  }, sel('workspacePickerButton'));

  await expect(page.getByRole('button', { name: /Scan for note workspaces/i })).toBeVisible();
});

test('changes the window workspace while an existing agent remains bound to its original workspace', async ({ page }) => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'interpreter-workspace-switch-'));
  temporaryRoots.push(rootPath);
  const originalWorkspace = path.join(rootPath, 'original');
  const nextWorkspace = path.join(rootPath, 'next');
  await Promise.all([
    mkdir(originalWorkspace, { recursive: true }),
    mkdir(nextWorkspace, { recursive: true }),
  ]);

  await waitForAppReady(page);
  const initialSet = await apiRequest(page, 'POST', '/api/workspace', { path: originalWorkspace });
  expect(initialSet.ok).toBe(true);

  const existingAgent = await page.evaluate(() => {
    const layout = (window as any).__layoutContext?.getState?.();
    const tab = Object.values(layout?.tabs ?? {}).find((candidate: any) => candidate?.type === 'agent') as any;
    return tab
      ? { id: tab.id as string, callerToken: tab.agent.session.callerToken as string }
      : null;
  });
  expect(existingAgent).not.toBeNull();

  const bindResult = await page.evaluate(async ({ agent, workspacePath }) => {
    return await (window as any).electron.agentTabs.registerThread({
      agentId: agent.id,
      callerToken: agent.callerToken,
      threadId: 'workspace-switch-existing-thread',
      workspacePath,
    });
  }, { agent: existingAgent!, workspacePath: originalWorkspace });
  expect(bindResult.success).toBe(true);

  const switchResultPromise = page.evaluate(async (workspacePath) => {
    return await (window as any).electron.workspace.set({ workspacePath });
  }, nextWorkspace);

  await expect(page.getByRole('heading', { name: 'Change Workspace' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace Is Locked' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Workspace' }).click();

  await expect(switchResultPromise).resolves.toMatchObject({ success: true });
  await expect.poll(async () => {
    const response = await apiRequest(page, 'GET', '/api/workspace');
    return response.data?.workspace;
  }).toBe(nextWorkspace);

  const newAgentId = await page.evaluate(() => {
    return (window as any).__layoutContext?.openNewTab?.();
  });
  expect(typeof newAgentId).toBe('string');

  await expect.poll(async () => {
    return await page.evaluate(({ agentId, expectedWorkspace }) => {
      const layout = (window as any).__layoutContext?.getState?.();
      const newAgent = (layout?.tabs ?? {})[agentId];
      return newAgent?.agent?.runtime?.workspacePath === expectedWorkspace;
    }, { agentId: newAgentId, expectedWorkspace: nextWorkspace });
  }).toBe(true);
});
