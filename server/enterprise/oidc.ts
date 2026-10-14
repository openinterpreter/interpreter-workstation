import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { ServerDirectory } from './serverDirectory';

export type OidcConfiguration = Readonly<{
  organizationId: string;
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  redirectUri: string;
  /** Only in injected localhost tests; never set from user-supplied HTTP input. */
  allowInsecureLoopbackForTests?: boolean;
}>;

type Fetch = typeof fetch;

function validatedURL(url: string, loopback: boolean): URL {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.hash ||
      (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:' &&
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')))) {
    throw new Error('OIDC endpoint must be HTTPS');
  }
  return parsed;
}

async function boundedJSON(response: Response, maximum: number): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new Error('OIDC endpoint unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('OIDC response too large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid OIDC response');
  return parsed as Record<string, unknown>;
}

/** Authorization-code + S256 PKCE client; does not itself mount any HTTP route. */
export class OidcIntegration {
  private readonly config: OidcConfiguration;

  constructor(config: OidcConfiguration, private readonly directory: ServerDirectory, private readonly request: Fetch = fetch) {
    const loopback = config.allowInsecureLoopbackForTests === true;
    for (const value of [config.issuer, config.authorizationEndpoint, config.tokenEndpoint, config.jwksUri, config.redirectUri]) validatedURL(value, loopback);
    if (!config.organizationId || !config.clientId || new URL(config.issuer).search ||
        new URL(config.redirectUri).search) throw new Error('Invalid pinned OIDC configuration');
    this.config = config;
  }

  async begin(): Promise<{ authorizationUrl: string; state: string; browserBinding: string }> {
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const browserBinding = randomBytes(32).toString('base64url');
    await this.directory.putAttempt(state, {
      organizationId: this.config.organizationId, issuer: this.config.issuer, nonce, verifier,
      bindingHash: createHash('sha256').update(browserBinding).digest('hex'), expiresAt: Date.now() + 5 * 60_000,
    });
    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', 'openid');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    return { authorizationUrl: url.toString(), state, browserBinding };
  }

  async complete(input: Readonly<{ code: string; state: string; browserBinding: string }>): Promise<{ token: string; expiresAt: number }> {
    if (!input.code || input.code.length > 2048 || !input.state || !input.browserBinding) throw new Error('Invalid OIDC callback');
    const attempt = await this.directory.takeAttempt(input.state, input.browserBinding);
    if (!attempt || attempt.organizationId !== this.config.organizationId || attempt.issuer !== this.config.issuer) throw new Error('OIDC state invalid or expired');
    const response = await this.request(this.config.tokenEndpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: this.config.redirectUri,
        client_id: this.config.clientId, code_verifier: attempt.verifier }),
    });
    const tokens = await boundedJSON(response, 32_768);
    if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16_384) throw new Error('Missing ID token');
    const jwksResponse = await this.request(this.config.jwksUri, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    const jwks = await boundedJSON(jwksResponse, 65_536);
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 16) throw new Error('Invalid JWKS');
    const verified = await jwtVerify(tokens.id_token, createLocalJWKSet({ keys: jwks.keys as JSONWebKeySet['keys'] }), {
      issuer: this.config.issuer, audience: this.config.clientId,
      algorithms: ['RS256', 'ES256'], clockTolerance: 30, maxTokenAge: '5 minutes',
    });
    const { payload } = verified;
    if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.exp !== 'number' ||
        payload.nonce !== attempt.nonce ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.config.clientId) ||
        (payload.azp !== undefined && payload.azp !== this.config.clientId)) throw new Error('Invalid ID token claims');
    // The token's organization/group claims are intentionally not authority.
    // Membership is provisioned independently in the server-owned directory.
    const expiresAt = Math.min(payload.exp * 1000, Date.now() + 8 * 60 * 60_000);
    const session = await this.directory.createSession(this.config.issuer, this.config.organizationId, payload.sub, expiresAt);
    return { token: session.token, expiresAt };
  }
}
