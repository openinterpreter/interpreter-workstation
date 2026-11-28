import { describe, expect, test } from 'bun:test';
import { blankDirectoryState, decodeDirectoryState } from './serverDirectory';
import { auditDigest, migrateEnterpriseRlsAuditSnapshots, prepareLedgerOnlySnapshot,
  MAX_AUDIT_PAGE_EVENT_BYTES, type LegacyAuditRow } from './rlsAuditMigration';

function fixture(organizationId = 'org-a') {
  const state = blankDirectoryState();
  const subject = 'opaque\u0000subject|quote"slash\\';
  state.organizations[organizationId] = { name: 'Alpha', issuer: 'https://idp.invalid/a',
    members: { [subject]: { organizationId, subject, displayName: 'Opaque', role: 'admin', active: true } } };
  state.audit.push({ organizationId, subject, action: 'organization.bootstrap',
    outcome: 'allowed', at: '2026-01-01T00:00:00.000Z' });
  state.audit.push({ organizationId, subject, action: 'organization.member.read',
    outcome: 'denied', at: '2026-01-01T00:01:00.000Z' });
  state.pendingAudit = [{ position: 2, event: { organizationId, subject,
    action: 'organization.audit.read', outcome: 'denied', at: '2026-01-01T00:02:00.000Z',
    firstAt: '2026-01-01T00:02:00.000Z', count: 1 } }];
  const rows: LegacyAuditRow[] = state.audit.map((event, index) => ({ id: String(index * 3 + 7), content: JSON.stringify(event) }));
  return { source: JSON.stringify(state), rows, subject };
}

