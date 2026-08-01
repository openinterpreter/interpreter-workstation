// import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
// import {
//   apiCall,
//   deleteProfile,
//   getTestWorkspace,
//   setWorkspace,
//   waitForAppReady,
//   waitForResponseWithErrorCheck,
// } from './helpers';
// import { sel, testId } from './selectors';
//
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// const OPENAI_BASE_URL = 'https://api.openai.com/v1';
// const OPENAI_MODEL = 'gpt-5.2';
//
// test.skip(!OPENAI_API_KEY, 'OPENAI_API_KEY is required for the Interpreter identity e2e test.');
//
// test('Interpreter stream identifies as Interpreter and not Codex', async ({ page }) => {
//   test.setTimeout(120000);
//
//   const profileId = `test-interpreter-identity-${Date.now()}`;
//   const profileName = `Interpreter Identity Test ${profileId}`;
//   let profileCreated = false;
//
//   try {
//     await waitForAppReady(page);
//     await setWorkspace(page, getTestWorkspace());
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
//     await page.reload();
//     await waitForAppReady(page);
//
//     pauseErrorChecking(page);
//     const settingsButton = page.locator(sel('agentSettingsButton'));
//     await settingsButton.click();
//     const popover = page.locator(sel('settingsPopover'));
//     await expect(popover).toBeVisible({ timeout: 5000 });
//     await popover.locator(sel.profileCard(profileId)).click();
//     await expect(popover).toBeHidden({ timeout: 5000 });
//
//     await settingsButton.click();
//     await expect(popover).toBeVisible({ timeout: 5000 });
//     await expect(popover.locator(`${sel.profileCard(profileId)} .lucide-check`).first()).toBeVisible({ timeout: 5000 });
//     await page.keyboard.press('Escape');
//     await expect(popover).toBeHidden({ timeout: 5000 });
//     resumeErrorChecking(page);
//
//     const composer = page.locator(sel('mainComposerInput')).first();
//     await expect(composer).toBeVisible({ timeout: 10000 });
//     await composer.click();
//     const prompt = 'Who are you? Answer in one short sentence and include the name you identify as.';
//     await page.keyboard.type(
//       prompt,
//       { delay: 20 },
//     );
//     await page.keyboard.press('Enter');
//
//     const thread = page.locator(sel.activeAgentThread());
//     const typingIndicator = page.getByTestId(testId('typingIndicator'));
//     await waitForResponseWithErrorCheck(page, typingIndicator, thread, 90000);
//     await page.waitForFunction(
//       (promptText: string) => {
//         const activeThread = document.querySelector('[data-testid^="agent-thread-"][data-active="true"]');
//         if (!activeThread) return false;
//         const threadText = activeThread.textContent?.trim() ?? '';
//         if (threadText.length <= promptText.length || threadText === promptText) return false;
//         return /\b(Interpreter|Codex)\b/i.test(threadText);
//       },
//       prompt,
//       { timeout: 90000 },
//     );
//
//     const threadText = (await thread.textContent({ timeout: 10000 })) || '';
//     expect(threadText).toMatch(/\bInterpreter\b/i);
//     expect(threadText).not.toMatch(/\bCodex\b/i);
//   } finally {
//     if (profileCreated) {
//       await deleteProfile(page, profileId);
//     }
//   }
// });
