import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { ServerDirectory } from './serverDirectory';
import { createEnterprisePostgresPool, PostgresDirectoryStore } from './postgresDirectoryStore';
import { createEnterpriseBrowserRouter } from './oidcHttp';
import { mountEnterpriseAdminRoutes } from './adminMount';

// Intentionally skipped by ordinary unit tests: the isolated OS-package fixture
// explicitly supplies these private, short-lived credentials and shuts itself down.
const live = process.env.ENTERPRISE_TEST_DB_FIXTURE && process.env.ENTERPRISE_TEST_DB_PASSWORD;
describe.skipIf(!live)('actual TLS PostgreSQL: tenant isolation, revocation and outage over HTTP', () => {
  it('rejects untrusted CA and plaintext before any tenant bootstrap', async () => {
    const base = { host: '127.0.0.1', port: Number(process.env.ENTERPRISE_TEST_DB_PORT), database: 'enterprise_fixture',
      user: 'enterprise_fixture', password: process.env.ENTERPRISE_TEST_DB_PASSWORD!, caCertificate: readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, 'utf8') };
    const wrong = createEnterprisePostgresPool({ ...base, caCertificate: '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----' });
    try { await expect(wrong.query('SELECT 1')).rejects.toThrow(); } finally { await wrong.end(); }
    const plaintext = new pg.Client({ host: base.host, port: base.port, database: base.database, user: base.user,
      password: base.password, ssl: false, connectionTimeoutMillis: 1500 });
    try { await expect(plaintext.connect()).rejects.toThrow(); } finally { await plaintext.end().catch(() => {}); }
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
      const post = (path: string, token: string) => request(app).post(path)
        .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
        .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
        .set('Cookie', `interpreter-enterprise-session=${token}`).send({});
      const overview = (tenant: string, token: string) => request(app).get(`/api/enterprise/organizations/${tenant}/overview`)
        .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
      const target = '/api/enterprise/organizations/tenant-a/members/worker/deactivate';
      expect((await overview('tenant-b', admin.token)).status).toBe(403);
      expect((await post(target, other.token)).status).toBe(403);
      expect((await post(target, worker.token)).status).toBe(403);
      expect((await post(target, admin.token)).status).toBe(204);
      expect((await overview('tenant-a', worker.token)).status).toBe(403);
      expect((await request(otherApp).get('/api/enterprise/organizations/tenant-b/overview')
        .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${other.token}`)).status).toBe(200);
      expect((await b.auditSummary('tenant-a')).eventCount).toBeGreaterThan(0);
      expect((await b.auditSummary('tenant-b')).eventCount).toBeGreaterThan(0);
      await a.revokeSession(actor);
      expect((await overview('tenant-a', admin.token)).status).toBe(403);
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
        offline.use('/api/enterprise', createEnterpriseBrowserRouter({ ...options, directory: down,
          verifySession: (token: string) => down.verifySession(token) }));
        expect((await request(offline).get('/api/enterprise/organizations/tenant-b/overview')
          .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${other.token}`)).status).toBe(503);
      } finally { await unavailable.end(); }
    } finally { await first.end().catch(() => {}); await second.end().catch(() => {}); }
  });
});
