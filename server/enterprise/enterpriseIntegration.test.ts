import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createEnterpriseControlPlane } from './controlPlane';
import { blankDirectoryState, MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT, ServerDirectory, type EnterpriseStateStore } from './serverDirectory';
import { OidcIntegration, providerMetadataUri, type OidcConfiguration } from './oidc';
import { createEnterpriseBrowserRouter } from './oidcHttp';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'enterprise-directory-'));
  paths.push(dir);
  const file = join(dir, 'private', 'directory.json');
  const directory = new ServerDirectory(file);
  await directory.bootstrap('org-a', 'Acme', config.issuer, { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
  await directory.bootstrap('org-b', 'Beta', 'http://127.0.0.1:39393/other-tenant', { organizationId: 'org-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
  return { directory, file };
}

const config: OidcConfiguration = {
  organizationId: 'org-a', issuer: 'http://127.0.0.1:39393/tenant', clientId: 'local-fixture-client',
  authorizationEndpoint: 'http://127.0.0.1:39393/tenant/authorize',
  tokenEndpoint: 'http://127.0.0.1:39393/tenant/token',
  jwksUri: 'http://127.0.0.1:39393/tenant/keys',
  redirectUri: 'http://127.0.0.1:39394/enterprise/callback',
  allowInsecureLoopbackForTests: true,
};

async function mockIdP(directory: ServerDirectory, overrides: Record<string, unknown> = {}, beforeToken?: () => Promise<void>, pinned: OidcConfiguration = config) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'local-fixture-key', alg: 'RS256', use: 'sig' };
  let authorizeNonce = '';
  let authorizeChallenge = '';
  let tokenRequests = 0;
  let metadataOverride: Record<string, unknown> = {};
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input) === providerMetadataUri(config.issuer)) return Response.json({ issuer: config.issuer,
      authorization_endpoint: config.authorizationEndpoint, token_endpoint: config.tokenEndpoint,
      jwks_uri: config.jwksUri, response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], ...metadataOverride });
    if (String(input) === config.jwksUri) return Response.json({ keys: [jwk] });
    if (String(input) !== config.tokenEndpoint || init?.method !== 'POST') throw new Error('Unexpected endpoint');
    tokenRequests++;
    await beforeToken?.();
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(config.redirectUri);
    expect(body.get('client_id')).toBe(config.clientId);
    expect(body.get('code_verifier')).toBeTruthy();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!));
    expect(Buffer.from(digest).toString('base64url')).toBe(authorizeChallenge);
    const token = await new SignJWT({ nonce: authorizeNonce, ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: 'local-fixture-key' })
      .setIssuer(config.issuer).setAudience(typeof overrides.aud === 'string' ? overrides.aud : config.clientId)
      .setSubject(typeof overrides.sub === 'string' ? overrides.sub : 'alice')
      .setIssuedAt().setExpirationTime('10m').sign(privateKey);
    return Response.json({ id_token: token });
  };
  const integration = new OidcIntegration(pinned, directory, fetchMock);
  const begin = async (recovery = false) => {
    const flow = recovery ? await integration.beginDomainRecovery() : await integration.begin();
    const url = new URL(flow.authorizationUrl);
    authorizeNonce = url.searchParams.get('nonce')!;
    authorizeChallenge = url.searchParams.get('code_challenge')!;
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(pinned.accountDomain ? 'openid email' : 'openid');
    return flow;
  };
  return { integration, begin, requests: () => tokenRequests,
    metadata: (changed: Record<string, unknown>) => { metadataOverride = changed; } };
}

