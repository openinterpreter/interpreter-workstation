// import fs from "fs";
// import path from "path";
//
// import {
//   test,
//   expect,
//   pauseErrorChecking,
//   resumeErrorChecking,
// } from "./fixtures";
// import {
//   apiCall,
//   deleteProfile,
//   getAgentEventsLogPath,
//   getTestWorkspace,
//   setWorkspace,
//   waitForJsonlMatchCount,
//   waitForResponseWithErrorCheck,
//   waitForAppReady,
// } from "./helpers";
// import { sel } from "./selectors";
// import { resolveInterpreterConfigFile } from "../shared/interpreterConfigPaths";
//
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
// const OPENAI_BASE_URL = "https://api.openai.com/v1";
// const OPENAI_MODEL = "gpt-5.4-mini";
// const RUN_MEDIA_AI_E2E = process.env.RUN_MEDIA_AI_E2E === "true";
//
// function hasConfiguredAuthTokens(): boolean {
//   const configPath = resolveInterpreterConfigFile();
//   if (!fs.existsSync(configPath)) {
//     return false;
//   }
//
//   try {
//     const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
//     return Boolean(config.authToken && config.refreshToken);
//   } catch {
//     return false;
//   }
// }
//
// function hasConfiguredFalKey(): boolean {
//   if (process.env.FAL_KEY?.trim()) {
//     return true;
//   }
//
//   const envPath = path.join(process.cwd(), ".env");
//   if (!fs.existsSync(envPath)) {
//     return false;
//   }
//
//   return fs
//     .readFileSync(envPath, "utf8")
//     .split("\n")
//     .some(
//       (line) =>
//         line.startsWith("FAL_KEY=") &&
//         line.slice("FAL_KEY=".length).trim().length > 0,
//     );
// }
//
// test.skip(
//   !RUN_MEDIA_AI_E2E,
//   "Set RUN_MEDIA_AI_E2E=true to run the live Media AI GPT Image 2 e2e test.",
// );
// test.skip(
//   !OPENAI_API_KEY,
//   "OPENAI_API_KEY is required for the live Media AI GPT Image 2 e2e test.",
// );
// test.skip(
//   !hasConfiguredFalKey(),
//   "FAL_KEY must be configured in the shell for the live Media AI GPT Image 2 e2e test.",
// );
// test.skip(
//   !hasConfiguredAuthTokens(),
//   "Interpreter auth tokens are required in the local app config for the live Media AI GPT Image 2 e2e test.",
// );
//
// test("agent edits a workspace photo with GPT Image 2 through the local Media AI proxy", async ({
//   page,
// }) => {
//   test.setTimeout(300000);
//
//   const profileId = `test-media-ai-gpt-image-2-${Date.now()}`;
//   const profileName = `Media AI GPT Image 2 ${profileId}`;
//   const workspacePath = getTestWorkspace();
//   const inputRelativePath = "dog_photo.jpg";
//   const outputDirRelativePath = "media-ai-output";
//   const outputFileName = "gpt-image-2-dog-edit.png";
//   const outputDirPath = path.join(workspacePath, outputDirRelativePath);
//   const outputFilePath = path.join(outputDirPath, outputFileName);
//   let profileCreated = false;
//
//   try {
//     fs.rmSync(outputDirPath, { recursive: true, force: true });
//
//     await waitForAppReady(page);
//     await setWorkspace(page, workspacePath);
//
//     const createProfileResponse = await apiCall(page, "POST", "/api/profiles", {
//       id: profileId,
//       name: profileName,
//       isBuiltin: false,
//       provider: "api",
//       apiKey: OPENAI_API_KEY,
//       baseURL: OPENAI_BASE_URL,
//       apiFormat: "openai",
//       modelId: OPENAI_MODEL,
//     });
//     expect(createProfileResponse.ok).toBe(true);
//     profileCreated = true;
//
//     pauseErrorChecking(page);
//     const settingsButton = page.locator(sel("agentSettingsButton")).first();
//     await expect(settingsButton).toBeVisible({ timeout: 10000 });
//     await settingsButton.click();
//     const popover = page.locator(sel("settingsPopover"));
//     await expect(popover).toBeVisible({ timeout: 5000 });
//     await popover.locator(sel.profileCard(profileId)).click();
//     await expect(popover).toBeHidden({ timeout: 5000 });
//     resumeErrorChecking(page);
//
//     const composer = page.locator(sel("mainComposerInput")).first();
//     await expect(composer).toBeVisible({ timeout: 15000 });
//     await composer.click();
//
//     const prompt = [
//       "Use only the built-in Media AI tools for this task. Do not use shell commands.",
//       'First search the media models for the exact FAL endpoint "openai/gpt-image-2/edit".',
//       'After searching, run only endpoint_id "openai/gpt-image-2/edit". Do not use "fal-ai/gpt-image-1/edit-image" or any other endpoint.',
//       `Then edit the workspace image ${inputRelativePath}.`,
//       "Keep the same dog and overall framing.",
//       "Add a bright red party hat and replace the background with a clean sky-blue studio backdrop.",
//       `Save exactly one PNG into output_dir "${outputDirRelativePath}" with output_filename "${outputFileName}".`,
//       `Use the local workspace path "${inputRelativePath}" in image_urls.`,
//       "Reply with only the saved relative file path and nothing else.",
//     ].join(" ");
//
//     await page.keyboard.type(prompt, { delay: 20 });
//     pauseErrorChecking(page);
//     await page.keyboard.press("Enter");
//     resumeErrorChecking(page);
//
//     const thread = page.locator(sel.activeAgentThread());
//     const typingIndicator = page.locator(sel("typingIndicator"));
//     await waitForResponseWithErrorCheck(
//       page,
//       typingIndicator,
//       thread,
//       240000,
//       60000,
//     );
//
//     await expect
//       .poll(() => fs.existsSync(outputFilePath), {
//         timeout: 60000,
//         intervals: [500, 1000, 2000],
//       })
//       .toBe(true);
//
//     const outputStats = fs.statSync(outputFilePath);
//     expect(outputStats.size).toBeGreaterThan(1024);
//
//     const threadText = await thread.innerText();
//     expect(threadText).toContain(`${outputDirRelativePath}/${outputFileName}`);
//
//     const agentEventsPath = getAgentEventsLogPath(test.info().title);
//     const logWaitMs = 240000;
//
//     await waitForJsonlMatchCount(
//       agentEventsPath,
//       (event) =>
//         event.kind === "transcript" &&
//         event.type === "tool_call" &&
//         ((event.toolName === "search_media_models" &&
//           typeof event.input?.query === "string" &&
//           event.input.query.includes("GPT Image 2")) ||
//           (event.toolName === "command_execution" &&
//             typeof event.input?.command === "string" &&
//             event.input.command.includes(
//               "builtin-media-ai search_media_models",
//             ))),
//       1,
//       logWaitMs,
//     );
//
//     await waitForJsonlMatchCount(
//       agentEventsPath,
//       (event) =>
//         event.kind === "transcript" &&
//         event.type === "tool_call" &&
//         ((event.toolName === "run_media_model" &&
//           event.input?.endpoint_id === "openai/gpt-image-2/edit") ||
//           (event.toolName === "command_execution" &&
//             typeof event.input?.command === "string" &&
//             event.input.command.includes("builtin-media-ai run_media_model") &&
//             event.input.command.includes(
//               '\\"endpoint_id\\":\\"openai/gpt-image-2/edit\\"',
//             ))),
//       1,
//       logWaitMs,
//     );
//   } finally {
//     resumeErrorChecking(page);
//     if (profileCreated) {
//       await deleteProfile(page, profileId);
//     }
//   }
// });
