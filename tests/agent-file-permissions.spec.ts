import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  getServerPort,
  setWorkspace,
  waitForAppReady,
} from './helpers';
import { sel } from './selectors';

type BoundAgentTab = {
  id: string;
  callerToken: string;
  threadId: string;
  workspacePath: string;
};

type CliToolResponse = {
  ok: boolean;
  status: number;
  data: {
    content?: Array<{ type?: unknown; text?: unknown }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
};

type RuntimePermissionState = {
  approvalPolicy: 'never' | 'on-failure' | 'on-request' | 'untrusted';
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  readAccessMode: 'workspace-only' | 'full-system';
  macosTempAccess: boolean;
};

const FIXTURE_PDF_PATH = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'workspace-template',
  'pdfs',
  'test-document.pdf',
);
const WORKSPACE_WRITE_PROMPT = 'Interpreter wants to change files in this workspace.';
const PDF_HTML = '<html><body><h1>Permission test</h1><p>Interpreter file permissions e2e.</p></body></html>';

function toPathSlug(value: string): string {
  return value
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

async function getEditorAgentTabs(page: Page): Promise<Array<{ id: string; callerToken: string }>> {
  return page.evaluate(() => {
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
  requestedBindings: Array<{ threadId: string; workspacePath: string }>,
): Promise<BoundAgentTab[]> {
  let tabs = await getEditorAgentTabs(page);
  while (tabs.length < requestedBindings.length) {
    await openNewEditorAgentTab(page, tabs.map((tab) => tab.id));
    tabs = await getEditorAgentTabs(page);
  }

  const bindings = requestedBindings.map((request, index) => ({
    id: tabs[index]!.id,
    callerToken: tabs[index]!.callerToken,
    threadId: request.threadId,
    workspacePath: request.workspacePath,
  }));

  await page.evaluate(async ({ nextBindings }) => {
    for (const binding of nextBindings as BoundAgentTab[]) {
      const result = await (window as any).electron.agentTabs.registerThread({
        agentId: binding.id,
        threadId: binding.threadId,
        callerToken: binding.callerToken,
        workspacePath: binding.workspacePath,
      });
      if (!result?.success) {
        throw new Error(result?.error || `Failed to register thread for ${binding.id}`);
      }
    }
  }, { nextBindings: bindings });

  return bindings;
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

async function setActiveEditorTab(page: Page, agentId: string): Promise<void> {
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
  await expect(surface.getByRole('button', { name: 'Allow once' }).last()).toBeVisible();
  await surface.getByRole('button', { name: 'Allow once' }).last().click();
}

async function denyRequest(
  page: Page,
  agentId: string,
  approvalText: string,
): Promise<void> {
  await setActiveEditorTab(page, agentId);
  const surface = page.locator(sel.editorAgentSurface(agentId));
  await expect(surface.getByText(approvalText)).toBeVisible();
  await expect(surface.getByRole('button', { name: "Don't allow" }).last()).toBeVisible();
  await surface.getByRole('button', { name: "Don't allow" }).last().click();
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

function extractToolText(response: CliToolResponse): string {
  return (response.data.content ?? [])
    .filter((item): item is { type?: unknown; text: string } => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

async function getRuntimePermissions(page: Page): Promise<RuntimePermissionState> {
  const [approvalPolicy, sandboxMode, readAccessMode, macosTempAccess] = await Promise.all([
    invokeNativeToolsMethod(page, 'getApprovalPolicy'),
    invokeNativeToolsMethod(page, 'getSandboxMode'),
    invokeNativeToolsMethod(page, 'getReadAccessMode'),
    invokeNativeToolsMethod(page, 'getMacosTempAccess'),
  ]);

  return {
    approvalPolicy: approvalPolicy.policy,
    sandboxMode: sandboxMode.mode,
    readAccessMode: readAccessMode.mode,
    macosTempAccess: macosTempAccess.enabled,
  };
}

async function setRuntimePermissions(
  page: Page,
  next: Partial<RuntimePermissionState>,
): Promise<void> {
  if (next.approvalPolicy) {
    await invokeNativeToolsMethod(page, 'setApprovalPolicy', [next.approvalPolicy]);
  }
  if (next.readAccessMode) {
    await invokeNativeToolsMethod(page, 'setReadAccessMode', [next.readAccessMode]);
  }
  if (next.sandboxMode) {
    await invokeNativeToolsMethod(page, 'setSandboxMode', [next.sandboxMode]);
  }
  if (typeof next.macosTempAccess === 'boolean') {
    await invokeNativeToolsMethod(page, 'setMacosTempAccess', [next.macosTempAccess]);
  }

  const current = await getRuntimePermissions(page);
  expect(current).toMatchObject(next);
}

async function getApprovalAutoApproveForTests(page: Page): Promise<boolean> {
  const result = await invokeNativeToolsMethod(page, 'getApprovalAutoApproveForTests');
  return result.enabled;
}

async function setApprovalAutoApproveForTests(page: Page, enabled: boolean): Promise<void> {
  await invokeNativeToolsMethod(page, 'setApprovalAutoApproveForTests', [enabled]);
  await expect
    .poll(async () => getApprovalAutoApproveForTests(page), { timeout: 10000 })
    .toBe(enabled);
}

async function invokeNativeToolsMethod(
  page: Page,
  method: string,
  args: unknown[] = [],
): Promise<any> {
  const response = await page.evaluate(async ({ method, args }) => {
    return await (window as any).electron.apiRequest({
      method: 'POST',
      path: `/api/ipc/nativeTools/${method}`,
      body: args,
    });
  }, { method, args });

  if (!response.ok) {
    throw new Error(`nativeTools.${method} failed: ${response.status} ${JSON.stringify(response.data)}`);
  }

  return response.data;
}

async function prepareScenario(
  page: Page,
  testInfo: TestInfo,
  agentWorkspaceNames: string[] = ['agent-a'],
): Promise<{
  port: number;
  windowWorkspacePath: string;
  outsidePath: string;
  agents: BoundAgentTab[];
}> {
  await waitForAppReady(page);

  const rootPath = path.join(
    os.homedir(),
    '.interpreter-e2e-file-permissions',
    `${toPathSlug(testInfo.project.name)}-${toPathSlug(testInfo.title)}-${Date.now()}`,
  );
  const windowWorkspacePath = path.join(rootPath, 'window-workspace');
  const outsidePath = path.join(rootPath, 'outside');
  const requestedBindings = agentWorkspaceNames.map((name, index) => ({
    threadId: `agent-file-permissions-${index + 1}-${name}`,
    workspacePath: path.join(rootPath, name),
  }));

  await mkdir(windowWorkspacePath, { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  await Promise.all(requestedBindings.map((binding) => mkdir(binding.workspacePath, { recursive: true })));

  await setWorkspace(page, windowWorkspacePath);
  const agents = await ensureBoundAgentTabs(page, requestedBindings);
  const port = await getServerPort(page);

  await expect(page.locator(sel.approvalItemAny())).toHaveCount(0);

  return {
    port,
    windowWorkspacePath,
    outsidePath,
    agents,
  };
}

async function removeIfPresent(targetPath: string): Promise<void> {
  if (!existsSync(targetPath)) {
    return;
  }

  await rm(targetPath, { force: true, recursive: true });
}

async function seedPdf(targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(FIXTURE_PDF_PATH, targetPath);
}

test.describe.serial('Agent file permissions', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await setApprovalAutoApproveForTests(page, false);
  });

  test.afterEach(async ({ page }) => {
    await setApprovalAutoApproveForTests(page, true).catch(() => {});
  });

  test('scopes writes to each bound agent workspace instead of the current window workspace', async ({ page }, testInfo) => {
    test.setTimeout(120000);

    const { port, windowWorkspacePath, agents } = await prepareScenario(page, testInfo, ['agent-a', 'agent-b']);
    const agentA = agents[0]!;
    const agentB = agents[1]!;
    const agentARelativeOutput = 'agent-a-relative.pdf';
    const agentAExpectedPath = path.join(agentA.workspacePath, agentARelativeOutput);
    const agentAForbiddenPath = path.join(agentB.workspacePath, 'agent-a-forbidden.pdf');
    const agentBRelativeOutput = 'agent-b-relative.pdf';
    const agentBExpectedPath = path.join(agentB.workspacePath, agentBRelativeOutput);

    await setRuntimePermissions(page, {
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      readAccessMode: 'workspace-only',
      macosTempAccess: true,
    });

    const agentAWrite = await startCliToolRequest({
      port,
      callerToken: agentA.callerToken,
      serverId: 'builtin-pdf',
      toolName: 'create_pdf',
      args: {
        path: agentARelativeOutput,
        content: PDF_HTML,
      },
    });
    expect(agentAWrite.ok).toBe(true);
    expect(agentAWrite.data.isError).toBe(false);
    expect(extractToolText(agentAWrite)).toContain(`Created PDF at: ${agentAExpectedPath}`);
    expect(existsSync(agentAExpectedPath)).toBe(true);
    expect(existsSync(path.join(windowWorkspacePath, agentARelativeOutput))).toBe(false);

    const forbiddenWrite = await startCliToolRequest({
      port,
      callerToken: agentA.callerToken,
      serverId: 'builtin-pdf',
      toolName: 'create_pdf',
      args: {
        path: agentAForbiddenPath,
        content: PDF_HTML,
      },
    });
    expect(forbiddenWrite.ok).toBe(true);
    expect(forbiddenWrite.data.isError).toBe(true);
    expect(extractToolText(forbiddenWrite)).toContain('Permission denied: this agent cannot change files outside its workspace.');
    expect(existsSync(agentAForbiddenPath)).toBe(false);
    await expect(page.locator(sel.approvalItemAny())).toHaveCount(0);

    const agentBWrite = await startCliToolRequest({
      port,
      callerToken: agentB.callerToken,
      serverId: 'builtin-pdf',
      toolName: 'create_pdf',
      args: {
        path: agentBRelativeOutput,
        content: PDF_HTML,
      },
    });
    expect(agentBWrite.ok).toBe(true);
    expect(agentBWrite.data.isError).toBe(false);
    expect(extractToolText(agentBWrite)).toContain(`Created PDF at: ${agentBExpectedPath}`);
    expect(existsSync(agentBExpectedPath)).toBe(true);
  });

  test('denies reads outside the bound workspace in current-folder mode', async ({ page }, testInfo) => {
    test.setTimeout(120000);

    const { port, outsidePath, agents } = await prepareScenario(page, testInfo);
    const agent = agents[0]!;
    const outsidePdfPath = path.join(outsidePath, 'outside-read-denied.pdf');

    await seedPdf(outsidePdfPath);

    await setRuntimePermissions(page, {
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      readAccessMode: 'workspace-only',
      macosTempAccess: true,
    });

    const response = await startCliToolRequest({
      port,
      callerToken: agent.callerToken,
      serverId: 'builtin-pdf',
      toolName: 'read_pdf',
      args: {
        path: outsidePdfPath,
      },
    });

    expect(response.ok).toBe(true);
    expect(response.data.isError).toBe(true);
    expect(extractToolText(response)).toContain('Permission denied: this agent can only view files inside its workspace.');
    await expect(page.locator(sel.approvalItemAny())).toHaveCount(0);
  });

  test('allows reads outside the bound workspace when global read access is anywhere', async ({ page }, testInfo) => {
    test.setTimeout(120000);

    const { port, outsidePath, agents } = await prepareScenario(page, testInfo);
    const agent = agents[0]!;
    const outsidePdfPath = path.join(outsidePath, 'outside-read-allowed.pdf');

    await seedPdf(outsidePdfPath);

    await setRuntimePermissions(page, {
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      readAccessMode: 'full-system',
      macosTempAccess: true,
    });

    const response = await startCliToolRequest({
      port,
      callerToken: agent.callerToken,
      serverId: 'builtin-pdf',
      toolName: 'read_pdf',
      args: {
        path: outsidePdfPath,
      },
    });

    expect(response.ok).toBe(true);
    expect(response.data.isError).toBe(false);
    expect(extractToolText(response)).toContain(`# ${path.basename(outsidePdfPath)}`);
    expect(extractToolText(response)).toContain('Test PDF Document');
  });

  test('prompts before workspace writes in ask-first mode and allows the write when approved', async ({ page }, testInfo) => {
    test.setTimeout(120000);

    const { port, agents } = await prepareScenario(page, testInfo);
    const agent = agents[0]!;
    const outputPath = path.join(agent.workspacePath, 'approved-write.pdf');
    const controller = new AbortController();

    await setRuntimePermissions(page, {
      approvalPolicy: 'untrusted',
      sandboxMode: 'workspace-write',
      readAccessMode: 'workspace-only',
      macosTempAccess: true,
    });

    try {
      const requestPromise = startCliToolRequest({
        port,
        callerToken: agent.callerToken,
        serverId: 'builtin-pdf',
        toolName: 'create_pdf',
        args: {
          path: outputPath,
          content: PDF_HTML,
        },
        signal: controller.signal,
      });

      await waitForApprovalDock(page, agent.id, WORKSPACE_WRITE_PROMPT);
      await approveRequest(page, agent.id, WORKSPACE_WRITE_PROMPT);

      const response = await requestPromise;
      expect(response.ok).toBe(true);
      expect(response.data.isError).toBe(false);
      expect(extractToolText(response)).toContain(`Created PDF at: ${outputPath}`);
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      controller.abort();
    }
  });

  test('prompts before workspace writes in ask-first mode and keeps the file unchanged when denied', async ({ page }, testInfo) => {
    test.setTimeout(120000);

    const { port, agents } = await prepareScenario(page, testInfo);
    const agent = agents[0]!;
    const outputPath = path.join(agent.workspacePath, 'denied-write.pdf');
    const controller = new AbortController();

    await setRuntimePermissions(page, {
      approvalPolicy: 'untrusted',
      sandboxMode: 'workspace-write',
      readAccessMode: 'workspace-only',
      macosTempAccess: true,
    });

    try {
      const requestPromise = startCliToolRequest({
        port,
        callerToken: agent.callerToken,
        serverId: 'builtin-pdf',
        toolName: 'create_pdf',
        args: {
          path: outputPath,
          content: PDF_HTML,
        },
        signal: controller.signal,
      });

      await waitForApprovalDock(page, agent.id, WORKSPACE_WRITE_PROMPT);
      await denyRequest(page, agent.id, WORKSPACE_WRITE_PROMPT);

      const response = await requestPromise;
      expect(response.ok).toBe(true);
      expect(response.data.isError).toBe(false);
      expect(extractToolText(response)).toContain(`Operation denied by user: write: ${outputPath}`);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      controller.abort();
    }
  });

  test('allows writes outside the bound workspace when global write access is anywhere', async ({ page }, testInfo) => {
    test.setTimeout(120000);

    const { port, outsidePath, agents } = await prepareScenario(page, testInfo);
    const agent = agents[0]!;
    const outputPath = path.join(outsidePath, 'anywhere-write.pdf');

    await setRuntimePermissions(page, {
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      readAccessMode: 'full-system',
      macosTempAccess: true,
    });

    const response = await startCliToolRequest({
      port,
      callerToken: agent.callerToken,
      serverId: 'builtin-pdf',
      toolName: 'create_pdf',
      args: {
        path: outputPath,
        content: PDF_HTML,
      },
    });

    expect(response.ok).toBe(true);
    expect(response.data.isError).toBe(false);
    expect(extractToolText(response)).toContain(`Created PDF at: ${outputPath}`);
    expect(existsSync(outputPath)).toBe(true);
  });

  test('macOS temporary-files setting gates /tmp writes outside the workspace', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    test.skip(process.platform !== 'darwin', 'The temporary-files setting is macOS-specific.');

    const { port, agents } = await prepareScenario(page, testInfo);
    const agent = agents[0]!;
    const tempOutputPath = path.join(os.tmpdir(), `agent-file-permissions-${Date.now()}.pdf`);

    await removeIfPresent(tempOutputPath);

    await setRuntimePermissions(page, {
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      readAccessMode: 'workspace-only',
      macosTempAccess: false,
    });

    const deniedResponse = await startCliToolRequest({
      port,
      callerToken: agent.callerToken,
      serverId: 'builtin-pdf',
      toolName: 'create_pdf',
      args: {
        path: tempOutputPath,
        content: PDF_HTML,
      },
    });
    expect(deniedResponse.ok).toBe(true);
    expect(deniedResponse.data.isError).toBe(true);
    expect(extractToolText(deniedResponse)).toContain('Permission denied: this agent cannot change files outside its workspace.');
    expect(existsSync(tempOutputPath)).toBe(false);

    await setRuntimePermissions(page, {
      macosTempAccess: true,
    });

    const allowedResponse = await startCliToolRequest({
      port,
      callerToken: agent.callerToken,
      serverId: 'builtin-pdf',
      toolName: 'create_pdf',
      args: {
        path: tempOutputPath,
        content: PDF_HTML,
      },
    });
    expect(allowedResponse.ok).toBe(true);
    expect(allowedResponse.data.isError).toBe(false);
    expect(extractToolText(allowedResponse)).toContain(`Created PDF at: ${tempOutputPath}`);
    expect(existsSync(tempOutputPath)).toBe(true);

    await removeIfPresent(tempOutputPath);
  });
});
