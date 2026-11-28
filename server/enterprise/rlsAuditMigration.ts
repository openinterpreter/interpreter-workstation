import { createHash } from 'node:crypto';
import { decodeDirectoryState, MAX_DIRECTORY_BYTES, validateDirectoryState, type DirectoryState } from './serverDirectory';

export const auditDigest = (content: string): string => createHash('sha256').update(content).digest('hex');
/** Shared migration/write/page limit; oversized legacy rows require review. */
export const MAX_AUDIT_PAGE_EVENT_BYTES = 65_536;
export type LegacyAuditRow = Readonly<{ id: string; content: string }>;
type Result = { rowCount: number | null; rows: Array<Record<string, unknown>> };
type MigrationClient = { query(sql: string, values?: unknown[]): Promise<Result>; release(discard?: boolean): void };
type MigrationPool = { connect(): Promise<MigrationClient> };

/** Pure, fail-closed offline migration transformation. The operator must hold
 * directory/ledger writer locks in one database transaction and verify a
 * recoverable backup before applying its output. No application request calls
 * this function; it never resets or truncates audit rows. */
export function prepareLedgerOnlySnapshot(organizationId: string, serialized: string,
  rows: readonly LegacyAuditRow[]): string {
  const state = decodeDirectoryState(serialized);
  if (state.version !== 1 || !/^[a-zA-Z0-9._@:-]{1,160}$/.test(organizationId) ||
      ['__proto__', 'constructor', 'prototype'].includes(organizationId) ||
      Object.keys(state.organizations).some((id) => id !== organizationId) ||
      (!state.organizations[organizationId] && (rows.length > 0 ||
        Object.keys(state.attempts).length > 0 || Object.keys(state.sessions).length > 0 ||
        (state.pendingAudit?.length ?? 0) > 0)) ||
      Object.values(state.attempts).some((entry) => entry.organizationId !== organizationId) ||
      Object.values(state.sessions).some((entry) => entry.organizationId !== organizationId) ||
      state.audit.some((entry) => entry.organizationId !== organizationId) ||
      (state.pendingAudit ?? []).some(({ event }) => event.organizationId !== organizationId ||
        Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_AUDIT_PAGE_EVENT_BYTES) ||
      rows.length !== state.audit.length) {
    throw new Error('Legacy tenant directory and audit ledger disagree');
  }
  let lastId = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const id = typeof row.id === 'string' && /^[1-9]\d*$/.test(row.id) ? Number(row.id) : NaN;
    if (!Number.isSafeInteger(id) || id <= lastId ||
        Buffer.byteLength(row.content, 'utf8') > MAX_AUDIT_PAGE_EVENT_BYTES ||
        row.content !== JSON.stringify(state.audit[index])) {
      throw new Error('Legacy tenant directory and audit ledger disagree');
    }
    lastId = id;
  }
  const next: DirectoryState = { ...state, version: 2, audit: [], auditCursor: {
    count: rows.length, lastId,
    tailDigest: rows.length ? auditDigest(rows.at(-1)!.content) : null,
    latestAt: state.audit.at(-1)?.at ?? null,
  } };
  validateDirectoryState(next);
  const content = JSON.stringify(next);
  if (Buffer.byteLength(content, 'utf8') > MAX_DIRECTORY_BYTES) throw new Error('Tenant directory capacity reached');
  return content;
}

/** Offline, operator-only migration. The caller verifies a restorable backup
 * before invoking this; production HTTP and the tenant database role must not
 * possess this pool. All tenants, or none, switch within one transaction. */
export async function migrateEnterpriseRlsAuditSnapshots(pool: MigrationPool): Promise<number> {
  const client = await pool.connect();
  let transaction = false;
  let discard = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const operator = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) AS operator_ok`);
    if (operator.rowCount !== 1 || operator.rows[0]?.operator_ok !== true) {
      throw new Error('Audit migration requires an operator who bypasses FORCE RLS');
    }
    await client.query('LOCK TABLE public.interpreter_enterprise_rls_directory IN SHARE ROW EXCLUSIVE MODE');
    await client.query('LOCK TABLE public.interpreter_enterprise_rls_audit IN ACCESS EXCLUSIVE MODE');
    const schema = await client.query(`SELECT
      (SELECT atttypid = 'text'::regtype FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.interpreter_enterprise_rls_directory'::regclass
         AND attname = 'content' AND attnum > 0 AND NOT attisdropped)
      AND (SELECT atttypid = 'text'::regtype FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.interpreter_enterprise_rls_audit'::regclass
         AND attname = 'content' AND attnum > 0 AND NOT attisdropped) AS schema_ok`);
    if (schema.rowCount !== 1 || schema.rows[0]?.schema_ok !== true) throw new Error('Expected text audit schema');
    const orphan = await client.query(`SELECT a.id FROM public.interpreter_enterprise_rls_audit a
      LEFT JOIN public.interpreter_enterprise_rls_directory d ON d.organization_id = a.organization_id
      WHERE d.organization_id IS NULL LIMIT 1`);
    if (orphan.rowCount !== 0) throw new Error('Orphan tenant audit ledger');
    const directories = await client.query(`SELECT organization_id, content
      FROM public.interpreter_enterprise_rls_directory ORDER BY organization_id FOR UPDATE`);
    if (directories.rowCount !== directories.rows.length || directories.rows.length === 0) {
      throw new Error('No legacy tenant directory to migrate');
    }
    for (const directory of directories.rows) {
      if (typeof directory.organization_id !== 'string' || typeof directory.content !== 'string') {
        throw new Error('Legacy tenant directory is invalid');
      }
      const ledger = await client.query(`SELECT id::text AS id, content
        FROM public.interpreter_enterprise_rls_audit WHERE organization_id = $1 ORDER BY id`,
      [directory.organization_id]);
      if (ledger.rowCount !== ledger.rows.length || ledger.rows.some((row) =>
        typeof row.id !== 'string' || typeof row.content !== 'string')) {
        throw new Error('Legacy tenant audit ledger is invalid');
      }
      const content = prepareLedgerOnlySnapshot(directory.organization_id, directory.content,
        ledger.rows as LegacyAuditRow[]);
      const updated = await client.query(`UPDATE public.interpreter_enterprise_rls_directory
        SET content = $1 WHERE organization_id = $2 AND content = $3`,
      [content, directory.organization_id, directory.content]);
      if (updated.rowCount !== 1) throw new Error('Tenant directory changed during migration');
    }
    await client.query('COMMIT');
    transaction = false;
    return directories.rows.length;
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    }
    throw error;
  } finally { client.release(discard); }
}
