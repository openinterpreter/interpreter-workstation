// import fs from 'fs';
// import path from 'path';
// import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
// import {
//   apiCall,
//   deleteProfile,
//   getAgentEventsLogPath,
//   getTestWorkspace,
//   setWorkspace,
//   waitForJsonlMatchCount,
// } from './helpers';
// import { sel } from './selectors';
//
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// const OPENAI_BASE_URL = 'https://api.openai.com/v1';
// const OPENAI_MODEL = 'gpt-5.4-mini';
//
// test.skip(!OPENAI_API_KEY, 'OPENAI_API_KEY is required for the OpenAI API shell file-read e2e test.');
//
// test('OpenAI API GPT-5.4-mini can read workspace files with native shell access', async ({ page }) => {
//   test.setTimeout(300000);
//
//   const profileId = `test-openai-mini-cli-${Date.now()}`;
//   const profileName = `OpenAI Mini CLI ${profileId}`;
//   const workspacePath = getTestWorkspace();
//   const secretFileName = 'openai-mini-cli-secret.txt';
//   const secret = `secret-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
//   const secretFilePath = path.join(workspacePath, secretFileName);
//   let profileCreated = false;
//
//   try {
//     fs.writeFileSync(secretFilePath, `${secret}\n`, 'utf8');
//
//     await page.waitForLoadState('networkidle');
//     await page.waitForTimeout(1000);
//     await setWorkspace(page, workspacePath);
//
//     const createProfileResponse = await apiCall(page, 'POST', '/api/profiles', {
//       id: profileId,
//       name: profileName,
//       isBuiltin: false,
//       provider: 'api',
//       apiKey: OPENAI_API_KEY,
//       baseURL: OPENAI_BASE_URL,
//       apiFormat: 'openai',
//       modelId: OPENAI_MODEL,
//     });
//     expect(createProfileResponse.ok).toBe(true);
//     profileCreated = true;
//
//     const composer = page.locator(sel('mainComposerInput')).first();
//     if (!(await composer.isVisible().catch(() => false))) {
//       const newAgentButton = page.locator(sel('newAgentButton')).first();
//       if (await newAgentButton.isVisible().catch(() => false)) {
//         await newAgentButton.click();
//       } else {
//         const started = await page.evaluate(async () => {
//           return await (window as typeof window & {
//             electron: {
//               programmaticTasks: {
//                 startHeaded: (request: {
//                   message?: string;
//                   timeoutMs?: number;
//                 }) => Promise<{ success: boolean }>;
//               };
//             };
//           }).electron.programmaticTasks.startHeaded({
//             message: 'Reply with only READY=1.',
//             timeoutMs: 30000,
//           });
//         });
//         expect(started.success).toBe(true);
//       }
//     }
//
//     await expect(composer).toBeVisible({ timeout: 15000 });
//
//     pauseErrorChecking(page);
//     const settingsButton = page.locator(sel('agentSettingsButton')).first();
//     await expect(settingsButton).toBeVisible({ timeout: 10000 });
//     await settingsButton.click();
//     const popover = page.locator(sel('settingsPopover'));
//     await expect(popover).toBeVisible({ timeout: 5000 });
//     await popover.locator(sel.profileCard(profileId)).click();
//     await expect(popover).toBeHidden({ timeout: 5000 });
//     resumeErrorChecking(page);
//
//     await composer.click();
//     const prompt = [
//       'Use the native shell and the interpreter CLI launcher only.',
//       'First run interpreter tools list.',
//       `The file is named ${secretFileName} and is directly in the current workspace root.`,
//       `Then run this exact shell command: cat ${secretFileName}`,
//       'Do not search parent directories or use guessed paths.',
//       'The file contains a single line.',
//       'Do not guess or paraphrase.',
//       'Reply with exactly SECRET= followed immediately by the line you read.',
//     ].join(' ');
//     await page.keyboard.type(prompt, { delay: 20 });
//     pauseErrorChecking(page);
//     await page.keyboard.press('Enter');
//
//     const thread = page.locator(sel.activeAgentThread());
//     const responseDeadline = Date.now() + 240000;
//     let threadText = '';
//     while (Date.now() < responseDeadline) {
//       const uiErrorVisible = await thread.locator('text=Something went wrong').isVisible().catch(() => false);
//       if (uiErrorVisible) {
//         throw new Error('UI showed "Something went wrong" during response');
//       }
//
//       threadText = await thread.innerText().catch(() => '');
//       if (threadText.includes(`SECRET=${secret}`)) {
//         break;
//       }
//       if (threadText.includes('No such file or directory')) {
//         throw new Error(`Shell could not find ${secretFileName}: ${threadText}`);
//       }
//
//       await page.waitForTimeout(250);
//     }
//     expect(threadText).toContain(`SECRET=${secret}`);
//
//     const agentEventsPath = getAgentEventsLogPath(test.info().title);
//     const logWaitMs = 180000;
//     await waitForJsonlMatchCount(
//       agentEventsPath,
//       (event) => (
//         event.method === 'item/completed'
//         && event.notification?.params?.item?.type === 'commandExecution'
//         && event.notification?.params?.item?.status === 'completed'
//         && String(event.notification?.params?.item?.command ?? '').includes('interpreter')
//         && String(event.notification?.params?.item?.command ?? '').includes('tools list')
//       ),
//       1,
//       logWaitMs,
//     );
//     await waitForJsonlMatchCount(
//       agentEventsPath,
//       (event) => (
//         event.method === 'item/completed'
//         && event.notification?.params?.item?.type === 'commandExecution'
//         && event.notification?.params?.item?.status === 'completed'
//         && String(event.notification?.params?.item?.command ?? '').includes(`cat ${secretFileName}`)
//       ),
//       1,
//       logWaitMs,
//     );
//     await waitForJsonlMatchCount(
//       agentEventsPath,
//       (event) => (
//         event.method === 'item/completed'
//         && event.notification?.params?.item?.type === 'agentMessage'
//         && event.notification?.params?.item?.phase === 'final_answer'
//         && String(event.notification?.params?.item?.text ?? '').includes('SECRET=')
//       ),
//       1,
//       logWaitMs,
//     );
//
//     resumeErrorChecking(page);
//   } finally {
//     resumeErrorChecking(page);
//     if (fs.existsSync(secretFilePath)) {
//       fs.unlinkSync(secretFilePath);
//     }
//     if (profileCreated) {
//       await deleteProfile(page, profileId);
//     }
//   }
// });
