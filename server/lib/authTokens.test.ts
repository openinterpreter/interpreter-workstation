import { afterEach, describe, expect, test } from 'bun:test';

import { clearConfigCache, setConfigOverride, type AppConfig } from '../configStore';
import {
  getAccessTokenUserId,
  getCurrentServerAccessTokenSync,
  getCurrentServerAccessTokenUserIdSync,
} from './authTokens';
import { clearServerJWT, setServerJWT } from './jwtStore';

function createTestJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

describe('authTokens', () => {
  afterEach(() => {
    clearServerJWT();
    setConfigOverride(null);
    clearConfigCache();
  });

  test('prefers the request JWT when both token sources are populated', () => {
    setConfigOverride({
      agents: {},
      authToken: 'config-access-token',
    } as AppConfig);
    setServerJWT('request-access-token');

    expect(getCurrentServerAccessTokenSync()).toBe('request-access-token');
  });

  test('falls back to the persisted config token when request JWT is empty', () => {
    setConfigOverride({
      agents: {},
      authToken: 'config-access-token',
    } as AppConfig);

    expect(getCurrentServerAccessTokenSync()).toBe('config-access-token');
  });

  test('extracts the current user id from the persisted config token', () => {
    setConfigOverride({
      agents: {},
      authToken: createTestJwt({ sub: 'user_123' }),
    } as AppConfig);

    expect(getCurrentServerAccessTokenUserIdSync()).toBe('user_123');
  });

  test('returns null for malformed access tokens', () => {
    expect(getAccessTokenUserId('not-a-jwt')).toBeNull();
  });
});
