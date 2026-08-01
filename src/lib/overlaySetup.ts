export interface OverlaySetupResetGate {
  settingsLoading: boolean;
  authLoading: boolean;
  paidPlanLoading: boolean;
  isOverlayEligible: boolean;
  settingsEnabled: boolean;
  permissionSetupPending: boolean;
}

export function shouldResetOverlaySetupState(gate: OverlaySetupResetGate): boolean {
  if (gate.settingsLoading || gate.authLoading || gate.paidPlanLoading || gate.isOverlayEligible) {
    return false;
  }

  return gate.settingsEnabled || gate.permissionSetupPending;
}
