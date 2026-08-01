import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import { reloadAndWaitForPageLoadSignals, waitForUiStability } from './helpers';
import { sel } from './selectors';
import { createDefaultOnboardingState, type OnboardingState } from '../shared/types/onboardingState';
import {
  ENABLED_ONBOARDING_STEP_INDICES,
  ONBOARDING_STEP_INDEX,
  ONBOARDING_STEPS,
} from '../src/components/onboarding/onboardingSteps';
import { IPC_CHANNELS } from '../electron/ipc/registry';
import { ElectronInstanceManager } from './electron-instance';
import {
  applyEnv,
  snapshotEnv,
  type EnvSnapshot,
} from './voice-test-utils';

const configPath = path.join(os.homedir(), 'Library/Application Support/interpreter/config.json');
let originalConfigText: string | null = null;
let envSnapshot: EnvSnapshot;

test.beforeAll(() => {
  envSnapshot = snapshotEnv([
    'FORM_TESTS_MODE',
    'FORM_TESTS_DEBUG_PORT',
    'INTERPRETER_OVERLAY_DEBUG_PORT',
    'INTERPRETER_OVERLAY_DEBUG_TOKEN',
    'INTERPRETER_OVERLAY_DISABLE_ADVANCED_VOICE_CREATE_CALL',
  ]);
  applyEnv({
    FORM_TESTS_MODE: 'true',
    FORM_TESTS_DEBUG_PORT: '0',
    INTERPRETER_OVERLAY_DEBUG_PORT: undefined,
    INTERPRETER_OVERLAY_DEBUG_TOKEN: undefined,
    INTERPRETER_OVERLAY_DISABLE_ADVANCED_VOICE_CREATE_CALL: 'true',
  });
});

test.afterAll(async () => {
  applyEnv(envSnapshot);
  ElectronInstanceManager.invalidate();
});

test.beforeEach(() => {
  originalConfigText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
});

test.afterEach(() => {
  if (originalConfigText === null) {
    fs.rmSync(configPath, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, originalConfigText);
});

async function ipc<T>(page: Page, namespace: string, method: string, args: unknown[] = []): Promise<T> {
  const port = await page.evaluate(async () => {
    return await (window as typeof window & {
      electron: { getServerPort: () => Promise<number> };
    }).electron.getServerPort();
  });

  return page.evaluate(
    async ({ port, namespace, method, args }) => {
      const response = await fetch(`http://localhost:${port}/api/ipc/${namespace}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!response.ok) {
        throw new Error(`${namespace}/${method} failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    },
    { port, namespace, method, args },
  ) as Promise<T>;
}

async function setOnboardingState(page: Page, state: OnboardingState): Promise<void> {
  await ipc(page, 'onboardingState', 'set', [state]);
}

test('first run is gated by the shared onboarding state contract', async ({ page }) => {
  const original = await ipc<{ state: OnboardingState }>(page, 'onboardingState', 'get');

  try {
    await setOnboardingState(page, createDefaultOnboardingState());
    await reloadAndWaitForPageLoadSignals(page);
    await waitForUiStability(page);

    await expect(page.getByText('Welcome to Interpreter')).toBeVisible({ timeout: 15000 });

    await setOnboardingState(page, {
      ...createDefaultOnboardingState(),
      completed: true,
      completedStepIds: ['name', 'feedback'],
    });
    await reloadAndWaitForPageLoadSignals(page);
    await waitForUiStability(page);

    await expect(page.getByText('Welcome to Interpreter')).toBeHidden({ timeout: 15000 });
    await expect(page.locator(sel('agentEmptyStatePage')).or(page.locator(sel('mainComposerInput'))).first()).toBeVisible({ timeout: 15000 });
  } finally {
    await setOnboardingState(page, original.state);
    await reloadAndWaitForPageLoadSignals(page).catch(() => {});
  }
});

test('onboarding voice interview completion fills the real AI setup review fields', async ({ page, electronApp }) => {
  const original = await ipc<{ state: OnboardingState }>(page, 'onboardingState', 'get');
  const aiSetupStep = ONBOARDING_STEP_INDEX['ai-setup'];
  const completedBeforeAiSetup = ENABLED_ONBOARDING_STEP_INDICES
    .filter((stepIndex) => stepIndex < aiSetupStep)
    .map((stepIndex) => ONBOARDING_STEPS[stepIndex].id);

  try {
    await setOnboardingState(page, {
      ...createDefaultOnboardingState(),
      completed: false,
      completedStepIds: completedBeforeAiSetup,
    });
    await reloadAndWaitForPageLoadSignals(page);
    await waitForUiStability(page);

    await expect(page.getByText('Tell Interpreter how you use AI')).toBeVisible({ timeout: 15000 });

    pauseErrorChecking(page);
    try {
      await page.getByRole('button', { name: 'Start voice interview' }).click();
      await expect(page.getByRole('button', { name: 'Voice interview running' })).toBeDisabled({ timeout: 15000 });
    } finally {
      resumeErrorChecking(page);
    }

    const answers = {
      modelsUsed: 'GPT-5 and Claude',
      aiUseToday: 'coding, research, and form filling',
      currentSetup: 'ChatGPT desktop, Claude Code, and local Ollama',
    };
    await electronApp.evaluate(({ BrowserWindow }, payload: {
      channel: string;
      answers: typeof answers;
    }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(payload.channel, payload.answers);
        }
      }
    }, {
      channel: IPC_CHANNELS.INTERPRETER_OVERLAY_ONBOARDING_VOICE_INTERVIEW_COMPLETED,
      answers,
    });

    await expect(page.getByLabel('Which models do you use now?')).toHaveValue(answers.modelsUsed, { timeout: 15000 });
    await expect(page.getByLabel('How do you use AI today?')).toHaveValue(answers.aiUseToday);
    await expect(page.getByLabel('What is your current AI setup?')).toHaveValue(answers.currentSetup);
  } finally {
    await setOnboardingState(page, original.state);
    await reloadAndWaitForPageLoadSignals(page).catch(() => {});
  }
});
