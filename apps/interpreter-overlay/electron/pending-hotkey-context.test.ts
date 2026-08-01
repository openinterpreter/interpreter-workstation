import { describe, expect, test } from 'bun:test';

import { getPendingHotkeyContextWaitPlan } from './pending-hotkey-context';

describe('getPendingHotkeyContextWaitPlan', () => {
  test('waits for every context producer before fast submit continues', () => {
    expect(getPendingHotkeyContextWaitPlan({
      hasPendingActiveAppTargetAttach: true,
      hasPendingInitialContextAttach: true,
      hasPendingInitialContextAttachPromise: false,
      hasPendingTargetContextHydration: true,
      hasPendingTargetContextHydrationPromise: false,
    })).toEqual([
      'await-active-app-target',
      'attach-initial-context',
      'await-initial-context',
      'start-target-hydration',
      'await-target-hydration',
    ]);
  });

  test('awaits already-started initial context and target hydration work', () => {
    expect(getPendingHotkeyContextWaitPlan({
      hasPendingActiveAppTargetAttach: false,
      hasPendingInitialContextAttach: false,
      hasPendingInitialContextAttachPromise: true,
      hasPendingTargetContextHydration: false,
      hasPendingTargetContextHydrationPromise: true,
    })).toEqual([
      'await-initial-context',
      'await-target-hydration',
    ]);
  });

  test('does not start duplicate target hydration while one is already running', () => {
    expect(getPendingHotkeyContextWaitPlan({
      hasPendingActiveAppTargetAttach: false,
      hasPendingInitialContextAttach: false,
      hasPendingInitialContextAttachPromise: false,
      hasPendingTargetContextHydration: true,
      hasPendingTargetContextHydrationPromise: true,
    })).toEqual(['await-target-hydration']);
  });
});
