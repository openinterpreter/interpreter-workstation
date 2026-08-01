import { isVersionGreaterThan } from '../../shared/utils/version';

export interface LatestOoEditorsVersionResponse {
  tag_name?: string;
  name?: string;
  published_at?: string;
}

export function extractLatestOoEditorsVersion(payload: LatestOoEditorsVersionResponse | null): string | null {
  if (!payload) return null;
  const candidate = payload.tag_name || payload.name;
  return candidate?.trim() || null;
}

export function shouldUpdateOoEditors(
  installedVersion: string | null,
  latestVersion: string | null
): boolean {
  if (!installedVersion || !latestVersion) {
    return false;
  }

  return isVersionGreaterThan(latestVersion, installedVersion);
}
