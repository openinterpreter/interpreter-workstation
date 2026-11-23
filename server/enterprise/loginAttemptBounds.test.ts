import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OidcIntegration, providerMetadataUri, type OidcConfiguration } from './oidc';
import { createOidcHttpRouter, loginClientNetwork } from './oidcHttp';
import {
  blankDirectoryState, decodeDirectoryState, MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT, MAX_ACTIVE_LOGIN_ATTEMPTS_PER_ORGANIZATION,
  ServerDirectory, validateDirectoryState, type DirectoryState, type EnterpriseStateStore,
} from './serverDirectory';

const config: OidcConfiguration = {
  organizationId: 'org-a', issuer: 'http://127.0.0.1:39393/tenant', clientId: 'local-fixture-client',
  authorizationEndpoint: 'http://127.0.0.1:39393/tenant/authorize',
  tokenEndpoint: 'http://127.0.0.1:39393/tenant/token',
  jwksUri: 'http://127.0.0.1:39393/tenant/keys',
  redirectUri: 'http://127.0.0.1:39394/enterprise/callback',
  allowInsecureLoopbackForTests: true,
};
const origin = 'http://127.0.0.1:39394';
const host = '127.0.0.1:39394';

/** Single-row in-memory store that counts committed writes. */
function memoryStore() {
  let serialized = JSON.stringify(blankDirectoryState());
  let writes = 0;
  const change = async <T>(fn: (data: DirectoryState) => T): Promise<T> => {
    const data = decodeDirectoryState(serialized);
    const result = fn(data);
    validateDirectoryState(data);
    serialized = JSON.stringify(data);
    writes++;
    return result;
  };
  const store: EnterpriseStateStore = { read: async () => decodeDirectoryState(serialized), change: (fn) => change(fn) };
  return { store, writes: () => writes, raw: () => serialized,
    edit: (fn: (data: DirectoryState) => void) => {
      const data = decodeDirectoryState(serialized);
      fn(data);
      serialized = JSON.stringify(data); // Only this disposable fixture simulates time passing.
    } };
}

