import { test, expect } from './fixtures';
import { clearUserConfig, waitForAppReady, apiCall, deleteProfile } from './helpers';
import { sel } from './selectors';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

test.describe.configure({ timeout: 120000 });

function writeOpenRouterModelCache(): void {
  const configDir = path.join(homedir(), '.interpreter');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'openrouter-models.json'),
    JSON.stringify(
      {
        fetchedAt: Date.now(),
        models: [
          {
            id: 'openai/gpt-5.4',
            name: 'GPT-5.4',
            provider: 'openai',
            description: 'Flagship reasoning model',
            contextLength: 400000,
          },
          {
            id: 'openai/gpt-5.4-mini',
            name: 'GPT-5.4-mini',
            provider: 'openai',
            description: 'Inexpensive OpenAI model',
            contextLength: 400000,
          },
          {
            id: 'anthropic/claude-opus-4.6',
            name: 'Claude Opus 4.6',
            provider: 'anthropic',
            description: 'Expensive reasoning model',
            contextLength: 200000,
          },
          {
            id: 'anthropic/claude-sonnet-4.6',
            name: 'Claude Sonnet 4.6',
            provider: 'anthropic',
            description: 'General-purpose reasoning model',
            contextLength: 200000,
          },
          {
            id: 'anthropic/claude-haiku-4.5',
            name: 'Claude Haiku 4.5',
            provider: 'anthropic',
            description: 'Fast lightweight model',
            contextLength: 200000,
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );
}

test('Settings > Models smoke persists a hosted model selection', async ({ page }) => {
  const profileId = `test-hosted-picker-${Date.now()}`;
  let profileCreated = false;

  try {
    writeOpenRouterModelCache();
    await clearUserConfig(page);
    await waitForAppReady(page);

    const createResponse = await apiCall(page, 'POST', '/api/profiles', {
      id: profileId,
      name: 'Hosted Picker Test',
      modelId: 'interpreter-smart',
      isBuiltin: false,
      provider: 'hosted',
      providerId: 'builtin:hosted',
    });
    expect(createResponse.ok).toBe(true);
    profileCreated = true;

    await page.locator(sel('agentSettingsButton')).click();
    await expect(page.locator(sel('settingsPopover'))).toBeVisible({ timeout: 5000 });
    await page.locator(sel('settingsPopover')).getByText('Settings').click();

    await expect(page.locator(sel('settingsView'))).toBeVisible({ timeout: 10000 });
    const settingsView = page.locator(sel('settingsView'));
    await page.locator(sel.settingsTab('models')).click();
    await expect(settingsView.getByText('API keys are set per model.')).toBeVisible();
    await settingsView.locator(sel.profileCard(profileId)).click();

    await expect(page.locator(sel.profileProviderTab('hosted'))).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'GPT-5.4-mini' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claude Sonnet 4.6' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'GPT-5.4-nano' })).toHaveCount(0);
    const opusWarning = page.getByRole('button', { name: 'Claude Opus 4.6 Expensive' }).getByText('Expensive');
    await expect(opusWarning).toBeVisible();
    const opusNameRow = page
      .getByRole('button', { name: 'Claude Opus 4.6 Expensive' })
      .locator('span', { hasText: 'Claude Opus 4.6' })
      .locator('xpath=..');
    await expect(opusNameRow).toHaveClass(/gap-2\.5/);

    await page.getByRole('button', { name: 'GPT-5.4-mini' }).click();

    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(settingsView.locator(sel.profileCard(profileId))).toBeVisible({ timeout: 10000 });

    await settingsView.locator(sel.profileCard(profileId)).click();
    await expect(page.locator(sel('hostedModelPickerTrigger'))).toContainText('GPT-5.4-mini');
  } finally {
    if (profileCreated) {
      await deleteProfile(page, profileId);
    }
  }
});
