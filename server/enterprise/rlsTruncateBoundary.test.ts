import { describe, expect, test } from 'bun:test';
import { TenantPostgresDirectoryStore } from './postgresDirectoryStore';

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
});
