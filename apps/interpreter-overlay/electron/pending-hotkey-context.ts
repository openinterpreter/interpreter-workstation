export type PendingHotkeyContextWaitStep =
  | 'await-active-app-target'
  | 'attach-initial-context'
  | 'await-initial-context'
  | 'start-target-hydration'
  | 'await-target-hydration';

export function getPendingHotkeyContextWaitPlan(state: {
  hasPendingActiveAppTargetAttach: boolean;
  hasPendingInitialContextAttach: boolean;
  hasPendingInitialContextAttachPromise: boolean;
  hasPendingTargetContextHydration: boolean;
  hasPendingTargetContextHydrationPromise: boolean;
}): PendingHotkeyContextWaitStep[] {
  const steps: PendingHotkeyContextWaitStep[] = [];

  if (state.hasPendingActiveAppTargetAttach) {
    steps.push('await-active-app-target');
  }
  if (state.hasPendingInitialContextAttach) {
    steps.push('attach-initial-context');
  }
  if (state.hasPendingInitialContextAttach || state.hasPendingInitialContextAttachPromise) {
    steps.push('await-initial-context');
  }
  if (state.hasPendingTargetContextHydration && !state.hasPendingTargetContextHydrationPromise) {
    steps.push('start-target-hydration');
  }
  if (state.hasPendingTargetContextHydration || state.hasPendingTargetContextHydrationPromise) {
    steps.push('await-target-hydration');
  }

  return steps;
}
