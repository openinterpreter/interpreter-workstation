import type { OverlayContextRole } from '../shared/ipc.js';

export function getOverlayRegionSelectionRole(
  _profileId: string | null | undefined,
  requestedRole: OverlayContextRole,
  options: {
    currentTargetIsActiveApp?: boolean;
  } = {},
): OverlayContextRole {
  if (requestedRole === 'target' || options.currentTargetIsActiveApp === true) {
    return 'target';
  }

  return requestedRole;
}
