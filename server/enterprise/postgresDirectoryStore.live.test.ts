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
import { ServerDirectory } from './serverDirectory';
import { createEnterprisePostgresPool, PostgresDirectoryStore, TenantPostgresDirectoryStore } from './postgresDirectoryStore';
import { mountEnterpriseAdminRoutes } from './adminMount';
import { OidcIntegration, providerMetadataUri, type OidcConfiguration } from './oidc';
import { createOidcHttpRouter } from './oidcHttp';

// Intentionally skipped by ordinary unit tests: the isolated OS-package fixture
// explicitly supplies these private, short-lived credentials and shuts itself down.
const live = process.env.ENTERPRISE_TEST_DB_FIXTURE && process.env.ENTERPRISE_TEST_DB_PASSWORD;
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
      await a.setMember(sessionA.identity, { organizationId: 'rls-a', subject: 'worker', displayName: 'Worker', role: 'member', active: true });
      const worker = await a.createSession('https://issuer.invalid/a', 'rls-a', 'worker', Date.now() + 60_000);
      await expect(aOther.listAudit(worker.identity)).rejects.toThrow('Access denied');
      expect((await poolA.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', ['rls-a']))
        .rows[0]?.content).toMatchObject({ organizationId: 'rls-a', subject: 'worker', action: 'organization.audit.read', outcome: 'denied' });
      expect((await poolB.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-a'])).rowCount).toBe(0);
      const origin = 'http://127.0.0.1:39394';
      const appA = express(), appB = express();
      expect(mountEnterpriseAdminRoutes(appA, { enabled: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'rls-a', issuer: 'https://issuer.invalid/a',
        directory: aOther, verifySession: (token) => aOther.verifySession(token) })).toBe(true);
      expect(mountEnterpriseAdminRoutes(appB, { enabled: true, applicationOrigin: origin,
        allowInsecureLoopbackForTests: true, organizationId: 'rls-b', issuer: 'https://issuer.invalid/b',
        directory: b, verifySession: (token) => b.verifySession(token) })).toBe(true);
      const httpA = appA.listen(0, '127.0.0.1'), httpB = appB.listen(0, '127.0.0.1');
      try {
        const read = (server: typeof httpA, tenant: string, token: string) => request(server)
          .get(`/api/enterprise/organizations/${tenant}/overview`)
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
        expect((await read(httpA, 'rls-a', sessionA.token)).status).toBe(200);
        expect((await read(httpA, 'rls-b', sessionA.token)).status).toBe(403);
        expect((await poolA.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', ['rls-a']))
          .rows[0]?.content).toMatchObject({ organizationId: 'rls-a', targetOrganizationId: 'rls-b',
          action: 'organization.overview.cross-tenant', outcome: 'denied' });
        expect((await request(httpA).post('/api/enterprise/organizations/rls-b/session/logout')
          .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
          .set('X-Interpreter-CSRF', '1').set('Cookie', `interpreter-enterprise-session=${sessionA.token}`)
          .set('Content-Type', 'application/json').send({})).status).toBe(403);
        expect((await poolA.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', ['rls-a']))
          .rows[0]?.content).toMatchObject({ organizationId: 'rls-a', targetOrganizationId: 'rls-b',
          action: 'organization.logout.cross-tenant', outcome: 'denied' });
        expect((await read(httpA, 'rls-b', sessionB.token)).status).toBe(403);
        expect((await read(httpB, 'rls-b', sessionB.token)).status).toBe(200);
        expect((await read(httpB, 'rls-a', sessionA.token)).status).toBe(403);
        const exportAudit = (server: typeof httpA, tenant: string, token: string) => request(server)
          .get(`/api/enterprise/organizations/${tenant}/activity/export`)
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
        const exported = await exportAudit(httpA, 'rls-a', sessionA.token);
        expect(exported.status).toBe(200);
        expect(exported.headers['content-disposition']).toContain('attachment;');
        expect(exported.body.events.every((event: { organizationId: string }) => event.organizationId === 'rls-a')).toBe(true);
        expect((await poolA.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', ['rls-a']))
          .rows[0]?.content).toMatchObject({ action: 'organization.audit.export', outcome: 'allowed' });
        expect((await exportAudit(httpB, 'rls-b', sessionA.token)).status).toBe(403);
        expect((await exportAudit(httpA, 'rls-a', worker.token)).status).toBe(403);
        expect((await request(httpA).post('/api/enterprise/organizations/rls-a/members/alice/deactivate')
          .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
          .set('X-Interpreter-CSRF', '1').set('Cookie', `interpreter-enterprise-session=${worker.token}`)
          .set('Content-Type', 'application/json').send({})).status).toBe(403);
        expect((await poolA.query('SELECT content FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', ['rls-a']))
          .rows[0]?.content).toMatchObject({ organizationId: 'rls-a', subject: 'worker',
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
      } finally { httpA.close(); httpB.close(); }
      await aOther.revokeSession(sessionA.identity);
      expect(await a.verifySession(sessionA.token)).toBeNull();
      expect((await b.verifySession(sessionB.token))?.organizationId).toBe('rls-b');
      const eventsA = await poolA.query('SELECT organization_id, content FROM public.interpreter_enterprise_rls_audit ORDER BY id');
      const eventsB = await poolB.query('SELECT organization_id, content FROM public.interpreter_enterprise_rls_audit ORDER BY id');
      expect(eventsA.rows.length).toBeGreaterThanOrEqual(4);
      expect(eventsA.rows.every((event) => event.organization_id === 'rls-a')).toBe(true);
      expect(eventsB.rows.every((event) => event.organization_id === 'rls-b')).toBe(true);
      expect(eventsA.rows.some((event) => event.content.action === 'session.revoke')).toBe(true);
      expect((await poolA.query('SELECT id FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-b'])).rowCount).toBe(0);
      await expect(poolA.query('INSERT INTO public.interpreter_enterprise_rls_audit (organization_id, content) VALUES ($1, $2::jsonb)',
        ['rls-b', JSON.stringify({ organizationId: 'rls-b', subject: 'alice', action: 'forged', outcome: 'allowed', at: new Date().toISOString() })]))
        .rejects.toThrow(/row.level security/i);
      await expect(poolA.query('INSERT INTO public.interpreter_enterprise_rls_audit (organization_id, content) VALUES ($1, $2::jsonb)',
        ['rls-a', JSON.stringify({ organizationId: 'rls-b', subject: 'alice', action: 'forged', outcome: 'allowed', at: new Date().toISOString() })]))
        .rejects.toThrow(/check constraint/i);
      for (const incomplete of [
        { subject: 'alice', action: 'forged', outcome: 'allowed', at: new Date().toISOString() },
        { organizationId: 'rls-a', subject: 'alice', action: 'forged', at: new Date().toISOString() },
        { organizationId: 'rls-a', subject: 'alice', action: 'forged', outcome: 'allowed' },
        { organizationId: 'rls-a', subject: null, action: 'forged', outcome: 'allowed', at: new Date().toISOString() },
      ]) {
        await expect(poolA.query('INSERT INTO public.interpreter_enterprise_rls_audit (organization_id, content) VALUES ($1, $2::jsonb)',
          ['rls-a', JSON.stringify(incomplete)])).rejects.toThrow(/check constraint/i);
      }
      await expect(poolA.query('UPDATE public.interpreter_enterprise_rls_audit SET content = $1::jsonb WHERE organization_id = $2',
        ['{}', 'rls-a'])).rejects.toThrow(/permission denied/i);
      await expect(poolA.query('DELETE FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-a']))
        .rejects.toThrow(/permission denied/i);
      await expect(new TenantPostgresDirectoryStore(poolA, 'rls-a', 'rls').change((state) => {
        state.audit[0]!.action = 'forged-history';
      })).rejects.toThrow('audit history cannot be rewritten');
      expect((await poolA.query('SELECT id FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-a'])).rowCount)
        .toBe(eventsA.rows.length);
      expect((await poolA.query('SELECT organization_id FROM public.interpreter_enterprise_rls_directory WHERE organization_id = $1', ['rls-c'])).rowCount).toBe(0);
      const fresh = await a.createSession('https://issuer.invalid/a', 'rls-a', 'alice', Date.now() + 60_000);
      // The fixture operator can simulate loss of one audit record. The app
      // role cannot delete it, and the next locked authorization must deny.
      const tamper = spawnSync('/usr/lib/postgresql/14/bin/psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1',
        '-h', process.env.ENTERPRISE_TEST_DB_FIXTURE!, '-p', String(process.env.ENTERPRISE_TEST_DB_PORT),
        '-d', 'enterprise_fixture', '-c', `DELETE FROM public.interpreter_enterprise_rls_audit
          WHERE id = (SELECT min(id) FROM public.interpreter_enterprise_rls_audit WHERE organization_id = 'rls-a')`], { encoding: 'utf8' });
      expect(tamper.status).toBe(0);
      await expect(aOther.verifySession(fresh.token)).rejects.toThrow('audit ledger is out of sync');
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
      // A privileged fixture operator rewrites an event but leaves the row
      // count unchanged. The app role cannot do this; both reads and the HTTP
      // boundary must still detect the changed ordered ledger content.
      const rewrite = spawnSync('/usr/lib/postgresql/14/bin/psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1',
        '-h', process.env.ENTERPRISE_TEST_DB_FIXTURE!, '-p', String(process.env.ENTERPRISE_TEST_DB_PORT),
        '-d', 'enterprise_fixture', '-c', `UPDATE public.interpreter_enterprise_rls_audit
          SET content = jsonb_set(content, '{action}', '"forged-history"'::jsonb)
          WHERE id = (SELECT min(id) FROM public.interpreter_enterprise_rls_audit WHERE organization_id = 'rls-b')`], { encoding: 'utf8' });
      expect(rewrite.status).toBe(0);
      expect((await poolB.query('SELECT count(*)::int AS count FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1', ['rls-b']))
        .rows[0]?.count).toBe(eventsB.rows.length);
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
  }, 30_000);
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
      user: 'enterprise_fixture', password: process.env.ENTERPRISE_TEST_DB_PASSWORD!, caCertificate: ca };
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
    idp.get('/tenant/.well-known/openid-configuration', (_req, res) => res.json({
      issuer: metadataIssuerOverride || issuer,
      authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`,
      response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
    }));
    idp.get('/tenant/keys', (_req, res) => res.json({ keys: [jwk] }));
    idp.post('/tenant/token', express.urlencoded({ extended: false }), async (req, res) => {
      tokenRequests++;
      if (req.body.code !== 'network-code' || req.body.grant_type !== 'authorization_code' ||
          req.body.redirect_uri !== expectedRedirectUri || req.body.client_id !== 'network-fixture-client' ||
          createHash('sha256').update(req.body.code_verifier ?? '').digest('base64url') !== challenge) {
        return void res.status(400).end();
      }
      const idToken = await new SignJWT({ nonce }).setProtectedHeader({ alg: 'RS256', kid: 'network-fixture-key' })
        .setIssuer(issuer).setAudience('network-fixture-client').setSubject('alice')
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
      const directory = new ServerDirectory(new PostgresDirectoryStore(first));
      const verifier = new ServerDirectory(new PostgresDirectoryStore(second));
      await directory.bootstrap('network-org', 'Network organization', issuer,
        { organizationId: 'network-org', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
      const app = express();
      const callbackServer = createHttpsServer(tls, app);
      await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
      try {
        const callbackAddress = callbackServer.address();
        if (!callbackAddress || typeof callbackAddress === 'string') throw new Error('Missing callback TLS port');
        const origin = `https://127.0.0.1:${callbackAddress.port}`;
        const config: OidcConfiguration = { organizationId: 'network-org', issuer, clientId: 'network-fixture-client',
          authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/keys`,
          redirectUri: `${origin}/enterprise/callback` };
        expectedRedirectUri = config.redirectUri;
        app.use(createOidcHttpRouter({ config, integration: new OidcIntegration(config, directory, pinnedFetch),
          applicationOrigin: origin, successPath: '/settings' }));
        expect(mountEnterpriseAdminRoutes(app, { enabled: true, applicationOrigin: origin, organizationId: 'network-org', issuer,
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
        const persisted = await second.query('SELECT content FROM interpreter_enterprise_directory WHERE id = 1');
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
        expect((await callback(rejected.state, rejected.cookie)).status).toBe(401); // Wrong binding consumes state across the store.
        expect(tokenRequests).toBe(0);
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
      user: 'enterprise_fixture', password: process.env.ENTERPRISE_TEST_DB_PASSWORD!, caCertificate: ca };
    const first = createEnterprisePostgresPool(database), second = createEnterprisePostgresPool(database);
    try {
      const directory = new ServerDirectory(new PostgresDirectoryStore(first));
      const verifier = new ServerDirectory(new PostgresDirectoryStore(second));
      const issuer = 'https://synthetic-idp.invalid/tenant';
      await directory.bootstrap('https-org', 'HTTPS organization', issuer,
        { organizationId: 'https-org', subject: 'admin', displayName: 'Admin', role: 'admin', active: true });
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
          redirectUri: `${origin}/enterprise/callback` };
        const { publicKey, privateKey } = await generateKeyPair('RS256');
        const jwk = { ...await exportJWK(publicKey), kid: 'https-fixture-key', alg: 'RS256', use: 'sig' };
        let nonce = '';
        const idp: typeof fetch = async (input, init) => {
          if (String(input) === providerMetadataUri(config.issuer)) return Response.json({ issuer: config.issuer,
            authorization_endpoint: config.authorizationEndpoint, token_endpoint: config.tokenEndpoint, jwks_uri: config.jwksUri,
            response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
          if (String(input) === config.jwksUri) return Response.json({ keys: [jwk] });
          if (String(input) !== config.tokenEndpoint || init?.method !== 'POST') throw new Error('Unexpected IdP request');
          const token = await new SignJWT({ nonce }).setProtectedHeader({ alg: 'RS256', kid: 'https-fixture-key' })
            .setIssuer(issuer).setAudience(config.clientId).setSubject('admin')
            .setIssuedAt().setExpirationTime('5m').sign(privateKey);
          return Response.json({ id_token: token });
        };
        app.use(createOidcHttpRouter({ config, integration: new OidcIntegration(config, directory, idp),
          applicationOrigin: origin, successPath: '/settings' }));
        expect(mountEnterpriseAdminRoutes(app, { enabled: true, applicationOrigin: origin,
          organizationId: 'https-org', issuer, directory: verifier,
          verifySession: (token) => verifier.verifySession(token) })).toBe(true);
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
        const started = await viaTLS('/organizations/https-org/login');
        expect(observedOrigin).toEqual({ host: new URL(origin).host, encrypted: true });
        expect(started.status).toBe(302);
        const binding = started.cookies.find((value) => value.startsWith('__Host-interpreter-oidc-binding='))!;
        expect(binding).toContain('HttpOnly');
        expect(binding).toContain('Secure');
        nonce = new URL(started.location!).searchParams.get('nonce')!;
        const state = new URL(started.location!).searchParams.get('state')!;
        const callback = await viaTLS(`/enterprise/callback?code=synthetic-code&state=${state}`, {
          headers: { Cookie: binding.split(';')[0] } });
        expect(callback.status).toBe(303);
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
      const worker = await b.createSession('https://synthetic.invalid/a', 'tenant-a', 'worker', Date.now() + 60_000);
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
