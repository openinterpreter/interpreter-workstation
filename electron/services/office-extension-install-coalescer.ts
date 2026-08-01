export function createOfficeExtensionInstallCoalescer() {
  const installsByTargetDir = new Map<string, Promise<void>>();

  return function runInstall(
    targetDir: string,
    install: () => Promise<void>,
  ): Promise<void> {
    const existingInstall = installsByTargetDir.get(targetDir);
    if (existingInstall) {
      return existingInstall;
    }

    const installPromise = install().finally(() => {
      if (installsByTargetDir.get(targetDir) === installPromise) {
        installsByTargetDir.delete(targetDir);
      }
    });

    installsByTargetDir.set(targetDir, installPromise);
    return installPromise;
  };
}
