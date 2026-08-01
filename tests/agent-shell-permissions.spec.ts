// import fs from 'node:fs';
// import os from 'node:os';
// import path from 'node:path';
// import { mkdir, rm, writeFile } from 'node:fs/promises';
// import type { Locator, Page } from '@playwright/test';
//
// import { expect, test } from './fixtures';
// import {
//   apiCall,
//   deleteProfile,
//   setWorkspace,
//   waitForAppReady,
// } from './helpers';
// import { sel } from './selectors';
// import { getTestRunDir } from './test-recorder';
//
// type RuntimePermissionState = {
//   approvalPolicy: 'never' | 'on-failure' | 'on-request' | 'untrusted';
//   sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
//   readAccessMode: 'workspace-only' | 'full-system';
//   macosTempAccess: boolean;
// };
//
// type Scenario = {
//   rootPath: string;
//   windowWorkspacePath: string;
//   outsidePath: string;
//   agentWorkspacePaths: string[];
// };
//
// type AgentSession = {
//   agentId: string;
//   threadId: string;
// };
//
// type ThreadHistoryItem = {
//   type?: string;
//   text?: string;
//   phase?: string | null;
// };
//
// type ThreadHistoryTurn = {
//   status?: string;
//   items?: ThreadHistoryItem[];
// };
//
// type AgentEventRecord = {
//   kind?: string;
//   type?: string;
//   toolName?: string;
// };
//
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// const OPENAI_BASE_URL = 'https://api.openai.com/v1';
// const OPENAI_MODEL = 'gpt-5.4-mini';
//
// function toPathSlug(value: string): string {
//   return value
//     .replace(/[^a-z0-9]+/gi, '-')
//     .replace(/^-+|-+$/g, '')
//     .toLowerCase();
// }
//
// function getTestArtifactPaths(testTitle: string): {
//   logPath: string;
//   agentEventsPath: string;
// } {
//   const logPath = path.join(
//     getTestRunDir(),
//     'logs',
//     `${toPathSlug(testTitle)}.log`,
//   );
//   return {
//     logPath,
//     agentEventsPath: logPath.replace(/\.log$/, '.agent-events.jsonl'),
//   };
// }
//
// function quotePosixShellArg(value: string): string {
//   if (process.platform === 'win32') {
//     return `"${value.replace(/"/g, '""')}"`;
//   }
//   return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
// }
//
// function quotePowerShellLiteral(value: string): string {
//   return `'${value.replace(/'/g, "''")}'`;
// }
//
// function buildReadFileCommand(filePath: string): string {
//   if (process.platform === 'win32') {
//     return `powershell.exe -NoProfile -Command "[Console]::Write([System.IO.File]::ReadAllText(${quotePowerShellLiteral(filePath)}))"`;
//   }
//   return `cat ${quotePosixShellArg(filePath)}`;
// }
//
// function buildWriteFileCommand(filePath: string, contents: string): string {
//   if (process.platform === 'win32') {
//     return `powershell.exe -NoProfile -Command "[System.IO.File]::WriteAllText(${quotePowerShellLiteral(filePath)}, ${quotePowerShellLiteral(contents)})"`;
//   }
//   return `printf %s ${quotePosixShellArg(contents)} > ${quotePosixShellArg(filePath)}`;
// }
//
// async function invokeNativeToolsMethod(
//   page: Page,
//   method: string,
//   args: unknown[] = [],
// ): Promise<any> {
//   const response = await page.evaluate(async ({ method, args }) => {
//     return await (window as any).electron.apiRequest({
//       method: 'POST',
//       path: `/api/ipc/nativeTools/${method}`,
//       body: args,
//     });
//   }, { method, args });
//
//   if (!response.ok) {
//     throw new Error(`nativeTools.${method} failed: ${response.status} ${JSON.stringify(response.data)}`);
//   }
//
//   return response.data;
// }
//
// async function getRuntimePermissions(page: Page): Promise<RuntimePermissionState> {
//   const [approvalPolicy, sandboxMode, readAccessMode, macosTempAccess] = await Promise.all([
//     invokeNativeToolsMethod(page, 'getApprovalPolicy'),
//     invokeNativeToolsMethod(page, 'getSandboxMode'),
//     invokeNativeToolsMethod(page, 'getReadAccessMode'),
//     invokeNativeToolsMethod(page, 'getMacosTempAccess'),
//   ]);
//
//   return {
//     approvalPolicy: approvalPolicy.policy,
//     sandboxMode: sandboxMode.mode,
//     readAccessMode: readAccessMode.mode,
//     macosTempAccess: macosTempAccess.enabled,
//   };
// }
//
// async function setRuntimePermissions(
//   page: Page,
//   next: Partial<RuntimePermissionState>,
// ): Promise<void> {
//   if (next.approvalPolicy) {
//     await invokeNativeToolsMethod(page, 'setApprovalPolicy', [next.approvalPolicy]);
//   }
//   if (next.readAccessMode) {
//     await invokeNativeToolsMethod(page, 'setReadAccessMode', [next.readAccessMode]);
//   }
//   if (next.sandboxMode) {
//     await invokeNativeToolsMethod(page, 'setSandboxMode', [next.sandboxMode]);
//   }
//   if (typeof next.macosTempAccess === 'boolean') {
//     await invokeNativeToolsMethod(page, 'setMacosTempAccess', [next.macosTempAccess]);
//   }
//
//   const current = await getRuntimePermissions(page);
//   expect(current).toMatchObject(next);
// }
//
// async function setApprovalAutoApproveForTests(page: Page, enabled: boolean): Promise<void> {
//   await invokeNativeToolsMethod(page, 'setApprovalAutoApproveForTests', [enabled]);
//   await expect
//     .poll(async () => {
//       const result = await invokeNativeToolsMethod(page, 'getApprovalAutoApproveForTests');
//       return result.enabled;
//     }, { timeout: 10000 })
//     .toBe(enabled);
// }
//
// async function createOpenAiProfile(page: Page): Promise<{
//   createdProfileId: string;
//   originalDefaultProfileId: string | null;
// }> {
//   if (!OPENAI_API_KEY) {
//     throw new Error('OPENAI_API_KEY is required for agent shell permission e2e tests');
//   }
//   const profileId = `test-hosted-shell-permissions-${Date.now()}`;
//   const profileName = `Hosted Shell Permissions ${profileId}`;
//
//   const profilesResponse = await apiCall(page, 'GET', '/api/profiles');
//   expect(profilesResponse.ok).toBe(true);
//   const originalDefaultProfileId = (profilesResponse.data as {
//     defaultProfileId?: string | null;
//   }).defaultProfileId ?? null;
//
//   const createProfileResponse = await apiCall(page, 'POST', '/api/profiles', {
//     id: profileId,
//     name: profileName,
//     modelId: OPENAI_MODEL,
//     isBuiltin: false,
//     provider: 'api',
//     apiKey: OPENAI_API_KEY,
//     baseURL: OPENAI_BASE_URL,
//     apiFormat: 'openai',
//   });
//   expect(createProfileResponse.ok).toBe(true);
//
//   const setDefaultResponse = await apiCall(page, 'POST', '/api/profiles/default', {
//     profileId,
//   });
//   expect(setDefaultResponse.ok).toBe(true);
//
//   return {
//     createdProfileId: profileId,
//     originalDefaultProfileId,
//   };
// }
//
// async function restoreOpenAiProfile(
//   page: Page,
//   createdProfileId: string,
//   originalDefaultProfileId: string | null,
// ): Promise<void> {
//   if (originalDefaultProfileId) {
//     await apiCall(page, 'POST', '/api/profiles/default', {
//       profileId: originalDefaultProfileId,
//     }).catch(() => {});
//   }
//   await deleteProfile(page, createdProfileId).catch(() => {});
// }
//
// async function prepareScenario(
//   page: Page,
//   testTitle: string,
//   agentWorkspaceNames: string[],
// ): Promise<Scenario> {
//   await waitForAppReady(page);
//
//   const rootPath = path.join(
//     os.homedir(),
//     '.interpreter-e2e-shell-permissions',
//     `${toPathSlug(testTitle)}-${Date.now()}`,
//   );
//   const windowWorkspacePath = path.join(rootPath, 'window-workspace');
//   const outsidePath = path.join(rootPath, 'outside');
//   const agentWorkspacePaths = agentWorkspaceNames.map((name) => path.join(rootPath, name));
//
//   await mkdir(windowWorkspacePath, { recursive: true });
//   await mkdir(outsidePath, { recursive: true });
//   await Promise.all(agentWorkspacePaths.map((workspacePath) => mkdir(workspacePath, { recursive: true })));
//
//   await setWorkspace(page, windowWorkspacePath);
//
//   return {
//     rootPath,
//     windowWorkspacePath,
//     outsidePath,
//     agentWorkspacePaths,
//   };
// }
//
// async function cleanupScenario(scenario: Scenario | null): Promise<void> {
//   if (!scenario) return;
//   await rm(scenario.rootPath, { recursive: true, force: true }).catch(() => {});
// }
//
// async function startHeadedAgent(
//   page: Page,
//   params: {
//     workspace: string;
//     message: string;
//     system?: string;
//     timeoutMs?: number;
//   },
// ): Promise<string> {
//   const response = await page.evaluate(async ({ workspace, message, system, timeoutMs }) => {
//     return await (window as any).electron.programmaticTasks.startHeaded({
//       workspace,
//       message,
//       system,
//       timeoutMs,
//     });
//   }, params);
//
//   expect(response.success).toBe(true);
//   expect(response.result?.agentId).toBeTruthy();
//   return response.result.agentId as string;
// }
//
// async function waitForAgentSession(page: Page, agentId: string): Promise<AgentSession> {
//   await page.waitForFunction(({ expectedAgentId }) => {
//     const layout = (window as any).__layoutContext?.getState?.();
//     const tab = layout?.tabs?.[expectedAgentId];
//     return typeof tab?.agent?.session?.codexThreadId === 'string';
//   }, { expectedAgentId: agentId }, { timeout: 30000 });
//
//   return page.evaluate(({ expectedAgentId }) => {
//     const layout = (window as any).__layoutContext?.getState?.();
//     const tab = layout?.tabs?.[expectedAgentId];
//     return {
//       agentId: expectedAgentId,
//       threadId: tab.agent.session.codexThreadId as string,
//     };
//   }, { expectedAgentId: agentId });
// }
//
// async function waitForActiveEditorTab(page: Page, agentId: string): Promise<void> {
//   await page.waitForFunction(({ expectedAgentId }) => {
//     const layout = (window as any).__layoutContext?.getState?.();
//     if (!layout?.tree || !layout.activePaneId) {
//       return false;
//     }
//
//     const findPane = (node: any): any => {
//       if (!node) return null;
//       if (node.kind === 'pane') {
//         return node.id === layout.activePaneId ? node : null;
//       }
//       if (!Array.isArray(node.children)) {
//         return null;
//       }
//       for (const child of node.children) {
//         const match = findPane(child);
//         if (match) {
//           return match;
//         }
//       }
//       return null;
//     };
//
//     return findPane(layout.tree)?.activeTabId === expectedAgentId;
//   }, { expectedAgentId: agentId }, { timeout: 10000 });
// }
//
// async function setActiveEditorTab(page: Page, agentId: string): Promise<void> {
//   await page.evaluate(({ nextAgentId }) => {
//     (window as any).__layoutContext?.setActiveTab?.(nextAgentId);
//   }, { nextAgentId: agentId });
//   await waitForActiveEditorTab(page, agentId);
//   await expect(page.locator(sel.editorAgentSurface(agentId))).toBeVisible({ timeout: 10000 });
// }
//
// async function waitForThreadCompletion(page: Page, threadId: string, timeoutMs: number = 180000): Promise<void> {
//   const deadline = Date.now() + timeoutMs;
//
//   while (Date.now() < deadline) {
//     const response = await apiCall(page, 'GET', `/api/agent/threads/${encodeURIComponent(threadId)}`);
//     if (response.ok) {
//       const turns = ((response.data as {
//         thread?: {
//           turns?: Array<{ status?: string }>;
//         };
//       }).thread?.turns ?? []);
//       const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
//       if (lastTurn?.status && lastTurn.status !== 'inProgress') {
//         return;
//       }
//     }
//     await page.waitForTimeout(500);
//   }
//
//   throw new Error(`Timed out waiting for thread ${threadId} to complete`);
// }
//
// async function waitForNextTurnCompletion(
//   page: Page,
//   threadId: string,
//   previousTurnCount: number,
//   timeoutMs: number = 180000,
// ): Promise<void> {
//   const deadline = Date.now() + timeoutMs;
//
//   while (Date.now() < deadline) {
//     const response = await apiCall(page, 'GET', `/api/agent/threads/${encodeURIComponent(threadId)}`);
//     if (response.ok) {
//       const turns = ((response.data as {
//         thread?: {
//           turns?: Array<{ status?: string }>;
//         };
//       }).thread?.turns ?? []);
//       if (turns.length > previousTurnCount) {
//         const lastTurn = turns[turns.length - 1];
//         if (lastTurn?.status && lastTurn.status !== 'inProgress') {
//           return;
//         }
//       }
//     }
//     await page.waitForTimeout(500);
//   }
//
//   throw new Error(`Timed out waiting for next turn on thread ${threadId} to complete`);
// }
//
// async function waitForAgentResponse(
//   page: Page,
//   agentId: string,
//   threadId: string,
//   timeoutMs: number = 180000,
// ): Promise<Locator> {
//   const thread = page.locator(sel.agentThread(agentId));
//   await thread.waitFor({ state: 'attached', timeout: 30000 });
//   await waitForThreadCompletion(page, threadId, timeoutMs);
//   await expect(thread.getByText('Something went wrong')).toHaveCount(0);
//   return thread;
// }
//
// async function bootstrapBoundAgent(
//   page: Page,
//   workspace: string,
// ): Promise<AgentSession> {
//   const agentId = await startHeadedAgent(page, {
//     workspace,
//     message: 'Reply with only READY=1.',
//     timeoutMs: 120000,
//   });
//   const session = await waitForAgentSession(page, agentId);
//   await waitForAgentResponse(page, agentId, session.threadId, 120000);
//   const items = await readThreadItems(page, session.threadId);
//   expect(getFinalAgentMessageText(items)).toBe('READY=1');
//   return session;
// }
//
// async function submitPromptToAgent(
//   page: Page,
//   agentId: string,
//   prompt: string,
// ): Promise<void> {
//   await setActiveEditorTab(page, agentId);
//   const composer = page.locator(sel.activeComposer()).first();
//   await expect(composer).toBeVisible({ timeout: 10000 });
//   await composer.click();
//   const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
//   await page.keyboard.press(`${modKey}+A`).catch(() => {});
//   await page.keyboard.press('Backspace').catch(() => {});
//   await page.keyboard.type(prompt, { delay: 10 });
//   await page.keyboard.press('Enter');
// }
//
// async function sendPromptToAgent(
//   page: Page,
//   agentId: string,
//   threadId: string,
//   prompt: string,
//   timeoutMs: number = 180000,
// ): Promise<void> {
//   const response = await apiCall(page, 'GET', `/api/agent/threads/${encodeURIComponent(threadId)}`);
//   expect(response.ok).toBe(true);
//   const previousTurnCount = ((response.data as {
//     thread?: {
//       turns?: Array<unknown>;
//     };
//   }).thread?.turns ?? []).length;
//
//   await submitPromptToAgent(page, agentId, prompt);
//   const thread = page.locator(sel.agentThread(agentId));
//   await waitForNextTurnCompletion(page, threadId, previousTurnCount, timeoutMs);
//   await expect(thread.getByText('Something went wrong')).toHaveCount(0);
// }
//
// async function readThreadItems(page: Page, threadId: string): Promise<ThreadHistoryItem[]> {
//   const turns = await readThreadTurns(page, threadId);
//   return turns.flatMap((turn) => turn.items ?? []);
// }
//
// async function readThreadTurns(page: Page, threadId: string): Promise<ThreadHistoryTurn[]> {
//   const response = await apiCall(page, 'GET', `/api/agent/threads/${encodeURIComponent(threadId)}`);
//   expect(response.ok).toBe(true);
//
//   return ((response.data as {
//     thread?: {
//       turns?: ThreadHistoryTurn[];
//     };
//   }).thread?.turns ?? []);
// }
//
// async function waitForLogMatch(
//   logPath: string,
//   predicate: (text: string) => boolean,
//   timeoutMs: number = 120000,
// ): Promise<string> {
//   const deadline = Date.now() + timeoutMs;
//
//   while (Date.now() < deadline) {
//     if (fs.existsSync(logPath)) {
//       const text = fs.readFileSync(logPath, 'utf8');
//       if (predicate(text)) {
//         return text;
//       }
//     }
//     await new Promise((resolve) => setTimeout(resolve, 500));
//   }
//
//   throw new Error(`Timed out waiting for matching log content in ${logPath}`);
// }
//
// async function waitForLogCommand(
//   logPath: string,
//   command: string,
//   timeoutMs: number = 120000,
// ): Promise<string> {
//   return waitForLogMatch(logPath, (text) => text.includes(command), timeoutMs);
// }
//
// async function waitForDeniedCommandInLog(
//   logPath: string,
//   filePath: string,
//   timeoutMs: number = 120000,
// ): Promise<string> {
//   return waitForLogMatch(
//     logPath,
//     (text) =>
//       text.includes(filePath)
//       && /(Operation not permitted|Permission denied|sandbox|Denied)/i.test(text),
//     timeoutMs,
//   );
// }
//
// async function waitForDeclinedCommandInLog(
//   logPath: string,
//   filePath: string,
//   timeoutMs: number = 120000,
// ): Promise<string> {
//   return waitForLogMatch(
//     logPath,
//     (text) =>
//       text.includes(filePath)
//       && /status=declined/.test(text),
//     timeoutMs,
//   );
// }
//
// function readAgentEvents(agentEventsPath: string): AgentEventRecord[] {
//   if (!fs.existsSync(agentEventsPath)) {
//     return [];
//   }
//
//   return fs.readFileSync(agentEventsPath, 'utf8')
//     .split('\n')
//     .map((line) => line.trim())
//     .filter(Boolean)
//     .map((line) => JSON.parse(line) as AgentEventRecord);
// }
//
// function getFinalAgentMessageText(items: ThreadHistoryItem[]): string {
//   const finalMessage = [...items]
//     .reverse()
//     .find((item) => item.type === 'agentMessage' && item.phase === 'final_answer');
//   return finalMessage?.text ?? '';
// }
//
// function getTurnFinalAgentMessageText(turn: ThreadHistoryTurn | undefined): string {
//   if (!turn) {
//     return '';
//   }
//   return getFinalAgentMessageText(turn.items ?? []);
// }
//
// function getLastThreadTurn(turns: ThreadHistoryTurn[]): ThreadHistoryTurn | undefined {
//   return turns.length > 0 ? turns[turns.length - 1] : undefined;
// }
//
// function expectNoNonShellToolUsage(
//   agentEventsPath: string,
// ): void {
//   const disallowed = readAgentEvents(agentEventsPath)
//     .filter((event) => event.kind === 'transcript' && event.type === 'tool_call')
//     .map((event) => event.toolName ?? '')
//     .filter((toolName) => toolName !== 'command_execution');
//
//   expect(
//     disallowed,
//     `Agent used non-shell tool surfaces: ${disallowed.join(', ')}`,
//   ).toEqual([]);
// }
//
// async function waitForApprovalDock(
//   page: Page,
//   agentId: string,
// ): Promise<void> {
//   await setActiveEditorTab(page, agentId);
//   const surface = page.locator(sel.editorAgentSurface(agentId));
//   await expect(surface.getByRole('button', { name: 'Allow once' }).last()).toBeVisible({ timeout: 20000 });
//   await expect(surface.getByRole('button', { name: "Don't allow" }).last()).toBeVisible({ timeout: 20000 });
// }
//
// async function waitForCommandApprovalRequest(logPath: string, needle: string): Promise<void> {
//   await expect
//     .poll(() => {
//       if (!fs.existsSync(logPath)) {
//         return false;
//       }
//       const text = fs.readFileSync(logPath, 'utf8');
//       return text.includes('item/commandExecution/requestApproval') && text.includes(needle);
//     }, { timeout: 45000, intervals: [250, 500, 1000] })
//     .toBe(true);
// }
//
// async function approveShellCommand(
//   page: Page,
//   agentId: string,
//   logPath: string,
//   approvalNeedle: string,
// ): Promise<void> {
//   await waitForCommandApprovalRequest(logPath, approvalNeedle);
//   await waitForApprovalDock(page, agentId);
//   const surface = page.locator(sel.editorAgentSurface(agentId));
//   await surface.getByRole('button', { name: 'Allow once' }).last().click();
// }
//
// async function denyShellCommand(
//   page: Page,
//   agentId: string,
//   logPath: string,
//   approvalNeedle: string,
// ): Promise<void> {
//   await waitForCommandApprovalRequest(logPath, approvalNeedle);
//   await waitForApprovalDock(page, agentId);
//   const surface = page.locator(sel.editorAgentSurface(agentId));
//   await surface.getByRole('button', { name: "Don't allow" }).last().click();
// }
//
// function buildShellReadPrompt(
//   command: string,
//   successPrefix: string,
//   blockedToken: string,
// ): string {
//   return [
//     'Use the native shell command execution tool only.',
//     'First run interpreter-app tools list.',
//     `Then run this exact shell command: ${command}`,
//     'You must actually run that exact shell command even if you expect it to fail or be blocked.',
//     'Do not stop after interpreter-app tools list.',
//     'Do not use any app tools, MCP tools, or non-shell tools.',
//     'Do not search parent directories or use guessed paths.',
//     `If the shell command prints the file contents successfully, reply with exactly ${successPrefix}<the exact line from the command output>.`,
//     `Otherwise reply with exactly ${blockedToken}.`,
//     'Do not guess any file contents.',
//   ].join(' ');
// }
//
// function buildShellWritePrompt(
//   command: string,
//   successToken: string,
//   blockedToken: string,
// ): string {
//   return [
//     'Use the native shell command execution tool only.',
//     'First run interpreter-app tools list.',
//     `Then run this exact shell command: ${command}`,
//     'You must actually run that exact shell command even if you expect it to fail or be blocked.',
//     'Do not stop after interpreter-app tools list.',
//     'Do not use any app tools, MCP tools, or non-shell tools.',
//     'Do not inspect any other files.',
//     'Do not run tests.',
//     'Do not search the repo.',
//     `If the shell command completes successfully, reply with exactly ${successToken}.`,
//     `If it is blocked, denied, or fails, reply with exactly ${blockedToken}.`,
//     'Do not claim success unless the shell command really succeeded.',
//   ].join(' ');
// }
//
// test.skip(!OPENAI_API_KEY, 'OPENAI_API_KEY is required for the agent shell permission e2e suite.');
//
// test.describe.serial('Agent shell permissions', () => {
//   let originalRuntimePermissions: RuntimePermissionState;
//
//   test.beforeEach(async ({ page }) => {
//     await waitForAppReady(page);
//     originalRuntimePermissions = await getRuntimePermissions(page);
//     await setApprovalAutoApproveForTests(page, true);
//   });
//
//   test.afterEach(async ({ page }) => {
//     await setApprovalAutoApproveForTests(page, true).catch(() => {});
//     await setRuntimePermissions(page, originalRuntimePermissions).catch(() => {});
//   });
//
//   test('native shell keeps reads scoped to the bound agent workspace', async ({ page }, testInfo) => {
//     test.setTimeout(300000);
//
//     let createdProfileId: string | null = null;
//     let originalDefaultProfileId: string | null = null;
//     let scenario: Scenario | null = null;
//
//     try {
//       ({ createdProfileId, originalDefaultProfileId } = await createOpenAiProfile(page));
//       scenario = await prepareScenario(page, testInfo.title, ['agent-a', 'agent-b']);
//       const { logPath, agentEventsPath } = getTestArtifactPaths(testInfo.title);
//
//       const allowedSecretLine = `allowed-token-${Date.now()}`;
//       const blockedSecretLine = `blocked-token-${Date.now()}`;
//       const allowedSecretPath = path.join(scenario.agentWorkspacePaths[0]!, 'secret-a.txt');
//       const blockedSecretPath = path.join(scenario.agentWorkspacePaths[0]!, 'secret-b.txt');
//       await writeFile(allowedSecretPath, allowedSecretLine, 'utf8');
//       await writeFile(blockedSecretPath, blockedSecretLine, 'utf8');
//
//       await setRuntimePermissions(page, {
//         approvalPolicy: 'never',
//         sandboxMode: 'workspace-write',
//         readAccessMode: 'workspace-only',
//         macosTempAccess: true,
//       });
//
//       const allowedCommand = buildReadFileCommand(allowedSecretPath);
//       const blockedCommand = buildReadFileCommand(blockedSecretPath);
//
//       const [agentASession, agentBSession] = await Promise.all([
//         bootstrapBoundAgent(page, scenario.agentWorkspacePaths[0]!),
//         bootstrapBoundAgent(page, scenario.agentWorkspacePaths[1]!),
//       ]);
//
//       await sendPromptToAgent(
//         page,
//         agentASession.agentId,
//         agentASession.threadId,
//         buildShellReadPrompt(allowedCommand, 'ALLOW_READ=', 'ALLOW_READ_BLOCKED'),
//       );
//       await sendPromptToAgent(
//         page,
//         agentBSession.agentId,
//         agentBSession.threadId,
//         buildShellReadPrompt(blockedCommand, 'BLOCKED_READ=', 'BLOCKED_READ=1'),
//       );
//
//       const toolsListLog = await waitForLogCommand(logPath, 'interpreter-app tools list');
//       expect((toolsListLog.match(/interpreter-app tools list/g) ?? []).length).toBeGreaterThanOrEqual(2);
//       const allowedReadLog = await waitForLogCommand(logPath, allowedCommand);
//       expect(allowedReadLog).toContain(allowedSecretPath);
//       const allowedItems = await readThreadItems(page, agentASession.threadId);
//       expect(getFinalAgentMessageText(allowedItems)).toBe(`ALLOW_READ=${allowedSecretLine}`);
//       expectNoNonShellToolUsage(agentEventsPath);
//
//       const blockedReadLog = await waitForLogCommand(logPath, blockedCommand);
//       expect(blockedReadLog).toContain(blockedSecretPath);
//       const deniedReadLog = await waitForDeniedCommandInLog(logPath, blockedSecretPath);
//       expect(deniedReadLog).not.toContain(blockedSecretLine);
//       const blockedItems = await readThreadItems(page, agentBSession.threadId);
//       expect(getFinalAgentMessageText(blockedItems)).toBe('BLOCKED_READ=1');
//       expect(blockedItems.some((item) => (item.text ?? '').includes(blockedSecretLine))).toBe(false);
//       expectNoNonShellToolUsage(agentEventsPath);
//     } finally {
//       if (createdProfileId) {
//         await restoreOpenAiProfile(page, createdProfileId, originalDefaultProfileId);
//       }
//       await cleanupScenario(scenario);
//     }
//   });
//
//   test('native shell cannot write outside the bound workspace without full access', async ({ page }, testInfo) => {
//     test.setTimeout(240000);
//
//     let createdProfileId: string | null = null;
//     let originalDefaultProfileId: string | null = null;
//     let scenario: Scenario | null = null;
//
//     try {
//       ({ createdProfileId, originalDefaultProfileId } = await createOpenAiProfile(page));
//       scenario = await prepareScenario(page, testInfo.title, ['agent-a']);
//       const { logPath, agentEventsPath } = getTestArtifactPaths(testInfo.title);
//
//       const outputPath = path.join(scenario.outsidePath, 'outside-blocked.txt');
//       const outputContents = `outside-blocked-${Date.now()}`;
//       const writeCommand = buildWriteFileCommand(outputPath, outputContents);
//
//       await setRuntimePermissions(page, {
//         approvalPolicy: 'never',
//         sandboxMode: 'workspace-write',
//         readAccessMode: 'workspace-only',
//         macosTempAccess: true,
//       });
//
//       const agentSession = await bootstrapBoundAgent(page, scenario.agentWorkspacePaths[0]!);
//       await sendPromptToAgent(
//         page,
//         agentSession.agentId,
//         agentSession.threadId,
//         buildShellWritePrompt(writeCommand, 'WRITE_OK', 'WRITE_BLOCKED'),
//       );
//
//       const toolsListLog = await waitForLogCommand(logPath, 'interpreter-app tools list');
//       expect(toolsListLog).toContain('interpreter-app tools list');
//       const blockedWriteLog = await waitForLogCommand(logPath, writeCommand);
//       expect(blockedWriteLog).toContain(outputPath);
//       await waitForDeniedCommandInLog(logPath, outputPath);
//       expect(fs.existsSync(outputPath)).toBe(false);
//       const items = await readThreadItems(page, agentSession.threadId);
//       expect(getFinalAgentMessageText(items)).toBe('WRITE_BLOCKED');
//       expectNoNonShellToolUsage(agentEventsPath);
//     } finally {
//       if (createdProfileId) {
//         await restoreOpenAiProfile(page, createdProfileId, originalDefaultProfileId);
//       }
//       await cleanupScenario(scenario);
//     }
//   });
//
//   test('native shell write approvals respect allow and deny in ask-first mode', async ({ page }, testInfo) => {
//     test.setTimeout(360000);
//
//     let createdProfileId: string | null = null;
//     let originalDefaultProfileId: string | null = null;
//     let scenario: Scenario | null = null;
//
//     try {
//       ({ createdProfileId, originalDefaultProfileId } = await createOpenAiProfile(page));
//       scenario = await prepareScenario(page, testInfo.title, ['agent-a', 'agent-b']);
//       const { logPath, agentEventsPath } = getTestArtifactPaths(testInfo.title);
//
//       const allowedPath = path.join(scenario.agentWorkspacePaths[0]!, 'approved-write.txt');
//       const deniedPath = path.join(scenario.agentWorkspacePaths[1]!, 'denied-write.txt');
//       const allowedContents = `approved-shell-write-${Date.now()}`;
//       const deniedContents = `denied-shell-write-${Date.now()}`;
//       await setApprovalAutoApproveForTests(page, false);
//       await setRuntimePermissions(page, {
//         approvalPolicy: 'untrusted',
//         sandboxMode: 'workspace-write',
//         readAccessMode: 'workspace-only',
//         macosTempAccess: true,
//       });
//
//       const approveSession = await bootstrapBoundAgent(page, scenario.agentWorkspacePaths[0]!);
//       const approvePrompt = buildShellWritePrompt(
//         buildWriteFileCommand(allowedPath, allowedContents),
//         'WRITE_APPROVED',
//         'WRITE_DENIED',
//       );
//       await submitPromptToAgent(page, approveSession.agentId, approvePrompt);
//       await approveShellCommand(page, approveSession.agentId, logPath, allowedPath);
//       await waitForAgentResponse(page, approveSession.agentId, approveSession.threadId);
//
//       const approveToolsListLog = await waitForLogCommand(logPath, 'interpreter-app tools list');
//       expect(approveToolsListLog).toContain('interpreter-app tools list');
//       const approveWriteLog = await waitForLogCommand(
//         logPath,
//         buildWriteFileCommand(allowedPath, allowedContents),
//       );
//       expect(approveWriteLog).toContain(allowedPath);
//       expect(fs.existsSync(allowedPath)).toBe(true);
//       expect(fs.readFileSync(allowedPath, 'utf8')).toBe(allowedContents);
//       const approveTurns = await readThreadTurns(page, approveSession.threadId);
//       expect(getTurnFinalAgentMessageText(getLastThreadTurn(approveTurns))).toBe('WRITE_APPROVED');
//       expectNoNonShellToolUsage(agentEventsPath);
//
//       const denySession = await bootstrapBoundAgent(page, scenario.agentWorkspacePaths[1]!);
//       const denyPrompt = buildShellWritePrompt(
//         buildWriteFileCommand(deniedPath, deniedContents),
//         'WRITE_APPROVED',
//         'WRITE_DENIED',
//       );
//       await submitPromptToAgent(page, denySession.agentId, denyPrompt);
//       await denyShellCommand(page, denySession.agentId, logPath, deniedPath);
//       await waitForAgentResponse(page, denySession.agentId, denySession.threadId);
//
//       const denyToolsListLog = await waitForLogCommand(logPath, 'interpreter-app tools list');
//       expect(denyToolsListLog).toContain('interpreter-app tools list');
//       const denyWriteLog = await waitForLogCommand(
//         logPath,
//         buildWriteFileCommand(deniedPath, deniedContents),
//       );
//       expect(denyWriteLog).toContain(deniedPath);
//       await waitForDeclinedCommandInLog(logPath, deniedPath);
//       expect(fs.existsSync(deniedPath)).toBe(false);
//       const denyTurns = await readThreadTurns(page, denySession.threadId);
//       const denyLastTurn = getLastThreadTurn(denyTurns);
//       expect(denyLastTurn?.status).toBe('interrupted');
//       expect(getTurnFinalAgentMessageText(denyLastTurn)).not.toBe('WRITE_APPROVED');
//       expect(
//         (denyLastTurn?.items ?? []).some((item: ThreadHistoryItem) => (item.text ?? '').includes(deniedContents)),
//       ).toBe(false);
//       expectNoNonShellToolUsage(agentEventsPath);
//     } finally {
//       if (createdProfileId) {
//         await restoreOpenAiProfile(page, createdProfileId, originalDefaultProfileId);
//       }
//       await cleanupScenario(scenario);
//     }
//   });
//
//   test('native shell can write outside the workspace when full access is enabled', async ({ page }, testInfo) => {
//     test.setTimeout(240000);
//
//     let createdProfileId: string | null = null;
//     let originalDefaultProfileId: string | null = null;
//     let scenario: Scenario | null = null;
//
//     try {
//       ({ createdProfileId, originalDefaultProfileId } = await createOpenAiProfile(page));
//       scenario = await prepareScenario(page, testInfo.title, ['agent-a']);
//       const { logPath, agentEventsPath } = getTestArtifactPaths(testInfo.title);
//
//       const outputPath = path.join(scenario.outsidePath, 'outside-allowed.txt');
//       const outputContents = `outside-allowed-${Date.now()}`;
//       const writeCommand = buildWriteFileCommand(outputPath, outputContents);
//
//       await setRuntimePermissions(page, {
//         approvalPolicy: 'never',
//         sandboxMode: 'danger-full-access',
//         readAccessMode: 'full-system',
//         macosTempAccess: true,
//       });
//
//       const agentSession = await bootstrapBoundAgent(page, scenario.agentWorkspacePaths[0]!);
//       await sendPromptToAgent(
//         page,
//         agentSession.agentId,
//         agentSession.threadId,
//         buildShellWritePrompt(writeCommand, 'WRITE_ANYWHERE_OK', 'WRITE_ANYWHERE_BLOCKED'),
//       );
//
//       const toolsListLog = await waitForLogCommand(logPath, 'interpreter-app tools list');
//       expect(toolsListLog).toContain('interpreter-app tools list');
//       const allowedWriteLog = await waitForLogCommand(logPath, writeCommand);
//       expect(allowedWriteLog).toContain(outputPath);
//       expect(fs.existsSync(outputPath)).toBe(true);
//       expect(fs.readFileSync(outputPath, 'utf8')).toBe(outputContents);
//       const items = await readThreadItems(page, agentSession.threadId);
//       expect(getFinalAgentMessageText(items)).toBe('WRITE_ANYWHERE_OK');
//       expectNoNonShellToolUsage(agentEventsPath);
//     } finally {
//       if (createdProfileId) {
//         await restoreOpenAiProfile(page, createdProfileId, originalDefaultProfileId);
//       }
//       await cleanupScenario(scenario);
//     }
//   });
// });
