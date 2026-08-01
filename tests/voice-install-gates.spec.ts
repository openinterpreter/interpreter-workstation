import { test, expect } from './fixtures';
import { ElectronInstanceManager } from './electron-instance';
import {
  TEST_MOONSHINE_INSTALL_ROOT,
  TEST_QWEN_INSTALL_ROOT,
  applyEnv,
  configureConversationalVoice,
  ensureAgentComposerReady,
  getPreferredTestVoiceBackend,
  resetInstallRoot,
  snapshotEnv,
  type EnvSnapshot,
} from './voice-test-utils';
import { sel } from './selectors';

let envSnapshot: EnvSnapshot;
const testVoiceBackend = getPreferredTestVoiceBackend();

test.beforeAll(() => {
  envSnapshot = snapshotEnv(['TEST_QWEN_ASR_INSTALL_ROOT', 'TEST_MOONSHINE_INSTALL_ROOT']);
  if (testVoiceBackend === 'moonshine') {
    applyEnv({ TEST_QWEN_ASR_INSTALL_ROOT: undefined, TEST_MOONSHINE_INSTALL_ROOT: TEST_MOONSHINE_INSTALL_ROOT });
    resetInstallRoot(TEST_MOONSHINE_INSTALL_ROOT);
    return;
  }
  applyEnv({ TEST_QWEN_ASR_INSTALL_ROOT: TEST_QWEN_INSTALL_ROOT, TEST_MOONSHINE_INSTALL_ROOT: undefined });
  resetInstallRoot(TEST_QWEN_INSTALL_ROOT);
});

test.afterAll(async () => {
  applyEnv(envSnapshot);
  ElectronInstanceManager.invalidate();
});

test('@voice voice mode shows the install modal when qwen assets are missing', async ({ page }) => {
  test.setTimeout(120000);

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await ensureAgentComposerReady(page);
  await configureConversationalVoice(page, testVoiceBackend);

  const composer = page.locator(sel('mainComposerInput')).first();
  const voiceButton = page.locator(sel('mainComposerVoiceButton')).first();

  await composer.click();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.press('Backspace');

  await expect(voiceButton).toBeVisible({ timeout: 15000 });
  await voiceButton.click();

  const modal = page.getByRole('heading', { name: 'Download experimental voice models?' });
  await expect(modal).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(testVoiceBackend === 'moonshine' ? 'Moonshine STT model' : 'Qwen STT model')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Total download')).toBeVisible({ timeout: 5000 });
});
