/**
 * Attributes conversation input that a paired device submits.
 *
 * Simple mode already labels input from other sources by prefixing the user
 * message with `[From <source>]` (for example GPT Live or a generated
 * interface). Input submitted through the device gateway gets the same label
 * with the device's name on every route that submits user text (see
 * DEVICE_ATTRIBUTED_INPUT_PATHS). Desktop requests are never changed.
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
    if (!deviceId || request.method !== 'POST' || !body || typeof body !== 'object'
      || !DEVICE_ATTRIBUTED_INPUT_PATHS.includes(pathOf(request))) {
      next();
      return;
    }
    lookup(deviceId).then((device) => {
      if (device) body.message = attributeDeviceInput(body.message, device.label);
      next();
    }, () => next());
  };
}

function pathOf(request: Request): string {
  const url = request.originalUrl || request.url || '';
  const query = url.indexOf('?');
  return (query < 0 ? url : url.slice(0, query)).replace(/\/+$/, '');
}

/**
 * Every route that submits user text (`message`) to a conversation: start,
 * steer, programmatic tasks (to a new or existing thread) and the composer's
 * message queue. Wake events need the local wake token and are refused for
 * relayed requests, so a device cannot reach them.
 */
export const DEVICE_ATTRIBUTED_INPUT_PATHS = [
  '/api/agent/chat/stream',
  '/api/agent/chat/steer',
  '/api/agent/tasks',
  '/api/agent/tasks/stream',
  '/api/agent/queue',
];
