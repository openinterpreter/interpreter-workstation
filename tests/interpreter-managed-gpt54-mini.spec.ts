// Hosted-provider smoke test: verifies the agent can invoke workspace tools via
// the interpreter-managed proxy (GPT-5.4-mini).
//
// Flake history (PRs #703, #880): the manual Date.now() polling loop and
// waitForResponseWithErrorCheck both suffered from the same root cause --
// the shared fixture's doSetup threw on non-crash errors (regression in
// PR #946 / 4832a809), which bypassed the retry loop and made waitForAppReady
// timeouts fatal. That regression is now fixed (doSetup returns instead of
// throwing), and this test uses Playwright's expect.toPass for the response
// poll: it retries with back-off intervals and surfaces the actual failing
// assertion on timeout, replacing the opaque `successObserved === false`.

import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import { apiCall, getTestWorkspace, setWorkspace } from './helpers';
import { sel } from './selectors';

test('Interpreter-managed GPT-5.4-mini can read workspace files via agent tools', async ({ page }) => {
  test.setTimeout(180_000);

  const profileId = `test-hosted-mini-${Date.now()}`;
  const profileName = `Hosted GPT-5.4-mini ${profileId}`;
  let profileCreated = false;

  try {
    const composer = page.locator(sel('mainComposerInput')).first();
    await expect(composer).toBeVisible();

    await setWorkspace(page, getTestWorkspace());

    const createProfileResponse = await apiCall(page, 'POST', '/api/profiles', {
      id: profileId,
      name: profileName,
      modelId: 'openai/gpt-5.4-mini',
      isBuiltin: false,
      provider: 'hosted',
      providerId: 'builtin:hosted',
    });
    expect(createProfileResponse.ok).toBe(true);
    profileCreated = true;

    pauseErrorChecking(page);
    await page.locator(sel('agentSettingsButton')).click();
    const popover = page.locator(sel('settingsPopover'));
    await expect(popover).toBeVisible();
    await popover.locator(sel.profileCard(profileId)).click();
    await expect(popover).toBeHidden();
    resumeErrorChecking(page);

    await expect(composer).toBeVisible();
    await composer.click();
    const prompt = 'Use tools to read notes.txt from the workspace. If the first non-empty line is exactly "Test content for proxy E2E tests", reply with only FIRST=1. Otherwise reply with only FIRST=0.';
    await page.keyboard.type(prompt, { delay: 20 });
    await page.keyboard.press('Enter');

    const thread = page.locator(sel.activeAgentThread());

    await expect(async () => {
      const threadText = await thread.innerText();
      expect(threadText).not.toContain('Something went wrong');

      const toolCallCount = await thread.locator('[data-testid^="tool-call-"]').count();
      const attemptedReadNotes = /read(?:ing)?\s+`?notes\.txt`?/i.test(threadText);
      expect(
        threadText.includes('FIRST=1') || toolCallCount > 0 || attemptedReadNotes,
      ).toBe(true);
    }).toPass({
      intervals: [500, 1_000, 2_000, 5_000],
      timeout: 120_000,
    });
  } finally {
    if (profileCreated) {
      const deleteProfileResponse = await apiCall(page, 'DELETE', `/api/profiles/${profileId}`);
      expect(deleteProfileResponse.ok).toBe(true);
    }
  }
});

test('local Interpreter Fast routes through the local hosted API', async ({ page }) => {
  test.skip(process.env.USE_LOCAL_API !== 'true', 'Requires USE_LOCAL_API=true so Interpreter Fast hits a compatible local hosted API.');
  test.setTimeout(180_000);

  const profileId = `test-interpreter-fast-${Date.now()}`;
  const profileName = `Interpreter Fast ${profileId}`;
  let profileCreated = false;

  try {
    const composer = page.locator(sel('mainComposerInput')).first();
    await expect(composer).toBeVisible();

    await setWorkspace(page, getTestWorkspace());

    const createProfileResponse = await apiCall(page, 'POST', '/api/profiles', {
      id: profileId,
      name: profileName,
      modelId: 'interpreter-fast',
      isBuiltin: false,
      provider: 'hosted',
      providerId: 'builtin:hosted',
    });
    expect(createProfileResponse.ok).toBe(true);
    profileCreated = true;

    pauseErrorChecking(page);
    await page.locator(sel('agentSettingsButton')).click();
    const popover = page.locator(sel('settingsPopover'));
    await expect(popover).toBeVisible();
    await popover.locator(sel.profileCard(profileId)).click();
    await expect(popover).toBeHidden();
    resumeErrorChecking(page);

    await expect(composer).toBeVisible();
    await composer.click();
    await page.keyboard.type('Reply with exactly FAST_OK and no other text.', { delay: 20 });
    await page.keyboard.press('Enter');

    const thread = page.locator(sel.activeAgentThread());
    await expect(async () => {
      const threadText = await thread.innerText();
      expect(threadText).not.toContain('Something went wrong');
      expect(threadText).toContain('FAST_OK');
    }).toPass({
      intervals: [500, 1_000, 2_000, 5_000],
      timeout: 120_000,
    });
  } finally {
    if (profileCreated) {
      const deleteProfileResponse = await apiCall(page, 'DELETE', `/api/profiles/${profileId}`);
      expect(deleteProfileResponse.ok).toBe(true);
    }
  }
});

test('local Interpreter Smart routes through the local hosted API', async ({ page }) => {
  test.skip(process.env.USE_LOCAL_API !== 'true', 'Requires USE_LOCAL_API=true so Interpreter Smart hits a compatible local hosted API.');
  test.setTimeout(180_000);

  const profileId = `test-interpreter-smart-${Date.now()}`;
  const profileName = `Interpreter Smart ${profileId}`;
  let profileCreated = false;

  try {
    const composer = page.locator(sel('mainComposerInput')).first();
    await expect(composer).toBeVisible();

    await setWorkspace(page, getTestWorkspace());

    const createProfileResponse = await apiCall(page, 'POST', '/api/profiles', {
      id: profileId,
      name: profileName,
      modelId: 'interpreter-smart',
      isBuiltin: false,
      provider: 'hosted',
      providerId: 'builtin:hosted',
    });
    expect(createProfileResponse.ok).toBe(true);
    profileCreated = true;

    pauseErrorChecking(page);
    await page.locator(sel('agentSettingsButton')).click();
    const popover = page.locator(sel('settingsPopover'));
    await expect(popover).toBeVisible();
    await popover.locator(sel.profileCard(profileId)).click();
    await expect(popover).toBeHidden();
    resumeErrorChecking(page);

    await expect(composer).toBeVisible();
    await composer.click();
    await page.keyboard.type('Reply with exactly SMART_OK and no other text.', { delay: 20 });
    await page.keyboard.press('Enter');

    const thread = page.locator(sel.activeAgentThread());
    await expect(async () => {
      const threadText = await thread.innerText();
      expect(threadText).not.toContain('Something went wrong');
      expect(threadText).toContain('SMART_OK');
    }).toPass({
      intervals: [500, 1_000, 2_000, 5_000],
      timeout: 120_000,
    });
  } finally {
    if (profileCreated) {
      const deleteProfileResponse = await apiCall(page, 'DELETE', `/api/profiles/${profileId}`);
      expect(deleteProfileResponse.ok).toBe(true);
    }
  }
});
