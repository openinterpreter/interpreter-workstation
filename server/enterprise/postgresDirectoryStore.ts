import pg, { type Pool, type PoolClient } from 'pg';
import {
  blankDirectoryState, decodeDirectoryState, EnterpriseDomainClaimConflict, MAX_DIRECTORY_BYTES, validateDirectoryState,
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
 * NOINHERIT/NOBYPASSRLS LOGIN role per tenant. On the directory grant only
 * SELECT and UPDATE(content); audit gets SELECT/column-limited INSERT and
 * domain claims get SELECT/column-limited INSERT. No app role owns a table.
 * Existing opt-in jsonb audit installations need the operator-owned,
 * backup-verified scripts/migrate-enterprise-rls-audit-jsonb-to-text.sql
 * migration before this version can serve them. The runtime
 * refuses the old column type; it never silently reinitializes their ledger. */
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
  -- Keep the canonical JSON spelling: PostgreSQL jsonb cannot represent an
  -- escaped U+0000 in an otherwise valid opaque OIDC Core ASCII subject.
  content text NOT NULL CHECK (octet_length(content) BETWEEN 2 AND 16384 AND
    -- Canonical JSON.stringify order is validated again by the application
    -- against the row-locked directory. Even json operators convert an
    -- unrelated escaped NUL to PostgreSQL text and cannot be used here.
    left(content, char_length(organization_id) + 21) = '{"organizationId":"' || organization_id || '",' AND
    content LIKE '%"subject":"_%' AND content NOT LIKE '%"subject":""%' AND
    content LIKE '%"action":"_%' AND content NOT LIKE '%"action":""%' AND
    content LIKE '%"at":"_%' AND content NOT LIKE '%"at":""%' AND
    (content LIKE '%"outcome":"allowed"%' OR content LIKE '%"outcome":"denied"%'))
);
CREATE INDEX enterprise_rls_audit_tenant_order ON public.interpreter_enterprise_rls_audit (organization_id, id);
ALTER TABLE public.interpreter_enterprise_rls_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interpreter_enterprise_rls_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY enterprise_audit_role_scope ON public.interpreter_enterprise_rls_audit
  USING (organization_id IN (SELECT d.organization_id FROM public.interpreter_enterprise_rls_directory d
    WHERE d.database_role = current_user))
  WITH CHECK (organization_id IN (SELECT d.organization_id FROM public.interpreter_enterprise_rls_directory d
    WHERE d.database_role = current_user));
