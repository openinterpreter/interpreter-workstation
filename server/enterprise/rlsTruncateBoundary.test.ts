import { describe, expect, test } from 'bun:test';
import { TenantPostgresDirectoryStore } from './postgresDirectoryStore';
import { blankDirectoryState } from './serverDirectory';

describe('operator-provisioned tenant role boundary', () => {
  test('checks TRUNCATE on all three RLS tables before reading tenant data', async () => {
    const statements: string[] = [];
    let released = 0;
    const pool = {
      query: async () => { throw new Error('RLS reads cannot query a different pooled connection'); },
      connect: async () => ({ query: async (sql: string) => {
          statements.push(sql);
          return { rowCount: 1, rows: [{ boundary_ok: false }] };
        }, release: () => { released++; } }),
    };
    const store = new TenantPostgresDirectoryStore(pool, 'tenant-a', 'rls');
    await expect(store.read()).rejects.toThrow('Enterprise tenant database boundary is unsafe');
    expect(statements).toHaveLength(1);
    expect(released).toBe(1);
    for (const table of ['audit', 'domain_claim']) {
      expect(statements[0]).toContain(`'public.interpreter_enterprise_rls_${table}', 'UPDATE, DELETE, TRUNCATE'`);
    }
    expect(statements[0]).toContain("'public.interpreter_enterprise_rls_directory', 'INSERT, DELETE, TRUNCATE'");
    expect(statements[0]).toContain('JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = current_user');
    expect(statements[0]).not.toContain('SELECT content FROM public.interpreter_enterprise_rls_directory');
  });

  test('claim privilege check and claim read share one leased connection', async () => {
    const statements: string[] = [];
    let released = 0;
    const pool = {
      query: async () => { throw new Error('Claim status cannot query a different pooled connection'); },
      connect: async () => ({ query: async (sql: string) => {
        statements.push(sql);
        return sql.includes('AS boundary_ok') ? { rowCount: 1, rows: [{ boundary_ok: true }] }
          : { rowCount: 1, rows: [{ domain: 'tenant.example' }] };
      }, release: () => { released++; } }),
    };
    const store = new TenantPostgresDirectoryStore(pool, 'tenant-a', 'rls');
    expect(await store.domainClaimStatus('tenant-a', 'https://idp.invalid/a', 'tenant.example')).toBe(true);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain('FROM public.interpreter_enterprise_rls_domain_claim');
    expect(released).toBe(1);
    expect(await store.domainClaimStatus('tenant-b', 'https://idp.invalid/a', 'tenant.example')).toBe(false);
    expect(statements).toHaveLength(2);
  });

  test('recovery preflight reads only a scoped snapshot after RLS privilege check', async () => {
    const state = blankDirectoryState();
    state.organizations['tenant-a'] = { name: 'Tenant A', issuer: 'https://idp.invalid/a', members: {},
      domainProofs: { 'tenant.example': { issuer: 'https://idp.invalid/a', challengeHash: 'a'.repeat(64),
        expiresAt: Date.now() - 20_000, verifiedUntil: Date.now() - 10_000 } } };
    const statements: string[] = [];
    let safe = true;
    let released = 0;
    const pool = {
      query: async () => { throw new Error('Recovery may not change pooled connections'); },
      connect: async () => ({ query: async (sql: string, values?: unknown[]) => {
        statements.push(sql);
        if (sql.includes('AS boundary_ok')) return { rowCount: 1, rows: [{ boundary_ok: safe }] };
        expect(values).toEqual(['tenant-a']);
        return { rowCount: 1, rows: [{ content: JSON.stringify(state) }] };
      }, release: () => { released++; } }),
    };
    const store = new TenantPostgresDirectoryStore(pool, 'tenant-a', 'rls');
    expect(await store.probeDomainRecovery('tenant-b', 'https://idp.invalid/a', 'tenant.example')).toBe(false);
    expect(statements).toHaveLength(0);
    expect(await store.probeDomainRecovery('tenant-a', 'https://idp.invalid/a', 'tenant.example')).toBe(true);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain('WHERE organization_id = $1');
    expect(statements[1]).not.toContain('rls_audit');
    state.organizations['tenant-a']!.domainProofs!['tenant.example']!.verifiedUntil = Date.now() + 60_000;
    expect(await store.probeDomainRecovery('tenant-a', 'https://idp.invalid/a', 'tenant.example')).toBe(false);
    safe = false;
    const before = statements.length;
    await expect(store.probeDomainRecovery('tenant-a', 'https://idp.invalid/a', 'tenant.example'))
      .rejects.toThrow('Enterprise tenant database boundary is unsafe');
    expect(statements).toHaveLength(before + 1);
    expect(released).toBe(3);
  });
});
