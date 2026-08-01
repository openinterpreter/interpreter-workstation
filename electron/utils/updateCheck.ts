export interface UpdateCheckResult {
  downloadPromise?: Promise<unknown> | null;
}

export interface AutoUpdaterCheckLike {
  checkForUpdates(): Promise<UpdateCheckResult | null | undefined>;
}

export async function checkForUpdatesSafely(autoUpdater: AutoUpdaterCheckLike): Promise<void> {
  const result = await autoUpdater.checkForUpdates();
  result?.downloadPromise?.catch(() => {});
}