describe('server-owned directory and local OIDC fixture', () => {
  test('workspace runtime grants require an active member, exact action and audited tenant transaction', async () => {
    const { directory: first, file } = await directory();
    const second = new ServerDirectory(file);
    const admin = await first.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000);
    await first.createWorkspace(admin.identity, 'engineering', 'Engineering');
    await first.setMember(admin.identity, { organizationId: 'org-a', subject: 'member|A',
      displayName: 'Member A', role: 'member', active: true });
    const member = await second.createSession(config.issuer, 'org-a', 'member|A', Date.now() + 60_000);
    const foreignBefore = (await first.auditSummary('org-b')).eventCount;
    expect(await second.authorizeRuntime(member.identity, 'tool.invoke', 'engineering')).toBe(false);
    await first.setRuntimeGrant(admin.identity, 'engineering', 'member|A', 'tool.invoke', true);
    expect(await second.authorizeRuntime(member.identity, 'tool.invoke', 'engineering')).toBe(true);
    expect(await second.authorizeRuntime(member.identity, 'agent.execute', 'engineering')).toBe(false);
    expect(await second.authorizeRuntime(member.identity, 'tool.invoke', 'missing')).toBe(false);
    await expect(first.setRuntimeGrant(admin.identity, 'engineering', 'bob', 'tool.invoke', true)).rejects.toThrow('Access denied');
    await first.setRuntimeGrant(admin.identity, 'engineering', 'member|A', 'tool.invoke', false);
    expect(await second.authorizeRuntime(member.identity, 'tool.invoke', 'engineering')).toBe(false);
    await first.setRuntimeGrant(admin.identity, 'engineering', 'member|A', 'tool.invoke', true);
    await first.deactivateMember(admin.identity, 'member|A');
    expect(await second.verifySession(member.token)).toBeNull();
    await expect(second.authorizeRuntime(member.identity, 'tool.invoke', 'engineering')).rejects.toThrow('Access denied');
    await first.setMember(admin.identity, { organizationId: 'org-a', subject: 'member|A',
      displayName: 'Member A', role: 'member', active: true });
    const restored = await second.createSession(config.issuer, 'org-a', 'member|A', Date.now() + 60_000);
    expect(await second.authorizeRuntime(restored.identity, 'tool.invoke', 'engineering')).toBe(false);
    expect((await first.auditSummary('org-b')).eventCount).toBe(foreignBefore);
    const audit = await first.listAudit(admin.identity);
    expect(audit.some((event) => event.action === 'runtime.tool.invoke' && event.outcome === 'allowed' &&
      event.targetWorkspaceId === 'engineering' && event.subject === 'member|A')).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8')).organizations['org-a'].workspaces.engineering.grants['member|A']).toBeUndefined();
  });

  test('accepts opaque ASCII OIDC subjects without confusing reserved object keys with membership', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'enterprise-subject-'));
    paths.push(parent);
    const file = join(parent, 'directory.json');
    const first = new ServerDirectory(file);
    const second = new ServerDirectory(file);
    const subject = 'auth0|Alice';
    await first.bootstrap('org-a', 'Acme', config.issuer,
      { organizationId: 'org-a', subject, displayName: 'Alice', role: 'admin', active: true });
    const idp = await mockIdP(first, { sub: subject });
    const flow = await idp.begin();
    const session = await idp.integration.complete({ code: 'synthetic', state: flow.state,
      browserBinding: flow.browserBinding });
    const actor = (await second.verifySession(session.token))!;
    expect(actor.subject).toBe(subject);
    expect((await second.readAdmin(actor, 'overview') as { identity: { subject: string } }).identity.subject).toBe(subject);
    for (const identifier of ['__proto__', 'constructor', 'prototype', 'S'.repeat(255)]) {
      await first.setMember(actor, { organizationId: 'org-a', subject: identifier,
        displayName: identifier, role: 'member', active: true });
      const member = await second.createSession(config.issuer, 'org-a', identifier, Date.now() + 60_000);
      expect((await first.verifySession(member.token))?.subject).toBe(identifier);
      expect((await first.getMember('org-a', identifier))?.role).toBe('member');
    }
    for (const identifier of [' ', 'zero\u0000byte', 'quote"slash\\']) {
      await first.setMember(actor, { organizationId: 'org-a', subject: identifier,
        displayName: 'Synthetic opaque subject', role: 'member', active: true });
      const issuer = await mockIdP(first, { sub: identifier });
      const started = await issuer.begin();
      const signed = await issuer.integration.complete({ code: 'synthetic', state: started.state,
        browserBinding: started.browserBinding });
      expect((await second.verifySession(signed.token))?.subject).toBe(identifier);
      await first.deactivateMember(actor, identifier);
      expect(await second.verifySession(signed.token)).toBeNull();
    }
    await expect(first.createSession(config.issuer, 'org-a', 'X'.repeat(256), Date.now() + 60_000))
      .rejects.toThrow('Invalid session');
    await expect(first.createSession(config.issuer, 'org-a', 'é', Date.now() + 60_000))
      .rejects.toThrow('Invalid session');
    const reserved = await first.createSession(config.issuer, 'org-a', '__proto__', Date.now() + 60_000);
    const state = JSON.parse(await readFile(file, 'utf8'));
    delete state.organizations['org-a'].members['__proto__'];
    await writeFile(file, JSON.stringify(state)); // A missing own member must not resolve Object.prototype.
    await expect(second.verifySession(reserved.token)).rejects.toThrow('Directory session is invalid');
  });

  test('a stale unrevoked session cannot outlive membership or issuer in the durable directory', async () => {
    const { directory: first, file } = await directory();
    const second = new ServerDirectory(file);
    const session = await first.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000);
    const app = express();
    app.use('/api/enterprise', createEnterpriseBrowserRouter({
      applicationOrigin: 'http://127.0.0.1:39394', allowInsecureLoopbackForTests: true,
      verifySession: (token) => second.verifySession(token), directory: second,
    }));
    const get = () => request(app).get('/api/enterprise/organizations/org-a/overview')
      .set('Host', '127.0.0.1:39394')
      .set('Cookie', `interpreter-enterprise-session=${session.token}`);
    expect((await get()).status).toBe(200);
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.organizations['org-a'].members.alice.active = false;
    await writeFile(file, JSON.stringify(state)); // Synthetic external deprovisioning without session cleanup.
    expect(await first.verifySession(session.token)).toBeNull();
    expect((await get()).status).toBe(403);
    state.organizations['org-a'].members.alice.active = true;
    state.organizations['org-a'].issuer = 'https://idp.example/rotated';
    await writeFile(file, JSON.stringify(state)); // A stale issuer must not restore authority.
    await expect(second.verifySession(session.token)).rejects.toThrow('Directory session is invalid');
    expect((await get()).status).toBe(503); // Corrupt issuer state fails closed as an outage.
  });

  test('pinned account domain requires global registry, fresh proof and signed verified email at both login boundaries', async () => {
    const pinned = { ...config, accountDomain: 'acme.example' };
    const { directory: filePilot } = await directory();
    const pilot = await mockIdP(filePilot, { email: 'alice@acme.example', email_verified: true }, undefined, pinned);
    await expect(pilot.begin()).rejects.toThrow('Account domain unavailable');
    await expect(filePilot.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000, 0, 'acme.example'))
      .rejects.toThrow('Verified account domain required');
    expect(pilot.requests()).toBe(0);
    expect(() => new OidcIntegration({ ...pinned, accountDomain: 'Acme.Example' }, filePilot)).toThrow('account domain');

    const state = blankDirectoryState();
    let claimed = true;
    let claimOutage = false;
    let dns: string[][] = [];
    const store: EnterpriseStateStore = {
      requiresPagedAudit: true,
      read: async () => state,
      change: async (fn) => fn(state),
      domainClaimStatus: async (org, issuer, domain) => {
        if (claimOutage) throw new Error('Registry unavailable');
        return claimed && org === 'org-a' && issuer === config.issuer && domain === 'acme.example';
      },
      changeWithDomainClaim: async (org, issuer, domain, fn) => {
        if (claimOutage) throw new Error('Registry unavailable');
        if (!claimed || org !== 'org-a' || issuer !== config.issuer || domain !== 'acme.example') {
          throw new Error('Verified account domain required');
        }
        return fn(state);
      },
      probeDomainRecovery: async (org, issuer, domain) => {
        const tenant = state.organizations[org];
        const proof = tenant?.domainProofs?.[domain];
        return Boolean(org === 'org-a' && issuer === tenant?.issuer && proof?.issuer === issuer &&
          proof.verifiedUntil && proof.verifiedUntil <= Date.now());
      },
    };
    const scopedDirectory = new ServerDirectory(store, async () => dns);
    await scopedDirectory.bootstrap('org-a', 'Acme', config.issuer,
      { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
    const admin = await scopedDirectory.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000);
    const valid = await mockIdP(scopedDirectory, { email: 'alice@acme.example', email_verified: true }, undefined, pinned);
    await expect(valid.begin()).rejects.toThrow('Account domain unavailable');
    const challenge = await scopedDirectory.beginDomainProof(admin.identity, 'acme.example');
    dns = [[challenge.value]];
    await scopedDirectory.confirmDomainProof(admin.identity, 'acme.example');
    claimed = false;
    await expect(valid.begin()).rejects.toThrow('Account domain unavailable');
    claimed = true;
    claimOutage = true;
    await expect(valid.begin()).rejects.toThrow('Registry unavailable');
    claimOutage = false;

    for (const claims of [
      { email: 'alice@acme.example' }, { email: 'alice@acme.example', email_verified: false },
      { email: 'alice@other.example', email_verified: true },
      { email: 'alice@acme.example.evil', email_verified: true },
    ]) {
      const idp = await mockIdP(scopedDirectory, claims, undefined, pinned);
      const flow = await idp.begin();
      await expect(idp.integration.complete({ code: 'synthetic', state: flow.state,
        browserBinding: flow.browserBinding })).rejects.toThrow('Verified account domain required');
    }
    const inFlight = await valid.begin();
    claimed = false;
    await expect(valid.integration.complete({ code: 'synthetic', state: inFlight.state,
      browserBinding: inFlight.browserBinding })).rejects.toThrow('Verified account domain required');
    claimed = true;
    const outage = await valid.begin();
    claimOutage = true;
    await expect(valid.integration.complete({ code: 'synthetic', state: outage.state,
      browserBinding: outage.browserBinding })).rejects.toThrow('Registry unavailable');
    claimOutage = false;
    const accepted = await valid.begin();
    const session = await valid.integration.complete({ code: 'synthetic', state: accepted.state,
      browserBinding: accepted.browserBinding });
    expect((await scopedDirectory.verifySession(session.token))?.organizationId).toBe('org-a');
    expect((await scopedDirectory.auditSummary('org-a')).eventCount).toBeGreaterThan(1);

    // A lapsed prior proof is recoverable through a *different* durable
    // purpose, never by weakening the ordinary login requirement.
    state.organizations['org-a']!.domainProofs!['acme.example']!.verifiedUntil = Date.now() - 1;
    await expect(valid.begin()).rejects.toThrow('Account domain unavailable');
    claimed = false;
    await expect(valid.begin(true)).rejects.toThrow('Domain recovery unavailable');
    claimed = true;
    const notEnabled = await valid.begin(true);
    const beforeExchange = valid.requests();
    await expect(valid.integration.complete({ code: 'synthetic', state: notEnabled.state,
      browserBinding: notEnabled.browserBinding })).rejects.toThrow('Domain recovery unavailable');
    expect(valid.requests()).toBe(beforeExchange); // Consumes one-time state before the IdP exchange.
    const recovery = await valid.begin(true);
    const recovered = await valid.integration.complete({ code: 'synthetic', state: recovery.state,
      browserBinding: recovery.browserBinding }, { allowDomainRecovery: true });
    expect(recovered.recoveryOnly).toBe(true);
    expect(recovered.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(await scopedDirectory.verifySession(recovered.token)).toBeNull();
    expect((await scopedDirectory.verifyBoundSessionForDomainRenewal(recovered.token, 'acme.example'))?.subject).toBe('alice');
    await expect(valid.integration.complete({ code: 'synthetic', state: recovery.state,
      browserBinding: recovery.browserBinding }, { allowDomainRecovery: true })).rejects.toThrow('OIDC state invalid or expired');
    for (const claims of [
      { email: 'alice@acme.example', email_verified: false },
      { email: 'alice@other.example', email_verified: true },
    ]) {
      const wrong = await mockIdP(scopedDirectory, claims, undefined, pinned);
      const flow = await wrong.begin(true);
      await expect(wrong.integration.complete({ code: 'synthetic', state: flow.state,
        browserBinding: flow.browserBinding }, { allowDomainRecovery: true })).rejects.toThrow('Verified account domain required');
    }
    const interrupted = await valid.begin(true);
    claimOutage = true;
    await expect(valid.integration.complete({ code: 'synthetic', state: interrupted.state,
      browserBinding: interrupted.browserBinding }, { allowDomainRecovery: true })).rejects.toThrow('Registry unavailable');
    claimOutage = false;
    const prior = await valid.begin(true);
    state.organizations['org-a']!.members.alice.active = false;
    await expect(valid.integration.complete({ code: 'synthetic', state: prior.state,
      browserBinding: prior.browserBinding }, { allowDomainRecovery: true })).rejects.toThrow('Domain recovery is unavailable');
    state.organizations['org-a']!.members.alice.active = true;
    const killed = await valid.begin(true);
    state.organizations['org-a']!.authEpoch = 1;
    await expect(valid.integration.complete({ code: 'synthetic', state: killed.state,
      browserBinding: killed.browserBinding }, { allowDomainRecovery: true })).rejects.toThrow('OIDC state invalid or expired');
  });
  test('provider discovery binds path issuer, endpoints, public client, S256 and algorithms before login and code exchange', async () => {
    expect(providerMetadataUri(config.issuer)).toBe('http://127.0.0.1:39393/tenant/.well-known/openid-configuration');
    const { directory: store } = await directory();
    const idp = await mockIdP(store);
    for (const changed of [
      { issuer: 'http://127.0.0.1:39393/other-tenant' }, { jwks_uri: 'http://127.0.0.1:39393/other-tenant/keys' },
      { token_endpoint: 'http://127.0.0.1:39393/other-tenant/token' }, { response_types_supported: ['id_token'] },
      { token_endpoint_auth_methods_supported: ['client_secret_basic'] }, { code_challenge_methods_supported: ['plain'] },
      { id_token_signing_alg_values_supported: ['none'] },
    ]) {
      idp.metadata(changed);
      await expect(idp.begin()).rejects.toThrow('provider metadata');
    }
    idp.metadata({});
    const flow = await idp.begin();
    idp.metadata({ issuer: 'http://127.0.0.1:39393/other-tenant' });
    await expect(idp.integration.complete({ code: 'one-time-code', state: flow.state,
      browserBinding: flow.browserBinding })).rejects.toThrow('provider metadata');
    idp.metadata({});
    await expect(idp.integration.complete({ code: 'one-time-code', state: flow.state,
      browserBinding: flow.browserBinding })).rejects.toThrow('state invalid');
    expect(idp.requests()).toBe(0);
    expect((await store.auditSummary('org-a')).eventCount).toBe(1);
  });
  test('server-held confidential client uses RFC form-encoded Basic only at the pinned token endpoint', async () => {
    const { directory: store, file } = await directory();
    const supplied = { ...config, clientId: 'client id+/', tokenEndpointAuthMethod: 'client_secret_basic' as const,
      clientSecret: 'synthetic +: %/only' }; // Synthetic fixture, never a provider credential.
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-basic', alg: 'RS256', use: 'sig' };
    let nonce = '';
    let tokenRequests = 0;
    const request: typeof fetch = async (input, init) => {
      if (String(input) === providerMetadataUri(config.issuer)) {
        expect(JSON.stringify(init)).not.toContain(supplied.clientSecret);
        return Response.json({ issuer: config.issuer, authorization_endpoint: config.authorizationEndpoint,
          token_endpoint: config.tokenEndpoint, jwks_uri: config.jwksUri, response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
        // Omitted auth methods default to client_secret_basic under OIDC Discovery.
      }
      if (String(input) === config.jwksUri) {
        expect(JSON.stringify(init)).not.toContain('Authorization');
        return Response.json({ keys: [jwk] });
      }
      expect(String(input)).toBe(config.tokenEndpoint);
      expect(init?.redirect).toBe('error');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Basic ' + Buffer.from('client+id%2B%2F:synthetic+%2B%3A+%25%2Fonly').toString('base64'));
      const body = new URLSearchParams(init?.body as URLSearchParams);
      expect(body.get('client_secret')).toBeNull();
      expect(body.get('client_id')).toBeNull();
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      tokenRequests++;
      return Response.json({ id_token: await new SignJWT({ nonce }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-basic' })
        .setIssuer(config.issuer).setAudience(supplied.clientId).setSubject('alice')
        .setIssuedAt().setExpirationTime('5m').sign(privateKey) });
    };
    const integration = new OidcIntegration(supplied, store, request);
    supplied.clientSecret = 'mutated credential'; // The instance retains its originally pinned snapshot.
    const begin = await integration.begin();
    nonce = new URL(begin.authorizationUrl).searchParams.get('nonce')!;
    expect(begin.authorizationUrl).not.toContain('synthetic +: %/only');
    const result = await integration.complete({ code: 'synthetic-code', state: begin.state, browserBinding: begin.browserBinding });
    expect(tokenRequests).toBe(1);
    expect((await store.verifySession(result.token))?.organizationId).toBe('org-a');
    expect(await readFile(file, 'utf8')).not.toContain('synthetic +: %/only');
  });
  test('confidential auth fails closed on absent credential or incompatible provider metadata', async () => {
    const { directory: store } = await directory();
    for (const unsafe of [
      { ...config, tokenEndpointAuthMethod: 'client_secret_basic' as const },
      { ...config, clientSecret: 'synthetic-only' },
      { ...config, tokenEndpointAuthMethod: 'client_secret_basic' as const, clientSecret: '' },
    ]) expect(() => new OidcIntegration(unsafe, store)).toThrow('client authentication');
    const confidential = { ...config, tokenEndpointAuthMethod: 'client_secret_basic' as const,
      clientSecret: 'synthetic-only' };
    const idp = new OidcIntegration(confidential, store, async (input) => {
      expect(String(input)).toBe(providerMetadataUri(config.issuer));
      return Response.json({ issuer: config.issuer, authorization_endpoint: config.authorizationEndpoint,
        token_endpoint: config.tokenEndpoint, jwks_uri: config.jwksUri, response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'] });
    });
    await expect(idp.begin()).rejects.toThrow('provider metadata');
  });
  test('provider discovery outage, wrong content type and oversized response deny before storing login state', async () => {
    const { directory: store, file } = await directory();
    const metadata = providerMetadataUri(config.issuer);
    for (const response of [
      () => { throw new Error('Provider unavailable'); },
      () => new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
      () => Response.json({ issuer: config.issuer, padding: 'x'.repeat(66_000) }),
    ]) {
      const integration = new OidcIntegration(config, store, async (input, init) => {
        expect(String(input)).toBe(metadata);
        expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
        return response();
      });
      await expect(integration.begin()).rejects.toThrow();
    }
    expect(JSON.parse(await readFile(file, 'utf8')).attempts).toEqual({});
  });
  test('signed OIDC login creates opaque revocable session and tenant-scoped admin view', async () => {
    const { directory: first, file } = await directory();
    const idp = await mockIdP(first);
    const flow = await idp.begin();
    const result = await idp.integration.complete({ code: 'one-time-code', state: flow.state, browserBinding: flow.browserBinding });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const resumed = new ServerDirectory(file);
    const app = express();
    app.use(createEnterpriseControlPlane({ verifyBearer: (token) => resumed.verifySession(token), directory: resumed }));
    const allowed = await request(app).get('/organizations/org-a/members').set('Authorization', `Bearer ${result.token}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.members).toHaveLength(1);
    const dashboard = await request(app).get('/organizations/org-a/overview').set('Authorization', `Bearer ${result.token}`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.organization).toEqual({ id: 'org-a', name: 'Acme' });
    expect(dashboard.body.users).toEqual({ total: 1, active: 1, admins: 1 });
    expect(dashboard.body.audit.eventCount).toBeGreaterThan(0);
    expect(dashboard.body.controls.policy).toBe('not enforced');
    expect((await request(app).get('/organizations/org-b/members').set('Authorization', `Bearer ${result.token}`)).status).toBe(403);
    expect((await request(app).get('/organizations/org-b/overview').set('Authorization', `Bearer ${result.token}`)).status).toBe(403);
    expect((await resumed.auditSummary('org-b')).eventCount).toBe(1); // bootstrap only; unauthorized reads are not attributed to another tenant
    const identity = await resumed.verifySession(result.token);
    expect(identity?.organizationId).toBe('org-a');
    await resumed.revokeSession(identity!);
    expect((await request(app).get('/organizations/org-a/members').set('Authorization', `Bearer ${result.token}`)).status).toBe(403);
    const onDisk = await readFile(file, 'utf8');
    expect(onDisk).not.toContain(result.token);
    expect((await stat(file)).mode & 0o077).toBe(0);
  });

  test('organization kill fences an OIDC code exchange already in flight, not a new login', async () => {
    const { directory: store, file } = await directory();
    const admin = await store.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000);
    const foreign = await store.createSession('http://127.0.0.1:39393/other-tenant', 'org-b', 'bob', Date.now() + 60_000);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const idp = await mockIdP(store, {}, async () => { started(); await gate; });
    const pending = await idp.begin();
    const inFlight = await idp.begin();
    const completion = idp.integration.complete({ code: 'one-time-code', state: inFlight.state,
      browserBinding: inFlight.browserBinding });
    try {
      await entered; // The code exchange has consumed its browser attempt on this host.
      expect(await store.revokeOrganizationSessions(admin.identity)).toBe(1);
    } finally { release(); }
    await expect(completion).rejects.toThrow('login epoch mismatch');
    await expect(idp.integration.complete({ code: 'one-time-code', state: pending.state,
      browserBinding: pending.browserBinding })).rejects.toThrow('state invalid');
    expect(await store.verifySession(admin.token)).toBeNull();
    expect(await store.verifySession(foreign.token)).not.toBeNull();
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).attempts)).toHaveLength(0);
    const fresh = await idp.begin();
    const issued = await idp.integration.complete({ code: 'new-code', state: fresh.state,
      browserBinding: fresh.browserBinding });
    expect(await store.verifySession(issued.token)).not.toBeNull();
    expect(idp.requests()).toBe(2); // Only the consumed and new attempts reach token exchange.
  });

  test('state and browser binding are one-time; no token exchange on mismatch or replay', async () => {
    const { directory: store } = await directory();
    const idp = await mockIdP(store);
    const flow = await idp.begin();
    // A wrong binding is rejected before token exchange and cannot burn the
    // genuine browser's attempt; the genuine callback then succeeds once.
    await expect(idp.integration.complete({ code: 'code', state: flow.state, browserBinding: 'wrong' })).rejects.toThrow('state invalid');
    expect(idp.requests()).toBe(0);
    await idp.integration.complete({ code: 'code', state: flow.state, browserBinding: flow.browserBinding });
    expect(idp.requests()).toBe(1);
    await expect(idp.integration.complete({ code: 'code', state: flow.state, browserBinding: flow.browserBinding })).rejects.toThrow('state invalid');
    expect(idp.requests()).toBe(1);
  });
  test('public login-start state is bounded per client across hosts without refusing another client or tenant', async () => {
    const { directory: first, file } = await directory();
    const second = new ServerDirectory(file);
    const make = (organizationId: string, issuer: string, expiresAt: number) => ({ organizationId, issuer,
      nonce: 'synthetic-nonce', verifier: 'synthetic-verifier', bindingHash: 'a'.repeat(64), expiresAt });
    const a = make('org-a', config.issuer, Date.now() + 60_000);
    const attempts = async () => Object.values(JSON.parse(await readFile(file, 'utf8')).attempts) as
      Array<{ organizationId: string; expiresAt: number; clientHash: string }>;
    for (let i = 0; i <= MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT; i++) {
      await (i % 2 ? second : first).putAttempt(`state-${i}`, { ...a, expiresAt: a.expiresAt + i }, '198.51.100.7');
    }
    // The client's own oldest attempt was evicted; no start was refused.
    expect((await attempts()).filter((attempt) => attempt.organizationId === 'org-a')).toHaveLength(MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT);
    expect((await attempts()).some((attempt) => attempt.expiresAt === a.expiresAt)).toBe(false);
    await second.putAttempt('other-client', a, '203.0.113.9');
    expect((await attempts()).filter((attempt) => attempt.organizationId === 'org-a')).toHaveLength(MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT + 1);
    const b = make('org-b', 'http://127.0.0.1:39393/other-tenant', Date.now() + 60_000);
    await second.putAttempt('other-tenant', b, '198.51.100.7');
    expect((await second.takeAttempt('other-tenant', 'wrong'))).toBeNull();
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('state-1'); // Only state digests are stored.
    expect(raw).not.toContain('198.51.100.7');
    await expect(first.putAttempt('too-long', { ...a, expiresAt: Date.now() + 60 * 60_000 })).rejects.toThrow('Invalid attempt');
  });

  test('signed token nonce mismatch, unprovisioned subject, and forged audience fail closed', async () => {
    for (const override of [{ nonce: 'incorrect' }, { aud: 'other-client' }, { sub: 'not-provisioned' }]) {
      const { directory: store } = await directory();
      const idp = await mockIdP(store, override);
      const flow = await idp.begin();
      await expect(idp.integration.complete({ code: 'code', state: flow.state, browserBinding: flow.browserBinding })).rejects.toThrow();
      expect(idp.requests()).toBe(1);
    }
  });

  test('admin demotion revokes sessions immediately and preserves another active admin', async () => {
    const { directory: store, file } = await directory();
    const { token, identity } = await store.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000);
    await store.setMember(identity, { organizationId: 'org-a', subject: 'carol', displayName: 'Carol', role: 'admin', active: true });
    // Membership updates revoke sessions of the target, not the actor.
    await store.setMember(identity, { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'member', active: true });
    expect(await store.verifySession(token)).toBeNull();
    const events = await readFile(file, 'utf8');
    expect(events).toContain('organization.member.update');
  });

  test('audit listing checks current admin and session in the locked tenant snapshot', async () => {
    const { directory: store } = await directory();
    const { identity } = await store.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000);
    const events = await store.listAudit(identity);
    expect(events.every((event) => event.organizationId === 'org-a')).toBe(true);
    expect((await store.auditSummary('org-a')).eventCount).toBe(events.length + 1);
    await store.setMember(identity, { organizationId: 'org-a', subject: 'bob', displayName: 'Bob', role: 'member', active: true });
    const member = await store.createSession(config.issuer, 'org-a', 'bob', Date.now() + 60_000);
    const before = (await store.auditSummary('org-a')).eventCount;
    await expect(store.listAudit(member.identity)).rejects.toThrow('Access denied');
    expect((await store.auditSummary('org-a')).eventCount).toBe(before + 1);
    expect((await store.listAudit(identity)).at(-1)).toMatchObject({ organizationId: 'org-a', subject: 'bob',
      action: 'organization.audit.read', outcome: 'denied' });
    await expect(store.listAudit({ ...identity, organizationId: 'org-b' })).rejects.toThrow();
    await store.revokeSession(identity);
    await expect(store.listAudit(identity)).rejects.toThrow();
  });

  test('unsafe HTTPS configuration is rejected outside local-only test setup', async () => {
    const { directory: store } = await directory();
    expect(() => new OidcIntegration({ ...config, allowInsecureLoopbackForTests: false }, store)).toThrow();
  });

  test('issuer pin, expired attempts, and unsafe object keys cannot create an organization session', async () => {
    const { directory: store } = await directory();
    await expect(store.bootstrap('__proto__', 'Invalid', config.issuer,
      { organizationId: '__proto__', subject: 'alice', displayName: 'Alice', role: 'admin', active: true })).rejects.toThrow();
    await expect(store.createSession('http://127.0.0.1:39393/untrusted', 'org-a', 'alice', Date.now() + 60_000)).rejects.toThrow();
    await store.putAttempt('expired-state', { organizationId: 'org-a', issuer: config.issuer, nonce: 'nonce', verifier: 'verifier',
      bindingHash: Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('binding'))).toString('hex'), expiresAt: Date.now() - 1 });
    expect(await store.takeAttempt('expired-state', 'binding')).toBeNull();
    expect(await store.takeAttempt('expired-state', 'binding')).toBeNull();
  });

  test('missing state and a stale cross-process lock fail closed without silently rebuilding audit', async () => {
    const { directory: store, file } = await directory();
    const { token } = await store.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000);
    await mkdir(file + '.lock');
    await expect(store.readAdmin((await store.verifySession(token))!, 'members')).rejects.toThrow();
    await rm(file + '.lock', { recursive: true }); // inspected fixture-only recovery
    await rm(file);
    expect(await stat(file).catch(() => null)).toBeNull();
    await expect(store.verifySession(token)).rejects.toThrow();
    expect(await stat(file).catch(() => null)).toBeNull();
  });

  test('oversized write leaves the last directory state readable instead of committing a self-lockout', async () => {
    const { directory: store, file } = await directory();
    const { token, identity } = await store.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000);
    await expect(store.setMember(identity, { organizationId: 'org-a', subject: 'huge',
      displayName: 'x'.repeat(8_100_000), role: 'member', active: true })).rejects.toThrow('Directory capacity reached');
    expect(await store.verifySession(token)).toMatchObject({ organizationId: 'org-a', subject: 'alice' });
    expect(await store.getMember('org-a', 'huge')).toBeNull();
    expect((await stat(file)).size).toBeLessThan(8_000_000);
  });

  test('cross-tenant persisted membership and audit tampering fail closed without rewriting evidence', async () => {
    for (const tamper of [(state: any) => { state.organizations['org-a'].members.alice.organizationId = 'org-b'; },
      (state: any) => { state.audit[0].organizationId = 'unknown-org'; },
      (state: any) => { state.organizations['org-a'].authEpoch = -1; },
      (state: any) => { state.organizations['org-a'].authEpoch = '1'; }]) {
      const { directory: store, file } = await directory();
      const state = JSON.parse(await readFile(file, 'utf8'));
      tamper(state);
      const evidence = JSON.stringify(state);
      await writeFile(file, evidence);
      await expect(store.listMembers('org-a')).rejects.toThrow();
      await expect(store.bootstrap('org-c', 'Gamma', config.issuer,
        { organizationId: 'org-c', subject: 'admin', displayName: 'Admin', role: 'admin', active: true })).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(evidence);
    }
  });

  test('unknown tenant admin read denies without inventing an invalid tenant audit event', async () => {
    const { directory: store } = await directory();
    const { identity } = await store.createSession(config.issuer, 'org-a', 'alice', Date.now() + 60_000);
    const before = await store.auditSummary('org-a');
    expect(await store.readAdmin({ ...identity, organizationId: 'unknown-org' }, 'overview')).toBeNull();
    expect(await store.auditSummary('org-a')).toEqual(before);
  });

  test('transient compaction preserves audit and active session; revoked/expired sessions stay denied', async () => {
    const { directory: store, file } = await directory();
    const { token, identity } = await store.createSession(config.issuer, 'org-a', 'alice', Date.now() + 30_000);
    await store.putAttempt('old-state', { organizationId: 'org-a', issuer: config.issuer, nonce: 'n', verifier: 'v',
      bindingHash: 'a'.repeat(64), expiresAt: Date.now() - 1000 });
    const before = await store.auditSummary('org-a');
    expect(await store.compactExpired(Date.now())).toEqual({ attempts: 1, sessions: 0 });
    expect(await store.verifySession(token)).toMatchObject({ subject: 'alice' });
    expect(await store.auditSummary('org-a')).toEqual(before);
    await store.revokeSession(identity);
    expect(await store.verifySession(token)).toBeNull();
    expect(await store.compactExpired(Date.now() + 35_000)).toEqual({ attempts: 0, sessions: 1 });
    expect((await readFile(file, 'utf8'))).toContain('session.revoke');
  });
});
