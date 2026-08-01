import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ENABLED_ONBOARDING_STEP_INDICES,
  ONBOARDING_STEP_INDEX,
  ONBOARDING_STEPS,
} from './onboardingSteps';

describe('AI setup onboarding flow', () => {
  test('keeps AI setup enabled immediately before model setup', () => {
    const activeStepIds = ENABLED_ONBOARDING_STEP_INDICES.map((index) => ONBOARDING_STEPS[index].id);

    expect(activeStepIds[activeStepIds.indexOf('overlay-permissions') - 1]).toBe('overlay-first-use');
    expect(activeStepIds[activeStepIds.indexOf('tool-addons') - 1]).toBe('overlay-permissions');
    expect(activeStepIds[activeStepIds.indexOf('model-setup') - 1]).toBe('ai-setup');
    expect(ONBOARDING_STEP_INDEX['ai-setup']).toBe(ONBOARDING_STEP_INDEX['model-setup'] - 1);
  });

  test('routes AI setup completion into model setup and workspace completion into feedback', async () => {
    const overlaySource = await readFile(
      join(process.cwd(), 'src/components/onboarding/OnboardingOverlay.tsx'),
      'utf-8',
    );

    expect(overlaySource).toContain('const STEP_AI_SETUP = ONBOARDING_STEP_INDEX[\'ai-setup\'];');
    expect(overlaySource).toContain('const STEP_OVERLAY_FIRST_USE = ONBOARDING_STEP_INDEX[\'overlay-first-use\'];');
    expect(overlaySource).toContain('const STEP_OVERLAY_PERMISSIONS = ONBOARDING_STEP_INDEX[\'overlay-permissions\'];');
    expect(overlaySource).toContain('goToStep(STEP_MODEL_SETUP);');
    expect(overlaySource).toContain('goToStep(STEP_FEEDBACK);');
    expect(overlaySource).toContain('case STEP_OVERLAY_FIRST_USE:');
    expect(overlaySource).toContain('<OverlayFirstUseScreen onNext={goForward} />');
    expect(overlaySource).toContain('case STEP_OVERLAY_PERMISSIONS:');
    expect(overlaySource).toContain('<OverlayPermissionsScreen onNext={goForward} />');
    expect(overlaySource).toContain('case STEP_AI_SETUP:');
    expect(overlaySource).toContain('<AiSetupScreen onComplete={handleAiSetupComplete} />');
  });

  test('persists a redacted imported tool summary from onboarding detection', async () => {
    const overlaySource = await readFile(
      join(process.cwd(), 'src/components/onboarding/OnboardingOverlay.tsx'),
      'utf-8',
    );

    expect(overlaySource).toContain('buildOnboardingImportedToolSummary');
    expect(overlaySource).toContain('importedToolSummary');
    expect(overlaySource).toContain('detectedConfigDirs: detectionResults.detectedConfigDirs');
    expect(overlaySource).toContain('detectedApps: detectionResults.detectedApps');
  });
});
