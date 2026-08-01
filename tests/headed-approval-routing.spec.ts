// import type { Page } from '@playwright/test';
// import { test, expect } from './fixtures';
// import {
//   apiCall,
//   deleteProfile,
//   getActiveCodexThreadId,
//   getTestWorkspace,
//   setWorkspace,
//   waitForAppReady,
//   waitForResponseWithErrorCheck,
// } from './helpers';
// import { sel } from './selectors';
//
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// const OPENAI_BASE_URL = 'https://api.openai.com/v1';
// const OPENAI_MODEL = 'gpt-5.4-mini';
// const QUESTION_TEXT = 'Choose one color.';
// const ANSWER_VALUE = 'cerulean';
// const FINAL_REPLY = `MODEL_CHOICE=${ANSWER_VALUE}`;
// const PREAMBLE_TEXT = 'I found the local Ask User tool. I’m using it directly now.';
//
// async function getEditorAgentTabIds(page: Page): Promise<string[]> {
//   return page.evaluate(() => {
//     const layout = (window as any).__layoutContext?.getState?.();
//     if (!layout) {
//       return [];
//     }
//
//     const sidebarTabIds = new Set<string>(layout.sidebarPane?.tabIds ?? []);
//     return Object.values(layout.tabs ?? {})
//       .filter((tab: any) => tab?.type === 'agent' && !sidebarTabIds.has(tab.id))
//       .map((tab: any) => tab.id as string);
//   });
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
// }
//
// async function openNewEditorAgentTab(page: Page, existingIds: string[]): Promise<string> {
//   await page.evaluate(() => {
//     (window as any).__layoutContext?.openNewTab?.();
//   });
//
//   await page.waitForFunction(({ previousIds }) => {
//     const layout = (window as any).__layoutContext?.getState?.();
//     if (!layout) {
//       return false;
//     }
//
//     const sidebarTabIds = new Set<string>(layout.sidebarPane?.tabIds ?? []);
//     const currentIds = Object.values(layout.tabs ?? {})
//       .filter((tab: any) => tab?.type === 'agent' && !sidebarTabIds.has(tab.id))
//       .map((tab: any) => tab.id as string);
//
//     return currentIds.some((id) => !previousIds.includes(id));
//   }, { previousIds: existingIds }, { timeout: 10000 });
//
//   const currentIds = await getEditorAgentTabIds(page);
//   const newId = currentIds.find((id) => !existingIds.includes(id));
//   if (!newId) {
//     throw new Error('Expected a new editor agent tab to be created');
//   }
//   return newId;
// }
//
// async function waitForInlineQuestion(page: Page, ownerThreadSelector: string): Promise<void> {
//   const result = await Promise.race([
//     page.waitForFunction(({ threadSelector, questionOptionSelector, submitSelector }) => {
//       const thread = document.querySelector(threadSelector);
//       if (!thread) return false;
//       return Boolean(
//         thread.querySelector(questionOptionSelector)
//         && thread.querySelector(submitSelector),
//       );
//     }, {
//       threadSelector: ownerThreadSelector,
//       questionOptionSelector: sel.questionOption(0, 0),
//       submitSelector: sel('questionSubmitButton'),
//     }, { timeout: 120000 }).then(() => 'question'),
//     page.waitForFunction(({ threadSelector }) => {
//       const thread = document.querySelector(threadSelector);
//       if (!thread) return false;
//       return (thread.textContent ?? '').includes('Something went wrong');
//     }, { threadSelector: ownerThreadSelector }, { timeout: 120000 }).then(() => 'error'),
//     page.waitForTimeout(120000).then(() => 'timeout'),
//   ]);
//
//   if (result === 'error') {
//     throw new Error('Owner thread showed "Something went wrong" before ask_user_question rendered');
//   }
//   if (result === 'timeout') {
//     throw new Error('Timed out waiting for ask_user_question to render inline in the owner thread');
//   }
// }
//
// async function getThreadText(page: Page, agentId: string): Promise<string> {
//   const text = await page.locator(sel.agentThread(agentId)).textContent();
//   return text ?? '';
// }
//
// async function waitForCliAskUserCommand(page: Page, threadId: string): Promise<void> {
//   const deadline = Date.now() + 30000;
//
//   while (Date.now() < deadline) {
//     const threadResponse = await apiCall(
//       page,
//       'GET',
//       `/api/agent/threads/${encodeURIComponent(threadId)}`,
//     );
//     expect(threadResponse.ok).toBe(true);
//
//     const items = ((threadResponse.data as {
//       thread?: {
//         turns?: Array<{
//           items?: Array<{
//             type?: string;
//             command?: string;
//             status?: string;
//             text?: string;
//           }>;
//         }>;
//       };
//     }).thread?.turns ?? []).flatMap((turn) => turn.items ?? []);
//
//     const cliAskUser = items.find((item) =>
//       item.type === 'commandExecution'
//       && item.status === 'completed'
//       && (item.command ?? '').includes('tools builtin-ask-user ask_user_question'));
//     const finalAssistantMessage = items.find((item) =>
//       item.type === 'agentMessage'
//       && (item.text ?? '').includes(FINAL_REPLY));
//
//     if (cliAskUser && finalAssistantMessage) {
//       return;
//     }
//
//     await page.waitForTimeout(500);
//   }
//
//   throw new Error('Timed out waiting for CLI ask_user_question command and final routed answer in thread history');
// }
//
// test('CLI ask_user_question renders inline in the owning agent tab and routes the answer back to that agent', async ({ page }) => {
//   test.setTimeout(180000);
//   test.skip(!OPENAI_API_KEY, 'OPENAI_API_KEY is required for the approval routing e2e test.');
//
//   const profileId = `test-openai-mini-approval-routing-${Date.now()}`;
//   const profileName = `OpenAI GPT-5.4-mini Approval Routing ${profileId}`;
//   let profileCreated = false;
//   let originalDefaultProfileId: string | null = null;
//
//   try {
//     await waitForAppReady(page);
//     const workspacePath = getTestWorkspace();
//     await setWorkspace(page, workspacePath);
//
//     const profilesResponse = await apiCall(page, 'GET', '/api/profiles');
//     expect(profilesResponse.ok).toBe(true);
//     originalDefaultProfileId = (profilesResponse.data as {
//       defaultProfileId?: string | null;
//     }).defaultProfileId ?? null;
//
//     const createProfileResponse = await apiCall(page, 'POST', '/api/profiles', {
//       id: profileId,
//       name: profileName,
//       modelId: OPENAI_MODEL,
//       isBuiltin: false,
//       provider: 'api',
//       apiKey: OPENAI_API_KEY,
//       baseURL: OPENAI_BASE_URL,
//       apiFormat: 'openai',
//     });
//     expect(createProfileResponse.ok).toBe(true);
//     profileCreated = true;
//
//     const setDefaultResponse = await apiCall(page, 'POST', '/api/profiles/default', {
//       profileId,
//     });
//     expect(setDefaultResponse.ok).toBe(true);
//
//     const baselineAgentIds = await getEditorAgentTabIds(page);
//     expect(baselineAgentIds.length).toBeGreaterThan(0);
//
//     const startResponse = await page.evaluate(async ({ workspace, questionText, finalReply, preambleText }) => {
//       return await (window as typeof window & {
//         electron: {
//           programmaticTasks: {
//             startHeaded: (request: {
//               message?: string;
//               system?: string;
//               timeoutMs?: number;
//               workspace?: string;
//             }) => Promise<{
//               success: boolean;
//               result?: {
//                 agentId?: string;
//               };
//               error?: string;
//             }>;
//           };
//         };
//       }).electron.programmaticTasks.startHeaded({
//         message: [
//           `First, reply with exactly this sentence and nothing else: ${preambleText}`,
//           'Then execute exactly one shell command, then stop and wait for the result.',
//           'Do not inspect any files.',
//           'Do not run tests.',
//           'Do not search the repo.',
//           'Do not send progress updates.',
//           'Do not use any tool except the one shell command below.',
//           `Shell command: "$INTERPRETER_CLI_PATH" tools builtin-ask-user ask_user_question --json '${JSON.stringify({
//             questions: [
//               {
//                 header: 'Color',
//                 question: questionText,
//                 options: [
//                   { label: 'Cerulean', value: 'cerulean', recommended: true },
//                   { label: 'Vermilion', value: 'vermilion' },
//                 ],
//               },
//             ],
//           })}'`,
//           `After that command returns, reply with exactly ${finalReply} or MODEL_CHOICE=vermilion and nothing else.`,
//         ].join('\n'),
//         system: [
//           'Deterministic evaluation mode.',
//           'The user message already contains the full procedure.',
//           'Forbidden actions: reading files, searching, running tests, planning, or sending commentary.',
//           `You must emit the exact preamble sentence before using shell: ${preambleText}`,
//           'Use native shell exactly once with the exact command from the user message.',
//           'When the shell command finishes, answer with the exact final token format requested by the user.',
//         ].join('\n'),
//         timeoutMs: 120000,
//         workspace,
//       });
//     }, {
//       workspace: workspacePath,
//       questionText: QUESTION_TEXT,
//       finalReply: FINAL_REPLY,
//       preambleText: PREAMBLE_TEXT,
//     });
//
//     expect(startResponse.success).toBe(true);
//     expect(startResponse.result?.agentId).toBeTruthy();
//     const ownerAgentId = startResponse.result?.agentId as string;
//
//     await page.waitForFunction(({ baselineIds, expectedOwnerId }) => {
//       const layout = (window as any).__layoutContext?.getState?.();
//       if (!layout) {
//         return false;
//       }
//
//       const sidebarTabIds = new Set<string>(layout.sidebarPane?.tabIds ?? []);
//       const currentIds = Object.values(layout.tabs ?? {})
//         .filter((tab: any) => tab?.type === 'agent' && !sidebarTabIds.has(tab.id))
//         .map((tab: any) => tab.id as string);
//
//       return currentIds.includes(expectedOwnerId) && currentIds.length > baselineIds.length;
//     }, { baselineIds: baselineAgentIds, expectedOwnerId: ownerAgentId }, { timeout: 10000 });
//
//     const currentAgentIds = await getEditorAgentTabIds(page);
//     const extraAgentId = await openNewEditorAgentTab(page, currentAgentIds);
//
//     const nonOwnerAgentIds = Array.from(new Set(
//       [...baselineAgentIds.filter((id) => id !== ownerAgentId), extraAgentId].filter(Boolean),
//     ));
//     expect(nonOwnerAgentIds.length).toBeGreaterThanOrEqual(2);
//
//     await setActiveEditorTab(page, ownerAgentId);
//     const ownerThreadSelector = sel.agentThread(ownerAgentId);
//     const ownerThread = page.locator(ownerThreadSelector);
//     const selectedOption = ownerThread.locator(sel.questionOption(0, 0)).last();
//     const submitButton = ownerThread.locator(sel('questionSubmitButton')).last();
//     await expect(ownerThread).toContainText(PREAMBLE_TEXT, { timeout: 30000 });
//     await waitForInlineQuestion(page, ownerThreadSelector);
//     await expect(selectedOption).toBeVisible({ timeout: 10000 });
//     await expect(submitButton).toBeVisible({ timeout: 10000 });
//
//     for (const otherAgentId of nonOwnerAgentIds) {
//       await setActiveEditorTab(page, otherAgentId);
//       const otherThreadText = await getThreadText(page, otherAgentId);
//       expect(otherThreadText.includes(QUESTION_TEXT)).toBe(false);
//       expect(otherThreadText.includes(FINAL_REPLY)).toBe(false);
//     }
//
//     await setActiveEditorTab(page, ownerAgentId);
//     await selectedOption.click();
//     await submitButton.click();
//
//     const typingIndicator = page.locator(sel('typingIndicator'));
//     await waitForResponseWithErrorCheck(page, typingIndicator, ownerThread, 120000);
//     await expect(ownerThread).toContainText(FINAL_REPLY, { timeout: 10000 });
//
//     for (const otherAgentId of nonOwnerAgentIds) {
//       await setActiveEditorTab(page, otherAgentId);
//       const otherThreadText = await getThreadText(page, otherAgentId);
//       expect(otherThreadText.includes(QUESTION_TEXT)).toBe(false);
//       expect(otherThreadText.includes(FINAL_REPLY)).toBe(false);
//     }
//
//     await setActiveEditorTab(page, ownerAgentId);
//     const threadId = await getActiveCodexThreadId(page);
//     expect(threadId).toBeTruthy();
//     await waitForCliAskUserCommand(page, threadId as string);
//   } finally {
//     if (originalDefaultProfileId) {
//       await apiCall(page, 'POST', '/api/profiles/default', {
//         profileId: originalDefaultProfileId,
//       });
//     }
//     if (profileCreated) {
//       await deleteProfile(page, profileId);
//     }
//   }
// });
