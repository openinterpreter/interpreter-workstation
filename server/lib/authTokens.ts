import { getAuthTokensSync } from '../configStore';
import { getServerJWT } from './jwtStore';

export function getCurrentServerAccessTokenSync(): string | null {
  return getServerJWT() ?? getAuthTokensSync().access_token;
}

export function getAccessTokenUserId(accessToken: string | null): string | null {
  if (!accessToken) {
    return null;
  }

  const parts = accessToken.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function getCurrentServerAccessTokenUserIdSync(): string | null {
  return getAccessTokenUserId(getCurrentServerAccessTokenSync());
}
