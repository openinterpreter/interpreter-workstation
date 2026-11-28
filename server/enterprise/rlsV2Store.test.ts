import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { ServerDirectory, blankDirectoryState, MAX_DIRECTORY_BYTES } from './serverDirectory';
import { TenantPostgresDirectoryStore } from './postgresDirectoryStore';
import { MAX_AUDIT_PAGE_EVENT_BYTES } from './rlsAuditMigration';
import { createEnterpriseAuditPageRouter } from './oidcHttp';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
type Row = { content: string; ledger: Array<{ id: number; content: string }> };
function syntheticRlsPool() {
  const rows = new Map<string, Row>();
  const statements: string[] = [];
  let sequence = 0;
  let failInsert = false;
  let failProbe = false;
  let claimed = true;
  const provision = (organizationId: string) => {
    const state = { ...blankDirectoryState(), version: 2 as const,
      auditCursor: { count: 0, lastId: 0, tailDigest: null as string | null, latestAt: null as string | null } };
    rows.set(organizationId, { content: JSON.stringify(state), ledger: [] });
  };
  const result = (row: Row | undefined, ledgerOnly = false) => row ? {
    rowCount: 1, rows: [{ ...(!ledgerOnly ? { content: row.content } : {}),
      audit_contents: row.ledger.map(({ content }) => content),
      audit_ids: row.ledger.map(({ id }) => String(id)) }],
  } : { rowCount: 0, rows: [] };
  const query = async (sql: string, params: unknown[] = [], staged?: Map<string, Row>) => {
    statements.push(sql);
    const db = staged ?? rows;
    if (sql.includes('AS boundary_ok')) return { rowCount: 1, rows: [{ boundary_ok: true }] };
    const tenant = String(params.at(-1) ?? '');
    if (sql.includes('AS audit_count')) {
      const row = db.get(tenant);
      const last = row?.ledger.at(-1);
      return row ? { rowCount: 1, rows: [{ ...(sql.startsWith('SELECT d.content') ? { content: row.content } : {}),
        audit_count: String(row.ledger.length), audit_last_id: last ? String(last.id) : null,
        audit_last_content: last?.content ?? null }] } : { rowCount: 0, rows: [] };
    }
    if (sql.startsWith('SELECT d.content')) return result(db.get(tenant));
    if (sql.startsWith('SELECT content FROM public.interpreter_enterprise_rls_directory')) {
      if (failProbe) throw new Error('Tenant directory unavailable');
      return result(db.get(tenant));
    }
    if (sql.startsWith('SELECT COALESCE')) return result(db.get(tenant), true);
    if (sql.startsWith('SELECT domain FROM public.interpreter_enterprise_rls_domain_claim')) {
      const row = db.get(String(params[1]));
      const proof = row && JSON.parse(row.content).organizations[String(params[1])]?.domainProofs?.[String(params[0])];
      return claimed && proof?.issuer === params[2]
        ? { rowCount: 1, rows: [{ domain: params[0] }] } : { rowCount: 0, rows: [] };
    }
    if (sql.startsWith('SELECT id::text AS id,') && sql.includes('FROM public.interpreter_enterprise_rls_audit')) {
      const row = db.get(String(params[0]));
      const items = row?.ledger.filter(({ id }) => id > Number(params[1]) && id <= Number(params[2]))
        .slice(0, Number(params[3])).map(({ id, content }) => ({ id: String(id),
          content: Buffer.byteLength(content, 'utf8') <= MAX_AUDIT_PAGE_EVENT_BYTES ? content : null })) ?? [];
      return { rowCount: items.length, rows: items };
    }
    if (sql.startsWith('INSERT INTO public.interpreter_enterprise_rls_audit')) {
      if (failInsert) throw new Error('Audit insert unavailable');
      const row = db.get(String(params[0]));
      if (!row) throw new Error('Missing tenant');
      const id = ++sequence;
      row.ledger.push({ id, content: String(params[1]) });
      return { rowCount: 1, rows: [{ id: String(id) }] };
    }
    if (sql.startsWith('UPDATE public.interpreter_enterprise_rls_directory')) {
      const row = db.get(String(params[1]));
      if (!row) return { rowCount: 0, rows: [] };
      row.content = String(params[0]);
      return { rowCount: 1, rows: [] };
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected synthetic SQL: ${sql.slice(0, 80)}`);
  };
  return { rows, statements, provision, failInserts: (value: boolean) => { failInsert = value; },
    failProbes: (value: boolean) => { failProbe = value; },
    claim: (value: boolean) => { claimed = value; },
    appendHistory: (organizationId: string, subject: string) => {
      const row = rows.get(organizationId)!;
      const event = { organizationId, subject, action: `runtime.${'x'.repeat(10_000)}`,
        outcome: 'allowed', at: new Date().toISOString() };
      const text = JSON.stringify(event);
      for (let i = 0; i < Math.ceil((MAX_DIRECTORY_BYTES + 20_000) / text.length); i++) {
        row.ledger.push({ id: ++sequence, content: text });
      }
      const state = JSON.parse(row.content);
      state.auditCursor = { count: row.ledger.length, lastId: sequence, tailDigest: digest(text), latestAt: event.at };
      row.content = JSON.stringify(state);
      return row.ledger.length * text.length;
    },
    query: async () => { throw new Error('RLS read must use its boundary-checked connection'); },
    connect: async () => {
      const staged = new Map([...rows].map(([id, row]) => [id,
        { content: row.content, ledger: row.ledger.map((entry) => ({ ...entry })) }]));
      let committed = false;
      return { query: async (sql: string, params?: unknown[]) => {
        const value = await query(sql, params, staged);
        if (sql === 'COMMIT') { for (const [id, row] of staged) rows.set(id, row); committed = true; }
        return value;
      }, release: () => { void committed; } };
    } };
}

describe('unmounted RLS v2 store protocol, synthetic only', () => {
  test('bounded page is tenant-scoped, stable and revocation-fenced under one locked audit transaction', async () => {
    const pool = syntheticRlsPool();
    pool.provision('org-a'); pool.provision('org-b');
    const store = new TenantPostgresDirectoryStore(pool, 'org-a', 'rls-v2');
    const a = new ServerDirectory(store);
    await a.bootstrap('org-a', 'Alpha', 'https://idp.invalid/a',
      { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
    const row = pool.rows.get('org-a')!;
    const state = JSON.parse(row.content);
    state.organizations['org-a'].domainProofs = { 'tenant.example': { issuer: 'https://idp.invalid/a',
      challengeHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000, verifiedUntil: Date.now() + 60_000 } };
    row.content = JSON.stringify(state);
    const admin = await a.createSession('https://idp.invalid/a', 'org-a', 'alice',
      Date.now() + 60_000, 0, 'tenant.example');
    await a.setMember(admin.identity,
      { organizationId: 'org-a', subject: 'bob', displayName: 'Bob', role: 'member', active: true });
    const member = await a.createSession('https://idp.invalid/a', 'org-a', 'bob',
      Date.now() + 60_000, 0, 'tenant.example');
    const beforeUnknown = pool.statements.length;
    expect(await a.takeAttempt('unknown-state', 'browser-binding')).toBeNull();
    const unknownQueries = pool.statements.slice(beforeUnknown);
    expect(unknownQueries.some((sql) => sql.includes('AS boundary_ok'))).toBe(true);
    expect(unknownQueries.some((sql) => sql.includes('SELECT content FROM public.interpreter_enterprise_rls_directory'))).toBe(true);
    expect(unknownQueries.some((sql) => sql.includes('count(*)::text') || sql.startsWith('UPDATE') || sql.startsWith('INSERT'))).toBe(false);
    pool.failProbes(true);
    await expect(a.takeAttempt('unknown-state', 'browser-binding')).rejects.toThrow('Tenant directory unavailable');
    pool.failProbes(false);
    const binding = 'bound-browser';
    await a.putAttempt('known-state', { organizationId: 'org-a', issuer: 'https://idp.invalid/a',
      nonce: 'nonce', verifier: 'verifier', bindingHash: digest(binding), expiresAt: Date.now() + 60_000 });
    const beforeKnown = pool.statements.length;
    expect((await a.takeAttempt('known-state', binding))?.nonce).toBe('nonce');
    expect(pool.statements.slice(beforeKnown).some((sql) => sql.includes('count(*)::text'))).toBe(true);
    for (let i = 0; i < 10; i++) {
      await expect(store.readAuditPage(member.identity, 0)).rejects.toThrow('Access denied');
    }
    const denied = JSON.parse(pool.rows.get('org-a')!.content).pendingAudit;
    expect(denied).toHaveLength(1);
    expect(denied[0].event).toMatchObject({ subject: 'bob', action: 'organization.audit.page.view',
      outcome: 'denied', count: 10 });
    const first = await store.readAuditPage(admin.identity, 0, undefined, 1);
    expect(first.events).toHaveLength(1);
    expect(first.nextId).toBe(first.events[0]?.id);
    expect(first.pendingCount).toBe(1);
    const second = await store.readAuditPage(admin.identity, first.nextId!, first.upperId, 1, 'export');
    expect(second.events).toHaveLength(1);
    expect(second.nextId).not.toBeNull();
    expect(second.upperId).toBe(first.upperId);
    expect(second.events[0]?.event.action).toBe('session.create');
    const rest = await store.readAuditPage(admin.identity, second.nextId!, first.upperId, 100);
    expect(rest.events.length).toBeGreaterThan(0);
    expect(rest.nextId).toBeNull();
    expect(rest.upperId).toBe(first.upperId);
    const exportPage = await store.readAuditPage(admin.identity, 0, undefined, 100, 'export');
    expect(exportPage.pendingCount).toBe(0);
    expect(exportPage.events.some(({ event }) => event.subject === 'bob' &&
      event.action === 'organization.audit.page.view' && event.count === 10)).toBe(true);
    await expect(store.readAuditPage(member.identity, 0)).rejects.toThrow('Access denied');
    const beforeFailedExport = pool.rows.get('org-a')!.content;
    const beforeFailedLedger = pool.rows.get('org-a')!.ledger.length;
    pool.failInserts(true);
    await expect(store.readAuditPage(admin.identity, 0, undefined, 100, 'export'))
      .rejects.toThrow('Audit insert unavailable');
    pool.failInserts(false);
    expect(pool.rows.get('org-a')!.content).toBe(beforeFailedExport);
    expect(pool.rows.get('org-a')!.ledger).toHaveLength(beforeFailedLedger);
    const retry = await store.readAuditPage(admin.identity, 0, undefined, 100, 'export');
    expect(retry.pendingCount).toBe(0);
    expect(retry.events.some(({ event }) => event.subject === 'bob' && event.count === 1)).toBe(true);
    expect(pool.rows.get('org-a')!.ledger.some(({ content }) => content.includes('organization.audit.page.export'))).toBe(true);
    expect(pool.statements.some((sql) => sql.includes('ORDER BY id LIMIT $4'))).toBe(true);
    expect(pool.statements.some((sql) => sql.includes('CASE WHEN octet_length(content) <= 65536'))).toBe(true);
    expect(pool.statements.some((sql) => sql.includes('array_agg'))).toBe(false);
    await expect(store.readAuditPage({ ...admin.identity, organizationId: 'org-b' }, 0)).rejects.toThrow('Access denied');
    await expect(store.readAuditPage(admin.identity, 2, 1)).rejects.toThrow('Access denied');
    const before = pool.rows.get('org-a')!.content;
    const priorEvents = pool.rows.get('org-a')!.ledger.length;
    pool.failInserts(true);
    await expect(store.readAuditPage(admin.identity, 0)).rejects.toThrow('Audit insert unavailable');
    pool.failInserts(false);
    expect(pool.rows.get('org-a')!.content).toBe(before);
    expect(pool.rows.get('org-a')!.ledger).toHaveLength(priorEvents);
    await expect(store.change((state) => { state.audit.push({ organizationId: 'org-a', subject: 'alice',
      action: 'x'.repeat(MAX_AUDIT_PAGE_EVENT_BYTES), outcome: 'allowed', at: new Date().toISOString() }); }))
      .rejects.toThrow('Tenant audit event exceeds page bound');
    expect(pool.rows.get('org-a')!.content).toBe(before);
    expect(pool.rows.get('org-a')!.ledger).toHaveLength(priorEvents);
    const firstCommitted = pool.rows.get('org-a')!.ledger[0]!;
    const priorContent = firstCommitted.content;
    firstCommitted.content = JSON.stringify({ ...JSON.parse(priorContent), action: 'x'.repeat(MAX_AUDIT_PAGE_EVENT_BYTES) });
    await expect(store.readAuditPage(admin.identity, 0)).rejects.toThrow('Tenant audit page is invalid');
    firstCommitted.content = priorContent;
    const http = express();
    const pagePath = '/api/enterprise/organizations/org-a/activity/page';
    expect((await request(http).get(pagePath)).status).toBe(404); // No implicit route mount.
    http.use('/api/enterprise', createEnterpriseAuditPageRouter({
      applicationOrigin: 'http://127.0.0.1:39394', allowInsecureLoopbackForTests: true,
      verifySession: (token) => a.verifySession(token), directory: a,
    }));
    const page = (path: string, token = admin.token) => request(http).get(path)
      .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
    expect((await page(pagePath).unset('Cookie')).status).toBe(401);
    expect((await page(`${pagePath}?after=01`)).status).toBe(403);
    expect((await page(`${pagePath}?limit=101`)).status).toBe(403);
    expect((await page(`${pagePath}?after=0&after=1`)).status).toBe(403);
    expect((await page(pagePath).set('Host', 'untrusted.test')).status).toBe(403);
    expect((await page(pagePath, member.token)).status).toBe(403);
    expect((await page('/api/enterprise/organizations/org-b/activity/page')).status).toBe(403);
    const beforeHttpOutage = pool.rows.get('org-a')!.content;
    const beforeHttpEvents = pool.rows.get('org-a')!.ledger.length;
    pool.failInserts(true);
    const unavailable = await page(`${pagePath}?after=0&purpose=export`);
    pool.failInserts(false);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers['content-disposition']).toBeUndefined();
    expect(pool.rows.get('org-a')!.content).toBe(beforeHttpOutage);
    expect(pool.rows.get('org-a')!.ledger).toHaveLength(beforeHttpEvents);
    const httpExport = await page(`${pagePath}?after=0&limit=2&purpose=export`);
    expect(httpExport.status).toBe(200);
    expect(httpExport.headers['content-disposition']).toContain('attachment');
    expect(httpExport.body).toMatchObject({ organizationId: 'org-a', pendingCount: 0 });
    expect(httpExport.body.events).toHaveLength(2);
    expect(httpExport.body.nextId).toBeNumber();
    expect(pool.rows.get('org-b')!.ledger).toHaveLength(0);
    pool.claim(false);
    await expect(store.readAuditPage(admin.identity, 0)).rejects.toThrow('Access denied');
    pool.claim(true);
    await a.revokeSession(admin.identity);
    await expect(store.readAuditPage(admin.identity, 0)).rejects.toThrow('Access denied');
    expect((await page(pagePath)).status).toBe(403);
    expect(pool.rows.get('org-b')!.ledger).toHaveLength(0);
  });

  test('legacy, unprovisioned and forged checkpoint rows fail before any mutation', async () => {
    const pool = syntheticRlsPool();
    const store = new TenantPostgresDirectoryStore(pool, 'org-a', 'rls-v2');
    await expect(store.read()).rejects.toThrow('Enterprise directory is unavailable');
    pool.provision('org-a');
    const row = pool.rows.get('org-a')!;
    const v1 = blankDirectoryState();
    row.content = JSON.stringify(v1);
    await expect(store.read()).rejects.toThrow('Tenant audit migration is required');
    await expect(store.change((state) => { state.audit.push({ organizationId: 'org-a', subject: 'x',
      action: 'forged', outcome: 'allowed', at: new Date().toISOString() }); }))
      .rejects.toThrow('Tenant audit migration is required');
    expect(row.content).toBe(JSON.stringify(v1));
    pool.provision('org-a');
    const forged = pool.rows.get('org-a')!;
    const state = JSON.parse(forged.content);
    state.auditCursor.count = 1;
    state.auditCursor.lastId = 1;
    state.auditCursor.tailDigest = 'a'.repeat(64);
    state.auditCursor.latestAt = new Date().toISOString();
    forged.content = JSON.stringify(state);
    await expect(store.read()).rejects.toThrow('Tenant audit checkpoint is out of sync');
  });

  test('export fixes one upper cursor and exposes remaining denial windows until a new pass closes them', async () => {
    const pool = syntheticRlsPool();
    pool.provision('org-a');
    const store = new TenantPostgresDirectoryStore(pool, 'org-a', 'rls-v2');
    const directory = new ServerDirectory(store);
    await directory.bootstrap('org-a', 'Alpha', 'https://idp.invalid/a',
      { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
    const row = pool.rows.get('org-a')!;
    const state = JSON.parse(row.content);
    state.organizations['org-a'].domainProofs = { 'tenant.example': { issuer: 'https://idp.invalid/a',
      challengeHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000, verifiedUntil: Date.now() + 60_000 } };
    const at = new Date().toISOString();
    state.pendingAudit = Array.from({ length: 101 }, (_, index) => ({ position: state.auditCursor.count,
      event: { organizationId: 'org-a', subject: 'alice', action: `test.denial.${index}`,
        outcome: 'denied', at, firstAt: at, count: 1 } }));
    row.content = JSON.stringify(state); // Disposable fixture only; no production row is edited.
    const admin = await directory.createSession('https://idp.invalid/a', 'org-a', 'alice',
      Date.now() + 60_000, 0, 'tenant.example');
    const first = await store.readAuditPage(admin.identity, 0, undefined, 2, 'export');
    expect(first.pendingCount).toBe(1);
    expect(first.upperId).toBeGreaterThan(100);
    const continuation = await store.readAuditPage(admin.identity, first.nextId!, first.upperId, 2, 'export');
    expect(continuation.upperId).toBe(first.upperId);
    expect(continuation.pendingCount).toBe(1);
    const nextPass = await store.readAuditPage(admin.identity, 0, undefined, 100, 'export');
    expect(nextPass.upperId).toBeGreaterThan(first.upperId);
    expect(nextPass.pendingCount).toBe(0);
    expect(pool.rows.get('org-a')!.ledger.some(({ content }) => content.includes('test.denial.100'))).toBe(true);
  });

  test('permitted member audit grows past the former snapshot cap while the directory stays bounded', async () => {
    const pool = syntheticRlsPool();
    pool.provision('org-a'); pool.provision('org-b');
    const a = new ServerDirectory(new TenantPostgresDirectoryStore(pool, 'org-a', 'rls-v2'));
    const b = new ServerDirectory(new TenantPostgresDirectoryStore(pool, 'org-b', 'rls-v2'));
    for (const [id, directory] of [['org-a', a], ['org-b', b]] as const) {
      await directory.bootstrap(id, id, `https://idp.invalid/${id}`,
        { organizationId: id, subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
      const admin = await directory.createSession(`https://idp.invalid/${id}`, id, 'alice', Date.now() + 60_000);
      await directory.setMember(admin.identity,
        { organizationId: id, subject: 'bob', displayName: 'Bob', role: 'member', active: true });
      await directory.createWorkspace(admin.identity, 'w', 'Workspace');
      await directory.setRuntimeGrant(admin.identity, 'w', 'bob', 'agent.execute', true);
    }
    const member = await a.createSession('https://idp.invalid/org-a', 'org-a', 'bob', Date.now() + 60_000);
    const other = await b.createSession('https://idp.invalid/org-b', 'org-b', 'bob', Date.now() + 60_000);
    expect(pool.appendHistory('org-a', 'bob')).toBeGreaterThan(MAX_DIRECTORY_BYTES);
    expect(Buffer.byteLength(pool.rows.get('org-a')!.content)).toBeLessThan(10_000);
    expect(await a.authorizeRuntime(member.identity, 'agent.execute', 'w')).toBe(true);
    expect(await b.authorizeRuntime(other.identity, 'agent.execute', 'w')).toBe(true);
    expect((await a.auditSummary('org-a')).eventCount).toBe(pool.rows.get('org-a')!.ledger.length);
    expect(await a.auditSummary('org-b')).toEqual({ eventCount: 0, latestAt: null });
    expect(JSON.parse(pool.rows.get('org-a')!.content).audit).toEqual([]);
    expect(pool.statements.some((sql) => sql.includes('array_agg'))).toBe(false);
    await expect(a.listAudit(member.identity)).rejects.toThrow('Paged tenant audit read is required');
    pool.failInserts(true);
    const before = pool.rows.get('org-a')!.content;
    await expect(a.authorizeRuntime(member.identity, 'agent.execute', 'w')).rejects.toThrow('Audit insert unavailable');
    expect(pool.rows.get('org-a')!.content).toBe(before);
    pool.failInserts(false);
    pool.rows.get('org-a')!.ledger.pop();
    await expect(a.verifySession(member.token)).rejects.toThrow('Tenant audit checkpoint is out of sync');
    expect((await b.verifySession(other.token))?.organizationId).toBe('org-b');
  });
});
