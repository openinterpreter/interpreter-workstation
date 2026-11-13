import pg, { type Pool, type PoolClient } from 'pg';
import {
  blankDirectoryState, decodeDirectoryState, MAX_DIRECTORY_BYTES, validateDirectoryState,
  type DirectoryState, type EnterpriseStateStore,
} from './serverDirectory';

/** Applied by a database operator, never by a browser request or application bootstrap. */
export const ENTERPRISE_DIRECTORY_SCHEMA = `CREATE TABLE public.interpreter_enterprise_directory (
  id smallint PRIMARY KEY CHECK (id = 1),
  content text NOT NULL
)`;

/** Separate, operator-created pilot table. This is application-scoped row
 * isolation, not PostgreSQL RLS or a per-tenant database credential boundary. */
export const ENTERPRISE_TENANT_DIRECTORY_SCHEMA = `CREATE TABLE public.interpreter_enterprise_tenant_directory (
  organization_id text PRIMARY KEY CHECK (char_length(organization_id) BETWEEN 1 AND 160 AND organization_id ~ '^[A-Za-z0-9._@:-]+$'),
  content text NOT NULL
)`;

/** Operator applies this schema and pre-provisions one row with an independent
 * NOINHERIT/NOBYPASSRLS LOGIN role per tenant. Only SELECT and UPDATE(content)
 * are granted to that role; no application role owns this table or has INSERT. */
export const ENTERPRISE_RLS_TENANT_DIRECTORY_SCHEMA = `CREATE TABLE public.interpreter_enterprise_rls_directory (
  organization_id text PRIMARY KEY CHECK (char_length(organization_id) BETWEEN 1 AND 160 AND organization_id ~ '^[A-Za-z0-9._@:-]+$'),
  database_role name NOT NULL UNIQUE,
  content text NOT NULL
);
ALTER TABLE public.interpreter_enterprise_rls_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interpreter_enterprise_rls_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY enterprise_tenant_role_scope ON public.interpreter_enterprise_rls_directory
  USING (database_role = current_user) WITH CHECK (database_role = current_user);
CREATE TABLE public.interpreter_enterprise_rls_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND
    jsonb_typeof(content->'organizationId') IS NOT DISTINCT FROM 'string' AND content->>'organizationId' = organization_id AND
    jsonb_typeof(content->'subject') IS NOT DISTINCT FROM 'string' AND btrim(content->>'subject') <> '' AND
    jsonb_typeof(content->'action') IS NOT DISTINCT FROM 'string' AND btrim(content->>'action') <> '' AND
    jsonb_typeof(content->'outcome') IS NOT DISTINCT FROM 'string' AND content->>'outcome' IN ('allowed', 'denied') AND
    jsonb_typeof(content->'at') IS NOT DISTINCT FROM 'string' AND btrim(content->>'at') <> '')
);
CREATE INDEX enterprise_rls_audit_tenant_order ON public.interpreter_enterprise_rls_audit (organization_id, id);
ALTER TABLE public.interpreter_enterprise_rls_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interpreter_enterprise_rls_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY enterprise_audit_role_scope ON public.interpreter_enterprise_rls_audit
  USING (organization_id IN (SELECT d.organization_id FROM public.interpreter_enterprise_rls_directory d
    WHERE d.database_role = current_user))
  WITH CHECK (organization_id IN (SELECT d.organization_id FROM public.interpreter_enterprise_rls_directory d
    WHERE d.database_role = current_user))`;

type QueryResult = { rows: Array<{ content?: unknown; audit_matches?: unknown }>; rowCount: number | null };
type TransactionClient = Pick<PoolClient, 'query' | 'release'>;
type DirectoryPool = { query(sql: string, values?: unknown[]): Promise<QueryResult>; connect(): Promise<TransactionClient> };

/** A shared database is required for multiple server hosts. No connection string:
 * URI sslmode overrides can silently replace a pinned CA in node-postgres. */
