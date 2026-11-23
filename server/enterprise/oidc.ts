import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { verifiedDomainName, type ServerDirectory } from './serverDirectory';

export type OidcConfiguration = Readonly<{
  organizationId: string;
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  redirectUri: string;
  /** Optional strict account-domain binding. DNS/registry proof and verified
   * signed email are required; neither alone establishes legal entitlement. */
  accountDomain?: string;
  /** Optional server-only credential, supplied by the deployment secret store.
   * Never place this configuration in browser, Electron renderer or source. */
  tokenEndpointAuthMethod?: 'none' | 'client_secret_basic';
  clientSecret?: string;
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

/** RFC 6749 §2.3.1 encodes both Basic components as form fields first. */
function basicComponent(value: string): string {
  return new URLSearchParams({ x: value }).toString().slice(2);
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

/** OIDC Discovery 1.0 appends this path to the issuer, including issuer paths.
 * Never discover from an email, an untrusted callback, or a redirect. */
export function providerMetadataUri(issuer: string): string {
  return `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
}

/** Authorization-code + S256 PKCE client; does not itself mount any HTTP route. */
export class OidcIntegration {
  private readonly config: OidcConfiguration;

  constructor(config: OidcConfiguration, private readonly directory: ServerDirectory, private readonly request: Fetch = fetch) {
    const loopback = config.allowInsecureLoopbackForTests === true;
    if (loopback && process.env.NODE_ENV !== 'test') throw new Error('Insecure OIDC loopback requires an isolated test process');
    for (const value of [config.issuer, config.authorizationEndpoint, config.tokenEndpoint, config.jwksUri, config.redirectUri]) validatedURL(value, loopback);
    if (!config.organizationId || !config.clientId || new URL(config.issuer).search ||
        new URL(config.redirectUri).search) throw new Error('Invalid pinned OIDC configuration');
    if (config.accountDomain !== undefined &&
        verifiedDomainName(config.accountDomain) !== config.accountDomain) throw new Error('Invalid pinned account domain');
    if (!loopback && !config.accountDomain) {
      throw new Error('Production OIDC requires a pinned account domain');
    }
    const authMethod = config.tokenEndpointAuthMethod ?? 'none';
    if (!['none', 'client_secret_basic'].includes(authMethod) ||
        (authMethod === 'none' && config.clientSecret !== undefined) ||
        (authMethod === 'client_secret_basic' && (typeof config.clientSecret !== 'string' ||
          !config.clientSecret || Buffer.byteLength(config.clientSecret, 'utf8') > 4096))) {
      throw new Error('Invalid OIDC client authentication configuration');
    }
    // A caller's mutable object must not silently retarget the issuer, token
    // endpoint or server-only credential between begin() and complete().
    this.config = Object.freeze({ ...config });
  }

  private async verifyProvider(): Promise<void> {
    const response = await this.request(providerMetadataUri(this.config.issuer), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' },
    });
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new Error('Invalid OIDC provider metadata type');
    }
    const metadata = await boundedJSON(response, 65_536);
    if (metadata.issuer !== this.config.issuer ||
        metadata.authorization_endpoint !== this.config.authorizationEndpoint ||
        metadata.token_endpoint !== this.config.tokenEndpoint || metadata.jwks_uri !== this.config.jwksUri ||
        !Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes('code') ||
        !Array.isArray(metadata.id_token_signing_alg_values_supported) ||
        !metadata.id_token_signing_alg_values_supported.some((alg) => alg === 'RS256' || alg === 'ES256') ||
        (metadata.token_endpoint_auth_methods_supported === undefined
          ? (this.config.tokenEndpointAuthMethod ?? 'none') !== 'client_secret_basic'
          : !Array.isArray(metadata.token_endpoint_auth_methods_supported) ||
            !metadata.token_endpoint_auth_methods_supported.includes(this.config.tokenEndpointAuthMethod ?? 'none')) ||
        !Array.isArray(metadata.code_challenge_methods_supported) ||
        !metadata.code_challenge_methods_supported.includes('S256')) {
      throw new Error('OIDC provider metadata does not match pinned public client');
    }
  }

  async begin(): Promise<{ authorizationUrl: string; state: string; browserBinding: string }> {
    if (this.config.accountDomain && !await this.directory.domainClaimVerifiedForLogin(
      this.config.organizationId, this.config.issuer, this.config.accountDomain)) throw new Error('Account domain unavailable');
    await this.verifyProvider();
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
    url.searchParams.set('scope', this.config.accountDomain ? 'openid email' : 'openid');
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
    await this.verifyProvider(); // Recheck before exchanging the one-time code; an outage consumes the attempt.
    const confidential = this.config.tokenEndpointAuthMethod === 'client_secret_basic';
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (confidential) headers.Authorization = 'Basic ' + Buffer.from(
      `${basicComponent(this.config.clientId)}:${basicComponent(this.config.clientSecret!)}`, 'utf8').toString('base64');
    const response = await this.request(this.config.tokenEndpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers,
      body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: this.config.redirectUri,
        ...(confidential ? {} : { client_id: this.config.clientId }), code_verifier: attempt.verifier }),
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
    if (this.config.accountDomain) {
      const email = payload.email;
      // Only a signed affirmative OP claim and an exact pinned domain qualify.
      // This does not provision membership, trust unverified groups or establish
      // real-world ownership of the account/domain relationship.
      if (payload.email_verified !== true || typeof email !== 'string' ||
          !/^[^@\s]+@[^@\s]+$/.test(email) ||
          email.slice(email.lastIndexOf('@') + 1).toLowerCase() !== this.config.accountDomain ||
          !await this.directory.domainClaimVerifiedForLogin(
            this.config.organizationId, this.config.issuer, this.config.accountDomain)) {
        throw new Error('Verified account domain required');
      }
    }
    // The token's organization/group claims are intentionally not authority.
    // Membership is provisioned independently in the server-owned directory.
    const expiresAt = Math.min(payload.exp * 1000, Date.now() + 8 * 60 * 60_000);
    const session = await this.directory.createSession(this.config.issuer, this.config.organizationId, payload.sub, expiresAt,
      attempt.authEpoch ?? 0, this.config.accountDomain);
    return { token: session.token, expiresAt };
  }
}
