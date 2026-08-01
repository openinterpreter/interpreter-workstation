export const APP_UPDATE_INSTALL_HINT_DELAY_MS = 8_000;

export type AppUpdateInstallHintKey = 'appUpdate.installHintDelayed';
export type AppUpdateSubtitleKey = 'appUpdate.subtitle' | 'appUpdate.restartingDelayed';

export function getAppUpdateInstallHintKey(params: {
  isInstalling: boolean;
  didDelayExpire: boolean;
}): AppUpdateInstallHintKey | null {
  if (!params.isInstalling) {
    return null;
  }

  if (!params.didDelayExpire) {
    return null;
  }

  return 'appUpdate.installHintDelayed';
}

export function getAppUpdateSubtitleKey(params: {
  isInstalling: boolean;
  didDelayExpire: boolean;
}): AppUpdateSubtitleKey {
  if (params.isInstalling && params.didDelayExpire) {
    return 'appUpdate.restartingDelayed';
  }

  return 'appUpdate.subtitle';
}
