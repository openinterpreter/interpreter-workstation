import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createEnterpriseControlPlane } from './controlPlane';
import { ServerDirectory } from './serverDirectory';
import { OidcIntegration, type OidcConfiguration } from './oidc';

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

async function mockIdP(directory: ServerDirectory, overrides: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'local-fixture-key', alg: 'RS256', use: 'sig' };
  let authorizeNonce = '';
  let authorizeChallenge = '';
  let tokenRequests = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input) === config.jwksUri) return Response.json({ keys: [jwk] });
    if (String(input) !== config.tokenEndpoint || init?.method !== 'POST') throw new Error('Unexpected endpoint');
    tokenRequests++;
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
  const integration = new OidcIntegration(config, directory, fetchMock);
  const begin = async () => {
    const flow = await integration.begin();
    const url = new URL(flow.authorizationUrl);
    authorizeNonce = url.searchParams.get('nonce')!;
    authorizeChallenge = url.searchParams.get('code_challenge')!;
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid');
    return flow;
  };
  return { integration, begin, requests: () => tokenRequests };
}

describe('server-owned directory and local OIDC fixture', () => {
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

  test('state and browser binding are one-time; no token exchange on mismatch or replay', async () => {
    const { directory: store } = await directory();
    const idp = await mockIdP(store);
    const flow = await idp.begin();
    await expect(idp.integration.complete({ code: 'code', state: flow.state, browserBinding: 'wrong' })).rejects.toThrow();
    await expect(idp.integration.complete({ code: 'code', state: flow.state, browserBinding: flow.browserBinding })).rejects.toThrow();
    expect(idp.requests()).toBe(0);
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
      (state: any) => { state.audit[0].organizationId = 'unknown-org'; }]) {
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
