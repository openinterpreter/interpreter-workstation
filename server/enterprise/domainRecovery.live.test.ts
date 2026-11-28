import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { createEnterprisePostgresPool, TenantPostgresDirectoryStore } from './postgresDirectoryStore';
import { ServerDirectory } from './serverDirectory';
import { mountEnterpriseAdminRoutes } from './adminMount';

// Explicit, private, disposable PostgreSQL 14 fixture only. No production
// server, account or DNS lookup is involved; ordinary CI skips this suite.
const fixture = process.env.ENTERPRISE_F4_TEST_FIXTURE;
describe.skipIf(!fixture)('real TLS PostgreSQL domain recovery across tenants and HTTP hosts', () => {
  test('RLS, global claim, expired lease and recovery-only cookie fail closed', async () => {
    const caCertificate = readFileSync(`${fixture}/ca.pem`, 'utf8');
    const connect = (user: string, pass: string) => createEnterprisePostgresPool({ host: '127.0.0.1', port: 55439,
      database: 'enterprise_f4_fixture', user, password: readFileSync(`${fixture}/pass-${pass}`, 'utf8'), caCertificate });
    const aPool = connect('enterprise_f4_a', '0');
    const aOtherPool = connect('enterprise_f4_a', '0');
    const bPool = connect('enterprise_f4_b', '1');
    try {
      const issuerA = 'https://idp.invalid/f4-a', issuerB = 'https://idp.invalid/f4-b';
      const domain = 'recovery.example';
      const aStore = new TenantPostgresDirectoryStore(aPool, 'f4-a', 'rls');
      const a = new ServerDirectory(aStore);
      let answer: string[][] = [];
      const other = new ServerDirectory(new TenantPostgresDirectoryStore(aOtherPool, 'f4-a', 'rls'), async () => answer);
      const b = new ServerDirectory(new TenantPostgresDirectoryStore(bPool, 'f4-b', 'rls'));
      await a.bootstrap('f4-a', 'Acme', issuerA,
        { organizationId: 'f4-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
      await b.bootstrap('f4-b', 'Beta', issuerB,
        { organizationId: 'f4-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
      const setup = await a.createSession(issuerA, 'f4-a', 'alice', Date.now() + 60_000);
      const challenge = await a.beginDomainProof(setup.identity, domain);
      answer = [[challenge.value]];
      await other.confirmDomainProof(setup.identity, domain);
      expect(await a.domainClaimHeldForRecovery('f4-a', issuerA, domain)).toBe(false);
      expect(await b.domainClaimHeldForRecovery('f4-b', issuerB, domain)).toBe(false);
      const bound = await a.createSession(issuerA, 'f4-a', 'alice', Date.now() + 60_000, 0, domain);
      await aStore.change((state) => { state.organizations['f4-a']!.domainProofs![domain]!.verifiedUntil = Date.now() - 1; });
      expect(await a.domainClaimHeldForRecovery('f4-a', issuerA, domain)).toBe(true);
      expect(await b.domainClaimHeldForRecovery('f4-a', issuerA, domain)).toBe(false);
      expect(await a.domainClaimHeldForRecovery('f4-b', issuerB, domain)).toBe(false);
      expect(await other.verifySession(bound.token)).toBeNull();
      const killedRecovery = await other.createDomainRecoverySession(issuerA, 'f4-a', 'alice', Date.now() + 60_000, 0, domain);
      expect((await a.verifyBoundSessionForDomainRenewal(killedRecovery.token, domain))?.subject).toBe('alice');
      await a.revokeOrganizationSessions(setup.identity);
      expect(await other.verifyBoundSessionForDomainRenewal(killedRecovery.token, domain)).toBeNull();
      await expect(other.createDomainRecoverySession(issuerA, 'f4-a', 'alice', Date.now() + 60_000, 0, domain))
        .rejects.toThrow('Domain recovery is unavailable');
      const recovery = await other.createDomainRecoverySession(issuerA, 'f4-a', 'alice', Date.now() + 60_000, 1, domain);
      expect(await a.verifySession(recovery.token)).toBeNull();
      expect((await a.verifyBoundSessionForDomainRenewal(recovery.token, domain))?.subject).toBe('alice');
      await expect(b.createDomainRecoverySession(issuerB, 'f4-b', 'bob', Date.now() + 60_000, 0, domain)).rejects.toThrow();
      const origin = 'http://127.0.0.1:39394';
      const app = express();
      expect(mountEnterpriseAdminRoutes(app, { enabled: true, enableDomainSetup: true,
        organizationId: 'f4-a', issuer: issuerA, accountDomain: domain, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, directory: other,
        verifySession: (token) => other.verifyBoundSessionForDomainRenewal(token, domain) })).toBe(true);
      const cookie = `interpreter-enterprise-session=${recovery.token}`;
      const base = '/api/enterprise/organizations/f4-a';
      const get = (path: string) => request(app).get(path).set('Host', '127.0.0.1:39394').set('Cookie', cookie);
      const post = (action: 'challenge' | 'verify') => request(app).post(`${base}/domains/${action}`)
        .set('Host', '127.0.0.1:39394').set('Cookie', cookie).set('Origin', origin)
        .set('Sec-Fetch-Site', 'same-origin').set('X-Interpreter-CSRF', '1')
        .set('Content-Type', 'application/json').send({ domain });
      expect((await get(`${base}/overview`)).status).toBe(403);
      expect((await get('/api/enterprise/organizations/f4-b/domains/status?domain=' + domain)).status).toBe(403);
      const renewal = await post('challenge');
      expect(renewal.status).toBe(200);
      answer = [[renewal.body.value]];
      expect((await post('verify')).status).toBe(204);
      expect(await a.domainClaimVerifiedForLogin('f4-a', issuerA, domain)).toBe(true);
      expect((await get(`${base}/overview`)).status).toBe(403); // Never elevate a recovery cookie.
      const normal = await a.createSession(issuerA, 'f4-a', 'alice', Date.now() + 60_000, 1, domain);
      expect((await a.verifyBoundSession(normal.token, domain))?.subject).toBe('alice');
      // TLS is mandatory even on loopback and an unrelated CA is not accepted.
      const plaintext = new pg.Client({ host: '127.0.0.1', port: 55439, database: 'enterprise_f4_fixture',
        user: 'enterprise_f4_a', password: readFileSync(`${fixture}/pass-0`, 'utf8'), ssl: false });
      await expect(plaintext.connect()).rejects.toThrow();
      const wrongCa = createEnterprisePostgresPool({ host: '127.0.0.1', port: 55439,
        database: 'enterprise_f4_fixture', user: 'enterprise_f4_a',
        password: readFileSync(`${fixture}/pass-0`, 'utf8'),
        caCertificate: readFileSync(`${fixture}/server.pem`, 'utf8') });
      try { await expect(wrongCa.query('SELECT 1')).rejects.toThrow(); }
      finally { await wrongCa.end(); }
      // Closing one host's real pool must be a 503, not a fallback to local
      // state or the other tenant's connection. A server crash is a separate
      // fixture test: killing pooled connections here emits asynchronous pg
      // errors before the Bun HTTP harness can reliably observe the result.
      await aOtherPool.end();
      expect((await get(`${base}/domains/status?domain=${domain}`)).status).toBe(503);
      expect((await a.verifyBoundSession(normal.token, domain))?.subject).toBe('alice');
    } finally {
      await Promise.allSettled([aPool.end(), aOtherPool.end(), bPool.end()]);
    }
  });
});