export function createEnterprisePostgresPool(config: Readonly<{
  host: string; port: number; database: string; user: string; password: string; caCertificate: string;
}>): Pool {
  if (!config.host || /[\s:/@\\]/.test(config.host) || !Number.isInteger(config.port) ||
      config.port < 1 || config.port > 65535 || !config.database || !config.user ||
      !config.password || !config.caCertificate.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('Invalid enterprise database configuration');
  }
  return new pg.Pool({
    host: config.host, port: config.port, database: config.database, user: config.user,
    password: config.password, ssl: { ca: config.caCertificate, rejectUnauthorized: true, servername: config.host },
    max: 8, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10_000,
    // Reads do not use the transactional SET LOCAL below. Bound them too,
    // including a stalled network response after a connection was established.
    statement_timeout: 5000, query_timeout: 6000,
    application_name: 'interpreter-enterprise-directory',
  });
}

function stateFrom(result: QueryResult): DirectoryState {
  if (result.rowCount !== 1 || result.rows.length !== 1 || typeof result.rows[0]?.content !== 'string') {
    throw new Error('Enterprise directory is unavailable');
  }
  return decodeDirectoryState(result.rows[0].content);
}

/** Transactional shared backend. Each permission check, revocation, mutation,
 * and audit append in ServerDirectory.change uses one row-locked transaction.
 * The 8 MB state cap is intentional: this is a bounded pilot seam, not a
 * horizontally scalable audit/retention system. No fallback to local state. */
export class PostgresDirectoryStore implements EnterpriseStateStore {
  constructor(private readonly pool: DirectoryPool) {}

  async read(): Promise<DirectoryState> {
    return stateFrom(await this.pool.query('SELECT content FROM public.interpreter_enterprise_directory WHERE id = 1'));
  }

  async change<T>(fn: (state: DirectoryState) => T, create = false): Promise<T> {
    const client = await this.pool.connect();
    let transaction = false;
    let discard = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      if (create) {
        // Only an explicitly invoked operator bootstrap may seed the migrated
        // singleton; application HTTP requests never pass create=true.
        await client.query('INSERT INTO public.interpreter_enterprise_directory (id, content) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
          [JSON.stringify(blankDirectoryState())]);
      }
      const state = stateFrom(await client.query('SELECT content FROM public.interpreter_enterprise_directory WHERE id = 1 FOR UPDATE'));
      const result = fn(state);
      validateDirectoryState(state);
      const content = JSON.stringify(state);
      if (Buffer.byteLength(content, 'utf8') > MAX_DIRECTORY_BYTES) throw new Error('Directory capacity reached');
      const updated = await client.query('UPDATE public.interpreter_enterprise_directory SET content = $1 WHERE id = 1', [content]);
      if (updated.rowCount !== 1) throw new Error('Enterprise directory changed unexpectedly');
      await client.query('COMMIT');
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}

function scopedTenantState(state: DirectoryState, organizationId: string): DirectoryState {
  validateDirectoryState(state);
  if (Object.keys(state.organizations).some((id) => id !== organizationId) ||
      Object.values(state.attempts).some((attempt) => attempt.organizationId !== organizationId) ||
      Object.values(state.sessions).some((session) => session.organizationId !== organizationId) ||
      state.audit.some((event) => event.organizationId !== organizationId)) {
    throw new Error('Cross-tenant directory state');
  }
  return state;
}

/** One pinned organization per row/ServerDirectory instance. The legacy pilot
 * uses a shared table role. The opt-in 'rls' mode uses an operator-provisioned
 * row and separate database role, and never inserts an absent row. Neither
 * mode is selected by the desktop. */
export class TenantPostgresDirectoryStore implements EnterpriseStateStore {
  private readonly table: 'public.interpreter_enterprise_tenant_directory' | 'public.interpreter_enterprise_rls_directory';

  constructor(private readonly pool: DirectoryPool, private readonly organizationId: string,
    mode: 'pilot' | 'rls' = 'pilot') {
    if (!/^[a-zA-Z0-9._@:-]{1,160}$/.test(organizationId) ||
        ['__proto__', 'constructor', 'prototype'].includes(organizationId)) throw new Error('Invalid pinned tenant');
    if (mode !== 'pilot' && mode !== 'rls') throw new Error('Invalid tenant storage mode');
    // Fixed, schema-qualified identifiers cannot be shadowed by a pg_temp
    // relation on a pooled connection or replaced by an input-derived schema.
    this.table = mode === 'rls' ? 'public.interpreter_enterprise_rls_directory' : 'public.interpreter_enterprise_tenant_directory';
  }

