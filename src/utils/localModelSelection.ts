export function pickLocalModelId(installedModels: string[] | undefined, fallbackModelId: string): string {
  if (!installedModels || installedModels.length === 0) {
    return fallbackModelId;
  }

  const firstInstalledModel = installedModels
    .map((modelId) => modelId.trim())
    .find((modelId) => modelId.length > 0);

  return firstInstalledModel || fallbackModelId;
}
