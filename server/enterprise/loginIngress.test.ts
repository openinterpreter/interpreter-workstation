import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { ENTERPRISE_RLS_LOGIN_INGRESS_SCHEMA, PostgresEnterpriseLoginIngress } from './loginIngress';

const role = { ssl: true, rolsuper: false, rolbypassrls: false, rolinherit: false,
  rolcreaterole: false, rolcreatedb: false, rolreplication: false, organization_id: 'org-a',
  directory_rls: true, directory_force: true, limiter_rls: true, limiter_force: true,
  table_owner: false, can_delete: false, can_truncate: false,
  can_select: true, can_insert: true, can_update_digest: true, can_update_window: true, can_update_hits: true };
const tls = { options: { host: '127.0.0.1', ssl: { servername: '127.0.0.1', rejectUnauthorized: true,
  ca: '-----BEGIN CERTIFICATE-----fixture' } } };

describe('separately operator-provisioned bounded tenant ingress', () => {
  test('requires scoped FORCE RLS, pinned TLS, a non-owner tenant role and a private shared key', async () => {
    expect(ENTERPRISE_RLS_LOGIN_INGRESS_SCHEMA).toContain('FORCE ROW LEVEL SECURITY');
    expect(ENTERPRISE_RLS_LOGIN_INGRESS_SCHEMA).toContain('slot BETWEEN 0 AND 4095');
    for (const override of [{ ssl: false }, { rolbypassrls: true }, { can_delete: true },
      { limiter_force: false }, { organization_id: null }, { table_owner: true }]) {
      const pool = { ...tls, query: async () => ({ rowCount: 1, rows: [{ ...role, ...override }] }) } as unknown as Pool;
      await expect(PostgresEnterpriseLoginIngress.connect(pool, 'org-a', Buffer.alloc(32, 1)))
        .rejects.toThrow('RLS and TLS boundary');
    }
    const pool = { ...tls, query: async () => ({ rowCount: 1, rows: [role] }) } as unknown as Pool;
    await expect(PostgresEnterpriseLoginIngress.connect(pool, 'org-a', Buffer.alloc(16, 1)))
      .rejects.toThrow('Invalid tenant ingress configuration');
    await expect(PostgresEnterpriseLoginIngress.connect({ ...pool, options: { host: '127.0.0.1', ssl: false } } as Pool,
      'org-a', Buffer.alloc(32, 1))).rejects.toThrow('Pinned tenant ingress TLS');
  });

  test('hashes network identities, constrains slots, does not query foreign tenants and denies on exhausted slots', async () => {
    let admitted = true;
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const pool = { ...tls, query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return queries.length === 1 ? { rowCount: 1, rows: [role] } : { rowCount: admitted ? 1 : 0, rows: [] };
    } } as unknown as Pool;
    const ingress = await PostgresEnterpriseLoginIngress.connect(pool, 'org-a', Buffer.alloc(32, 2));
    expect(await ingress.admit('org-b', '198.51.100.7', 'login')).toBe(false);
    expect(await ingress.admit('org-a', 'not-an-ip', 'login')).toBe(false);
    expect(await ingress.admit('org-a', '198.51.100.7', '__proto__' as 'login')).toBe(false);
    expect(queries).toHaveLength(1);
    expect(await ingress.admit('org-a', '198.51.100.7', 'login')).toBe(true);
    expect(queries[1]?.sql).toContain('ON CONFLICT (organization_id, operation, slot) DO UPDATE');
    expect(queries[1]?.values[0]).toBe('org-a');
    expect(queries[1]?.values[1]).toBeGreaterThanOrEqual(0);
    expect(queries[1]?.values[1]).toBeLessThan(4096);
    expect(queries[1]?.values[3]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(queries[1]?.values)).not.toContain('198.51.100.7');
    expect(queries[1]?.values[4]).toBe(12);
    admitted = false;
    expect(await ingress.admit('org-a', '198.51.100.7', 'login')).toBe(false);
    expect(await ingress.admit('org-a', '2001:db8:0:1::/64', 'callback')).toBe(false);
    expect(queries.at(-1)?.values[4]).toBe(60);
  });
});
