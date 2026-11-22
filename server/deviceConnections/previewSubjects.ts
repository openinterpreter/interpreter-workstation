/**
 * Who a Simple preview ticket was issued to. A paired device's ticket and
 * cookie stop working as soon as that device is revoked; a ticket issued to
 * a browser session authenticated by the host itself names that session kind.
 */
import type { SimplePreviewAccess } from '../utils/simplePreviewProxy';
import { isDeviceId } from './gatewayTrust';
import { getDeviceRegistry } from './deviceRegistry';
import { getPreviewSigningKey } from './previewSigningKey';

const DEVICE_PREFIX = 'device:';
const HOST_SESSION_SUBJECT = 'session';

export function previewSubjectFor(deviceId: string | null): string {
  return deviceId ? `${DEVICE_PREFIX}${deviceId}` : HOST_SESSION_SUBJECT;
}

export async function isPreviewSubjectActive(
  subject: string,
  isDeviceActive: (id: string) => Promise<boolean> = async (id) => (await getDeviceRegistry().get(id)) !== null,
): Promise<boolean> {
  if (subject === HOST_SESSION_SUBJECT) return true;
  if (!subject.startsWith(DEVICE_PREFIX)) return false;
  const deviceId = subject.slice(DEVICE_PREFIX.length);
  return isDeviceId(deviceId) && isDeviceActive(deviceId);
}

export async function createPreviewAccess(): Promise<SimplePreviewAccess> {
  return {
    signingKey: await getPreviewSigningKey(),
    isSubjectActive: (subject) => isPreviewSubjectActive(subject),
  };
}
