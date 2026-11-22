/**
 * Attributes conversation input that a paired device submits.
 *
 * Simple mode already labels input from other sources by prefixing the user
 * message with `[From <source>]` (for example GPT Live or a generated
 * interface). Input submitted through the device gateway gets the same label
 * with the device's name, on the same start and steer routes the desktop
 * composer uses. Desktop requests are never changed.
 */
import type { NextFunction, Request, Response } from 'express';
import { trustedClientDeviceId } from './gatewayTrust';
import { getDeviceRegistry, type DeviceSummary } from './deviceRegistry';

const SOURCE_PREFIX = /^\[From ([^\]\n]+)\]\n/;

export function attributeDeviceInput(message: unknown, deviceLabel: string): unknown {
  if (typeof message !== 'string' || !message.trim()) return message;
  const label = deviceLabel.replace(/[[\]\n]/g, '').trim() || 'device';
  const existing = SOURCE_PREFIX.exec(message);
  if (!existing) return `[From ${label}]\n${message}`;
  const source = existing[1];
  if (source === label || source.endsWith(` on ${label}`)) return message;
  return `[From ${source} on ${label}]\n${message.slice(existing[0].length)}`;
}

export function createDeviceInputAttributionMiddleware(
  lookup: (deviceId: string) => Promise<DeviceSummary | null> = (deviceId) => getDeviceRegistry().get(deviceId),
) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const deviceId = trustedClientDeviceId(request);
    const body = request.body as Record<string, unknown> | undefined;
    if (!deviceId || request.method !== 'POST' || !body || typeof body !== 'object') {
      next();
      return;
    }
    lookup(deviceId).then((device) => {
      if (device) body.message = attributeDeviceInput(body.message, device.label);
      next();
    }, () => next());
  };
}

/** The conversation start and steer routes that paired-device input uses. */
export const DEVICE_ATTRIBUTED_INPUT_PATHS = ['/api/agent/chat/stream', '/api/agent/chat/steer'];
