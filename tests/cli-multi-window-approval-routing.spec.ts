import { type Page, type ElectronApplication } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  getServerPort,
  getTestWorkspace,
  waitForAppReady,
} from './helpers';
import { sel } from './selectors';

type BoundAgentTab = {
  id: string;
  callerToken: string;
  threadId: string;
};

type CliToolResponse = {
  ok: boolean;
  status: number;
  data: any;
};

async function isRendererWindow(page: Page): Promise<boolean> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 1000 });
    return await page.evaluate(() => {
      return Boolean(
        document.getElementById('root')
        && (window as any).electron?.getWindowSessionKey,
      );
    });
  } catch {
    return false;
  }
}

async function getRendererWindows(electronApp: ElectronApplication): Promise<Page[]> {
  const windows = electronApp.windows();
  const result: Page[] = [];
  for (const candidate of windows) {
    if (await isRendererWindow(candidate)) {
      result.push(candidate);
    }
  }
  return result;
}

async function waitForRendererWindowCount(
  electronApp: ElectronApplication,
  count: number,
): Promise<Page[]> {
  await expect.poll(async () => {
    return (await getRendererWindows(electronApp)).length;
  }, { timeout: 30000 }).toBe(count);

  return await getRendererWindows(electronApp);
}

async function waitForWindowReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="editor-layout"]', { timeout: 30000 });
  await expect.poll(async () => {
    return await page.evaluate(() => {
      return Boolean(
        (window as any).electron?.getWindowSessionKey?.()
        && (window as any).__layoutContext?.getState?.(),
      );
    });
  }, { timeout: 30000 }).toBe(true);
}

async function getWindowSessionKey(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    return (window as any).electron?.getWindowSessionKey?.() ?? null;
  });
}

async function createAdditionalWindow(page: Page, electronApp: ElectronApplication): Promise<Page> {
  const existingWindows = await getRendererWindows(electronApp);
  const existingSessionKeys = new Set(
    (
      await Promise.all(
        existingWindows.map(async (candidate) => await getWindowSessionKey(candidate)),
      )
    ).filter((sessionKey): sessionKey is string => Boolean(sessionKey)),
  );
  const expectedRendererWindowCount = existingWindows.length + 1;

  await page.evaluate(async () => {
    const result = await (window as any).electron.window.create();
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to create new window');
    }
  });

  const windows = await waitForRendererWindowCount(electronApp, expectedRendererWindowCount);
  for (const candidate of windows) {
    const sessionKey = await getWindowSessionKey(candidate);
    if (sessionKey && !existingSessionKeys.has(sessionKey)) {
      await waitForWindowReady(candidate);
      return candidate;
    }
  }

  throw new Error('Failed to identify the newly created renderer window');
}

async function apiRequestInWindow(
  page: Page,
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  return await page.evaluate(async (request) => {
    return await (window as any).electron.apiRequest(request);
  }, {
    method,
    path: requestPath,
    body,
  });
}

async function setWorkspaceForWindow(page: Page, workspacePath: string): Promise<void> {
  const response = await apiRequestInWindow(page, 'POST', '/api/workspace', { path: workspacePath });
  expect(response.ok).toBe(true);
}

async function getEditorAgentTabs(page: Page): Promise<Array<{ id: string; callerToken: string }>> {
  return await page.evaluate(() => {
    const layout = (window as any).__layoutContext?.getState?.();
    if (!layout) {
      return [];
    }

    const sidebarTabIds = new Set<string>(layout.sidebarPane?.tabIds ?? []);
    return Object.values(layout.tabs ?? {})
      .filter((tab: any) => tab?.type === 'agent' && !sidebarTabIds.has(tab.id))
      .map((tab: any) => ({
        id: tab.id as string,
        callerToken: tab.agent?.session?.callerToken as string,
      }))
      .filter((tab: { id: string; callerToken?: string }) => typeof tab.callerToken === 'string');
  });
}