describe('offline RLS audit snapshot transformation, no DB credentials', () => {
  test('an unbootstrapped, empty operator-provisioned tenant can migrate without inventing audit', () => {
    const next = decodeDirectoryState(prepareLedgerOnlySnapshot('org-new', JSON.stringify(blankDirectoryState()), []));
    expect(next.auditCursor).toEqual({ count: 0, lastId: 0, tailDigest: null, latestAt: null });
    expect(next.organizations).toEqual({});
  });
  test('preserves ordered opaque subjects and pending denials without storing committed history twice', () => {
    const { source, rows, subject } = fixture();
    const serialized = prepareLedgerOnlySnapshot('org-a', source, rows);
    const state = decodeDirectoryState(serialized);
    expect(state.version).toBe(2);
    expect(state.audit).toEqual([]);
    expect(state.auditCursor).toEqual({ count: 2, lastId: 10, tailDigest: auditDigest(rows[1]!.content),
      latestAt: '2026-01-01T00:01:00.000Z' });
    expect(state.pendingAudit?.[0]?.position).toBe(2);
    expect(state.pendingAudit?.[0]?.event.subject).toBe(subject);
    expect(state.organizations['org-a']?.members[subject]?.subject).toBe(subject);
    expect(serialized).toContain('\\u0000'); // JSON text survives without PostgreSQL jsonb coercion.
    expect(serialized).not.toContain('organization.bootstrap');
  });

  test('refuses missing, reordered, rewritten, foreign and repeated migrations', () => {
    const { source, rows } = fixture();
    for (const altered of [rows.slice(0, 1), [...rows].reverse(),
      [rows[0]!, { ...rows[1]!, content: rows[1]!.content.replace('denied', 'allowed') }],
      [rows[0]!, { ...rows[1]!, id: rows[0]!.id }]]) {
      expect(() => prepareLedgerOnlySnapshot('org-a', source, altered)).toThrow('disagree');
    }
    expect(() => prepareLedgerOnlySnapshot('org-b', source, rows)).toThrow('disagree');
    expect(() => prepareLedgerOnlySnapshot('org-a', prepareLedgerOnlySnapshot('org-a', source, rows), rows))
      .toThrow('disagree');
    const foreign = JSON.parse(source);
    foreign.audit[0].organizationId = 'org-b';
    expect(() => prepareLedgerOnlySnapshot('org-a', JSON.stringify(foreign), rows)).toThrow();
    const oversized = JSON.parse(source);
    oversized.audit[0].action = 'x'.repeat(MAX_AUDIT_PAGE_EVENT_BYTES);
    expect(() => prepareLedgerOnlySnapshot('org-a', JSON.stringify(oversized),
      [{ ...rows[0]!, content: JSON.stringify(oversized.audit[0]) }, rows[1]!])).toThrow('disagree');
    const pendingOversized = JSON.parse(source);
    pendingOversized.pendingAudit[0].event.action = 'x'.repeat(MAX_AUDIT_PAGE_EVENT_BYTES);
    expect(() => prepareLedgerOnlySnapshot('org-a', JSON.stringify(pendingOversized), rows)).toThrow('disagree');
  });

  test('locks and migrates all tenants atomically; a corrupt second tenant rolls back the first', async () => {
    const initial = new Map([
      ['org-a', { content: fixture('org-a').source, ledger: fixture('org-a').rows }],
      ['org-b', { content: fixture('org-b').source, ledger: fixture('org-b').rows }],
    ]);
    let operator = true;
    const statements: string[] = [];
    const pool = { connect: async () => {
      let staged = new Map([...initial].map(([id, row]) => [id, { ...row }]));
      return { query: async (sql: string, values: unknown[] = []) => {
        statements.push(sql);
        if (sql === 'BEGIN' || sql.startsWith('SET LOCAL') || sql.startsWith('LOCK TABLE')) return { rowCount: 0, rows: [] };
        if (sql.includes('AS operator_ok')) return { rowCount: 1, rows: [{ operator_ok: operator }] };
        if (sql.includes('AS schema_ok')) return { rowCount: 1, rows: [{ schema_ok: true }] };
        if (sql.includes('LEFT JOIN public.interpreter_enterprise_rls_directory')) return { rowCount: 0, rows: [] };
        if (sql.startsWith('SELECT organization_id, content')) {
          const rows = [...staged].map(([organization_id, row]) => ({ organization_id, content: row.content }));
          return { rowCount: rows.length, rows };
        }
        if (sql.startsWith('SELECT id::text AS id')) {
          const rows = staged.get(String(values[0]))?.ledger ?? [];
          return { rowCount: rows.length, rows };
        }
        if (sql.startsWith('UPDATE public.interpreter_enterprise_rls_directory')) {
          const row = staged.get(String(values[1]));
          if (!row || row.content !== values[2]) return { rowCount: 0, rows: [] };
          row.content = String(values[0]);
          return { rowCount: 1, rows: [] };
        }
        if (sql === 'COMMIT') { initial.clear(); for (const [id, row] of staged) initial.set(id, row); return { rowCount: 0, rows: [] }; }
        if (sql === 'ROLLBACK') { staged = new Map(); return { rowCount: 0, rows: [] }; }
        throw new Error(`Unexpected SQL: ${sql}`);
      }, release: () => {} };
    } };
    operator = false;
    await expect(migrateEnterpriseRlsAuditSnapshots(pool)).rejects.toThrow('bypasses FORCE RLS');
    expect(statements).not.toContain('LOCK TABLE public.interpreter_enterprise_rls_directory IN SHARE ROW EXCLUSIVE MODE');
    statements.length = 0;
    operator = true;
    initial.get('org-b')!.ledger = [{ ...initial.get('org-b')!.ledger[0]!, content: '{}' }, initial.get('org-b')!.ledger[1]!];
    const beforeA = initial.get('org-a')!.content;
    await expect(migrateEnterpriseRlsAuditSnapshots(pool)).rejects.toThrow('disagree');
    expect(initial.get('org-a')!.content).toBe(beforeA);
    initial.get('org-b')!.ledger = fixture('org-b').rows;
    expect(await migrateEnterpriseRlsAuditSnapshots(pool)).toBe(2);
    for (const row of initial.values()) {
      const next = decodeDirectoryState(row.content);
      expect(next.version).toBe(2);
      expect(next.audit).toEqual([]);
      expect(next.auditCursor?.count).toBe(2);
    }
    await expect(migrateEnterpriseRlsAuditSnapshots(pool)).rejects.toThrow('disagree');
  });
});