async function setup() {
  const memory = memoryStore();
  const directory = new ServerDirectory(memory.store);
  await directory.bootstrap('org-a', 'Acme', config.issuer,
    { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'bounds-key', alg: 'RS256', use: 'sig' };
  const nonces = new Map<string, string>(); // code_challenge -> nonce, as an IdP would remember it.
  let discoveries = 0;
  let tokenRequests = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input) === providerMetadataUri(config.issuer)) {
      discoveries++;
      return Response.json({ issuer: config.issuer, authorization_endpoint: config.authorizationEndpoint,
        token_endpoint: config.tokenEndpoint, jwks_uri: config.jwksUri, response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'] });
    }
    if (String(input) === config.jwksUri) return Response.json({ keys: [jwk] });
    if (String(input) !== config.tokenEndpoint || init?.method !== 'POST') throw new Error('Unexpected endpoint');
    tokenRequests++;
    const body = new URLSearchParams(init.body as URLSearchParams);
    const nonce = nonces.get(createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url'));
    if (!nonce) return new Response('{}', { status: 400 });
    return Response.json({ id_token: await new SignJWT({ nonce }).setProtectedHeader({ alg: 'RS256', kid: 'bounds-key' })
      .setIssuer(config.issuer).setAudience(config.clientId).setSubject('alice')
      .setIssuedAt().setExpirationTime('5m').sign(privateKey) });
  };
  const integration = new OidcIntegration(config, directory, fetchMock);
  const authorize = (authorizationUrl: string) => {
    const url = new URL(authorizationUrl);
    nonces.set(url.searchParams.get('code_challenge')!, url.searchParams.get('nonce')!);
    return url.searchParams.get('state')!;
  };
  const begin = async (client: string) => {
    const flow = await integration.begin(client);
    authorize(flow.authorizationUrl);
    return flow;
  };
  const router = () => {
    const app = express();
    app.use(createOidcHttpRouter({ config, integration, applicationOrigin: origin, successPath: '/settings' }));
    return app;
  };
  return { ...memory, directory, integration, begin, authorize, router,
    discoveries: () => discoveries, tokenRequests: () => tokenRequests };
}

describe('anonymous OIDC login start and callback cannot block a tenant or force writes', () => {
  test('a callback with an unknown, wrongly bound or expired state is rejected without any store write', async () => {
    const { directory, integration, begin, writes, edit, tokenRequests } = await setup();
    const flow = await begin('198.51.100.7');
    const before = writes();
    expect(await directory.takeAttempt('d'.repeat(43), flow.browserBinding)).toBeNull();
    expect(await directory.takeAttempt(flow.state, 'e'.repeat(43))).toBeNull();
    await expect(integration.complete({ code: 'probe', state: 'd'.repeat(43), browserBinding: 'e'.repeat(43) }))
      .rejects.toThrow('OIDC state invalid or expired');
    await expect(integration.complete({ code: 'probe', state: flow.state, browserBinding: 'e'.repeat(43) }))
      .rejects.toThrow('OIDC state invalid or expired');
    expect(writes()).toBe(before);
    expect(tokenRequests()).toBe(0);
    // The genuine attempt survives the rejected probes and is still one-time.
    await integration.complete({ code: 'genuine', state: flow.state, browserBinding: flow.browserBinding });
    expect(tokenRequests()).toBe(1);
    await expect(integration.complete({ code: 'genuine', state: flow.state, browserBinding: flow.browserBinding }))
      .rejects.toThrow('OIDC state invalid or expired');
    const stale = await begin('198.51.100.7');
    edit((data) => { for (const attempt of Object.values(data.attempts)) attempt.expiresAt = Date.now() - 1; });
    const beforeExpired = writes();
    expect(await directory.takeAttempt(stale.state, stale.browserBinding)).toBeNull();
    expect(writes()).toBe(beforeExpired);
  });

  test('an unknown-state HTTP callback keeps its 401 response and writes nothing', async () => {
    const { router, writes, tokenRequests } = await setup();
    const app = router();
    const before = writes();
    const response = await request(app).get(`/enterprise/callback?code=probe&state=${'d'.repeat(43)}`)
      .set('Host', host).set('Cookie', `interpreter-oidc-binding=${'e'.repeat(43)}`);
    expect(response.status).toBe(401);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toBe('');
    const cookies = ((response.headers['set-cookie'] ?? []) as string[]).join(';');
    expect(cookies).toContain('interpreter-oidc-binding=;'); // The binding cookie is still cleared.
    expect(cookies).not.toContain('interpreter-enterprise-session=');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(writes()).toBe(before);
    expect(tokenRequests()).toBe(0);
  });

  test('two concurrent callbacks for one valid state: exactly one succeeds', async () => {
    const { directory, integration, begin, tokenRequests } = await setup();
    const flow = await begin('198.51.100.7');
    const taken = await Promise.all([directory.takeAttempt(flow.state, flow.browserBinding),
      directory.takeAttempt(flow.state, flow.browserBinding)]);
    expect(taken.filter(Boolean)).toHaveLength(1);
    const next = await begin('198.51.100.7');
    const outcomes = await Promise.allSettled([
      integration.complete({ code: 'one', state: next.state, browserBinding: next.browserBinding }),
      integration.complete({ code: 'two', state: next.state, browserBinding: next.browserBinding }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(tokenRequests()).toBe(1);
  });

  test('many anonymous sign-in starts from one client do not prevent another client signing in', async () => {
    const { directory, integration, begin, raw, discoveries } = await setup();
    for (let i = 0; i < MAX_ACTIVE_LOGIN_ATTEMPTS_PER_ORGANIZATION + 8; i++) await begin('198.51.100.7');
    expect(Object.keys(decodeDirectoryState(raw()).attempts)).toHaveLength(MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT);
    const user = await begin('203.0.113.9');
    const session = await integration.complete({ code: 'genuine', state: user.state, browserBinding: user.browserBinding });
    expect((await directory.verifySession(session.token))?.subject).toBe('alice');
    // One cached login-start discovery for every start, plus the uncached recheck before code exchange.
    expect(discoveries()).toBe(2);
  });

  test('many networks with more attempts each cannot evict a lightly loaded client', async () => {
    const { directory, integration, begin, raw } = await setup();
    const user = await begin('203.0.113.9');
    for (let network = 0; network < 200; network++) {
      for (let repeat = 0; repeat < 2; repeat++) await begin(`198.18.0.${network}`);
    }
    expect(Object.keys(decodeDirectoryState(raw()).attempts).length).toBeLessThanOrEqual(MAX_ACTIVE_LOGIN_ATTEMPTS_PER_ORGANIZATION);
    const session = await integration.complete({ code: 'genuine', state: user.state, browserBinding: user.browserBinding });
    expect((await directory.verifySession(session.token))?.subject).toBe('alice');
  });

  test('expired attempts do not count against the client or the tenant', async () => {
    const { directory, integration, begin, edit, raw } = await setup();
    for (let i = 0; i < MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT; i++) await begin('203.0.113.9');
    for (let network = 0; network < MAX_ACTIVE_LOGIN_ATTEMPTS_PER_ORGANIZATION; network++) await begin(`198.18.1.${network}`);
    edit((data) => { for (const attempt of Object.values(data.attempts)) attempt.expiresAt = Date.now() - 1; });
    const user = await begin('203.0.113.9');
    for (let i = 0; i < MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT - 2; i++) await begin('203.0.113.9');
    expect(Object.keys(decodeDirectoryState(raw()).attempts)).toHaveLength(MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT - 1);
    const session = await integration.complete({ code: 'genuine', state: user.state, browserBinding: user.browserBinding });
    expect((await directory.verifySession(session.token))?.subject).toBe('alice');
  });

  test('happy-path HTTP sign-in still works end to end and stores no clear state', async () => {
    const { directory, router, authorize, raw, tokenRequests } = await setup();
    const app = router();
    const started = await request(app).get('/organizations/org-a/login').set('Host', host);
    expect(started.status).toBe(302);
    const state = authorize(started.headers.location);
    const binding = (started.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(raw()).not.toContain(state);
    expect(raw()).not.toContain(binding.split('=')[1]!);
    const callback = () => request(app).get(`/enterprise/callback?code=one-time&state=${state}`)
      .set('Host', host).set('Cookie', binding);
    const done = await callback();
    expect(done.status).toBe(303);
    expect(done.headers.location).toBe('/settings');
    const session = (done.headers['set-cookie'] as unknown as string[])
      .find((value) => value.startsWith('interpreter-enterprise-session='))!.split(';')[0]!.split('=')[1]!;
    expect((await directory.verifySession(session))?.subject).toBe('alice');
    expect((await callback()).status).toBe(401);
    expect(tokenRequests()).toBe(1);
  });

  test('login-start client network comes from the peer address only, IPv6 grouped by /64', () => {
    expect(loginClientNetwork('192.0.2.1')).toBe('192.0.2.1');
    expect(loginClientNetwork('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(loginClientNetwork('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(loginClientNetwork('2001:0db8:0001:0002:ffff:0:0:9')).toBe('2001:db8:1:2::/64');
    expect(loginClientNetwork('::1')).toBe('0:0:0:0::/64');
    expect(loginClientNetwork('not-an-address')).toBeNull();
    expect(loginClientNetwork(undefined)).toBeNull();
  });
});
