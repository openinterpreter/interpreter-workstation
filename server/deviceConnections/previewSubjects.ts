/**
 * Who a Simple preview ticket was issued to. A paired device's ticket and
 * cookie stop working as soon as that device is revoked; a ticket issued to
 * a password session stops working when that session expires. No other
 * request receives a ticket.
 */
import type { Request } from 'express';
import type { SimplePreviewAccess } from '../utils/simplePreviewProxy';
import { getWorkstationHostPolicy, workstationPasswordSessionExpiry } from '../workstationConnection';
import { isDeviceId, trustedClientDeviceId } from './gatewayTrust';
import { getDeviceRegistry } from './deviceRegistry';
import { getPreviewSigningKey } from './previewSigningKey';

const DEVICE_PREFIX = 'device:';
const SESSION_PREFIX = 'session:';

export function previewSubjectForDevice(deviceId: string): string {
  return `${DEVICE_PREFIX}${deviceId}`;
}

export function previewSubjectForSession(expiresAtSeconds: number): string {
  return `${SESSION_PREFIX}${expiresAtSeconds}`;
}

/**
 * The preview subject for a request: its trusted paired device, else its
 * authenticated password session, else null (no ticket is issued).
 */
export function previewSubjectForRequest(
  request: Pick<Request, 'headers' | 'header'>,
  policy = getWorkstationHostPolicy(),
  now = Date.now(),
): string | null {
  const deviceId = trustedClientDeviceId(request);
  if (deviceId) return previewSubjectForDevice(deviceId);
  const expiresAt = workstationPasswordSessionExpiry(request, policy, now);
  return expiresAt === null ? null : previewSubjectForSession(expiresAt);
}

export async function isPreviewSubjectActive(
  subject: string,
  isDeviceActive: (id: string) => Promise<boolean> = async (id) => (await getDeviceRegistry().get(id)) !== null,
  now = Date.now(),
): Promise<boolean> {
  if (subject.startsWith(SESSION_PREFIX)) {
    const expiresAt = subject.slice(SESSION_PREFIX.length);
    return /^\d{1,12}$/.test(expiresAt) && Number(expiresAt) > Math.floor(now / 1000);
  }
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
