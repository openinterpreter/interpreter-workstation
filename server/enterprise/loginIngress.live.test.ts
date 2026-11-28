import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import express from 'express';
import type { Server } from 'node:https';
import type { Pool } from 'pg';
import { createEnterprisePostgresPool } from './postgresDirectoryStore';
import { PostgresEnterpriseLoginIngress } from './loginIngress';
import { createOidcHttpRouter } from './oidcHttp';
import type { OidcIntegration, OidcConfiguration } from './oidc';

// Disposable loopback-only, CA-pinned PostgreSQL and synthetic TLS fixture.
// No production issuer, credential or external service is contacted.
const fixture = process.env.ENTERPRISE_F4_TEST_FIXTURE;
describe.skipIf(!fixture)('shared RLS ingress under real TLS PostgreSQL and HTTPS', () => {
  test('independent hosts share bounds, tenant roles stay isolated and outage denies before IdP work', async () => {
    const caCertificate = readFileSync(`${fixture}/ca.pem`, 'utf8');
    const connect = (role: 'a' | 'b', port = 55439) => createEnterprisePostgresPool({
      host: '127.0.0.1', port, database: 'enterprise_f4_fixture',
      user: `enterprise_f4_${role}`, password: readFileSync(`${fixture}/pass-${role === 'a' ? 0 : 1}`, 'utf8'),
      caCertificate,
    });
    const first = connect('a'), second = connect('a'), tenantB = connect('b'), unavailable = connect('a');
    const pools: Pool[] = [first, second, tenantB, unavailable];
    const key = Buffer.alloc(32, 7); // Synthetic only; actual deployments need one private shared key.
    let server: Server | undefined;
    try {
      const a = await PostgresEnterpriseLoginIngress.connect(first, 'f4-a', key);
      const otherHost = await PostgresEnterpriseLoginIngress.connect(second, 'f4-a', key);
      const b = await PostgresEnterpriseLoginIngress.connect(tenantB, 'f4-b', key);
      await expect(PostgresEnterpriseLoginIngress.connect(tenantB, 'f4-a', key)).rejects.toThrow('RLS and TLS boundary');
      await expect(tenantB.query(`INSERT INTO public.interpreter_enterprise_rls_login_ingress
        (organization_id,database_role,slot,operation,network_digest,window_bucket,hits)
        VALUES ('f4-a',current_user,4095,'callback',$1,100,1)`, ['f'.repeat(64)])).rejects.toThrow();
      for (let index = 0; index < 12; index++) {
        expect(await (index % 2 ? a : otherHost).admit('f4-a', '127.0.0.1', 'login')).toBe(true);
      }
      expect(await a.admit('f4-a', '127.0.0.1', 'login')).toBe(false);
      const slot = (network: string) => parseInt(createHmac('sha256', key)
        .update(`f4-a\0login\0${network}`).digest('hex').slice(0, 8), 16) % 4096;
      let collision: string | null = null;
      for (let index = 0; index < 65_536 && !collision; index++) {
        const candidate = `198.18.${index >>> 8}.${index & 255}`;
        if (slot(candidate) === slot('127.0.0.1')) collision = candidate;
      }
      expect(collision).not.toBeNull();
      expect(await otherHost.admit('f4-a', collision!, 'login')).toBe(false); // Collision denies, never evicts a live peer.
      expect(await b.admit('f4-a', '127.0.0.1', 'login')).toBe(false);
      expect(await b.admit('f4-b', '127.0.0.1', 'login')).toBe(true);
      expect(await otherHost.admit('f4-a', '198.51.100.9', 'login')).toBe(true);
      const racing = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? a : otherHost).admit('f4-a', '127.0.0.1', 'domain-recovery')));
      expect(racing.filter(Boolean)).toHaveLength(6); // Atomic across independent host pools.
      for (let index = 0; index < 60; index++) {
        expect(await (index % 2 ? a : otherHost).admit('f4-a', '127.0.0.1', 'callback')).toBe(true);
      }
      const scoped = await first.query(`SELECT network_digest FROM public.interpreter_enterprise_rls_login_ingress`);
      expect(scoped.rows.length).toBeGreaterThan(0);
      expect(scoped.rows.every((row) => !String(row.network_digest).includes('127.0.0.1'))).toBe(true);
      expect((await tenantB.query('SELECT * FROM public.interpreter_enterprise_rls_login_ingress')).rows)
        .toHaveLength(1); // The B role cannot see or alter A's rate-limit rows.

      const app = express();
      server = createHttpsServer({ key: readFileSync(`${fixture}/server.key`), cert: readFileSync(`${fixture}/server.pem`) }, app);
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind');
      const origin = `https://127.0.0.1:${address.port}`;
      const config: OidcConfiguration = { organizationId: 'f4-a', issuer: 'https://idp.invalid/f4-a', clientId: 'synthetic',
        authorizationEndpoint: 'https://idp.invalid/f4-a/authorize', tokenEndpoint: 'https://idp.invalid/f4-a/token',
        jwksUri: 'https://idp.invalid/f4-a/keys', redirectUri: `${origin}/enterprise/callback`, accountDomain: 'recovery.example' };
      let idpWork = 0;
      app.use(createOidcHttpRouter({ config, integration: {
        begin: async () => { idpWork++; throw new Error('Denied request must not reach IdP'); },
        complete: async () => { idpWork++; throw new Error('Denied callback must not reach IdP'); },
      } as OidcIntegration, applicationOrigin: origin, successPath: '/settings', ingress: a }));
      const get = (path: string) => new Promise<{ status: number; cookies?: string[]; location?: string }>((resolve, reject) => {
        const req = httpsRequest({ hostname: '127.0.0.1', port: address.port, path, ca: caCertificate,
          rejectUnauthorized: true, headers: { 'X-Forwarded-For': '203.0.113.99',
            Cookie: `__Host-interpreter-oidc-binding=${'a'.repeat(43)}` } }, (res) => {
          res.resume(); res.on('end', () => resolve({ status: res.statusCode!, cookies: res.headers['set-cookie'], location: res.headers.location }));
        });
        req.on('error', reject); req.end();
      });
      const denied = await get('/organizations/f4-a/login');
      const callback = await get(`/enterprise/callback?code=synthetic&state=${'b'.repeat(43)}`);
      expect(denied.status).toBe(429);
      expect(callback.status).toBe(429);
      expect(denied.cookies).toBeUndefined();
      expect(callback.cookies).toBeUndefined();
      expect(denied.location).toBeUndefined();
      expect(idpWork).toBe(0);
      const unavailableIngress = await PostgresEnterpriseLoginIngress.connect(unavailable, 'f4-a', key);
      await unavailable.end();
      pools.pop();
      const outageApp = express();
      const outageServer = createHttpsServer({ key: readFileSync(`${fixture}/server.key`), cert: readFileSync(`${fixture}/server.pem`) }, outageApp);
      try {
        await new Promise<void>((resolve) => outageServer.listen(0, '127.0.0.1', resolve));
        const outageAddress = outageServer.address();
        if (!outageAddress || typeof outageAddress === 'string') throw new Error('Outage HTTPS fixture did not bind');
        const outageOrigin = `https://127.0.0.1:${outageAddress.port}`;
        outageApp.use(createOidcHttpRouter({ config: { ...config, redirectUri: `${outageOrigin}/enterprise/callback` },
          integration: { begin: async () => { idpWork++; throw new Error('Outage must deny'); } } as OidcIntegration,
          applicationOrigin: outageOrigin, successPath: '/settings', ingress: unavailableIngress }));
        const outage = await new Promise<number>((resolve, reject) => {
          const req = httpsRequest({ hostname: '127.0.0.1', port: outageAddress.port,
            path: '/organizations/f4-a/login', ca: caCertificate, rejectUnauthorized: true }, (res) => {
            res.resume(); res.on('end', () => resolve(res.statusCode!));
          });
          req.on('error', reject); req.end();
        });
        expect(outage).toBe(503);
        expect(idpWork).toBe(0);
      } finally { await new Promise<void>((resolve) => outageServer.close(() => resolve())); }
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await Promise.all(pools.map((pool) => pool.end()));
    }
  }, 60_000);
});
