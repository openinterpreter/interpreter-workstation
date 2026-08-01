import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { shouldResetOverlaySetupState } from './overlaySetup';

describe('overlay setup reset gate', () => {
  test('does not reset while auth state is still loading', () => {
    const shouldReset = shouldResetOverlaySetupState({
      settingsLoading: false,
      authLoading: true,
      paidPlanLoading: false,
      isOverlayEligible: false,
      settingsEnabled: false,
      permissionSetupPending: true,
    });

    assert.equal(shouldReset, false);
  });

  test('resets when loading is done and overlay is not eligible with pending setup', () => {
    const shouldReset = shouldResetOverlaySetupState({
      settingsLoading: false,
      authLoading: false,
      paidPlanLoading: false,
      isOverlayEligible: false,
      settingsEnabled: false,
      permissionSetupPending: true,
    });

    assert.equal(shouldReset, true);
  });

  test('does not reset when overlay is eligible', () => {
    const shouldReset = shouldResetOverlaySetupState({
      settingsLoading: false,
      authLoading: false,
      paidPlanLoading: false,
      isOverlayEligible: true,
      settingsEnabled: false,
      permissionSetupPending: true,
    });

    assert.equal(shouldReset, false);
  });
});