  private state(result: QueryResult): DirectoryState {
    return scopedTenantState(stateFrom(result), this.organizationId);
  }

  async read(): Promise<DirectoryState> {
    if (this.table === 'public.interpreter_enterprise_rls_directory') {
      // One statement snapshot: check ordered event content, not just count;
      // a concurrent committed write cannot split the directory and ledger.
      // This detects drift but is not a cryptographic proof against a database
      // operator who can deliberately rewrite both copies and backups.
      const result = await this.pool.query(`SELECT d.content,
        (d.content::jsonb->'audit' = COALESCE((SELECT jsonb_agg(a.content ORDER BY a.id)
          FROM public.interpreter_enterprise_rls_audit a WHERE a.organization_id = d.organization_id), '[]'::jsonb)) AS audit_matches
        FROM ${this.table} d WHERE d.organization_id = $1`, [this.organizationId]);
      const state = this.state(result);
      if (result.rows[0]?.audit_matches !== true) throw new Error('Tenant audit ledger is out of sync');
      return state;
    }
    return this.state(await this.pool.query(`SELECT content FROM ${this.table} WHERE organization_id = $1`, [this.organizationId]));
  }

  async change<T>(fn: (state: DirectoryState) => T, create = false): Promise<T> {
    const client = await this.pool.connect();
    let transaction = false;
    let discard = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      if (create && this.table === 'public.interpreter_enterprise_tenant_directory') {
        // Only ServerDirectory.bootstrap passes create=true; ordinary reads and
        // HTTP handlers never provision an absent tenant on demand.
        await client.query('INSERT INTO public.interpreter_enterprise_tenant_directory (organization_id, content) VALUES ($1, $2) ON CONFLICT (organization_id) DO NOTHING',
          [this.organizationId, JSON.stringify(blankDirectoryState())]);
      }
      const state = this.state(await client.query(
        `SELECT content FROM ${this.table} WHERE organization_id = $1 FOR UPDATE`, [this.organizationId]));
      if (this.table === 'public.interpreter_enterprise_rls_directory') {
        const ledger = await client.query(
          `SELECT (d.content::jsonb->'audit' = COALESCE((SELECT jsonb_agg(a.content ORDER BY a.id)
            FROM public.interpreter_enterprise_rls_audit a WHERE a.organization_id = d.organization_id), '[]'::jsonb)) AS audit_matches
            FROM public.interpreter_enterprise_rls_directory d WHERE d.organization_id = $1`,
          [this.organizationId]);
        if (ledger.rowCount !== 1 || ledger.rows[0]?.audit_matches !== true) {
          throw new Error('Tenant audit ledger is out of sync');
        }
      }
      const originalAudit = this.table === 'public.interpreter_enterprise_rls_directory'
        ? JSON.stringify(state.audit) : '';
      const originalAuditCount = state.audit.length;
      const result = fn(state);
      scopedTenantState(state, this.organizationId);
      if (!state.organizations[this.organizationId]) throw new Error('Tenant is not bootstrapped');
      if (originalAudit && (state.audit.length < originalAuditCount ||
          JSON.stringify(state.audit.slice(0, originalAuditCount)) !== originalAudit)) {
        throw new Error('Tenant audit history cannot be rewritten');
      }
      const content = JSON.stringify(state);
      if (Buffer.byteLength(content, 'utf8') > MAX_DIRECTORY_BYTES) throw new Error('Tenant directory capacity reached');
      if (this.table === 'public.interpreter_enterprise_rls_directory') {
        for (const event of state.audit.slice(originalAuditCount)) {
          await client.query('INSERT INTO public.interpreter_enterprise_rls_audit (organization_id, content) VALUES ($1, $2::jsonb)',
            [this.organizationId, JSON.stringify(event)]);
        }
      }
      const updated = await client.query(
        `UPDATE ${this.table} SET content = $1 WHERE organization_id = $2`,
        [content, this.organizationId]);
      if (updated.rowCount !== 1) throw new Error('Tenant directory changed unexpectedly');
      await client.query('COMMIT');
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
      }
      throw error;
    } finally { client.release(discard); }
  }
}
