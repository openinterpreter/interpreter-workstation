/**
 * Trust between the device gateway and the app server in the same process.
 *
 * The gateway authenticates a paired device and forwards its request to the
 * loopback app server with a per-process token and the device id. Only a
 * request carrying that token is attributed to a device or admitted as a
 * device session; a client cannot supply either header itself because the
 * gateway strips them and the token never leaves this process.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEVICE_GATEWAY_TOKEN_HEADER = 'x-interpreter-device-gateway';
export const CLIENT_DEVICE_HEADER = 'x-interpreter-client-device';

const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{8,64}$/;
const gatewayToken = randomBytes(32).toString('base64url');

type HeaderSource = { headers: Record<string, string | string[] | undefined> };

export function getDeviceGatewayToken(): string {
  return gatewayToken;
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

function single(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value ?? null;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

/** The paired device that sent this request through the gateway, or null. */
export function trustedClientDeviceId(request: HeaderSource): string | null {
  const token = single(request.headers[DEVICE_GATEWAY_TOKEN_HEADER]);
  if (!token || !safeEqual(token, gatewayToken)) return null;
  const deviceId = single(request.headers[CLIENT_DEVICE_HEADER]);
  return isDeviceId(deviceId) ? deviceId : null;
}

export type ActiveDeviceGateway = { publicOrigin: string; port: number };

let activeGateway: ActiveDeviceGateway | null = null;

/** Records the running gateway so pairing can build links; null when stopped. */
export function setActiveDeviceGateway(gateway: ActiveDeviceGateway | null): void {
  activeGateway = gateway;
}

export function getActiveDeviceGateway(): ActiveDeviceGateway | null {
  return activeGateway;
}