async function openNewEditorAgentTab(page: Page, existingIds: string[]): Promise<string> {
  await page.evaluate(() => {
    (window as any).__layoutContext?.openNewTab?.();
  });

  await page.waitForFunction(({ previousIds }) => {
    const layout = (window as any).__layoutContext?.getState?.();
    if (!layout) {
      return false;
    }

    const sidebarTabIds = new Set<string>(layout.sidebarPane?.tabIds ?? []);
    const currentIds = Object.values(layout.tabs ?? {})
      .filter((tab: any) => tab?.type === 'agent' && !sidebarTabIds.has(tab.id))
      .map((tab: any) => tab.id as string);

    return currentIds.some((id) => !previousIds.includes(id));
  }, { previousIds: existingIds }, { timeout: 10000 });

  const currentTabs = await getEditorAgentTabs(page);
  const newTab = currentTabs.find((tab) => !existingIds.includes(tab.id));
  if (!newTab) {
    throw new Error('Expected a new editor agent tab to be created');
  }
  return newTab.id;
}

async function ensureBoundAgentTabs(
  page: Page,
  windowPrefix: string,
  count: number,
  workspacePath: string,
): Promise<BoundAgentTab[]> {
  let tabs = await getEditorAgentTabs(page);
  while (tabs.length < count) {
    await openNewEditorAgentTab(page, tabs.map((tab) => tab.id));
    tabs = await getEditorAgentTabs(page);
  }

  const selectedTabs = tabs.slice(0, count).map((tab, index) => ({
    id: tab.id,
    callerToken: tab.callerToken,
    threadId: `${windowPrefix}-thread-${index + 1}`,
  }));

  await page.evaluate(async ({ bindings, workspace }) => {
    for (const binding of bindings as BoundAgentTab[]) {
      const result = await (window as any).electron.agentTabs.registerThread({
        agentId: binding.id,
        threadId: binding.threadId,
        callerToken: binding.callerToken,
        workspacePath: workspace,
      });
      if (!result?.success) {
        throw new Error(result?.error || `Failed to register thread for ${binding.id}`);
      }
    }
  }, {
    bindings: selectedTabs,
    workspace: workspacePath,
  });

  return selectedTabs;
}

async function allowHiddenApprovalTool(
  page: Page,
  binding: BoundAgentTab,
  workspacePath: string,
): Promise<void> {
  await page.evaluate(async ({ targetBinding, workspace }) => {
    const result = await (window as any).electron.agentTabs.registerThread({
      agentId: targetBinding.id,
      threadId: targetBinding.threadId,
      callerToken: targetBinding.callerToken,
      workspacePath: workspace,
      allowedToolNames: ['builtin-test-approval__test_approval'],
    });
    if (!result?.success) {
      throw new Error(result?.error || `Failed to scope hidden approval tool for ${targetBinding.id}`);
    }
  }, {
    targetBinding: binding,
    workspace: workspacePath,
  });
}

async function waitForActiveEditorTab(page: Page, agentId: string): Promise<void> {
  await page.waitForFunction(({ expectedAgentId }) => {
    const layout = (window as any).__layoutContext?.getState?.();
    if (!layout?.tree || !layout.activePaneId) {
      return false;
    }

    const findPane = (node: any): any => {
      if (!node) return null;
      if (node.kind === 'pane') {
        return node.id === layout.activePaneId ? node : null;
      }
      if (!Array.isArray(node.children)) {
        return null;
      }
      for (const child of node.children) {
        const match = findPane(child);
        if (match) {
          return match;
        }
      }
      return null;
    };

    return findPane(layout.tree)?.activeTabId === expectedAgentId;
  }, { expectedAgentId: agentId }, { timeout: 10000 });
}

async function setActiveEditorTab(
  page: Page,
  agentId: string,
): Promise<void> {
  await page.evaluate(({ nextAgentId }) => {
    (window as any).__layoutContext?.setActiveTab?.(nextAgentId);
  }, { nextAgentId: agentId });
  await waitForActiveEditorTab(page, agentId);
}

async function waitForApprovalDock(
  page: Page,
  agentId: string,
  approvalText: string,
): Promise<void> {
  await setActiveEditorTab(page, agentId);
  const surface = page.locator(sel.editorAgentSurface(agentId));
  await expect(surface.getByText(approvalText)).toBeVisible({ timeout: 30000 });
  await expect(surface.getByRole('button', { name: 'Allow once' }).last()).toBeVisible();
}

