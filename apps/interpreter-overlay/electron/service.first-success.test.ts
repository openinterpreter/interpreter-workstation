import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('overlay first successful use onboarding marker', () => {
  test('records the durable onboarding milestone from the completed overlay run path', async () => {
    const source = await readFile(
      join(process.cwd(), 'apps/interpreter-overlay/electron/service.ts'),
      'utf-8',
    );

    expect(source).toContain('ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID');
    expect(source).toContain('markOnboardingStepIdComplete(state, ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID)');
    expect(source).toContain('void this.recordOverlayFirstSuccessfulUse().catch');

    const completionIndex = source.indexOf("this.trackOverlayEvent('overlay_run_completed'");
    const markerIndex = source.indexOf('void this.recordOverlayFirstSuccessfulUse().catch');
    const failureIndex = source.indexOf("this.trackOverlayError('overlay_run_failed'");

    expect(completionIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeGreaterThan(completionIndex);
    expect(failureIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeGreaterThan(failureIndex);
  });
});
