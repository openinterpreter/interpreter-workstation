import { describe, expect, it } from 'bun:test';
import type { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { ServerDirectory } from './serverDirectory';
import { createEnterprisePostgresPool, PostgresDirectoryStore } from './postgresDirectoryStore';
import { createEnterpriseAdminMutationRouter, createEnterpriseBrowserRouter } from './oidcHttp';

// Deterministic PostgreSQL protocol fixture: two independent directory hosts
// use the same locked database row; no external service or credential is used.
class SharedDatabase {
  content: string | null = null;
  failConnect = false;
  failUpdate = false;
  releases = 0;
  private held: Promise<void> = Promise.resolve();
  async query(sql: string) {
    if (!sql.startsWith('SELECT')) throw new Error('Unexpected public query');
    return this.row(this.content);
  }
  private row(content: string | null) {
    return { rowCount: content === null ? 0 : 1, rows: content === null ? [] : [{ content }] };
  }
  async connect() {
    if (this.failConnect) throw new Error('Database unavailable');
    let releaseLock: (() => void) | undefined;
    let transaction: string | null = null;
    return {
      query: async (sql: string, values?: unknown[]) => {
        if (sql === 'BEGIN') {
          const predecessor = this.held;
          this.held = new Promise<void>((done) => { releaseLock = done; });
          await predecessor;
          transaction = this.content;
        } else if (sql.startsWith('SET LOCAL')) {
          // Timeout settings apply to the same client as BEGIN and FOR UPDATE.
        } else if (sql.startsWith('INSERT')) {
          if (transaction === null) transaction = String(values?.[0]);
        } else if (sql.includes('FOR UPDATE')) {
          return this.row(transaction);
        } else if (sql.startsWith('UPDATE')) {
          if (this.failUpdate) throw new Error('Write unavailable');
          if (transaction === null) return { rowCount: 0, rows: [] };
          transaction = String(values?.[0]);
          return { rowCount: 1, rows: [] };
        } else if (sql === 'COMMIT') {
          this.content = transaction;
          releaseLock?.();
        } else if (sql === 'ROLLBACK') {
          releaseLock?.();
        } else throw new Error(`Unexpected statement: ${sql}`);
        return { rowCount: 0, rows: [] };
      },
      release: () => { this.releases++; },
    };
  }
}

function hosts() {
  const database = new SharedDatabase();
  const store = () => new PostgresDirectoryStore(database as unknown as Pool);
  return { database, a: new ServerDirectory(store()), b: new ServerDirectory(store()), store };
}

async function seed(a: ServerDirectory) {
  await a.bootstrap('tenant-a', 'Alpha', 'https://idp.example/a',
    { organizationId: 'tenant-a', subject: 'admin-a', displayName: 'Admin A', role: 'admin', active: true });
  await a.bootstrap('tenant-b', 'Beta', 'https://idp.example/b',
    { organizationId: 'tenant-b', subject: 'admin-b', displayName: 'Admin B', role: 'admin', active: true });
  const first = await a.createSession('https://idp.example/a', 'tenant-a', 'admin-a', Date.now() + 60_000);
  const other = await a.createSession('https://idp.example/b', 'tenant-b', 'admin-b', Date.now() + 60_000);
  return { first, other };
}

describe('shared PostgreSQL directory transaction contract (mock protocol only)', () => {
  it('serializes two hosts, scopes audit and permissions, and revokes sessions across hosts', async () => {
    const { a, b, database } = hosts();
    const { first, other } = await seed(a);
    const aAdmin = await b.verifySession(first.token);
    const bAdmin = await b.verifySession(other.token);
    expect(aAdmin).toBeTruthy();
    expect(bAdmin).toBeTruthy();
    expect(await b.readAdmin({ ...aAdmin!, organizationId: 'tenant-b' }, 'members')).toBeNull();
    const beforeB = await a.auditSummary('tenant-b');
    await Promise.all(Array.from({ length: 6 }, () => b.readAdmin(aAdmin!, 'overview')));
    expect((await a.auditSummary('tenant-a')).eventCount).toBe(8); // bootstrap + session + 6 reads
    expect((await a.auditSummary('tenant-b')).eventCount).toBe(beforeB.eventCount);
    await a.revokeSession(aAdmin!);
    expect(await b.verifySession(first.token)).toBeNull();
    expect(await b.readAdmin(aAdmin!, 'overview')).toBeNull();
    expect((await b.readAdmin(bAdmin!, 'members') as { organizationId: string }).organizationId).toBe('tenant-b');
    expect(database.content).not.toContain(first.token);
    expect(database.releases).toBeGreaterThan(10);
  });

  it('rolls back failed audit/write and fails closed for absent, corrupted or disconnected store', async () => {
    const { a, b, database, store } = hosts();
    await expect(b.readAdmin({ organizationId: 'tenant-a', issuer: 'x', subject: 'x', sessionId: 'x' }, 'members')).rejects.toThrow();
    const { first } = await seed(a);
    const identity = (await b.verifySession(first.token))!;
    const before = database.content;
    database.failUpdate = true;
    await expect(b.readAdmin(identity, 'overview')).rejects.toThrow('Write unavailable');
    database.failUpdate = false;
    expect(database.content).toBe(before);
    database.failConnect = true;
    await expect(a.revokeSession(identity)).rejects.toThrow('Database unavailable');
    database.failConnect = false;
    expect(await b.verifySession(first.token)).not.toBeNull();
    const state = JSON.parse(database.content!);
    state.organizations['tenant-a'].members['admin-a'].organizationId = 'tenant-b';
    database.content = JSON.stringify(state);
    await expect(store().read()).rejects.toThrow('Directory membership is invalid');
    await expect(b.readAdmin(identity, 'members')).rejects.toThrow('Directory membership is invalid');
  });

  it('mounts a mock-only HTTP backend on another host with tenant and revocation checks', async () => {
    const { a, b, database } = hosts();
    const { first, other } = await seed(a);
    const actor = (await a.verifySession(first.token))!;
    await a.setMember(actor, { organizationId: 'tenant-a', subject: 'worker', displayName: 'Worker', role: 'member', active: true });
    const worker = await a.createSession('https://idp.example/a', 'tenant-a', 'worker', Date.now() + 60_000);
    const origin = 'http://127.0.0.1:39394';
    const options = { applicationOrigin: origin, allowInsecureLoopbackForTests: true,
      verifySession: (token: string) => b.verifySession(token), directory: b };
    const app = express();
    app.use('/api/enterprise', createEnterpriseBrowserRouter(options));
    app.use('/api/enterprise', createEnterpriseAdminMutationRouter(options));
    const target = '/api/enterprise/organizations/tenant-a/members/worker/deactivate';
    const call = (path: string, token: string) => request(app).post(path)
      .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
      .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
      .set('Cookie', `interpreter-enterprise-session=${token}`).send({});
    expect((await call('/api/enterprise/organizations/tenant-b/members/admin-b/deactivate', first.token)).status).toBe(403);
    expect((await call(target, other.token)).status).toBe(403);
    expect((await call(target, worker.token)).status).toBe(403);
    database.failConnect = true;
    expect((await call(target, first.token)).status).toBe(503);
    database.failConnect = false;
    expect((await call(target, first.token)).status).toBe(204);
    expect(await a.verifySession(worker.token)).toBeNull();
    expect((await call(target, first.token)).status).toBe(403);
    expect((await request(app).get('/api/enterprise/organizations/tenant-b/overview')
      .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${first.token}`)).status).toBe(403);
  });

  it('requires a pinned TLS CA and never accepts a URI that can override SSL options', async () => {
    const base = { host: 'db.example.test', port: 5432, database: 'enterprise', user: 'directory',
      password: 'mock-only', caCertificate: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----' };
    expect(() => createEnterprisePostgresPool({ ...base, host: 'postgres://db.example.test' })).toThrow();
    expect(() => createEnterprisePostgresPool({ ...base, caCertificate: '' })).toThrow();
    const pool = createEnterprisePostgresPool(base);
    expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: true, servername: base.host });
    await pool.end();
  });
});
