import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT, ServerDirectory, type EnterpriseStateStore } from './serverDirectory';
import { createEnterprisePostgresPool, PostgresDirectoryStore, TenantPostgresDirectoryStore } from './postgresDirectoryStore';
import { mountEnterpriseAdminRoutes } from './adminMount';
import { OidcIntegration, providerMetadataUri, type OidcConfiguration } from './oidc';
import { createOidcHttpRouter } from './oidcHttp';
import { createEnterpriseRuntimeGate } from './runtimeGate';
import ipcRouter from '../routes/ipc';

// Intentionally skipped by ordinary unit tests: the isolated OS-package fixture
// explicitly supplies these private, short-lived credentials and shuts itself down.
const live = process.env.ENTERPRISE_TEST_DB_FIXTURE && process.env.ENTERPRISE_TEST_DB_PASSWORD;
const auditEvent = (row: { content: string } | undefined): Record<string, unknown> | undefined =>
  row ? JSON.parse(row.content) as Record<string, unknown> : undefined;
describe.skipIf(!live)('actual TLS PostgreSQL: tenant isolation, revocation and outage over HTTP', () => {
  it('enforces PostgreSQL RLS with independent tenant roles before pinned-store or HTTP authorization', async () => {
    const shared = { host: '127.0.0.1', port: Number(process.env.ENTERPRISE_TEST_DB_PORT), database: 'enterprise_fixture',
      caCertificate: readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, 'utf8') };
    const configA = { ...shared, user: 'enterprise_fixture_a', password: process.env.ENTERPRISE_TEST_DB_PASSWORD_A! };
    const configB = { ...shared, user: 'enterprise_fixture_b', password: process.env.ENTERPRISE_TEST_DB_PASSWORD_B! };
    const poolA = createEnterprisePostgresPool(configA), otherA = createEnterprisePostgresPool(configA);
    const poolB = createEnterprisePostgresPool(configB);
    try {
      const a = new ServerDirectory(new TenantPostgresDirectoryStore(poolA, 'rls-a', 'rls'));
      const aOther = new ServerDirectory(new TenantPostgresDirectoryStore(otherA, 'rls-a', 'rls'));
      const b = new ServerDirectory(new TenantPostgresDirectoryStore(poolB, 'rls-b', 'rls'));
      await expect(new ServerDirectory(new TenantPostgresDirectoryStore(poolA, 'rls-c', 'rls'))
        .bootstrap('rls-c', 'Unprovisioned', 'https://issuer.invalid/c',
          { organizationId: 'rls-c', subject: 'eve', displayName: 'Eve', role: 'admin', active: true }))
        .rejects.toThrow('unavailable'); // Operator did not pre-provision this row or role.
      expect((await poolA.query('SELECT organization_id FROM interpreter_enterprise_rls_directory')).rows.map((row) => row.organization_id)).toEqual(['rls-a']);
      expect((await poolB.query('SELECT organization_id FROM interpreter_enterprise_rls_directory')).rows.map((row) => row.organization_id)).toEqual(['rls-b']);
      const role = await poolA.query('SELECT rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = current_user');
      expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolinherit: false });
      expect((await poolA.query(`SELECT 1 FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = current_user`)).rowCount).toBe(0);
      await expect(poolA.query('SELECT pg_sleep(7)')).rejects.toThrow(/statement timeout|query read timeout/i);
      expect((await poolA.query('UPDATE interpreter_enterprise_rls_directory SET content = $1 WHERE organization_id = $2',
        ['{}', 'rls-b'])).rowCount).toBe(0);
      await expect(poolA.query('UPDATE interpreter_enterprise_rls_directory SET organization_id = $1 WHERE organization_id = $2',
        ['rls-b', 'rls-a'])).rejects.toThrow(/permission denied/i);
      await expect(poolA.query('UPDATE interpreter_enterprise_rls_directory SET database_role = $1 WHERE organization_id = $2',
        ['enterprise_fixture_b', 'rls-a'])).rejects.toThrow(/permission denied/i);
      await expect(poolA.query('INSERT INTO interpreter_enterprise_rls_directory (organization_id, database_role, content) VALUES ($1, $2, $3)',
        ['rls-c', 'enterprise_fixture_a', '{}'])).rejects.toThrow(/permission denied/i);
      const spoofed = await poolA.connect();
      try {
        await spoofed.query("SET app.tenant = 'rls-b'");
        expect((await spoofed.query('SELECT organization_id FROM interpreter_enterprise_rls_directory WHERE organization_id = $1', ['rls-b'])).rowCount).toBe(0);
        await expect(spoofed.query('SET ROLE enterprise_fixture_b')).rejects.toThrow(/permission denied/i);
      } finally { spoofed.release(); }
      await a.bootstrap('rls-a', 'RLS Alpha', 'https://issuer.invalid/a',
        { organizationId: 'rls-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
      await b.bootstrap('rls-b', 'RLS Beta', 'https://issuer.invalid/b',
        { organizationId: 'rls-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
      const shadow = await poolA.connect();
      try {
        await shadow.query('CREATE TEMP TABLE interpreter_enterprise_rls_directory (organization_id text PRIMARY KEY, database_role name NOT NULL, content text NOT NULL)');
        await shadow.query('INSERT INTO interpreter_enterprise_rls_directory (organization_id, database_role, content) VALUES ($1, $2, $3)',
          ['rls-a', 'enterprise_fixture_a', '{}']);
        expect((await shadow.query('SELECT content FROM interpreter_enterprise_rls_directory WHERE organization_id = $1', ['rls-a'])).rows[0]?.content).toBe('{}');
        const pinned = new TenantPostgresDirectoryStore({
          query: (sql: string, values?: unknown[]) => shadow.query(sql, values),
          connect: async () => ({ query: (sql: string, values?: unknown[]) => shadow.query(sql, values), release: () => {} }),
        }, 'rls-a', 'rls');
        const scoped = new ServerDirectory(pinned);
        expect((await scoped.getMember('rls-a', 'alice'))?.subject).toBe('alice');
        const tempSession = await scoped.createSession('https://issuer.invalid/a', 'rls-a', 'alice', Date.now() + 60_000);
        expect((await scoped.verifySession(tempSession.token))?.organizationId).toBe('rls-a');
        expect((await shadow.query('SELECT content FROM interpreter_enterprise_rls_directory WHERE organization_id = $1', ['rls-a'])).rows[0]?.content).toBe('{}');
      } finally { shadow.release(); }
      await expect(new ServerDirectory(new TenantPostgresDirectoryStore(poolB, 'rls-a', 'rls'))
        .getMember('rls-a', 'alice')).rejects.toThrow('unavailable'); // Wrong role cannot read a pinned foreign row.
      const sessionA = await a.createSession('https://issuer.invalid/a', 'rls-a', 'alice', Date.now() + 60_000);
      const sessionB = await b.createSession('https://issuer.invalid/b', 'rls-b', 'bob', Date.now() + 60_000);
      for (const subject of ['auth0|worker', 'S'.repeat(255), ' ', 'zero\u0000byte', 'quote"slash\\']) {
        await a.setMember(sessionA.identity, { organizationId: 'rls-a', subject,
          displayName: 'Synthetic worker', role: 'member', active: true });
        const opaque = await aOther.createSession('https://issuer.invalid/a', 'rls-a', subject, Date.now() + 60_000);
        expect((await a.verifySession(opaque.token))?.subject).toBe(subject);
        expect((await aOther.getMember('rls-a', subject))?.subject).toBe(subject);
        if (subject === 'zero\u0000byte') {
          await a.deactivateMember(sessionA.identity, subject);
          expect(await aOther.verifySession(opaque.token)).toBeNull();
          expect((await aOther.getMember('rls-a', subject))?.active).toBe(false);
        }
      }
      const roleCapability = (capability: 'BYPASSRLS' | 'NOBYPASSRLS') => spawnSync('/usr/lib/postgresql/14/bin/psql',
        ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', process.env.ENTERPRISE_TEST_DB_FIXTURE!,
          '-p', String(process.env.ENTERPRISE_TEST_DB_PORT), '-d', 'enterprise_fixture',
          '-c', `ALTER ROLE enterprise_fixture_a ${capability}`], { encoding: 'utf8' });
      expect(roleCapability('BYPASSRLS').status).toBe(0);
      try {
        await expect(a.verifySession(sessionA.token)).rejects.toThrow('database boundary is unsafe');
        await expect(a.beginDomainProof(sessionA.identity, 'unsafe.test')).rejects.toThrow('database boundary is unsafe');
        expect((await b.verifySession(sessionB.token))?.organizationId).toBe('rls-b');
      } finally { expect(roleCapability('NOBYPASSRLS').status).toBe(0); }
      expect((await a.verifySession(sessionA.token))?.organizationId).toBe('rls-a');
      const alphaChallenge = await a.beginDomainProof(sessionA.identity, 'fixture.test');
      expect(alphaChallenge.name).toBe('_interpreter-workstation.fixture.test');
      // A challenge alone reserves nothing; the claim is taken at verification.
      expect((await poolA.query('SELECT domain FROM public.interpreter_enterprise_rls_domain_claim')).rowCount).toBe(0);
      const rlsVerifier = (pool: typeof poolA, tenant: string, value: string) =>
        new ServerDirectory(new TenantPostgresDirectoryStore(pool, tenant, 'rls'), async () => [[value]]);
      await rlsVerifier(otherA, 'rls-a', alphaChallenge.value).confirmDomainProof(sessionA.identity, 'fixture.test');
      expect((await poolA.query('SELECT domain FROM public.interpreter_enterprise_rls_domain_claim')).rows)
        .toEqual([{ domain: 'fixture.test' }]);
      expect((await poolB.query('SELECT domain FROM public.interpreter_enterprise_rls_domain_claim')).rowCount).toBe(0);
      await expect(poolB.query(`INSERT INTO public.interpreter_enterprise_rls_domain_claim
        (domain, organization_id, database_role, issuer) VALUES ($1, $2, $3, $4)`,
        ['other.test', 'rls-a', 'enterprise_fixture_a', 'https://issuer.invalid/a'])).rejects.toThrow(/row-level security|permission denied/i);
      await expect(poolA.query('DELETE FROM public.interpreter_enterprise_rls_domain_claim')).rejects.toThrow(/permission denied/i);
      await expect(poolA.query(`UPDATE public.interpreter_enterprise_rls_domain_claim SET domain = 'stolen.test'
        WHERE domain = 'fixture.test'`)).rejects.toThrow(/permission denied/i);
      await expect(poolA.query(`UPDATE public.interpreter_enterprise_rls_domain_claim
        SET database_role = 'enterprise_fixture_b' WHERE domain = 'fixture.test'`))
        .rejects.toThrow(/row-level security|permission denied/i);
      expect((await poolA.query(`UPDATE public.interpreter_enterprise_rls_domain_claim
        SET database_role = current_user WHERE domain = 'fixture.test'`)).rowCount).toBe(1);
      // Another tenant may still create a challenge (same response shape),
      // but its correct DNS answer cannot take the verified foreign claim.
      const betaFixture = await b.beginDomainProof(sessionB.identity, 'fixture.test');
      expect(betaFixture.name).toBe('_interpreter-workstation.fixture.test');
      expect(betaFixture.value).toMatch(/^interpreter-workstation-verification=[A-Za-z0-9_-]{43}$/);
      expect((await b.domainProofStatus(sessionB.identity, 'fixture.test')).challengeExpiresAt).toBe(betaFixture.expiresAt);
      await expect(rlsVerifier(poolB, 'rls-b', betaFixture.value).confirmDomainProof(sessionB.identity, 'fixture.test'))
        .rejects.toThrow('Access denied');
      expect(await b.domainVerified('rls-b', 'https://issuer.invalid/b', 'fixture.test')).toBe(false);
      expect((await b.domainProofStatus(sessionB.identity, 'fixture.test')).verifiedUntil).toBeNull();
      expect((await a.domainProofStatus(sessionA.identity, 'fixture.test')).verifiedUntil).toBeGreaterThan(Date.now());
      expect((await poolB.query(`SELECT content FROM public.interpreter_enterprise_rls_audit
        WHERE organization_id = $1 ORDER BY id DESC LIMIT 2`, ['rls-b'])).rows
        .some((row) => auditEvent(row)?.action === 'organization.domain.verify' && auditEvent(row)?.outcome === 'denied')).toBe(true);
      expect((await poolB.query('SELECT domain FROM public.interpreter_enterprise_rls_domain_claim')).rowCount).toBe(0);
      await b.beginDomainProof(sessionB.identity, 'different.test');
      expect((await poolA.query('SELECT domain FROM public.interpreter_enterprise_rls_domain_claim')).rows)
        .toEqual([{ domain: 'fixture.test' }]);
      // A pending challenge does not block another tenant; after that tenant
      // verifies, the first tenant's correct answer is denied and unmarked.
      const pendingA = await a.beginDomainProof(sessionA.identity, 'contested.test');
      const winningB = await b.beginDomainProof(sessionB.identity, 'contested.test');
      await rlsVerifier(poolB, 'rls-b', winningB.value).confirmDomainProof(sessionB.identity, 'contested.test');
      expect(await b.domainVerified('rls-b', 'https://issuer.invalid/b', 'contested.test')).toBe(true);
      await expect(rlsVerifier(otherA, 'rls-a', pendingA.value).confirmDomainProof(sessionA.identity, 'contested.test'))
        .rejects.toThrow('Access denied');
      expect(await a.domainVerified('rls-a', 'https://issuer.invalid/a', 'contested.test')).toBe(false);
      expect((await a.domainProofStatus(sessionA.identity, 'contested.test')).verifiedUntil).toBeNull();
      expect(auditEvent((await poolA.query(`SELECT content FROM public.interpreter_enterprise_rls_audit
        WHERE organization_id = 'rls-a' ORDER BY id DESC LIMIT 1 OFFSET 1`)).rows[0]))
        .toMatchObject({ action: 'organization.domain.verify', targetDomain: 'contested.test', outcome: 'denied' });
      const againA = await a.beginDomainProof(sessionA.identity, 'contested.test');
      expect(againA.name).toBe(pendingA.name);
      expect(againA.value).toMatch(/^interpreter-workstation-verification=[A-Za-z0-9_-]{43}$/);
      expect((await poolA.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
        WHERE domain = 'contested.test'`)).rowCount).toBe(0);
      expect((await poolB.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
        WHERE domain = 'contested.test'`)).rowCount).toBe(1);
      // Concurrent challenges both succeed; concurrent verifications cannot both win.
      const [raceA, raceB] = await Promise.all([
        aOther.beginDomainProof(sessionA.identity, 'race.test'),
        b.beginDomainProof(sessionB.identity, 'race.test'),
      ]);
      expect((await poolA.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
        WHERE domain = 'race.test'`)).rowCount +
        (await poolB.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
          WHERE domain = 'race.test'`)).rowCount).toBe(0);
      const race = await Promise.allSettled([
        rlsVerifier(otherA, 'rls-a', raceA.value).confirmDomainProof(sessionA.identity, 'race.test'),
        rlsVerifier(poolB, 'rls-b', raceB.value).confirmDomainProof(sessionB.identity, 'race.test'),
      ]);
      expect(race.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(race.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      expect((await poolA.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
        WHERE domain = 'race.test'`)).rowCount +
        (await poolB.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
          WHERE domain = 'race.test'`)).rowCount).toBe(1);
      expect(Number(await a.domainVerified('rls-a', 'https://issuer.invalid/a', 'race.test')) +
        Number(await b.domainVerified('rls-b', 'https://issuer.invalid/b', 'race.test'))).toBe(1);
      await a.setMember(sessionA.identity, { organizationId: 'rls-a', subject: 'worker', displayName: 'Worker', role: 'member', active: true });
      await a.setMember(sessionA.identity, { organizationId: 'rls-a', subject: 'admin-c', displayName: 'Admin C', role: 'admin', active: true });
      const worker = await a.createSession('https://issuer.invalid/a', 'rls-a', 'worker', Date.now() + 60_000);
      const demotedSession = await aOther.createSession('https://issuer.invalid/a', 'rls-a', 'admin-c', Date.now() + 60_000);
      // Denied reads and cross-tenant probes are counted in the row's open
      // window and reach the append-only ledger as one row when it closes.
      const heldA = async () => ((JSON.parse((await poolA.query(`SELECT content FROM public.interpreter_enterprise_rls_directory
        WHERE organization_id = 'rls-a'`)).rows[0]!.content as string).pendingAudit ?? []) as Array<{ event: Record<string, unknown> }>)
        .map(({ event }) => event);
      await expect(aOther.listAudit(worker.identity)).rejects.toThrow('Access denied');
      expect((await heldA()).at(-1))
        .toMatchObject({ organizationId: 'rls-a', subject: 'worker', action: 'organization.audit.read', outcome: 'denied', count: 1 });
      expect((await poolB.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-a'])).rowCount).toBe(0);
      const origin = 'http://127.0.0.1:39394';
      const appA = express(), appB = express();
      expect(mountEnterpriseAdminRoutes(appA, { enabled: true, enableWorkspaceAdministration: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'rls-a', issuer: 'https://issuer.invalid/a',
        directory: aOther, verifySession: (token) => aOther.verifySession(token) })).toBe(true);
      expect(mountEnterpriseAdminRoutes(appB, { enabled: true, enableDomainSetup: true, enableWorkspaceAdministration: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'rls-b', issuer: 'https://issuer.invalid/b',
        directory: b, verifySession: (token) => b.verifySession(token) })).toBe(true);
      const httpA = appA.listen(0, '127.0.0.1'), httpB = appB.listen(0, '127.0.0.1');
      try {
        const read = (server: typeof httpA, tenant: string, token: string) => request(server)
          .get(`/api/enterprise/organizations/${tenant}/overview`)
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
        expect((await read(httpA, 'rls-a', sessionA.token)).status).toBe(200);
        const demotePath = '/api/enterprise/organizations/rls-a/members/admin-c/demote';
        const revokeAdminPath = '/api/enterprise/organizations/rls-a/members/admin-c/revoke-sessions';
        const demote = (token: string, path = demotePath) => request(httpA).post(path)
          .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
          .set('X-Interpreter-CSRF', '1').set('Cookie', `interpreter-enterprise-session=${token}`)
          .set('Content-Type', 'application/json').send({});
        const betaAudit = (await b.auditSummary('rls-b')).eventCount;
        expect((await demote(worker.token, revokeAdminPath)).status).toBe(403);
        expect((await demote(sessionA.token, revokeAdminPath)).status).toBe(204);
        expect((await aOther.getMember('rls-a', 'admin-c'))?.role).toBe('admin');
        expect(await aOther.verifySession(demotedSession.token)).toBeNull();
        const renewedAdmin = await aOther.createSession('https://issuer.invalid/a', 'rls-a', 'admin-c', Date.now() + 60_000);
        expect((await a.verifySession(renewedAdmin.token))?.subject).toBe('admin-c');
        expect((await demote(worker.token)).status).toBe(403);
        expect((await demote(sessionA.token, '/api/enterprise/organizations/rls-b/members/bob/demote')).status).toBe(403);
        expect((await demote(sessionA.token)).status).toBe(204);
        expect(await aOther.verifySession(renewedAdmin.token)).toBeNull();
        expect((await aOther.getMember('rls-a', 'admin-c'))?.role).toBe('member');
        expect((await read(httpA, 'rls-a', demotedSession.token)).status).toBe(403);
        expect((await b.auditSummary('rls-b')).eventCount).toBe(betaAudit);
        expect(auditEvent((await poolA.query(`SELECT content FROM public.interpreter_enterprise_rls_audit
          WHERE organization_id = 'rls-a' ORDER BY id DESC LIMIT 1`)).rows[0]))
          .toMatchObject({ action: 'organization.member.demote', subject: 'alice',
            targetSubject: 'admin-c', outcome: 'allowed' });
        await a.setMember(sessionA.identity, { organizationId: 'rls-a', subject: 'admin-d',
          displayName: 'Admin D', role: 'admin', active: true });
        const disabledAdmin = await aOther.createSession('https://issuer.invalid/a', 'rls-a', 'admin-d', Date.now() + 60_000);
        expect((await demote(sessionA.token,
          '/api/enterprise/organizations/rls-a/members/admin-d/deactivate')).status).toBe(204);
        expect((await aOther.getMember('rls-a', 'admin-d'))).toMatchObject({ role: 'admin', active: false });
        expect(await aOther.verifySession(disabledAdmin.token)).toBeNull();
        await expect(a.createSession('https://issuer.invalid/a', 'rls-a', 'admin-d', Date.now() + 60_000))
          .rejects.toThrow('Unprovisioned identity');
        expect((await aOther.getMember('rls-a', 'alice'))?.active).toBe(true);
        expect(roleCapability('BYPASSRLS').status).toBe(0);
        try { expect((await read(httpA, 'rls-a', sessionA.token)).status).toBe(503); }
        finally { expect(roleCapability('NOBYPASSRLS').status).toBe(0); }
        expect((await read(httpA, 'rls-a', sessionA.token)).status).toBe(200);
        expect((await read(httpA, 'rls-b', sessionA.token)).status).toBe(403);
        const foreignDigest = `organization:${createHash('sha256').update('rls-b').digest('hex').slice(0, 16)}`;
        expect((await heldA()).at(-1)).toMatchObject({ organizationId: 'rls-a', targetDigest: foreignDigest,
          action: 'organization.overview.cross-tenant', outcome: 'denied', count: 1 });
        expect((await request(httpA).post('/api/enterprise/organizations/rls-b/session/logout')
          .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
          .set('X-Interpreter-CSRF', '1').set('Cookie', `interpreter-enterprise-session=${sessionA.token}`)
          .set('Content-Type', 'application/json').send({})).status).toBe(403);
        expect((await heldA()).at(-1)).toMatchObject({ organizationId: 'rls-a', targetDigest: foreignDigest,
          action: 'organization.logout.cross-tenant', outcome: 'denied', count: 1 });
        expect((await read(httpA, 'rls-b', sessionA.token)).status).toBe(403);
        expect((await heldA()).find((event) => event.action === 'organization.overview.cross-tenant')).toMatchObject({ count: 2 });
        // Simulate the window closing (the app role may update its own row's
        // content). The next probe appends each closed window as ONE ledger
        // row in the same transaction; the ordered ledger still equals the
        // snapshot, so later locked reads and writes keep passing.
        const held = JSON.parse((await poolA.query(`SELECT content FROM public.interpreter_enterprise_rls_directory
          WHERE organization_id = 'rls-a'`)).rows[0]!.content as string);
        const closing = held.pendingAudit.length as number;
        for (const entry of held.pendingAudit) entry.event.firstAt = new Date(Date.now() - 11 * 60_000).toISOString();
        expect((await poolA.query(`UPDATE public.interpreter_enterprise_rls_directory SET content = $1
          WHERE organization_id = 'rls-a'`, [JSON.stringify(held)])).rowCount).toBe(1);
        expect((await read(httpA, 'rls-b', sessionA.token)).status).toBe(403);
        const summaries = (await poolA.query(`SELECT content FROM public.interpreter_enterprise_rls_audit
          WHERE organization_id = 'rls-a' ORDER BY id DESC LIMIT ${closing}`)).rows.map(auditEvent);
        expect(summaries.find((event) => event?.action === 'organization.overview.cross-tenant'))
          .toMatchObject({ count: 2, outcome: 'denied', targetDigest: foreignDigest });
        expect(summaries.every((event) => event?.targetOrganizationId === undefined)).toBe(true);
        expect((await heldA()).map((event) => [event.action, event.count])).toEqual([['organization.overview.cross-tenant', 1]]);
        expect((await a.verifySession(sessionA.token))?.subject).toBe('alice'); // Ledger comparison passes.
        expect((await read(httpA, 'rls-b', sessionB.token)).status).toBe(403);
        expect((await read(httpB, 'rls-b', sessionB.token)).status).toBe(200);
        expect((await read(httpB, 'rls-a', sessionA.token)).status).toBe(403);
        const workspaces = (server: typeof httpA, tenant: string, token: string) => request(server)
          .get(`/api/enterprise/organizations/${tenant}/workspaces`)
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
        expect((await request(httpA).post('/api/enterprise/organizations/rls-a/workspaces')
          .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
          .set('X-Interpreter-CSRF', '1').set('Cookie', `interpreter-enterprise-session=${sessionA.token}`)
          .set('Content-Type', 'application/json').send({ id: 'engineering', name: 'Engineering' })).status).toBe(204);
        expect((await workspaces(httpA, 'rls-a', sessionA.token)).body.workspaces)
          .toEqual([{ id: 'engineering', name: 'Engineering', active: true }]);
        expect((await a.listWorkspaces(sessionA.identity)).map((workspace) => workspace.id)).toEqual(['engineering']);
        expect((await workspaces(httpB, 'rls-b', sessionB.token)).body.workspaces).toEqual([]);
        expect((await workspaces(httpA, 'rls-b', sessionA.token)).status).toBe(403);
        expect((await workspaces(httpA, 'rls-a', worker.token)).status).toBe(403);
        const foreignRuntimeBefore = (await b.auditSummary('rls-b')).eventCount;
        expect(await aOther.authorizeRuntime(sessionA.identity, 'tool.invoke', 'engineering')).toBe(false);
        expect(auditEvent((await poolA.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', ['rls-a'])).rows[0]))
          .toMatchObject({ organizationId: 'rls-a', subject: 'alice', targetWorkspaceId: 'engineering',
            action: 'runtime.tool.invoke', outcome: 'denied' });
        await a.setRuntimeGrant(sessionA.identity, 'engineering', 'worker', 'tool.invoke', true);
        expect(await aOther.authorizeRuntime(worker.identity, 'tool.invoke', 'engineering')).toBe(true);
        expect(await aOther.authorizeRuntime(worker.identity, 'agent.execute', 'engineering')).toBe(false);
        // Exercise the actual browser IPC route through a second TLS-backed
        // directory connection, rather than treating a direct policy call as
        // evidence that HTTP dispatch has been gated.
        const runtimeApp = express();
        runtimeApp.use(express.json());
        runtimeApp.use('/api/ipc', createEnterpriseRuntimeGate({
          applicationOrigin: origin, organizationId: 'rls-a', issuer: 'https://issuer.invalid/a',
          workspaceId: 'engineering', action: 'tool.invoke', routePath: '/browser/create',
          directory: aOther, allowInsecureLoopbackForTests: true,
        }), ipcRouter);
        const runtime = (token: string) => request(runtimeApp).post('/api/ipc/browser/create')
          .set('Host', '127.0.0.1:39394').set('Origin', origin)
          .set('Sec-Fetch-Site', 'same-origin').set('X-Interpreter-CSRF', '1')
          .set('Cookie', `interpreter-enterprise-session=${token}`).send([]);
        expect((await runtime(sessionB.token)).status).toBe(403);
        expect((await b.auditSummary('rls-b')).eventCount).toBe(foreignRuntimeBefore);
        expect((await runtime(worker.token)).status).toBe(200);
        await a.setRuntimeGrant(sessionA.identity, 'engineering', 'worker', 'tool.invoke', false);
        expect(await aOther.authorizeRuntime(worker.identity, 'tool.invoke', 'engineering')).toBe(false);
        expect((await runtime(worker.token)).status).toBe(403);
        expect((await b.auditSummary('rls-b')).eventCount).toBe(foreignRuntimeBefore);
        // A challenge for a foreign-claimed name is issued like any other; it
        // neither reserves the name nor reveals the existing claim.
        const foreignClaimChallenge = await request(httpB).post('/api/enterprise/organizations/rls-b/domains/challenge')
          .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
          .set('X-Interpreter-CSRF', '1').set('Cookie', `interpreter-enterprise-session=${sessionB.token}`)
          .set('Content-Type', 'application/json').send({ domain: 'fixture.test' });
        expect(foreignClaimChallenge.status).toBe(200);
        expect(foreignClaimChallenge.body).toMatchObject({ name: '_interpreter-workstation.fixture.test' });
        const exportAudit = (server: typeof httpA, tenant: string, token: string) => request(server)
          .get(`/api/enterprise/organizations/${tenant}/activity/export`)
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
        const exported = await exportAudit(httpA, 'rls-a', sessionA.token);
        expect(exported.status).toBe(200);
        expect(exported.headers['content-disposition']).toContain('attachment;');
        expect(exported.body.events.every((event: { organizationId: string }) => event.organizationId === 'rls-a')).toBe(true);
        expect(auditEvent((await poolA.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', ['rls-a']))
          .rows[0])).toMatchObject({ action: 'organization.audit.export', outcome: 'allowed' });
        expect((await exportAudit(httpB, 'rls-b', sessionA.token)).status).toBe(403);
        expect((await exportAudit(httpA, 'rls-a', worker.token)).status).toBe(403);
        expect((await request(httpA).post('/api/enterprise/organizations/rls-a/members/alice/deactivate')
          .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
          .set('X-Interpreter-CSRF', '1').set('Cookie', `interpreter-enterprise-session=${worker.token}`)
          .set('Content-Type', 'application/json').send({})).status).toBe(403);
        expect(auditEvent((await poolA.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', ['rls-a']))
          .rows[0])).toMatchObject({ organizationId: 'rls-a', subject: 'worker',
          action: 'organization.member.deactivate', outcome: 'denied' });
        // A real PostgreSQL audit-write failure must roll back the session
        // mutation, not merely produce a 503 after revocation committed.
        const rollbackBinding = 'audit-outage-browser';
        await a.putAttempt('audit-outage-attempt', { organizationId: 'rls-a', issuer: 'https://issuer.invalid/a',
          nonce: 'outage-nonce', verifier: 'outage-verifier',
          bindingHash: createHash('sha256').update(rollbackBinding).digest('hex'), expiresAt: Date.now() + 60_000 });
        const auditBefore = (await poolA.query('SELECT id FROM public.interpreter_enterprise_rls_audit')).rowCount;
        const auditGrant = (verb: 'REVOKE' | 'GRANT') => spawnSync('/usr/lib/postgresql/14/bin/psql',
          ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', process.env.ENTERPRISE_TEST_DB_FIXTURE!,
            '-p', String(process.env.ENTERPRISE_TEST_DB_PORT), '-d', 'enterprise_fixture',
            '-c', `${verb} INSERT(organization_id, content) ON public.interpreter_enterprise_rls_audit ${verb === 'REVOKE' ? 'FROM' : 'TO'} enterprise_fixture_a`],
          { encoding: 'utf8' });
        expect(auditGrant('REVOKE').status).toBe(0);
        try {
          const deniedKill = await request(httpA).post('/api/enterprise/organizations/rls-a/sessions/revoke-all')
            .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
            .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
            .set('Cookie', `interpreter-enterprise-session=${sessionA.token}`).send({});
          expect(deniedKill.status).toBe(503);
          expect(deniedKill.headers['set-cookie']).toBeUndefined();
        } finally { expect(auditGrant('GRANT').status).toBe(0); }
        expect((await poolA.query('SELECT id FROM public.interpreter_enterprise_rls_audit')).rowCount).toBe(auditBefore);
        expect(await a.verifySession(sessionA.token)).not.toBeNull();
        expect(await aOther.verifySession(worker.token)).not.toBeNull();
        expect((await b.verifySession(sessionB.token))?.organizationId).toBe('rls-b');
        const preserved = await aOther.takeAttempt('audit-outage-attempt', rollbackBinding);
        expect(preserved?.authEpoch).toBe(0); // Rollback must not advance the login fence or delete attempts.
        expect((await a.createSession('https://issuer.invalid/a', 'rls-a', 'alice', Date.now() + 60_000,
          preserved!.authEpoch ?? 0)).identity.organizationId).toBe('rls-a');
        await aOther.revokeSession(worker.identity);
        expect((await runtime(worker.token)).status).toBe(403);
      } finally { httpA.close(); httpB.close(); }
      await aOther.revokeSession(sessionA.identity);
      expect(await a.verifySession(sessionA.token)).toBeNull();
      await expect(aOther.authorizeRuntime(sessionA.identity, 'tool.invoke', 'engineering')).rejects.toThrow('Access denied');
      expect((await b.verifySession(sessionB.token))?.organizationId).toBe('rls-b');
      const eventsA = await poolA.query('SELECT organization_id, content FROM public.interpreter_enterprise_rls_audit ORDER BY id');
      const eventsB = await poolB.query('SELECT organization_id, content FROM public.interpreter_enterprise_rls_audit ORDER BY id');
      expect(eventsA.rows.length).toBeGreaterThanOrEqual(4);
      expect(eventsA.rows.every((event) => event.organization_id === 'rls-a')).toBe(true);
      expect(eventsB.rows.every((event) => event.organization_id === 'rls-b')).toBe(true);
      expect(eventsA.rows.some((event) => auditEvent(event)?.action === 'session.revoke')).toBe(true);
      expect((await poolA.query('SELECT id FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-b'])).rowCount).toBe(0);
      await expect(poolA.query('INSERT INTO public.interpreter_enterprise_rls_audit (organization_id, content) VALUES ($1, $2)',
        ['rls-b', JSON.stringify({ organizationId: 'rls-b', subject: 'alice', action: 'forged', outcome: 'allowed', at: new Date().toISOString() })]))
        .rejects.toThrow(/row.level security/i);
      await expect(poolA.query('INSERT INTO public.interpreter_enterprise_rls_audit (organization_id, content) VALUES ($1, $2)',
        ['rls-a', JSON.stringify({ organizationId: 'rls-b', subject: 'alice', action: 'forged', outcome: 'allowed', at: new Date().toISOString() })]))
        .rejects.toThrow(/check constraint/i);
      for (const incomplete of [
        { subject: 'alice', action: 'forged', outcome: 'allowed', at: new Date().toISOString() },
        { organizationId: 'rls-a', subject: 'alice', action: 'forged', at: new Date().toISOString() },
        { organizationId: 'rls-a', subject: 'alice', action: 'forged', outcome: 'allowed' },
        { organizationId: 'rls-a', subject: null, action: 'forged', outcome: 'allowed', at: new Date().toISOString() },
      ]) {
        await expect(poolA.query('INSERT INTO public.interpreter_enterprise_rls_audit (organization_id, content) VALUES ($1, $2)',
          ['rls-a', JSON.stringify(incomplete)])).rejects.toThrow(/check constraint/i);
      }
      await expect(poolA.query('UPDATE public.interpreter_enterprise_rls_audit SET content = $1 WHERE organization_id = $2',
        ['{}', 'rls-a'])).rejects.toThrow(/permission denied/i);
      await expect(poolA.query('DELETE FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-a']))
        .rejects.toThrow(/permission denied/i);
      // FORCE RLS filters rows for SELECT/UPDATE/DELETE, but not TRUNCATE.
      // None of the tenant roles may clear any tenant's directory, audit or claims.
      for (const table of ['interpreter_enterprise_rls_directory', 'interpreter_enterprise_rls_audit',
        'interpreter_enterprise_rls_domain_claim']) {
        await expect(poolA.query(`TRUNCATE public.${table}`)).rejects.toThrow(/permission denied/i);
      }
      await expect(new TenantPostgresDirectoryStore(poolA, 'rls-a', 'rls').change((state) => {
        state.audit[0]!.action = 'forged-history';
      })).rejects.toThrow('audit history cannot be rewritten');
      expect((await poolA.query('SELECT id FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-a'])).rowCount)
        .toBe(eventsA.rows.length);
      expect((await poolA.query('SELECT organization_id FROM public.interpreter_enterprise_rls_directory WHERE organization_id = $1', ['rls-c'])).rowCount).toBe(0);
      // An explicit opt-in HTTP seam uses two TLS pools and a synthetic DNS
      // resolver. This never enables SSO or queries a customer domain.
      const fresh = await a.createSession('https://issuer.invalid/a', 'rls-a', 'alice', Date.now() + 60_000);
      let answer: string[][] = [];
      let dnsQueries = 0;
      const verifyingHost = new ServerDirectory(new TenantPostgresDirectoryStore(otherA, 'rls-a', 'rls'),
        async () => { dnsQueries++; return answer; });
      const setupApp = express();
      expect(mountEnterpriseAdminRoutes(setupApp, { enabled: true, enableDomainSetup: true,
        applicationOrigin: origin, allowInsecureLoopbackForTests: true, organizationId: 'rls-a', issuer: 'https://issuer.invalid/a',
        directory: verifyingHost, verifySession: (token) => verifyingHost.verifySession(token) })).toBe(true);
      const domainPost = (action: 'challenge' | 'verify', token: string, tenant = 'rls-a', domain = 'fixture.test') => request(setupApp)
        .post(`/api/enterprise/organizations/${tenant}/domains/${action}`)
        .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
        .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
        .set('Cookie', `interpreter-enterprise-session=${token}`).send({ domain });
      expect((await domainPost('verify', fresh.token, 'rls-a', 'unclaimed.test')).status).toBe(403);
      expect(dnsQueries).toBe(0);
      expect((await domainPost('challenge', worker.token)).status).toBe(403);
      expect((await domainPost('challenge', fresh.token, 'rls-b')).status).toBe(403);
      const challenge = await domainPost('challenge', fresh.token);
      expect(challenge.status).toBe(200);
      answer = [[challenge.body.value]];
      expect((await domainPost('verify', worker.token)).status).toBe(403);
      expect(dnsQueries).toBe(0);
      expect((await domainPost('verify', fresh.token)).status).toBe(204);
      expect(dnsQueries).toBe(1);
      const statusUrl = '/api/enterprise/organizations/rls-a/domains/status?domain=fixture.test';
      const domainStatus = (token: string) => request(setupApp).get(statusUrl)
        .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
      expect((await domainStatus(worker.token)).status).toBe(403);
      const status = await domainStatus(fresh.token);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ domain: 'fixture.test', verifiedUntil: expect.any(Number) });
      expect(JSON.stringify(status.body)).not.toContain(challenge.body.value.split('=')[1]!);
      // Simulate an external directory deprovisioning write that did not
      // atomically revoke a previously issued session. An independent TLS
      // pool and real HTTP must still deny the stale identity; the other
      // tenant remains unchanged.
      await a.setMember(fresh.identity, { organizationId: 'rls-a', subject: 'stale-worker',
        displayName: 'Stale Worker', role: 'member', active: true });
      const stale = await aOther.createSession('https://issuer.invalid/a', 'rls-a', 'stale-worker', Date.now() + 60_000);
      await new TenantPostgresDirectoryStore(poolA, 'rls-a', 'rls').change((data) => {
        data.organizations['rls-a']!.members['stale-worker']!.active = false;
      });
      expect(await aOther.verifySession(stale.token)).toBeNull();
      expect((await domainStatus(stale.token)).status).toBe(403);
      expect((await b.verifySession(sessionB.token))?.organizationId).toBe('rls-b');
      expect(await a.domainVerified('rls-a', 'https://issuer.invalid/a', 'fixture.test')).toBe(true);
      expect(await a.domainVerified('rls-a', 'https://issuer.invalid/b', 'fixture.test')).toBe(false);
      expect(await b.domainVerified('rls-b', 'https://issuer.invalid/b', 'fixture.test')).toBe(false);
      // The new activation gate is exercised through two independent TLS
      // PostgreSQL pools and actual HTTP router requests, not a file pilot.
      const domainConfig: OidcConfiguration = {
        organizationId: 'rls-a', issuer: 'https://issuer.invalid/a', clientId: 'synthetic-domain-client',
        authorizationEndpoint: 'https://issuer.invalid/a/authorize',
        tokenEndpoint: 'https://issuer.invalid/a/token', jwksUri: 'https://issuer.invalid/a/keys',
        redirectUri: 'http://127.0.0.1:39394/enterprise/callback',
        accountDomain: 'fixture.test', allowInsecureLoopbackForTests: true,
      };
      const { publicKey: domainPublicKey, privateKey: domainPrivateKey } = await generateKeyPair('RS256');
      const domainJwk = { ...await exportJWK(domainPublicKey), kid: 'domain-fixture-key', alg: 'RS256', use: 'sig' };
      let domainNonce = '';
      let emailVerified = false;
      const domainIdp: typeof fetch = async (input) => {
        if (String(input) === providerMetadataUri(domainConfig.issuer)) return Response.json({
          issuer: domainConfig.issuer, authorization_endpoint: domainConfig.authorizationEndpoint,
          token_endpoint: domainConfig.tokenEndpoint, jwks_uri: domainConfig.jwksUri,
          response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
        });
        if (String(input) === domainConfig.jwksUri) return Response.json({ keys: [domainJwk] });
        if (String(input) !== domainConfig.tokenEndpoint) throw new Error('Unexpected synthetic IdP endpoint');
        return Response.json({ id_token: await new SignJWT({ nonce: domainNonce, email: 'alice@fixture.test', email_verified: emailVerified })
          .setProtectedHeader({ alg: 'RS256', kid: 'domain-fixture-key' })
          .setIssuer(domainConfig.issuer).setAudience(domainConfig.clientId).setSubject('alice')
          .setIssuedAt().setExpirationTime('5m').sign(domainPrivateKey) });
      };
      const loginApp = express(), callbackApp = express();
      loginApp.use(createOidcHttpRouter({ config: domainConfig, integration: new OidcIntegration(domainConfig, a, domainIdp),
        applicationOrigin: 'http://127.0.0.1:39394', successPath: '/settings' }));
      callbackApp.use(createOidcHttpRouter({ config: domainConfig, integration: new OidcIntegration(domainConfig, aOther, domainIdp),
        applicationOrigin: 'http://127.0.0.1:39394', successPath: '/settings' }));
      const startDomainLogin = async () => {
        const response = await request(loginApp).get('/organizations/rls-a/login').set('Host', '127.0.0.1:39394');
        if (response.status === 302) domainNonce = new URL(response.headers.location).searchParams.get('nonce')!;
        return response;
      };
      const domainCallback = async (start: request.Response) => request(callbackApp)
        .get(`/enterprise/callback?code=synthetic&state=${new URL(start.headers.location).searchParams.get('state')}`)
        .set('Host', '127.0.0.1:39394').set('Cookie', start.headers['set-cookie'][0].split(';')[0]);
      const badDomainLogin = await startDomainLogin();
      expect(badDomainLogin.status).toBe(302);
      expect(new URL(badDomainLogin.headers.location).searchParams.get('scope')).toBe('openid email');
      expect((await domainCallback(badDomainLogin)).status).toBe(401);
      emailVerified = true;
      const goodDomainLogin = await startDomainLogin();
      const goodDomainCallback = await domainCallback(goodDomainLogin);
      expect(goodDomainCallback.status).toBe(303);
      const domainCookie = goodDomainCallback.headers['set-cookie'].find((value: string) => value.startsWith('interpreter-enterprise-session='))!;
      const boundToken = domainCookie.split(';')[0].split('=')[1]!;
      expect((await a.verifySession(boundToken))?.organizationId).toBe('rls-a');
      const boundOverview = () => request(appA).get('/api/enterprise/organizations/rls-a/overview')
        .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${boundToken}`);
      expect((await boundOverview()).status).toBe(200);
      const pendingRegistryOutage = await startDomainLogin();
      expect(pendingRegistryOutage.status).toBe(302);
      const registryGrant = (verb: 'REVOKE' | 'GRANT') => spawnSync('/usr/lib/postgresql/14/bin/psql',
        ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', process.env.ENTERPRISE_TEST_DB_FIXTURE!,
          '-p', String(process.env.ENTERPRISE_TEST_DB_PORT), '-d', 'enterprise_fixture',
          '-c', `${verb} SELECT ON public.interpreter_enterprise_rls_domain_claim ${verb === 'REVOKE' ? 'FROM' : 'TO'} enterprise_fixture_a`],
        { encoding: 'utf8' });
      expect(registryGrant('REVOKE').status).toBe(0);
      try {
        await expect(a.domainVerified('rls-a', 'https://issuer.invalid/a', 'fixture.test'))
          .rejects.toThrow(/permission denied/i);
        expect((await domainStatus(fresh.token)).status).toBe(503);
        expect((await startDomainLogin()).status).toBe(503);
        await expect(aOther.verifySession(boundToken)).rejects.toThrow(/permission denied/i);
        expect((await boundOverview()).status).toBe(503);
        const unavailableCallback = await domainCallback(pendingRegistryOutage);
        expect(unavailableCallback.status).toBe(401);
        expect((unavailableCallback.headers['set-cookie'] ?? []).join(';')).not.toContain('interpreter-enterprise-session=');
      } finally { expect(registryGrant('GRANT').status).toBe(0); }
      expect(await a.domainVerified('rls-a', 'https://issuer.invalid/a', 'fixture.test')).toBe(true);
      expect((await domainCallback(pendingRegistryOutage)).status).toBe(401); // Consumed one-time state cannot be replayed.
      // Only the disposable fixture operator can release a claim; a stale
      // verified lease in the directory must immediately lose authority.
      // Release the claim exactly after callback verification but before the
      // final session write. The write's own FOR SHARE guard must deny.
      const racingStore = new TenantPostgresDirectoryStore(otherA, 'rls-a', 'rls');
      let claimReleased = false;
      const racingBoundary: EnterpriseStateStore = {
        read: () => racingStore.read(), change: (fn, create) => racingStore.change(fn, create),
        domainClaimStatus: (org, issuer, domain) => racingStore.domainClaimStatus(org, issuer, domain),
        changeWithDomainClaim: (org, issuer, domain, fn) => {
          const released = spawnSync('/usr/lib/postgresql/14/bin/psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1',
            '-h', process.env.ENTERPRISE_TEST_DB_FIXTURE!, '-p', String(process.env.ENTERPRISE_TEST_DB_PORT),
            '-d', 'enterprise_fixture', '-c', `DELETE FROM public.interpreter_enterprise_rls_domain_claim
              WHERE domain = 'fixture.test'`], { encoding: 'utf8' });
          expect(released.status).toBe(0);
          claimReleased = true;
          return racingStore.changeWithDomainClaim(org, issuer, domain, fn);
        },
      };
      const racingCallback = express();
      racingCallback.use(createOidcHttpRouter({ config: domainConfig,
        integration: new OidcIntegration(domainConfig, new ServerDirectory(racingBoundary), domainIdp),
        applicationOrigin: 'http://127.0.0.1:39394', successPath: '/settings' }));
      const pendingRelease = await startDomainLogin();
      expect(pendingRelease.status).toBe(302);
      const afterRelease = await request(racingCallback)
        .get(`/enterprise/callback?code=synthetic&state=${new URL(pendingRelease.headers.location).searchParams.get('state')}`)
        .set('Host', '127.0.0.1:39394').set('Cookie', pendingRelease.headers['set-cookie'][0].split(';')[0]);
      expect(claimReleased).toBe(true);
      expect(afterRelease.status).toBe(401);
      expect((afterRelease.headers['set-cookie'] ?? []).join(';')).not.toContain('interpreter-enterprise-session=');
      expect(await a.domainVerified('rls-a', 'https://issuer.invalid/a', 'fixture.test')).toBe(false);
      expect(await aOther.verifySession(boundToken)).toBeNull();
      expect((await boundOverview()).status).toBe(403);
      expect((await domainStatus(fresh.token)).body.verifiedUntil).toBeNull();
      expect((await startDomainLogin()).status).toBe(503);
      // After operator release, another tenant takes the name only by
      // verifying it; the former holder can challenge but not re-verify.
      const transfer = await b.beginDomainProof(sessionB.identity, 'fixture.test');
      expect((await poolB.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
        WHERE domain = 'fixture.test'`)).rowCount).toBe(0);
      await rlsVerifier(poolB, 'rls-b', transfer.value).confirmDomainProof(sessionB.identity, 'fixture.test');
      const reclaim = await a.beginDomainProof(fresh.identity, 'fixture.test');
      await expect(rlsVerifier(otherA, 'rls-a', reclaim.value).confirmDomainProof(fresh.identity, 'fixture.test'))
        .rejects.toThrow('Access denied');
      expect(await a.domainVerified('rls-a', 'https://issuer.invalid/a', 'fixture.test')).toBe(false);
      expect(await b.domainVerified('rls-b', 'https://issuer.invalid/b', 'fixture.test')).toBe(true);
      expect((await poolA.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
        WHERE domain = 'fixture.test'`)).rowCount).toBe(0);
      expect((await poolB.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
        WHERE domain = 'fixture.test'`)).rowCount).toBe(1);
      expect((await poolB.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-a'])).rowCount).toBe(0);
      // Verification may finish before an operator releases the actor's
      // claim. The later admin write must acquire the claim lock itself.
      const actionChallenge = await a.beginDomainProof(fresh.identity, 'action.test');
      const actionProof = new ServerDirectory(new TenantPostgresDirectoryStore(otherA, 'rls-a', 'rls'),
        async () => [[actionChallenge.value]]);
      await actionProof.confirmDomainProof(fresh.identity, 'action.test');
      const actionSession = await a.createSession('https://issuer.invalid/a', 'rls-a', 'alice',
        Date.now() + 60_000, 0, 'action.test');
      const operationStore = new TenantPostgresDirectoryStore(otherA, 'rls-a', 'rls');
      let releasedDuringAction = false;
      const operationBoundary: EnterpriseStateStore = {
        read: () => operationStore.read(), change: (fn, create) => operationStore.change(fn, create),
        domainClaimStatus: (org, issuer, domain) => operationStore.domainClaimStatus(org, issuer, domain),
        changeWithDomainClaim: (org, issuer, domain, fn) => {
          const released = spawnSync('/usr/lib/postgresql/14/bin/psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1',
            '-h', process.env.ENTERPRISE_TEST_DB_FIXTURE!, '-p', String(process.env.ENTERPRISE_TEST_DB_PORT),
            '-d', 'enterprise_fixture', '-c', `DELETE FROM public.interpreter_enterprise_rls_domain_claim
              WHERE domain = 'action.test'`], { encoding: 'utf8' });
          expect(released.status).toBe(0);
          releasedDuringAction = true;
          return operationStore.changeWithDomainClaim(org, issuer, domain, fn);
        },
      };
      const actionDirectory = new ServerDirectory(operationBoundary);
      const actionApp = express();
      expect(mountEnterpriseAdminRoutes(actionApp, { enabled: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'rls-a', issuer: 'https://issuer.invalid/a',
        directory: actionDirectory, verifySession: (token) => aOther.verifySession(token) })).toBe(true);
      const actionResponse = await request(actionApp)
        .post('/api/enterprise/organizations/rls-a/members/worker/deactivate')
        .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
        .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
        .set('Cookie', `interpreter-enterprise-session=${actionSession.token}`).send({});
      expect(releasedDuringAction).toBe(true);
      expect(actionResponse.status).toBe(503);
      expect((await a.getMember('rls-a', 'worker'))?.active).toBe(true);
      expect(await aOther.verifySession(actionSession.token)).toBeNull();
      const pending = { organizationId: 'rls-a', issuer: 'https://issuer.invalid/a', nonce: 'synthetic',
        verifier: 'synthetic', bindingHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000 };
      const attemptsA = async () => Object.values(JSON.parse((await poolA.query(
        `SELECT content FROM public.interpreter_enterprise_rls_directory WHERE organization_id = 'rls-a'`)).rows[0]!.content).attempts) as
        Array<{ expiresAt: number; clientHash: string }>;
      for (let i = 0; i <= MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT; i++) {
        await (i % 2 ? aOther : a).putAttempt(`quota-${i}`, { ...pending, expiresAt: pending.expiresAt + i }, '198.51.100.7');
      }
      // A full client allowance evicts that client's own oldest attempt across hosts; nothing is refused.
      const quotaClient = (await attemptsA()).find((attempt) => attempt.expiresAt === pending.expiresAt + 1)!.clientHash;
      expect((await attemptsA()).filter((attempt) => attempt.clientHash === quotaClient)).toHaveLength(MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT);
      expect((await attemptsA()).some((attempt) => attempt.clientHash === quotaClient && attempt.expiresAt === pending.expiresAt)).toBe(false);
      await aOther.putAttempt('other-client-not-starved', pending, '203.0.113.9');
      expect((await attemptsA()).filter((attempt) => attempt.clientHash !== quotaClient &&
        attempt.expiresAt === pending.expiresAt)).toHaveLength(1);
      await b.putAttempt('tenant-b-not-starved', { ...pending, organizationId: 'rls-b', issuer: 'https://issuer.invalid/b' });
      expect((await b.takeAttempt('tenant-b-not-starved', 'wrong'))).toBeNull();
      // The fixture operator can simulate loss of one audit record. The app
      // role cannot delete it, and the next locked authorization must deny.
      const tamper = spawnSync('/usr/lib/postgresql/14/bin/psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1',
        '-h', process.env.ENTERPRISE_TEST_DB_FIXTURE!, '-p', String(process.env.ENTERPRISE_TEST_DB_PORT),
        '-d', 'enterprise_fixture', '-c', `DELETE FROM public.interpreter_enterprise_rls_audit
          WHERE id = (SELECT min(id) FROM public.interpreter_enterprise_rls_audit WHERE organization_id = 'rls-a')`], { encoding: 'utf8' });
      expect(tamper.status).toBe(0);
      await expect(aOther.verifySession(fresh.token)).rejects.toThrow('audit ledger is out of sync');
      expect((await domainStatus(fresh.token)).status).toBe(503);
      const damagedApp = express();
      expect(mountEnterpriseAdminRoutes(damagedApp, { enabled: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'rls-a', issuer: 'https://issuer.invalid/a',
        directory: aOther, verifySession: (token) => aOther.verifySession(token) })).toBe(true);
      const damagedHttp = damagedApp.listen(0, '127.0.0.1');
      try {
        expect((await request(damagedHttp).get('/api/enterprise/organizations/rls-a/overview')
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${fresh.token}`)).status).toBe(503);
      } finally { damagedHttp.close(); }
      await expect(aOther.revokeSession(fresh.identity)).rejects.toThrow('audit ledger is out of sync');
      expect((await b.verifySession(sessionB.token))?.organizationId).toBe('rls-b');
      const beforeRewrite = (await poolB.query('SELECT id FROM public.interpreter_enterprise_rls_audit')).rowCount;
      // A privileged fixture operator rewrites an event but leaves the row
      // count unchanged. The app role cannot do this; both reads and the HTTP
      // boundary must still detect the changed ordered ledger content.
      const rewrite = spawnSync('/usr/lib/postgresql/14/bin/psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1',
        '-h', process.env.ENTERPRISE_TEST_DB_FIXTURE!, '-p', String(process.env.ENTERPRISE_TEST_DB_PORT),
        '-d', 'enterprise_fixture', '-c', `UPDATE public.interpreter_enterprise_rls_audit
          SET content = replace(content, '"action":', '"action":"forged-history","priorAction":')
          WHERE id = (SELECT min(id) FROM public.interpreter_enterprise_rls_audit WHERE organization_id = 'rls-b')`], { encoding: 'utf8' });
      expect(rewrite.status).toBe(0);
      expect((await poolB.query('SELECT count(*)::int AS count FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-b']))
        .rows[0]?.count).toBe(beforeRewrite);
      await expect(b.verifySession(sessionB.token)).rejects.toThrow('audit ledger is out of sync');
      const rewrittenApp = express();
      expect(mountEnterpriseAdminRoutes(rewrittenApp, { enabled: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'rls-b', issuer: 'https://issuer.invalid/b',
        directory: b, verifySession: (token) => b.verifySession(token) })).toBe(true);
      const rewrittenHttp = rewrittenApp.listen(0, '127.0.0.1');
      try {
        expect((await request(rewrittenHttp).get('/api/enterprise/organizations/rls-b/activity/export')
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${sessionB.token}`)).status).toBe(503);
      } finally { rewrittenHttp.close(); }
    } finally { await poolA.end(); await otherA.end(); await poolB.end(); }
  }, 90_000);
  it('keeps two pinned tenant rows separate across TLS pools and fails closed on cross-row state', async () => {
    const config = { host: '127.0.0.1', port: Number(process.env.ENTERPRISE_TEST_DB_PORT), database: 'enterprise_fixture',
      user: 'enterprise_fixture', password: process.env.ENTERPRISE_TEST_DB_PASSWORD!,
      caCertificate: readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, 'utf8') };
    const first = createEnterprisePostgresPool(config), second = createEnterprisePostgresPool(config);
    try {
      const a = new ServerDirectory(new TenantPostgresDirectoryStore(first, 'row-a'));
      const aOther = new ServerDirectory(new TenantPostgresDirectoryStore(second, 'row-a'));
      const b = new ServerDirectory(new TenantPostgresDirectoryStore(second, 'row-b'));
      await expect(a.getMember('row-a', 'alice')).rejects.toThrow('unavailable'); // No implicit row on read.
      await expect(new TenantPostgresDirectoryStore(first, 'row-a').change(() => {}, true))
        .rejects.toThrow('not bootstrapped'); // A blank row cannot survive an explicit create transaction.
      await expect(a.bootstrap('row-b', 'Wrong tenant', 'https://issuer.invalid/b',
        { organizationId: 'row-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true }))
        .rejects.toThrow('Cross-tenant directory state');
      expect((await first.query('SELECT content FROM interpreter_enterprise_tenant_directory WHERE organization_id = $1', ['row-a'])).rowCount).toBe(0);
      await a.bootstrap('row-a', 'Alpha', 'https://issuer.invalid/a',
        { organizationId: 'row-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
      await b.bootstrap('row-b', 'Beta', 'https://issuer.invalid/b',
        { organizationId: 'row-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
      const sessionA = await a.createSession('https://issuer.invalid/a', 'row-a', 'alice', Date.now() + 60_000);
      const sessionB = await b.createSession('https://issuer.invalid/b', 'row-b', 'bob', Date.now() + 60_000);
      const origin = 'http://127.0.0.1:39394';
      const appA = express(), appB = express();
      expect(mountEnterpriseAdminRoutes(appA, { enabled: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'row-a', issuer: 'https://issuer.invalid/a',
        directory: aOther, verifySession: (token) => aOther.verifySession(token) })).toBe(true);
      expect(mountEnterpriseAdminRoutes(appB, { enabled: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'row-b', issuer: 'https://issuer.invalid/b',
        directory: b, verifySession: (token) => b.verifySession(token) })).toBe(true);
      const httpA = appA.listen(0, '127.0.0.1'), httpB = appB.listen(0, '127.0.0.1');
      try {
        const read = (server: typeof httpA, tenant: string, token: string) => request(server)
          .get(`/api/enterprise/organizations/${tenant}/overview`)
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
        expect((await read(httpA, 'row-a', sessionA.token)).status).toBe(200);
        expect((await read(httpA, 'row-b', sessionB.token)).status).toBe(403);
        expect((await read(httpB, 'row-b', sessionB.token)).status).toBe(200);
        expect((await read(httpB, 'row-a', sessionA.token)).status).toBe(403);
      } finally { httpA.close(); httpB.close(); }
      expect((await aOther.verifySession(sessionA.token))?.organizationId).toBe('row-a');
      expect(await b.verifySession(sessionA.token)).toBeNull();
      expect(await aOther.verifySession(sessionB.token)).toBeNull();
      expect(await aOther.readAdmin(sessionB.identity, 'members')).toBeNull();
      expect((await b.auditSummary('row-b')).eventCount).toBe(3); // Only its own successful HTTP read was appended.
      await aOther.revokeSession(sessionA.identity);
      expect(await a.verifySession(sessionA.token)).toBeNull();
      expect((await b.verifySession(sessionB.token))?.organizationId).toBe('row-b');
      const storedA = await first.query('SELECT content FROM interpreter_enterprise_tenant_directory WHERE organization_id = $1', ['row-a']);
      const storedB = await second.query('SELECT content FROM interpreter_enterprise_tenant_directory WHERE organization_id = $1', ['row-b']);
      expect(storedA.rows[0]?.content).not.toContain(sessionA.token);
      expect(storedB.rows[0]?.content).not.toContain(sessionB.token);
      expect(storedA.rows[0]?.content).not.toContain('row-b');
      expect(storedB.rows[0]?.content).not.toContain('row-a');
      // Simulate operator-side row tampering in this disposable database: a
      // wrongly copied tenant snapshot must not become an authority for A.
      await first.query('UPDATE interpreter_enterprise_tenant_directory SET content = $1 WHERE organization_id = $2',
        [storedB.rows[0]?.content, 'row-a']);
      await expect(a.getMember('row-a', 'alice')).rejects.toThrow('Cross-tenant directory state');
      expect((await b.verifySession(sessionB.token))?.organizationId).toBe('row-b');
      await first.query('UPDATE interpreter_enterprise_tenant_directory SET content = $1 WHERE organization_id = $2',
        [storedA.rows[0]?.content, 'row-a']);
      expect(await a.verifySession(sessionA.token)).toBeNull();
    } finally { await first.end(); await second.end(); }
  });
  it('exchanges OIDC code with a CA-pinned loopback HTTPS IdP and denies metadata drift across hosts', async () => {
    const ca = readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, 'utf8');
    const tls = { key: readFileSync(`${process.env.ENTERPRISE_TEST_DB_FIXTURE}/server.key`),
      cert: readFileSync(`${process.env.ENTERPRISE_TEST_DB_FIXTURE}/server.pem`) };
    const database = { host: '127.0.0.1', port: Number(process.env.ENTERPRISE_TEST_DB_PORT), database: 'enterprise_fixture',
      user: 'enterprise_fixture_network', password: process.env.ENTERPRISE_TEST_DB_PASSWORD_NETWORK!, caCertificate: ca };
    const first = createEnterprisePostgresPool(database), second = createEnterprisePostgresPool(database);
    const idp = express();
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'network-fixture-key', alg: 'RS256', use: 'sig' };
    let issuer = '';
    let nonce = '';
    let challenge = '';
    let expectedRedirectUri = '';
    let metadataIssuerOverride = '';
    let tokenRequests = 0;
    const opaqueSubject = 'opaque\u0000admin|network';
    const syntheticSecret = 'synthetic only/fixture';
    idp.get('/tenant/.well-known/openid-configuration', (_req, res) => res.json({
      issuer: metadataIssuerOverride || issuer,
      authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`,
      response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
    }));
    idp.get('/tenant/keys', (_req, res) => res.json({ keys: [jwk] }));
    idp.post('/tenant/token', express.urlencoded({ extended: false }), async (req, res) => {
      tokenRequests++;
      if (req.get('authorization') !== 'Basic ' + Buffer.from('network-fixture-client:synthetic+only%2Ffixture').toString('base64') ||
          req.body.client_secret || req.body.client_id || req.body.code !== 'network-code' || req.body.grant_type !== 'authorization_code' ||
          req.body.redirect_uri !== expectedRedirectUri ||
          createHash('sha256').update(req.body.code_verifier ?? '').digest('base64url') !== challenge) {
        return void res.status(400).end();
      }
      const idToken = await new SignJWT({ nonce, email: 'alice@network.test', email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: 'network-fixture-key' })
        .setIssuer(issuer).setAudience('network-fixture-client').setSubject(opaqueSubject)
        .setIssuedAt().setExpirationTime('5m').sign(privateKey);
      return void res.json({ id_token: idToken });
    });
    const idpServer = createHttpsServer(tls, idp);
    await new Promise<void>((resolve) => idpServer.listen(0, '127.0.0.1', resolve));
    try {
      const idpAddress = idpServer.address();
      if (!idpAddress || typeof idpAddress === 'string') throw new Error('Missing IdP TLS port');
      issuer = `https://127.0.0.1:${idpAddress.port}/tenant`;
      await expect(new Promise((resolve, reject) => {
        const req = httpsRequest(providerMetadataUri(issuer), {
          ca: readFileSync(`${process.env.ENTERPRISE_TEST_DB_FIXTURE}/untrusted-ca.pem`, 'utf8'),
          rejectUnauthorized: true }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      })).rejects.toThrow(/certificate|verify|self.signed/i);
      // This fixture transport pins the ephemeral CA and accepts only the local
      // issuer origin. Unlike a fetch mock, metadata, token and JWKS use TLS IO.
      const pinnedFetch: typeof fetch = async (input, init) => {
        const target = new URL(String(input));
        if (target.origin !== new URL(issuer).origin) throw new Error('Unexpected IdP origin');
        return new Promise<Response>((resolve, reject) => {
          const req = httpsRequest(target, { method: init?.method ?? 'GET',
            headers: init?.headers as Record<string, string> | undefined, ca, rejectUnauthorized: true }, (res) => {
            if ((res.statusCode ?? 0) >= 300 && init?.redirect === 'error') { res.resume(); reject(new Error('IdP redirect')); return; }
            const chunks: Buffer[] = [];
            res.on('data', (part: Buffer) => chunks.push(part));
            res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
              status: res.statusCode, headers: { 'Content-Type': res.headers['content-type'] ?? 'application/octet-stream' },
            })));
            res.on('error', reject);
          });
          req.on('error', reject);
          if (init?.signal) {
            if (init.signal.aborted) req.destroy(new Error('IdP request aborted'));
            else init.signal.addEventListener('abort', () => req.destroy(new Error('IdP request aborted')), { once: true });
          }
          req.end(init?.body instanceof URLSearchParams ? init.body.toString() : undefined);
        });
      };
      const directory = new ServerDirectory(new TenantPostgresDirectoryStore(first, 'network-org', 'rls'));
      const verifier = new ServerDirectory(new TenantPostgresDirectoryStore(second, 'network-org', 'rls'));
      await directory.bootstrap('network-org', 'Network organization', issuer,
        { organizationId: 'network-org', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
      const setup = await directory.createSession(issuer, 'network-org', 'alice', Date.now() + 60_000);
      await directory.setMember(setup.identity, { organizationId: 'network-org', subject: opaqueSubject,
        displayName: 'Synthetic OIDC admin', role: 'admin', active: true });
      const domainChallenge = await directory.beginDomainProof(setup.identity, 'network.test');
      await new ServerDirectory(new TenantPostgresDirectoryStore(second, 'network-org', 'rls'),
        async () => [[domainChallenge.value]]).confirmDomainProof(setup.identity, 'network.test');
      const app = express();
      const callbackServer = createHttpsServer(tls, app);
      await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
      try {
        const callbackAddress = callbackServer.address();
        if (!callbackAddress || typeof callbackAddress === 'string') throw new Error('Missing callback TLS port');
        const origin = `https://127.0.0.1:${callbackAddress.port}`;
        const config: OidcConfiguration = { organizationId: 'network-org', issuer, clientId: 'network-fixture-client',
          tokenEndpointAuthMethod: 'client_secret_basic', clientSecret: syntheticSecret,
          authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/keys`,
          redirectUri: `${origin}/enterprise/callback`, accountDomain: 'network.test' };
        expectedRedirectUri = config.redirectUri;
        app.use(createOidcHttpRouter({ config, integration: new OidcIntegration(config, directory, pinnedFetch),
          applicationOrigin: origin, successPath: '/settings' }));
        expect(mountEnterpriseAdminRoutes(app, { enabled: true, applicationOrigin: origin, organizationId: 'network-org', issuer,
          accountDomain: 'network.test', oidc: config,
          directory: verifier, verifySession: (token) => verifier.verifySession(token) })).toBe(true);
        const call = (path: string, cookie?: string) => new Promise<{ status: number; cookies: string[]; location?: string }>((resolve, reject) => {
          const req = httpsRequest({ hostname: '127.0.0.1', port: callbackAddress.port, path,
            headers: cookie ? { Cookie: cookie } : {}, ca, rejectUnauthorized: true }, (res) => {
            res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0,
              cookies: res.headers['set-cookie'] ?? [], location: res.headers.location }));
          });
          req.on('error', reject); req.end();
        });
        metadataIssuerOverride = `${issuer}-wrong`;
        expect((await call('/organizations/network-org/login')).status).toBe(503);
        expect(tokenRequests).toBe(0);
        metadataIssuerOverride = '';
        const started = await call('/organizations/network-org/login');
        expect(started.status).toBe(302);
        const authorization = new URL(started.location!);
        expect(authorization.origin).toBe(new URL(issuer).origin);
        nonce = authorization.searchParams.get('nonce')!;
        challenge = authorization.searchParams.get('code_challenge')!;
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        const state = authorization.searchParams.get('state')!;
        const binding = started.cookies.find((value) => value.startsWith('__Host-interpreter-oidc-binding='))!.split(';')[0];
        metadataIssuerOverride = `${issuer}-wrong`;
        expect((await call(`/enterprise/callback?code=network-code&state=${state}`, binding)).status).toBe(401);
        expect(tokenRequests).toBe(0);
        metadataIssuerOverride = '';
        expect((await call(`/enterprise/callback?code=network-code&state=${state}`, binding)).status).toBe(401);
        const retry = await call('/organizations/network-org/login');
        expect(retry.status).toBe(302);
        const next = new URL(retry.location!);
        nonce = next.searchParams.get('nonce')!;
        challenge = next.searchParams.get('code_challenge')!;
        const secondBinding = retry.cookies.find((value) => value.startsWith('__Host-interpreter-oidc-binding='))!.split(';')[0];
        const finished = await call(`/enterprise/callback?code=network-code&state=${next.searchParams.get('state')}`, secondBinding);
        expect(finished.status).toBe(303);
        expect(tokenRequests).toBe(1);
        const session = finished.cookies.find((value) => value.startsWith('__Host-interpreter-enterprise-session='))!.split(';')[0];
        expect((await call('/api/enterprise/organizations/network-org/overview', session)).status).toBe(200);
        expect((await call('/api/enterprise/organizations/foreign-org/overview', session)).status).toBe(403);
        await directory.deactivateMember(setup.identity, opaqueSubject);
        expect((await call('/api/enterprise/organizations/network-org/overview', session)).status).toBe(403);
        const persisted = await second.query(`SELECT content FROM public.interpreter_enterprise_rls_directory
          WHERE organization_id = 'network-org'`);
        expect(persisted.rows[0]?.content).not.toContain(session.split('=')[1]!);
      } finally { await new Promise<void>((resolve) => callbackServer.close(() => resolve())); }
    } finally {
      await new Promise<void>((resolve) => idpServer.close(() => resolve()));
      await first.end(); await second.end();
    }
  });
  it('binds mock OIDC callback to tenant, one-time browser state and a second TLS-backed admin host', async () => {
    const database = { host: '127.0.0.1', port: Number(process.env.ENTERPRISE_TEST_DB_PORT), database: 'enterprise_fixture',
      user: 'enterprise_fixture', password: process.env.ENTERPRISE_TEST_DB_PASSWORD!,
      caCertificate: readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, 'utf8') };
    const first = createEnterprisePostgresPool(database), second = createEnterprisePostgresPool(database);
    try {
      const loginStore = new ServerDirectory(new PostgresDirectoryStore(first));
      const adminStore = new ServerDirectory(new PostgresDirectoryStore(second));
      const origin = 'http://127.0.0.1:39394';
      const config: OidcConfiguration = {
        organizationId: 'oidc-a', issuer: 'http://127.0.0.1:39393/issuer-a', clientId: 'synthetic-client',
        authorizationEndpoint: 'http://127.0.0.1:39393/issuer-a/authorize',
        tokenEndpoint: 'http://127.0.0.1:39393/issuer-a/token',
        jwksUri: 'http://127.0.0.1:39393/issuer-a/keys',
        redirectUri: `${origin}/enterprise/callback`, allowInsecureLoopbackForTests: true,
      };
      await loginStore.bootstrap('oidc-a', 'OIDC Alpha', config.issuer,
        { organizationId: 'oidc-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
      await loginStore.bootstrap('oidc-b', 'OIDC Beta', 'http://127.0.0.1:39393/issuer-b',
        { organizationId: 'oidc-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
      let expectedNonce = '';
      let expectedChallenge = '';
      let tokenRequests = 0;
      const syntheticIdp: typeof fetch = async (input, init) => {
        if (String(input) === providerMetadataUri(config.issuer)) return Response.json({ issuer: config.issuer,
          authorization_endpoint: config.authorizationEndpoint, token_endpoint: config.tokenEndpoint, jwks_uri: config.jwksUri,
          response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
        if (String(input) === config.jwksUri) return Response.json({ keys: [jwk] });
        if (String(input) !== config.tokenEndpoint || init?.method !== 'POST' || init.redirect !== 'error') throw new Error('Unexpected IdP request');
        tokenRequests++;
        const form = new URLSearchParams(init.body as URLSearchParams);
        expect(form.get('code')).toBe('fixture-code');
        expect(form.get('redirect_uri')).toBe(config.redirectUri);
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(expectedChallenge);
        const idToken = await new SignJWT({ nonce: expectedNonce }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
          .setIssuer(config.issuer).setAudience(config.clientId).setSubject('alice')
          .setIssuedAt().setExpirationTime('5m').sign(privateKey);
        return Response.json({ id_token: idToken });
      };
      const app = express();
      app.use(createOidcHttpRouter({ config, integration: new OidcIntegration(config, loginStore, syntheticIdp),
        applicationOrigin: origin, successPath: '/settings' }));
      expect(mountEnterpriseAdminRoutes(app, { enabled: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'oidc-a', issuer: config.issuer,
        directory: adminStore, verifySession: (token) => adminStore.verifySession(token) })).toBe(true);
      const http = app.listen(0, '127.0.0.1');
      try {
        const begin = async () => {
          const response = await request(http).get('/organizations/oidc-a/login').set('Host', '127.0.0.1:39394');
          expect(response.status).toBe(302);
          const authorization = new URL(response.headers.location);
          expectedNonce = authorization.searchParams.get('nonce')!;
          expectedChallenge = authorization.searchParams.get('code_challenge')!;
          expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
          return { state: authorization.searchParams.get('state')!,
            cookie: response.headers['set-cookie'][0].split(';')[0] };
        };
        expect((await request(http).get('/organizations/oidc-b/login').set('Host', '127.0.0.1:39394')).status).toBe(403);
        const rejected = await begin();
        const callback = (state: string, binding: string) => request(http).get(`/enterprise/callback?code=fixture-code&state=${state}`)
          .set('Host', '127.0.0.1:39394').set('Cookie', binding);
        expect((await callback(rejected.state, `interpreter-oidc-binding=${'x'.repeat(43)}`)).status).toBe(401);
        expect((await callback(`${'d'.repeat(43)}`, rejected.cookie)).status).toBe(401); // Unknown state, genuine cookie.
        expect(tokenRequests).toBe(0); // A wrong binding is rejected by a read and leaves the attempt unused.
        const valid = await begin();
        const completed = await callback(valid.state, valid.cookie);
        expect(completed.status).toBe(303);
        expect(completed.headers.location).toBe('/settings');
        expect(tokenRequests).toBe(1);
        const sessionCookie = completed.headers['set-cookie'].find((value: string) => value.startsWith('interpreter-enterprise-session='))!.split(';')[0];
        const opaque = sessionCookie.split('=')[1]!;
        expect(opaque).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const read = (tenant: string) => request(http).get(`/api/enterprise/organizations/${tenant}/overview`)
          .set('Host', '127.0.0.1:39394').set('Cookie', sessionCookie);
        expect((await read('oidc-a')).status).toBe(200);
        expect((await read('oidc-b')).status).toBe(403);
        const activity = await request(http).get('/api/enterprise/organizations/oidc-a/activity')
          .set('Host', '127.0.0.1:39394').set('Cookie', sessionCookie);
        expect(activity.status).toBe(200);
        expect(activity.body.organizationId).toBe('oidc-a');
        expect(activity.body.events.every((event: { organizationId: string }) => event.organizationId === 'oidc-a')).toBe(true);
        expect((await request(http).get('/api/enterprise/organizations/oidc-b/activity')
          .set('Host', '127.0.0.1:39394').set('Cookie', sessionCookie)).status).toBe(403);
        expect((await callback(valid.state, valid.cookie)).status).toBe(401);
        expect(tokenRequests).toBe(1);
        const persisted = await first.query('SELECT content FROM interpreter_enterprise_directory WHERE id = 1');
        expect(persisted.rows[0]?.content).not.toContain(opaque);
        const logout = await request(http).post('/api/enterprise/organizations/oidc-a/session/logout')
          .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
          .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
          .set('Cookie', sessionCookie).send({});
        expect(logout.status).toBe(204);
        expect(await loginStore.verifySession(opaque)).toBeNull();
        expect((await read('oidc-a')).status).toBe(403);
        expect((await request(http).get('/api/enterprise/organizations/oidc-a/activity')
          .set('Host', '127.0.0.1:39394').set('Cookie', sessionCookie)).status).toBe(403);
        expect((await adminStore.auditSummary('oidc-b')).eventCount).toBe(1); // Foreign reads do not write its ledger.
        // The global singleton (unlike independent tenant RLS rows) can
        // serialize a synthetic domain claim against both organizations.
        const aFresh = await loginStore.createSession(config.issuer, 'oidc-a', 'alice', Date.now() + 60_000);
        const bFresh = await adminStore.createSession('http://127.0.0.1:39393/issuer-b', 'oidc-b', 'bob', Date.now() + 60_000);
        const challenge = await loginStore.beginDomainProof(aFresh.identity, 'shared.test');
        const verifier = new ServerDirectory(new PostgresDirectoryStore(second), async () => [[challenge.value]]);
        await verifier.confirmDomainProof(aFresh.identity, 'shared.test');
        const contested = await adminStore.beginDomainProof(bFresh.identity, 'shared.test'); // Reserves nothing.
        await expect(new ServerDirectory(new PostgresDirectoryStore(first), async () => [[contested.value]])
          .confirmDomainProof(bFresh.identity, 'shared.test')).rejects.toThrow('Access denied');
        expect(await verifier.domainVerified('oidc-a', config.issuer, 'shared.test')).toBe(true);
        expect(await verifier.domainVerified('oidc-b', 'http://127.0.0.1:39393/issuer-b', 'shared.test')).toBe(false);
      } finally { http.close(); }
    } finally { await first.end(); await second.end(); }
  });
  it('rejects untrusted CA and plaintext before any tenant bootstrap', async () => {
    const base = { host: '127.0.0.1', port: Number(process.env.ENTERPRISE_TEST_DB_PORT), database: 'enterprise_fixture',
      user: 'enterprise_fixture', password: process.env.ENTERPRISE_TEST_DB_PASSWORD!, caCertificate: readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, 'utf8') };
    const wrong = createEnterprisePostgresPool({ ...base,
      caCertificate: readFileSync(`${process.env.ENTERPRISE_TEST_DB_FIXTURE}/untrusted-ca.pem`, 'utf8') });
    try { await expect(wrong.query('SELECT 1')).rejects.toThrow(/certificate|verify|self.signed/i); } finally { await wrong.end(); }
    const plaintext = new pg.Client({ host: base.host, port: base.port, database: base.database, user: base.user,
      password: base.password, ssl: false, connectionTimeoutMillis: 1500 });
    try { await expect(plaintext.connect()).rejects.toThrow(); } finally { await plaintext.end().catch(() => {}); }
  });

  it('accepts only direct CA-verified HTTPS with secure host-only OIDC and session cookies', async () => {
    const ca = readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, 'utf8');
    const database = { host: '127.0.0.1', port: Number(process.env.ENTERPRISE_TEST_DB_PORT), database: 'enterprise_fixture',
      user: 'enterprise_fixture_https', password: process.env.ENTERPRISE_TEST_DB_PASSWORD_HTTPS!, caCertificate: ca };
    const first = createEnterprisePostgresPool(database), second = createEnterprisePostgresPool(database);
    try {
      const directory = new ServerDirectory(new TenantPostgresDirectoryStore(first, 'https-org', 'rls'));
      const verifier = new ServerDirectory(new TenantPostgresDirectoryStore(second, 'https-org', 'rls'));
      const issuer = 'https://synthetic-idp.invalid/tenant';
      await directory.bootstrap('https-org', 'HTTPS organization', issuer,
        { organizationId: 'https-org', subject: 'admin', displayName: 'Admin', role: 'admin', active: true });
      const setup = await directory.createSession(issuer, 'https-org', 'admin', Date.now() + 60_000);
      const challenge = await directory.beginDomainProof(setup.identity, 'https.test');
      await new ServerDirectory(new TenantPostgresDirectoryStore(second, 'https-org', 'rls'),
        async () => [[challenge.value]]).confirmDomainProof(setup.identity, 'https.test');
      const otherChallenge = await directory.beginDomainProof(setup.identity, 'secondary.test');
      await new ServerDirectory(new TenantPostgresDirectoryStore(second, 'https-org', 'rls'),
        async () => [[otherChallenge.value]]).confirmDomainProof(setup.identity, 'secondary.test');
      const wrongDomain = await directory.createSession(issuer, 'https-org', 'admin', Date.now() + 60_000,
        0, 'secondary.test');
      const app = express();
      let observedOrigin: { host: string | undefined; encrypted: boolean } | null = null;
      app.use((req, _res, next) => {
        observedOrigin = { host: req.get('host'), encrypted: (req.socket as TLSSocket).encrypted === true };
        next();
      });
      const server = createHttpsServer({ key: readFileSync(`${process.env.ENTERPRISE_TEST_DB_FIXTURE}/server.key`),
        cert: readFileSync(`${process.env.ENTERPRISE_TEST_DB_FIXTURE}/server.pem`) }, app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing local TLS port');
        const origin = `https://127.0.0.1:${address.port}`;
        const config: OidcConfiguration = { organizationId: 'https-org', issuer, clientId: 'https-fixture',
          authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/keys`,
          redirectUri: `${origin}/enterprise/callback`, accountDomain: 'https.test' };
        const { publicKey, privateKey } = await generateKeyPair('RS256');
        const jwk = { ...await exportJWK(publicKey), kid: 'https-fixture-key', alg: 'RS256', use: 'sig' };
        let nonce = '';
        let tokenRequests = 0;
        const idp: typeof fetch = async (input, init) => {
          if (String(input) === providerMetadataUri(config.issuer)) return Response.json({ issuer: config.issuer,
            authorization_endpoint: config.authorizationEndpoint, token_endpoint: config.tokenEndpoint, jwks_uri: config.jwksUri,
            response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
          if (String(input) === config.jwksUri) return Response.json({ keys: [jwk] });
          if (String(input) !== config.tokenEndpoint || init?.method !== 'POST') throw new Error('Unexpected IdP request');
          tokenRequests++;
          const token = await new SignJWT({ nonce, email: 'admin@https.test', email_verified: true })
            .setProtectedHeader({ alg: 'RS256', kid: 'https-fixture-key' })
            .setIssuer(issuer).setAudience(config.clientId).setSubject('admin')
            .setIssuedAt().setExpirationTime('5m').sign(privateKey);
          return Response.json({ id_token: token });
        };
        app.use(createOidcHttpRouter({ config, integration: new OidcIntegration(config, directory, idp),
          applicationOrigin: origin, successPath: '/settings' }));
        const adminOptions = { enabled: true as const, applicationOrigin: origin,
          organizationId: 'https-org', issuer, accountDomain: 'https.test', oidc: config, directory: verifier,
          // A permissive supplied verifier cannot authorize an unbound
          // operator session through a production HTTPS composition.
          verifySession: async () => setup.identity };
        expect(mountEnterpriseAdminRoutes(app, adminOptions)).toBe(true);
        adminOptions.accountDomain = 'secondary.test'; // A mutable caller cannot retarget handlers after composition.
        const viaTLS = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string; ca?: string } = {}) =>
          new Promise<{ status: number; cookies: string[]; location?: string }>((resolve, reject) => {
            const req = httpsRequest({ hostname: '127.0.0.1', port: address.port, path,
              method: options.method ?? 'GET', headers: options.headers, ca: options.ca ?? ca,
              rejectUnauthorized: true }, (res) => {
              res.resume();
              res.on('end', () => resolve({ status: res.statusCode ?? 0,
                cookies: res.headers['set-cookie'] ?? [], location: res.headers.location }));
            });
            req.on('error', reject);
            req.end(options.body);
          });
        await expect(viaTLS('/organizations/https-org/login', { ca: readFileSync(`${process.env.ENTERPRISE_TEST_DB_FIXTURE}/untrusted-ca.pem`, 'utf8') }))
          .rejects.toThrow(/certificate|verify|self.signed/i);
        expect((await viaTLS('/api/enterprise/organizations/https-org/overview', { headers: {
          Cookie: `__Host-interpreter-enterprise-session=${setup.token}` } })).status).toBe(403);
        expect((await viaTLS('/api/enterprise/organizations/https-org/overview', { headers: {
          Cookie: `__Host-interpreter-enterprise-session=${wrongDomain.token}` } })).status).toBe(403);
        const started = await viaTLS('/organizations/https-org/login');
        expect(observedOrigin).toEqual({ host: new URL(origin).host, encrypted: true });
        expect(started.status).toBe(302);
        const binding = started.cookies.find((value) => value.startsWith('__Host-interpreter-oidc-binding='))!;
        expect(binding).toContain('HttpOnly');
        expect(binding).toContain('Secure');
        nonce = new URL(started.location!).searchParams.get('nonce')!;
        const state = new URL(started.location!).searchParams.get('state')!;
        const foreignTarget = await viaTLS(`https://untrusted.invalid/enterprise/callback?code=synthetic-code&state=${state}`, {
          headers: { Cookie: binding.split(';')[0] } });
        expect(foreignTarget.status).toBe(400);
        expect(foreignTarget.cookies).toEqual([]);
        expect(tokenRequests).toBe(0);
        const callback = await viaTLS(`/enterprise/callback?code=synthetic-code&state=${state}`, {
          headers: { Cookie: binding.split(';')[0] } });
        expect(callback.status).toBe(303);
        expect(tokenRequests).toBe(1);
        const session = callback.cookies.find((value) => value.startsWith('__Host-interpreter-enterprise-session='))!;
        expect(session).toContain('HttpOnly');
        expect(session).toContain('Secure');
        const cookie = session.split(';')[0];
        expect((await viaTLS('/api/enterprise/organizations/https-org/overview', { headers: { Cookie: cookie } })).status).toBe(200);
        expect((await viaTLS('/api/enterprise/organizations/https-org/activity', { headers: { Cookie: cookie } })).status).toBe(200);
        expect((await viaTLS('/api/enterprise/organizations/other-org/overview', { headers: { Cookie: cookie } })).status).toBe(403);
        expect((await viaTLS('/api/enterprise/organizations/other-org/activity', { headers: { Cookie: cookie } })).status).toBe(403);
        expect((await viaTLS('/api/enterprise/organizations/https-org/overview',
          { headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' } })).status).toBe(403);
        const logoutPath = '/api/enterprise/organizations/https-org/session/logout';
        const logoutHeaders = { Cookie: cookie, Origin: origin, 'Sec-Fetch-Site': 'same-origin',
          'X-Interpreter-CSRF': '1', 'Content-Type': 'application/json' };
        expect((await viaTLS(logoutPath, { method: 'POST', headers: { ...logoutHeaders, Origin: 'https://untrusted.invalid' }, body: '{}' })).status).toBe(403);
        const loggedOut = await viaTLS(logoutPath, { method: 'POST', headers: logoutHeaders, body: '{}' });
        expect(loggedOut.status).toBe(204);
        expect(loggedOut.cookies[0]).toContain('__Host-interpreter-enterprise-session=;');
        expect(loggedOut.cookies[0]).toContain('Secure');
        expect((await viaTLS('/api/enterprise/organizations/https-org/overview', { headers: { Cookie: cookie } })).status).toBe(403);
        expect((await viaTLS('/api/enterprise/organizations/https-org/activity', { headers: { Cookie: cookie } })).status).toBe(403);
      } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    } finally { await first.end(); await second.end(); }
  });

  it('recovers committed tenant audit, workspace and revocation after an immediate database restart', async () => {
    const config = { host: '127.0.0.1', port: Number(process.env.ENTERPRISE_TEST_DB_PORT), database: 'enterprise_fixture',
      user: 'enterprise_fixture_recovery', password: process.env.ENTERPRISE_TEST_DB_PASSWORD_RECOVERY!,
      caCertificate: readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, 'utf8') };
    const before = createEnterprisePostgresPool(config);
    const first = new ServerDirectory(new TenantPostgresDirectoryStore(before, 'rls-recovery', 'rls'));
    let revokedToken = '';
    let boundToken = '';
    try {
      await first.bootstrap('rls-recovery', 'Recovery fixture', 'https://issuer.invalid/recovery',
        { organizationId: 'rls-recovery', subject: 'operator', displayName: 'Operator', role: 'admin', active: true });
      const admin = await first.createSession('https://issuer.invalid/recovery', 'rls-recovery', 'operator', Date.now() + 60_000);
      revokedToken = admin.token;
      await first.createWorkspace(admin.identity, 'recovery', 'Recovery workspace');
      const challenge = await first.beginDomainProof(admin.identity, 'recovery.test');
      await new ServerDirectory(new TenantPostgresDirectoryStore(before, 'rls-recovery', 'rls'),
        async () => [[challenge.value]]).confirmDomainProof(admin.identity, 'recovery.test');
      boundToken = (await first.createSession('https://issuer.invalid/recovery', 'rls-recovery', 'operator',
        Date.now() + 60_000, 0, 'recovery.test')).token;
      expect((await first.verifySession(boundToken))?.organizationId).toBe('rls-recovery');
      const count = (await first.auditSummary('rls-recovery')).eventCount;
      await first.revokeSession(admin.identity);
      expect((await first.auditSummary('rls-recovery')).eventCount).toBe(count + 1);
      expect(await first.verifySession(admin.token)).toBeNull();
    } finally { await before.end(); }
    // Only the disposable test cluster is stopped. The expected committed
    // state must survive PostgreSQL's crash-recovery path, not a local cache.
    const restarted = spawnSync('/usr/lib/postgresql/14/bin/pg_ctl',
      ['-D', `${process.env.ENTERPRISE_TEST_DB_FIXTURE}/data`, '-m', 'immediate', '-w', 'restart'], { encoding: 'utf8' });
    expect(restarted.status).toBe(0);
    const after = createEnterprisePostgresPool(config);
    try {
      const recovered = new ServerDirectory(new TenantPostgresDirectoryStore(after, 'rls-recovery', 'rls'));
      const records = await after.query('SELECT content FROM public.interpreter_enterprise_rls_directory WHERE organization_id = $1', ['rls-recovery']);
      expect(records.rowCount).toBe(1);
      const state = JSON.parse(String(records.rows[0]?.content));
      expect(Object.keys(state.sessions)).toHaveLength(2);
      expect(Object.values(state.sessions as Record<string, { revoked: boolean }>).some((session) => session.revoked === true)).toBe(true);
      expect(await recovered.verifySession(revokedToken)).toBeNull();
      expect((await recovered.verifySession(boundToken))?.organizationId).toBe('rls-recovery');
      expect(await recovered.domainClaimVerifiedForLogin('rls-recovery', 'https://issuer.invalid/recovery', 'recovery.test')).toBe(true);
      expect((await recovered.auditSummary('rls-recovery')).eventCount).toBe(7);
      const admin = await recovered.createSession('https://issuer.invalid/recovery', 'rls-recovery', 'operator', Date.now() + 60_000);
      expect(await recovered.listWorkspaces(admin.identity)).toEqual([{ id: 'recovery', name: 'Recovery workspace', active: true }]);
      expect((await recovered.listAudit(admin.identity)).some((event) => event.action === 'session.revoke')).toBe(true);
      const fixture = process.env.ENTERPRISE_TEST_DB_FIXTURE!;
      const port = String(process.env.ENTERPRISE_TEST_DB_PORT);
      const backup = `${fixture}/operator-snapshot.dump`;
      const dumped = spawnSync('/usr/lib/postgresql/14/bin/pg_dump',
        ['-Fc', '-f', backup, '-h', fixture, '-p', port, '-d', 'enterprise_fixture'], { encoding: 'utf8' });
      expect(dumped.status).toBe(0);
      const createRestore = spawnSync('/usr/lib/postgresql/14/bin/psql',
        ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', fixture, '-p', port, '-d', 'postgres',
          '-c', 'CREATE DATABASE enterprise_fixture_restored'], { encoding: 'utf8' });
      expect(createRestore.status).toBe(0);
      const restored = spawnSync('/usr/lib/postgresql/14/bin/pg_restore',
        ['-h', fixture, '-p', port, '-d', 'enterprise_fixture_restored', backup], { encoding: 'utf8' });
      expect(restored.status).toBe(0);
      const restoreGrant = spawnSync('/usr/lib/postgresql/14/bin/psql',
        ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', fixture, '-p', port, '-d', 'postgres',
          '-c', 'GRANT CONNECT ON DATABASE enterprise_fixture_restored TO enterprise_fixture_recovery'], { encoding: 'utf8' });
      expect(restoreGrant.status).toBe(0);
      const restoredPool = createEnterprisePostgresPool({ ...config, database: 'enterprise_fixture_restored' });
      try {
        const restoredDirectory = new ServerDirectory(new TenantPostgresDirectoryStore(restoredPool, 'rls-recovery', 'rls'));
        expect(await restoredDirectory.verifySession(revokedToken)).toBeNull();
        expect((await restoredDirectory.verifySession(boundToken))?.organizationId).toBe('rls-recovery');
        expect(await restoredDirectory.domainClaimVerifiedForLogin('rls-recovery', 'https://issuer.invalid/recovery', 'recovery.test')).toBe(true);
        expect((await restoredDirectory.auditSummary('rls-recovery')).eventCount).toBeGreaterThanOrEqual(7);
        const restoredAdmin = await restoredDirectory.createSession('https://issuer.invalid/recovery', 'rls-recovery', 'operator', Date.now() + 60_000);
        expect(await restoredDirectory.listWorkspaces(restoredAdmin.identity))
          .toEqual([{ id: 'recovery', name: 'Recovery workspace', active: true }]);
      } finally { await restoredPool.end(); }
      const otherRole = createEnterprisePostgresPool({ ...config, database: 'enterprise_fixture_restored',
        user: 'enterprise_fixture_b', password: process.env.ENTERPRISE_TEST_DB_PASSWORD_B! });
      try {
        expect((await otherRole.query(`SELECT organization_id FROM public.interpreter_enterprise_rls_directory
          WHERE organization_id = 'rls-recovery'`)).rowCount).toBe(0);
        expect((await otherRole.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
          WHERE domain = 'recovery.test'`)).rowCount).toBe(0);
      } finally { await otherRole.end(); }
    } finally { await after.end(); }
  }, 30_000);

  it('uses two independent TLS pools and denies cross-tenant, stale and disconnected requests', async () => {
    const config = { host: '127.0.0.1', port: Number(process.env.ENTERPRISE_TEST_DB_PORT), database: 'enterprise_fixture',
      user: 'enterprise_fixture', password: process.env.ENTERPRISE_TEST_DB_PASSWORD!,
      caCertificate: readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, 'utf8') };
    const first = createEnterprisePostgresPool(config), second = createEnterprisePostgresPool(config);
    try {
      const tls = await first.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      expect(tls.rows[0]?.ssl).toBe(true);
      const a = new ServerDirectory(new PostgresDirectoryStore(first));
      const b = new ServerDirectory(new PostgresDirectoryStore(second));
      await a.bootstrap('tenant-a', 'Alpha', 'https://synthetic.invalid/a',
        { organizationId: 'tenant-a', subject: 'admin-a', displayName: 'Admin A', role: 'admin', active: true });
      await a.bootstrap('tenant-b', 'Beta', 'https://synthetic.invalid/b',
        { organizationId: 'tenant-b', subject: 'admin-b', displayName: 'Admin B', role: 'admin', active: true });
      const admin = await a.createSession('https://synthetic.invalid/a', 'tenant-a', 'admin-a', Date.now() + 60_000);
      const other = await a.createSession('https://synthetic.invalid/b', 'tenant-b', 'admin-b', Date.now() + 60_000);
      const actor = (await b.verifySession(admin.token))!;
      await b.setMember(actor, { organizationId: 'tenant-a', subject: 'worker', displayName: 'Worker', role: 'member', active: true });
      await b.setMember(actor, { organizationId: 'tenant-a', subject: 'admin-c', displayName: 'Admin C', role: 'admin', active: true });
      const worker = await b.createSession('https://synthetic.invalid/a', 'tenant-a', 'worker', Date.now() + 60_000);
      const otherAdmin = await b.createSession('https://synthetic.invalid/a', 'tenant-a', 'admin-c', Date.now() + 60_000);
      const origin = 'http://127.0.0.1:39394';
      const options = { applicationOrigin: origin, allowInsecureLoopbackForTests: true,
        verifySession: (token: string) => b.verifySession(token), directory: b };
      const app = express();
      expect(mountEnterpriseAdminRoutes(app)).toBe(false);
      expect(mountEnterpriseAdminRoutes(app, { ...options, enabled: true,
        organizationId: 'tenant-a', issuer: 'https://synthetic.invalid/a' })).toBe(true);
      const otherApp = express();
      expect(mountEnterpriseAdminRoutes(otherApp, { ...options, enabled: true,
        organizationId: 'tenant-b', issuer: 'https://synthetic.invalid/b' })).toBe(true);
      // Supertest otherwise creates a transient listener on all interfaces.
      const httpA = app.listen(0, '127.0.0.1');
      const httpB = otherApp.listen(0, '127.0.0.1');
      try {
      const post = (path: string, token: string) => request(httpA).post(path)
        .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
        .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
        .set('Cookie', `interpreter-enterprise-session=${token}`).send({});
      const overview = (tenant: string, token: string) => request(httpA).get(`/api/enterprise/organizations/${tenant}/overview`)
        .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
      const activity = (tenant: string, token: string) => request(httpA).get(`/api/enterprise/organizations/${tenant}/activity`)
        .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
      const target = '/api/enterprise/organizations/tenant-a/members/worker/deactivate';
      const kill = '/api/enterprise/organizations/tenant-a/members/worker/revoke-sessions';
      expect((await overview('tenant-b', admin.token)).status).toBe(403);
      expect((await activity('tenant-b', admin.token)).status).toBe(403);
      expect((await activity('tenant-a', worker.token)).status).toBe(403);
      const ownActivity = await activity('tenant-a', admin.token);
      expect(ownActivity.status).toBe(200);
      expect(ownActivity.body.events.every((event: { organizationId: string }) => event.organizationId === 'tenant-a')).toBe(true);
      expect((await post(target, other.token)).status).toBe(403);
      expect((await post(target, worker.token)).status).toBe(403);
      const demote = '/api/enterprise/organizations/tenant-a/members/admin-c/demote';
      expect((await post(demote, worker.token)).status).toBe(403);
      expect((await post('/api/enterprise/organizations/tenant-b/members/admin-b/demote', admin.token)).status).toBe(403);
      expect((await post(demote, admin.token)).status).toBe(204);
      expect((await b.getMember('tenant-a', 'admin-c'))?.role).toBe('member');
      expect(await a.verifySession(otherAdmin.token)).toBeNull();
      expect(await b.verifySession(admin.token)).not.toBeNull();
      expect(await b.verifySession(other.token)).not.toBeNull();
      const secondWorker = await a.createSession('https://synthetic.invalid/a', 'tenant-a', 'worker', Date.now() + 60_000);
      expect((await post(kill, other.token)).status).toBe(403);
      expect((await post(kill, worker.token)).status).toBe(403);
      expect((await post(kill, admin.token)).status).toBe(204);
      expect(await a.verifySession(worker.token)).toBeNull();
      expect(await b.verifySession(secondWorker.token)).toBeNull();
      expect((await b.getMember('tenant-a', 'worker'))?.active).toBe(true);
      const afterKill = await b.createSession('https://synthetic.invalid/a', 'tenant-a', 'worker', Date.now() + 60_000);
      expect(await a.verifySession(afterKill.token)).not.toBeNull();
      expect((await post(target, admin.token)).status).toBe(204);
      expect((await overview('tenant-a', afterKill.token)).status).toBe(403);
      expect((await request(httpB).get('/api/enterprise/organizations/tenant-b/overview')
        .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${other.token}`)).status).toBe(200);
      expect((await b.auditSummary('tenant-a')).eventCount).toBeGreaterThan(0);
      expect((await b.auditSummary('tenant-b')).eventCount).toBeGreaterThan(0);
      const logout = await post('/api/enterprise/organizations/tenant-a/session/logout', admin.token);
      expect(logout.status).toBe(204);
      expect(logout.headers['set-cookie'][0]).toContain('interpreter-enterprise-session=;');
      expect(await a.verifySession(admin.token)).toBeNull(); // Other pool observes durable revocation.
      expect(await b.verifySession(other.token)).not.toBeNull();
      expect((await overview('tenant-a', admin.token)).status).toBe(403);
      expect((await activity('tenant-a', admin.token)).status).toBe(403);
      const freshAdmin = await a.createSession('https://synthetic.invalid/a', 'tenant-a', 'admin-a', Date.now() + 60_000);
      const secondAdmin = await b.createSession('https://synthetic.invalid/a', 'tenant-a', 'admin-a', Date.now() + 60_000);
      const browserBinding = 'synthetic-browser-binding';
      const attempt = { organizationId: 'tenant-a', issuer: 'https://synthetic.invalid/a',
        nonce: 'synthetic-nonce', verifier: 'synthetic-verifier',
        bindingHash: createHash('sha256').update(browserBinding).digest('hex'), expiresAt: Date.now() + 60_000 };
      await a.putAttempt('pending-before-kill', attempt);
      await a.putAttempt('inflight-before-kill', attempt);
      const inFlight = await b.takeAttempt('inflight-before-kill', browserBinding);
      expect(inFlight?.authEpoch).toBe(0); // Already consumed by a second host before revocation.
      const emergency = '/api/enterprise/organizations/tenant-a/sessions/revoke-all';
      const emergencyResult = await post(emergency, freshAdmin.token);
      expect(emergencyResult.status).toBe(204);
      expect(emergencyResult.headers['set-cookie'][0]).toContain('interpreter-enterprise-session=;');
      expect(await a.verifySession(freshAdmin.token)).toBeNull();
      expect(await b.verifySession(secondAdmin.token)).toBeNull(); // Independent TLS pool observes the kill.
      expect(await b.takeAttempt('pending-before-kill', browserBinding)).toBeNull();
      await expect(b.createSession('https://synthetic.invalid/a', 'tenant-a', 'admin-a', Date.now() + 60_000,
        inFlight!.authEpoch ?? 0)).rejects.toThrow('login epoch mismatch');
      expect((await overview('tenant-a', secondAdmin.token)).status).toBe(403);
      expect((await request(httpB).get('/api/enterprise/organizations/tenant-b/overview')
        .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${other.token}`)).status).toBe(200);
      await a.putAttempt('fresh-after-kill', attempt);
      const freshAttempt = await b.takeAttempt('fresh-after-kill', browserBinding);
      expect(freshAttempt?.authEpoch).toBe(1);
      expect((await b.listAudit((await b.createSession('https://synthetic.invalid/a', 'tenant-a', 'admin-a', Date.now() + 60_000, 1)).identity))
        .some((event) => event.action === 'organization.sessions.revoke-all' && event.outcome === 'allowed')).toBe(true);
      // Stop the disposable server while both hosts still have session pools.
      await first.end();
      await second.end();
      const stopped = spawnSync('/usr/lib/postgresql/14/bin/pg_ctl',
        ['-D', `${process.env.ENTERPRISE_TEST_DB_FIXTURE}/data`, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
      expect(stopped.status).toBe(0);
      const unavailable = createEnterprisePostgresPool(config);
      try {
        const down = new ServerDirectory(new PostgresDirectoryStore(unavailable));
        const offline = express();
        expect(mountEnterpriseAdminRoutes(offline, { ...options, directory: down,
          verifySession: (token: string) => down.verifySession(token), enabled: true,
          organizationId: 'tenant-b', issuer: 'https://synthetic.invalid/b' })).toBe(true);
        const httpOffline = offline.listen(0, '127.0.0.1');
        try {
          expect((await request(httpOffline).get('/api/enterprise/organizations/tenant-b/overview')
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${other.token}`)).status).toBe(503);
          expect((await request(httpOffline).get('/api/enterprise/organizations/tenant-b/activity')
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${other.token}`)).status).toBe(503);
          const failedLogout = await request(httpOffline).post('/api/enterprise/organizations/tenant-b/session/logout')
            .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
            .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
            .set('Cookie', `interpreter-enterprise-session=${other.token}`).send({});
          expect(failedLogout.status).toBe(503);
          expect(failedLogout.headers['set-cookie']).toBeUndefined();
          const failedKill = await request(httpOffline).post('/api/enterprise/organizations/tenant-b/members/admin-b/revoke-sessions')
            .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
            .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
            .set('Cookie', `interpreter-enterprise-session=${other.token}`).send({});
          expect(failedKill.status).toBe(503);
          const failedEmergency = await request(httpOffline).post('/api/enterprise/organizations/tenant-b/sessions/revoke-all')
            .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
            .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
            .set('Cookie', `interpreter-enterprise-session=${other.token}`).send({});
          expect(failedEmergency.status).toBe(503);
          expect(failedEmergency.headers['set-cookie']).toBeUndefined();
        } finally { httpOffline.close(); }
      } finally { await unavailable.end(); }
      } finally { httpA.close(); httpB.close(); }
    } finally { await first.end().catch(() => {}); await second.end().catch(() => {}); }
  });
});
