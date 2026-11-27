import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { getWorkstationHostPolicy } from '../workstationConnection';
import { CLIENT_DEVICE_HEADER, DEVICE_GATEWAY_TOKEN_HEADER, getDeviceGatewayToken } from './gatewayTrust';
import { isPreviewSubjectActive, previewSubjectForRequest } from './previewSubjects';

const NOW = Date.UTC(2026, 10, 1);
const SECRET = 'session-secret-for-tests';

function fakeRequest(headers: Record<string, string>): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { headers: lower, header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

function sessionCookie(expiresAt: number): string {
  const payload = `v1.${expiresAt}`;
  return `interpreter_workstation_session=${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

const passwordPolicy = getWorkstationHostPolicy({
  INTERPRETER_WORKSTATION_ACCESS: 'read-write',
  INTERPRETER_WORKSTATION_AUTH: 'password',
  INTERPRETER_WORKSTATION_PASSWORD: 'pw',
  INTERPRETER_WORKSTATION_SESSION_SECRET: SECRET,
});

describe('preview ticket subjects', () => {
  test('are issued to a paired device or a password session, and to nothing else', () => {
    const device = fakeRequest({
      [DEVICE_GATEWAY_TOKEN_HEADER]: getDeviceGatewayToken(),
      [CLIENT_DEVICE_HEADER]: 'dev_abcdefghijklmnop',
    });
    expect(previewSubjectForRequest(device, passwordPolicy, NOW)).toBe('device:dev_abcdefghijklmnop');

    const expiresAt = Math.floor(NOW / 1000) + 3600;
    expect(previewSubjectForRequest(fakeRequest({ Cookie: sessionCookie(expiresAt) }), passwordPolicy, NOW))
      .toBe(`session:${expiresAt}`);

    expect(previewSubjectForRequest(fakeRequest({}), passwordPolicy, NOW)).toBeNull();
    expect(previewSubjectForRequest(fakeRequest({ Cookie: 'interpreter_workstation_session=v1.99999999999.forged' }), passwordPolicy, NOW)).toBeNull();
    expect(previewSubjectForRequest(fakeRequest({ Host: 'workstation.example' }), getWorkstationHostPolicy({}), NOW)).toBeNull();
    expect(previewSubjectForRequest(fakeRequest({ Host: 'workstation.example' }), getWorkstationHostPolicy({
      INTERPRETER_WORKSTATION_ACCESS: 'read-write',
    }), NOW)).toBeNull();
  });

  test('a session subject lasts only as long as its session', async () => {
    const expiresAt = Math.floor(NOW / 1000) + 60;
    expect(await isPreviewSubjectActive(`session:${expiresAt}`, async () => false, NOW)).toBe(true);
    expect(await isPreviewSubjectActive(`session:${expiresAt}`, async () => false, NOW + 61_000)).toBe(false);
    expect(await isPreviewSubjectActive('session', async () => false, NOW)).toBe(false);
    expect(await isPreviewSubjectActive('device:dev_abcdefghijklmnop', async () => true, NOW)).toBe(true);
    expect(await isPreviewSubjectActive('device:dev_abcdefghijklmnop', async () => false, NOW)).toBe(false);
  });
});