async function approveRequest(
  page: Page,
  agentId: string,
  approvalText: string,
): Promise<void> {
  await setActiveEditorTab(page, agentId);
  const surface = page.locator(sel.editorAgentSurface(agentId));
  await expect(surface.getByText(approvalText)).toBeVisible();
  await surface.getByRole('button', { name: 'Allow once' }).last().click();
}

async function waitForQuestionPrompt(
  page: Page,
  agentId: string,
  questionText: string,
): Promise<void> {
  await setActiveEditorTab(page, agentId);
  const surface = page.locator(sel.editorAgentSurface(agentId));
  await expect(surface.getByText(questionText)).toBeVisible({ timeout: 30000 });
  await expect(surface.locator(sel.questionOption(0, 0)).last()).toBeVisible();
  await expect(surface.locator(sel('questionSubmitButton')).last()).toBeVisible();
}

async function answerQuestion(
  page: Page,
  agentId: string,
  questionText: string,
): Promise<void> {
  await setActiveEditorTab(page, agentId);
  const surface = page.locator(sel.editorAgentSurface(agentId));
  await expect(surface.getByText(questionText)).toBeVisible();
  await surface.locator(sel.questionOption(0, 0)).last().click();
  await surface.locator(sel('questionSubmitButton')).last().click();
}

