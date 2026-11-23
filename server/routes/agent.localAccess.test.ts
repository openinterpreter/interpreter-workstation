import { describe, expect, test } from 'bun:test';
import type { Request } from 'express';
import { savedThreadIdentityReadAllowed, wakeMutationAllowed } from './agent';
import { CLIENT_DEVICE_HEADER, DEVICE_GATEWAY_TOKEN_HEADER, getDeviceGatewayToken } from '../deviceConnections/gatewayTrust';

function loopbackRequest(headers: Record<string, string>): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const read = (name: string) => lower[name.toLowerCase()];
  return { headers: lower, socket: { remoteAddress: '127.0.0.1' }, header: read, get: read } as unknown as Request;
}

describe('local-only agent helpers', () => {
  test('admit a local request on a loopback Host', () => {
    const local = loopbackRequest({ Host: '127.0.0.1:5177' });
    expect(wakeMutationAllowed(local)).toBe(true);
    expect(savedThreadIdentityReadAllowed(local)).toBe(true);
  });

  test('refuse a request relayed by the device gateway or a proxy', () => {
    const fromDevice = loopbackRequest({
      Host: '127.0.0.1:5177',
      [DEVICE_GATEWAY_TOKEN_HEADER]: getDeviceGatewayToken(),
      [CLIENT_DEVICE_HEADER]: 'dev_abcdefghijklmnop',
    });
    const proxied = loopbackRequest({ Host: '127.0.0.1:5177', 'X-Forwarded-Host': 'workstation.example' });
    for (const request of [fromDevice, proxied]) {
      expect(wakeMutationAllowed(request)).toBe(false);
      expect(savedThreadIdentityReadAllowed(request)).toBe(false);
    }
  });
});