CREATE TABLE public.interpreter_enterprise_rls_domain_claim (
  domain text PRIMARY KEY CHECK (char_length(domain) BETWEEN 3 AND 253 AND domain ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'),
  organization_id text NOT NULL REFERENCES public.interpreter_enterprise_rls_directory(organization_id),
  database_role name NOT NULL,
  issuer text NOT NULL
);
ALTER TABLE public.interpreter_enterprise_rls_domain_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interpreter_enterprise_rls_domain_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY enterprise_domain_role_scope ON public.interpreter_enterprise_rls_domain_claim
  USING (database_role = current_user)
  WITH CHECK (database_role = current_user AND organization_id IN
    (SELECT d.organization_id FROM public.interpreter_enterprise_rls_directory d WHERE d.database_role = current_user))`;

type QueryResult = { rows: Array<{ content?: unknown; audit_contents?: unknown; boundary_ok?: unknown }>; rowCount: number | null };
type TransactionClient = Pick<PoolClient, 'query' | 'release'>;
type DirectoryPool = { query(sql: string, values?: unknown[]): Promise<QueryResult>; connect(): Promise<TransactionClient> };

/** This is a per-operation guard, not a substitute for an operator's grants,
 * migration or independent role audit. Never cache a positive result across
 * pooled connections or after a privileged schema/role change. */
const RLS_BOUNDARY_QUERY = `SELECT
  (SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolinherit
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
  AND (SELECT count(*) = 3 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
      AND NOT pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER'))
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN
      ('interpreter_enterprise_rls_directory', 'interpreter_enterprise_rls_audit',
       'interpreter_enterprise_rls_domain_claim') AND c.relkind = 'r')
  AND NOT pg_catalog.has_table_privilege(current_user, 'public.interpreter_enterprise_rls_directory', 'INSERT, DELETE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_directory', 'organization_id', 'UPDATE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_directory', 'database_role', 'UPDATE')
  AND (SELECT a.atttypid = 'text'::regtype FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.interpreter_enterprise_rls_audit'::regclass
      AND a.attname = 'content' AND a.attnum > 0 AND NOT a.attisdropped)
  AND NOT pg_catalog.has_table_privilege(current_user, 'public.interpreter_enterprise_rls_audit', 'UPDATE, DELETE')
  AND NOT pg_catalog.has_table_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'UPDATE, DELETE')
  AND pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'database_role', 'UPDATE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'domain', 'UPDATE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'organization_id', 'UPDATE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'issuer', 'UPDATE')
  AS boundary_ok`;

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

function assertAuditMatches(state: DirectoryState, result: QueryResult): void {
  const ledger = result.rows[0]?.audit_contents;
  // Compare canonical append-only serialized events. Never coerce the ledger
  // through jsonb, which rejects valid escaped-NUL subjects on read as well.
  if (!Array.isArray(ledger) || !ledger.every((event) => typeof event === 'string') ||
      JSON.stringify(state.audit) !== `[${ledger.join(',')}]`) {
    throw new Error('Tenant audit ledger is out of sync');
  }
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

  private async assertRlsBoundary(connection: Pick<DirectoryPool, 'query'>): Promise<void> {
    if (this.table !== 'public.interpreter_enterprise_rls_directory') return;
    const result = await connection.query(RLS_BOUNDARY_QUERY);
    if (result.rowCount !== 1 || result.rows[0]?.boundary_ok !== true) {
      throw new Error('Enterprise tenant database boundary is unsafe');
    }
  }

  /** A pilot row has no global registry. Missing RLS registry, role or claim
   * must not be mistaken for a verified globally unique domain. */
  async domainClaimStatus(organizationId: string, issuer: string, domain: string): Promise<boolean> {
    if (organizationId !== this.organizationId || this.table !== 'public.interpreter_enterprise_rls_directory') return false;
    await this.assertRlsBoundary(this.pool);
    const result = await this.pool.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
      WHERE domain = $1 AND organization_id = $2 AND issuer = $3 AND database_role = current_user`,
    [domain, organizationId, issuer]);
    return result.rowCount === 1;
  }

  async read(): Promise<DirectoryState> {
    if (this.table === 'public.interpreter_enterprise_rls_directory') {
      await this.assertRlsBoundary(this.pool);
      // One statement snapshot: check ordered event content, not just count;
      // a concurrent committed write cannot split the directory and ledger.
      // This detects drift but is not a cryptographic proof against a database
      // operator who can deliberately rewrite both copies and backups.
      const result = await this.pool.query(`SELECT d.content,
        COALESCE((SELECT array_agg(a.content ORDER BY a.id)
          FROM public.interpreter_enterprise_rls_audit a WHERE a.organization_id = d.organization_id), ARRAY[]::text[]) AS audit_contents
        FROM ${this.table} d WHERE d.organization_id = $1`, [this.organizationId]);
      const state = this.state(result);
      assertAuditMatches(state, result);
      return state;
    }
    return this.state(await this.pool.query(`SELECT content FROM ${this.table} WHERE organization_id = $1`, [this.organizationId]));
  }

  async change<T>(fn: (state: DirectoryState) => T, create = false): Promise<T> {
    return this.changeInternal(fn, create);
  }

  /** Lock the operator-owned claim row through session issuance. A claim
   * release waits for this commit, or this transaction sees its deletion. */
  async changeWithDomainClaim<T>(organizationId: string, issuer: string, domain: string,
    fn: (state: DirectoryState) => T): Promise<T> {
    if (this.table !== 'public.interpreter_enterprise_rls_directory' || organizationId !== this.organizationId) {
      throw new Error('Verified account domain required');
    }
    return this.changeInternal(fn, false, { issuer, domain });
  }

  private async changeInternal<T>(fn: (state: DirectoryState) => T, create = false,
    claim?: { issuer: string; domain: string }): Promise<T> {
    const client = await this.pool.connect();
    let transaction = false;
    let discard = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await this.assertRlsBoundary(client);
      if (create && this.table === 'public.interpreter_enterprise_tenant_directory') {
        // Only ServerDirectory.bootstrap passes create=true; ordinary reads and
        // HTTP handlers never provision an absent tenant on demand.
        await client.query('INSERT INTO public.interpreter_enterprise_tenant_directory (organization_id, content) VALUES ($1, $2) ON CONFLICT (organization_id) DO NOTHING',
          [this.organizationId, JSON.stringify(blankDirectoryState())]);
      }
      const state = this.state(await client.query(
        `SELECT content FROM ${this.table} WHERE organization_id = $1 FOR UPDATE`, [this.organizationId]));
      if (claim) {
        const owned = await client.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
          WHERE domain = $1 AND organization_id = $2 AND issuer = $3 AND database_role = current_user FOR KEY SHARE`,
        [claim.domain, this.organizationId, claim.issuer]);
        if (owned.rowCount !== 1) throw new Error('Verified account domain required');
      }
      if (this.table === 'public.interpreter_enterprise_rls_directory') {
        const ledger = await client.query(
          `SELECT COALESCE((SELECT array_agg(a.content ORDER BY a.id)
            FROM public.interpreter_enterprise_rls_audit a WHERE a.organization_id = d.organization_id), ARRAY[]::text[]) AS audit_contents
            FROM public.interpreter_enterprise_rls_directory d WHERE d.organization_id = $1`,
          [this.organizationId]);
        if (ledger.rowCount !== 1) throw new Error('Tenant audit ledger is out of sync');
        assertAuditMatches(state, ledger);
      }
      const originalAudit = this.table === 'public.interpreter_enterprise_rls_directory'
        ? JSON.stringify(state.audit) : '';
      const originalAuditCount = state.audit.length;
      const priorProofs = new Map(Object.entries(state.organizations[this.organizationId]?.domainProofs ?? {})
        .map(([domain, proof]) => [domain, `${proof.challengeHash}:${proof.verifiedUntil ?? 0}`]));
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
        // Reserve a name in the same row-locked transaction as its challenge,
        // confirmation and audit append. A foreign claim is invisible under
        // RLS but the unique index prevents concurrent cross-tenant overlap.
        for (const [domain, proof] of Object.entries(state.organizations[this.organizationId]?.domainProofs ?? {})) {
          if (priorProofs.get(domain) === `${proof.challengeHash}:${proof.verifiedUntil ?? 0}`) continue;
          const owned = await client.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
            WHERE domain = $1 AND organization_id = $2 AND issuer = $3 AND database_role = current_user`,
          [domain, this.organizationId, proof.issuer]);
          if (owned.rowCount === 1) continue;
          const inserted = await client.query(`INSERT INTO public.interpreter_enterprise_rls_domain_claim
            (domain, organization_id, database_role, issuer)
            SELECT $1, $2, current_user, $3 WHERE EXISTS
              (SELECT 1 FROM public.interpreter_enterprise_rls_directory
                WHERE organization_id = $2 AND database_role = current_user)
            ON CONFLICT (domain) DO NOTHING RETURNING domain`,
          [domain, this.organizationId, proof.issuer]);
          if (inserted.rowCount !== 1) throw new EnterpriseDomainClaimConflict();
        }
        for (const event of state.audit.slice(originalAuditCount)) {
          await client.query('INSERT INTO public.interpreter_enterprise_rls_audit (organization_id, content) VALUES ($1, $2)',
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