function startCliToolRequest(params: {
  port: number;
  callerToken: string;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<CliToolResponse> {
  return fetch(`http://127.0.0.1:${params.port}/api/interpreter-cli/tools/${params.serverId}/${params.toolName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Interpreter-Caller-Token': params.callerToken,
    },
    body: JSON.stringify(params.args),
    signal: params.signal,
  }).then(async (response) => ({
    ok: response.ok,
    status: response.status,
    data: await response.json(),
  }));
}

test.describe.serial('CLI Multi Window Approval Routing', () => {
  test.afterEach(async ({ electronApp }) => {
    const windows = await getRendererWindows(electronApp);
    for (const extraWindow of windows.slice(1)) {
      await extraWindow.evaluate(() => {
        window.close();
      }).catch(() => {});
    }
  });

  test('routes concurrent CLI approvals and ask-user questions to the owning window and agent tab', async ({ page, electronApp }) => {
    test.setTimeout(120000);

    const workspacePath = getTestWorkspace();
    await waitForAppReady(page);
    await setWorkspaceForWindow(page, workspacePath);

    const secondPage = await createAdditionalWindow(page, electronApp);
    await setWorkspaceForWindow(secondPage, workspacePath);

    const firstWindowTabs = await ensureBoundAgentTabs(page, 'window-a', 2, workspacePath);
    const secondWindowTabs = await ensureBoundAgentTabs(secondPage, 'window-b', 2, workspacePath);
    await allowHiddenApprovalTool(page, firstWindowTabs[0]!, workspacePath);
    await allowHiddenApprovalTool(secondPage, secondWindowTabs[0]!, workspacePath);
    const port = await getServerPort(page);

    const firstApprovalText = 'Approve window A action.';
    const firstQuestionText = 'Choose a window A color.';
    const secondApprovalText = 'Approve window B action.';
    const secondQuestionText = 'Choose a window B color.';
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ];

    try {
      const firstApprovalRequest = startCliToolRequest({
        port,
        callerToken: firstWindowTabs[0]!.callerToken,
        serverId: 'builtin-test-approval',
        toolName: 'test_approval',
        args: {
          message: firstApprovalText,
          timeout: 0,
        },
        signal: controllers[0]!.signal,
      });
      const firstQuestionRequest = startCliToolRequest({
        port,
        callerToken: firstWindowTabs[1]!.callerToken,
        serverId: 'builtin-ask-user',
        toolName: 'ask_user_question',
        args: {
          questions: [
            {
              header: 'Color',
              question: firstQuestionText,
              options: [
                { label: 'Cerulean', value: 'cerulean', recommended: true },
                { label: 'Vermilion', value: 'vermilion' },
              ],
            },
          ],
        },
        signal: controllers[1]!.signal,
      });
      const secondApprovalRequest = startCliToolRequest({
        port,
        callerToken: secondWindowTabs[0]!.callerToken,
        serverId: 'builtin-test-approval',
        toolName: 'test_approval',
        args: {
          message: secondApprovalText,
          timeout: 0,
        },
        signal: controllers[2]!.signal,
      });
      const secondQuestionRequest = startCliToolRequest({
        port,
        callerToken: secondWindowTabs[1]!.callerToken,
        serverId: 'builtin-ask-user',
        toolName: 'ask_user_question',
        args: {
          questions: [
            {
              header: 'Color',
              question: secondQuestionText,
              options: [
                { label: 'Cyan', value: 'cyan', recommended: true },
                { label: 'Amber', value: 'amber' },
              ],
            },
          ],
        },
        signal: controllers[3]!.signal,
      });

      await waitForApprovalDock(page, firstWindowTabs[0]!.id, firstApprovalText);
      await waitForQuestionPrompt(page, firstWindowTabs[1]!.id, firstQuestionText);
      await waitForApprovalDock(secondPage, secondWindowTabs[0]!.id, secondApprovalText);
      await waitForQuestionPrompt(secondPage, secondWindowTabs[1]!.id, secondQuestionText);

      await expect(page.locator(sel.editorAgentSurface(firstWindowTabs[0]!.id))).toContainText(firstApprovalText);
      await expect(page.locator(sel.editorAgentSurface(firstWindowTabs[0]!.id))).not.toContainText(secondApprovalText);
      await expect(page.locator(sel.editorAgentSurface(firstWindowTabs[1]!.id))).toContainText(firstQuestionText);
      await expect(page.locator(sel.editorAgentSurface(firstWindowTabs[1]!.id))).not.toContainText(secondQuestionText);

      await expect(secondPage.locator(sel.editorAgentSurface(secondWindowTabs[0]!.id))).toContainText(secondApprovalText);
      await expect(secondPage.locator(sel.editorAgentSurface(secondWindowTabs[0]!.id))).not.toContainText(firstApprovalText);
      await expect(secondPage.locator(sel.editorAgentSurface(secondWindowTabs[1]!.id))).toContainText(secondQuestionText);
      await expect(secondPage.locator(sel.editorAgentSurface(secondWindowTabs[1]!.id))).not.toContainText(firstQuestionText);

      await approveRequest(page, firstWindowTabs[0]!.id, firstApprovalText);
      await answerQuestion(page, firstWindowTabs[1]!.id, firstQuestionText);

      const firstApprovalResult = await firstApprovalRequest;
      expect(firstApprovalResult.ok).toBe(true);
      expect(JSON.parse(firstApprovalResult.data.content[0]?.text ?? '{}')).toMatchObject({
        approved: true,
        message: firstApprovalText,
      });

      const firstQuestionResult = await firstQuestionRequest;
      expect(firstQuestionResult.ok).toBe(true);
      expect(JSON.parse(firstQuestionResult.data.content[0]?.text ?? '{}')).toEqual({
        answers: { '0': 'cerulean' },
      });

      await waitForApprovalDock(secondPage, secondWindowTabs[0]!.id, secondApprovalText);
      await waitForQuestionPrompt(secondPage, secondWindowTabs[1]!.id, secondQuestionText);

      await approveRequest(secondPage, secondWindowTabs[0]!.id, secondApprovalText);
      await answerQuestion(secondPage, secondWindowTabs[1]!.id, secondQuestionText);

      const secondApprovalResult = await secondApprovalRequest;
      expect(secondApprovalResult.ok).toBe(true);
      expect(JSON.parse(secondApprovalResult.data.content[0]?.text ?? '{}')).toMatchObject({
        approved: true,
        message: secondApprovalText,
      });

      const secondQuestionResult = await secondQuestionRequest;
      expect(secondQuestionResult.ok).toBe(true);
      expect(JSON.parse(secondQuestionResult.data.content[0]?.text ?? '{}')).toEqual({
        answers: { '0': 'cyan' },
      });
    } finally {
      for (const controller of controllers) {
        controller.abort();
      }
    }
  });
});
