import pg, { type Pool, type PoolClient } from 'pg';
import type { VerifiedIdentity } from './controlPlane';
import {
  appendScopedAudit, blankDirectoryState, decodeDirectoryState, EnterpriseAccessDenied, EnterpriseDomainClaimConflict,
  MAX_DIRECTORY_BYTES, RECOVERY_RESERVE_BYTES, validateDirectoryState,
  type DirectoryState, type EnterpriseStateStore,
} from './serverDirectory';
import { auditDigest, MAX_AUDIT_PAGE_EVENT_BYTES } from './rlsAuditMigration';
import { evaluateTenantPolicy } from './tenantPolicy';

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

type QueryResult = { rows: Array<{ content?: unknown; audit_contents?: unknown;
  audit_count?: unknown; audit_last_id?: unknown; audit_last_content?: unknown;
  id?: unknown; boundary_ok?: unknown }>; rowCount: number | null };
type TransactionClient = Pick<PoolClient, 'query' | 'release'>;
type DirectoryPool = { query(sql: string, values?: unknown[]): Promise<QueryResult>; connect(): Promise<TransactionClient> };
export type TenantAuditPage = Readonly<{ upperId: number; nextId: number | null; pendingCount: number;
  events: readonly { id: number; event: DirectoryState['audit'][number] }[] }>;

/** This is a per-operation guard, not a substitute for an operator's grants,
 * migration or independent role audit. Never cache a positive result across
 * pooled connections or after a privileged schema/role change. */
const RLS_BOUNDARY_QUERY = `SELECT
  (SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolinherit
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
  -- NOINHERIT alone is insufficient: SET ROLE can activate a granted tenant
  -- role. Runtime tenant roles must have no granted role memberships at all.
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = current_user)
  AND (SELECT count(*) = 3 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
      AND NOT pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER'))
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN
      ('interpreter_enterprise_rls_directory', 'interpreter_enterprise_rls_audit',
       'interpreter_enterprise_rls_domain_claim') AND c.relkind = 'r')
  -- RLS does not protect TRUNCATE: it empties every tenant, including rows
  -- this tenant's role cannot SELECT. A drifted grant must fail closed.
  AND NOT pg_catalog.has_table_privilege(current_user, 'public.interpreter_enterprise_rls_directory', 'INSERT, DELETE, TRUNCATE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_directory', 'organization_id', 'UPDATE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_directory', 'database_role', 'UPDATE')
  AND (SELECT a.atttypid = 'text'::regtype FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.interpreter_enterprise_rls_audit'::regclass
      AND a.attname = 'content' AND a.attnum > 0 AND NOT a.attisdropped)
  AND NOT pg_catalog.has_table_privilege(current_user, 'public.interpreter_enterprise_rls_audit', 'UPDATE, DELETE, TRUNCATE')
  AND NOT pg_catalog.has_table_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'UPDATE, DELETE, TRUNCATE')
  AND pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'database_role', 'UPDATE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'domain', 'UPDATE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'organization_id', 'UPDATE')
  AND NOT pg_catalog.has_column_privilege(current_user, 'public.interpreter_enterprise_rls_domain_claim', 'issuer', 'UPDATE')
  AS boundary_ok`;

/** A shared database is required for multiple server hosts. No connection string:
 * URI sslmode overrides can silently replace a pinned CA in node-postgres. */
export function createEnterprisePostgresPool(config: Readonly<{
  host: string; port: number; database: string; user: string; password: string; caCertificate: string;
}>, options?: Readonly<{ offlineMigration?: true }>): Pool {
  if (options && options.offlineMigration !== true) throw new Error('Invalid enterprise database pool mode');
  if (!config.host || /[\s:/@\\]/.test(config.host) || !Number.isInteger(config.port) ||
      config.port < 1 || config.port > 65535 || !config.database || !config.user ||
      !config.password || !config.caCertificate.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('Invalid enterprise database configuration');
  }
  return new pg.Pool({
    host: config.host, port: config.port, database: config.database, user: config.user,
    password: config.password, ssl: { ca: config.caCertificate, rejectUnauthorized: true, servername: config.host },
    max: options?.offlineMigration ? 1 : 8, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10_000,
    // Reads do not use the transactional SET LOCAL below. Bound them too,
    // including a stalled network response after a connection was established.
    statement_timeout: options?.offlineMigration ? 120_000 : 5000,
    query_timeout: options?.offlineMigration ? 125_000 : 6000,
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
      state.audit.some((event) => event.organizationId !== organizationId) ||
      (state.pendingAudit ?? []).some(({ event }) => event.organizationId !== organizationId)) {
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

const RLS_AUDIT_CURSOR_COLUMNS = `
  (SELECT count(*)::text FROM public.interpreter_enterprise_rls_audit a
    WHERE a.organization_id = d.organization_id) AS audit_count,
  (SELECT a.id::text FROM public.interpreter_enterprise_rls_audit a
    WHERE a.organization_id = d.organization_id ORDER BY a.id DESC LIMIT 1) AS audit_last_id,
  (SELECT a.content FROM public.interpreter_enterprise_rls_audit a
    WHERE a.organization_id = d.organization_id ORDER BY a.id DESC LIMIT 1) AS audit_last_content`;

function assertLedgerCheckpoint(state: DirectoryState, result: QueryResult): void {
  const row = result.rows[0];
  const rawCount = row?.audit_count;
  const count = typeof rawCount === 'string' && /^(?:0|[1-9]\d*)$/.test(rawCount) ? Number(rawCount) : NaN;
  const rawId = row?.audit_last_id;
  const lastId = rawId === null ? 0 : typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId) ? Number(rawId) : NaN;
  let latestAt: string | null = null;
  try {
    if (typeof row?.audit_last_content === 'string') {
      const last = JSON.parse(row.audit_last_content);
      latestAt = last?.at;
    }
  } catch { throw new Error('Tenant audit checkpoint is out of sync'); }
  if (state.version !== 2 || state.audit.length !== 0 || !state.auditCursor ||
      !Number.isSafeInteger(count) || !Number.isSafeInteger(lastId) ||
      state.auditCursor.count !== count || state.auditCursor.lastId !== lastId ||
      state.auditCursor.tailDigest !== (count ? typeof row?.audit_last_content === 'string'
        ? auditDigest(row.audit_last_content) : null : null) ||
      state.auditCursor.latestAt !== latestAt) {
    throw new Error('Tenant audit checkpoint is out of sync');
  }
}

/** One pinned organization per row/ServerDirectory instance. The legacy pilot
 * uses a shared table role. The opt-in 'rls' mode uses an operator-provisioned
 * row and separate database role, and never inserts an absent row. The
 * experimental 'rls-v2' protocol requires a separately migrated version-2
 * checkpoint, keeps committed audit out of the persisted directory, and
 * fails closed on any legacy row. It checks count plus indexed tail on
 * every read/change, but has no paginated authenticated export yet: do not
 * select it in a production composition. No mode is selected by desktop. */
export class TenantPostgresDirectoryStore implements EnterpriseStateStore {
  private readonly table: 'public.interpreter_enterprise_tenant_directory' | 'public.interpreter_enterprise_rls_directory';
  private readonly ledgerOnly: boolean;
  readonly requiresPagedAudit: boolean;

  constructor(private readonly pool: DirectoryPool, private readonly organizationId: string,
    mode: 'pilot' | 'rls' | 'rls-v2' = 'pilot') {
    if (!/^[a-zA-Z0-9._@:-]{1,160}$/.test(organizationId) ||
        ['__proto__', 'constructor', 'prototype'].includes(organizationId)) throw new Error('Invalid pinned tenant');
    if (mode !== 'pilot' && mode !== 'rls' && mode !== 'rls-v2') throw new Error('Invalid tenant storage mode');
    this.ledgerOnly = mode === 'rls-v2'; // Never selected by desktop or existing opt-in composition.
    this.requiresPagedAudit = this.ledgerOnly;
    // Fixed, schema-qualified identifiers cannot be shadowed by a pg_temp
    // relation on a pooled connection or replaced by an input-derived schema.
    this.table = mode === 'pilot' ? 'public.interpreter_enterprise_tenant_directory' : 'public.interpreter_enterprise_rls_directory';
  }

  private state(result: QueryResult): DirectoryState {
    const state = scopedTenantState(stateFrom(result), this.organizationId);
    if (this.table === 'public.interpreter_enterprise_rls_directory' &&
        state.version !== (this.ledgerOnly ? 2 : 1)) throw new Error('Tenant audit migration is required');
    return state;
  }

  snapshotBytes(state: DirectoryState): number {
    if (!this.ledgerOnly) return Buffer.byteLength(JSON.stringify(state), 'utf8');
    if (state.version !== 2 || !state.auditCursor) throw new Error('Tenant audit migration is required');
    return Buffer.byteLength(JSON.stringify({ ...state, audit: [],
      auditCursor: { ...state.auditCursor, count: state.auditCursor.count + state.audit.length } }), 'utf8');
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
    const client = await this.pool.connect();
    try {
      await this.assertRlsBoundary(client);
      const result = await client.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
        WHERE domain = $1 AND organization_id = $2 AND issuer = $3 AND database_role = current_user`,
      [domain, organizationId, issuer]);
      return result.rowCount === 1;
    } finally { client.release(); }
  }

  /** Bounded negative-only tenant snapshot: anonymous recovery start must
   * not count or hydrate the historical ledger. This never creates a
   * session; the claim and proof are rechecked under a locked write. */
  async probeDomainRecovery(organizationId: string, issuer: string, domain: string): Promise<boolean> {
    if (organizationId !== this.organizationId || this.table !== 'public.interpreter_enterprise_rls_directory') return false;
    const client = await this.pool.connect();
    try {
      await this.assertRlsBoundary(client);
      const state = this.state(await client.query(`SELECT content FROM ${this.table}
        WHERE organization_id = $1`, [this.organizationId]));
      if (this.ledgerOnly && state.audit.length !== 0) throw new Error('Tenant audit checkpoint is out of sync');
      const org = state.organizations[organizationId];
      const proof = org?.domainProofs?.[domain];
      return Boolean(org?.issuer === issuer && proof?.issuer === issuer && proof.verifiedUntil &&
        proof.verifiedUntil <= Date.now());
    } finally { client.release(); }
  }

  async read(): Promise<DirectoryState> {
    if (this.table === 'public.interpreter_enterprise_rls_directory') {
      const client = await this.pool.connect();
      try {
        await this.assertRlsBoundary(client);
        if (this.ledgerOnly) {
          const result = await client.query(`SELECT d.content, ${RLS_AUDIT_CURSOR_COLUMNS}
            FROM ${this.table} d WHERE d.organization_id = $1`, [this.organizationId]);
          const state = this.state(result);
          assertLedgerCheckpoint(state, result);
          return state;
        }
        // One statement snapshot: check ordered event content, not just count;
        // a concurrent committed write cannot split the directory and ledger.
        // This detects drift but is not a cryptographic proof against a database
        // operator who can deliberately rewrite both copies and backups.
        const result = await client.query(`SELECT d.content,
          COALESCE((SELECT array_agg(a.content ORDER BY a.id)
            FROM public.interpreter_enterprise_rls_audit a WHERE a.organization_id = d.organization_id), ARRAY[]::text[]) AS audit_contents
          FROM ${this.table} d WHERE d.organization_id = $1`, [this.organizationId]);
        const state = this.state(result);
        assertAuditMatches(state, result);
        return state;
      } finally { client.release(); }
    }
    return this.state(await this.pool.query(`SELECT content FROM ${this.table} WHERE organization_id = $1`, [this.organizationId]));
  }

  /** Unknown callback states must not scan a growing audit index. This
   * bounded tenant-snapshot probe grants nothing: a matching candidate is
   * consumed only through change(), which rechecks the full ledger checkpoint
   * under the row lock. Boundary or directory outage still fails closed. */
  async probeAttempt(stateKey: string): Promise<DirectoryState['attempts'][string] | undefined> {
    if (!/^[a-f0-9]{64}$/.test(stateKey)) throw new Error('Invalid attempt key');
    if (this.table !== 'public.interpreter_enterprise_rls_directory') {
      return (await this.read()).attempts[stateKey];
    }
    const client = await this.pool.connect();
    try {
      await this.assertRlsBoundary(client);
      const state = this.state(await client.query(`SELECT content FROM ${this.table}
        WHERE organization_id = $1`, [this.organizationId]));
      if (this.ledgerOnly && state.audit.length !== 0) throw new Error('Tenant audit checkpoint is out of sync');
      return state.attempts[stateKey];
    } finally { client.release(); }
  }

  /** Commit this page request's events and snapshot atomically. Only called
   * with a locked version-2 tenant row, never by a production route. */
  private async commitPageAudit(client: TransactionClient, state: DirectoryState): Promise<void> {
    for (const event of state.audit) {
      const serialized = JSON.stringify(event);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_AUDIT_PAGE_EVENT_BYTES) {
        throw new Error('Tenant audit event exceeds page bound');
      }
      const inserted = await client.query(`INSERT INTO public.interpreter_enterprise_rls_audit
        (organization_id, content) VALUES ($1, $2) RETURNING id`, [this.organizationId, serialized]);
      const id = inserted.rows[0]?.id;
      if (inserted.rowCount !== 1 || !/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id)) ||
          Number(id) <= state.auditCursor!.lastId) throw new Error('Tenant audit checkpoint is out of sync');
      state.auditCursor = { count: state.auditCursor!.count + 1, lastId: Number(id),
        tailDigest: auditDigest(serialized), latestAt: event.at };
    }
    const content = JSON.stringify({ ...state, audit: [] });
    if (Buffer.byteLength(content, 'utf8') > MAX_DIRECTORY_BYTES - RECOVERY_RESERVE_BYTES) {
      throw new Error('Tenant directory capacity reached');
    }
    const updated = await client.query(`UPDATE ${this.table} SET content = $1 WHERE organization_id = $2`,
      [content, this.organizationId]);
    if (updated.rowCount !== 1) throw new Error('Tenant directory changed unexpectedly');
  }

  /** Experimental v2-only committed-event page. No HTTP route selects it.
   * Authorization, global claim, the stable upper cursor, read-request audit
   * and page query share one locked tenant transaction. Open denial windows
   * are reported by count, not silently presented as exported events. */
  async readAuditPage(identity: VerifiedIdentity, afterId: number, upperId?: number,
    limit = 100, purpose: 'view' | 'export' = 'view'): Promise<TenantAuditPage> {
    if (!this.ledgerOnly || identity.organizationId !== this.organizationId ||
        !Number.isSafeInteger(afterId) || afterId < 0 ||
        (upperId !== undefined && (!Number.isSafeInteger(upperId) || upperId < afterId)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (purpose !== 'view' && purpose !== 'export')) throw new EnterpriseAccessDenied();
    const client = await this.pool.connect();
    let transaction = false;
    let discard = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await this.assertRlsBoundary(client);
      const state = this.state(await client.query(
        `SELECT content FROM ${this.table} WHERE organization_id = $1 FOR UPDATE`, [this.organizationId]));
      const cursor = await client.query(`SELECT ${RLS_AUDIT_CURSOR_COLUMNS}
        FROM public.interpreter_enterprise_rls_directory d WHERE d.organization_id = $1`, [this.organizationId]);
      if (cursor.rowCount !== 1) throw new Error('Tenant audit checkpoint is out of sync');
      assertLedgerCheckpoint(state, cursor);
      const org = state.organizations[this.organizationId];
      const member = org?.members[identity.subject];
      const session = state.sessions[identity.sessionId];
      const domain = session?.accountDomain;
      const proof = domain && org?.domainProofs?.[domain];
      const now = Date.now();
      const active = Boolean(session && !session.revoked && session.expiresAt > now &&
        session.organizationId === identity.organizationId && session.issuer === identity.issuer &&
        session.subject === identity.subject && org?.issuer === identity.issuer &&
        domain && proof?.issuer === identity.issuer && (proof.verifiedUntil ?? 0) > now);
      if (!org || !domain || !active) throw new EnterpriseAccessDenied();
      const claim = await client.query(`SELECT domain FROM public.interpreter_enterprise_rls_domain_claim
        WHERE domain = $1 AND organization_id = $2 AND issuer = $3 AND database_role = current_user FOR KEY SHARE`,
      [domain, this.organizationId, identity.issuer]);
      if (claim.rowCount !== 1) throw new EnterpriseAccessDenied();
      const permitted = evaluateTenantPolicy({ identity, organizationId: this.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'audit.read' });
      if (!permitted) {
        appendScopedAudit(state, { organizationId: this.organizationId, subject: identity.subject,
          action: `organization.audit.page.${purpose}`, outcome: 'denied', at: new Date().toISOString() });
        validateDirectoryState(state);
        await this.commitPageAudit(client, state);
        await client.query('COMMIT');
        transaction = false;
        throw new EnterpriseAccessDenied();
      }
      // A fresh export first closes at most one page of open denial windows
      // under this same tenant lock. An export must not silently omit them.
      // A continuation with an explicit upper bound keeps its original stable
      // snapshot; callers must start another export if pendingCount remains.
      if (purpose === 'export' && upperId === undefined && state.pendingAudit?.length) {
        state.audit.push(...state.pendingAudit.splice(0, 100).map(({ event }) => event));
        validateDirectoryState(state);
        await this.commitPageAudit(client, state);
        state.audit = [];
      }
      const upper = upperId ?? state.auditCursor!.lastId;
      if (upper > state.auditCursor!.lastId || afterId > upper) throw new EnterpriseAccessDenied();
      const result = await client.query(`SELECT id::text AS id,
        CASE WHEN octet_length(content) <= ${MAX_AUDIT_PAGE_EVENT_BYTES} THEN content ELSE NULL END AS content
        FROM public.interpreter_enterprise_rls_audit
        WHERE organization_id = $1 AND id > $2 AND id <= $3 ORDER BY id LIMIT $4`,
      [this.organizationId, String(afterId), String(upper), limit + 1]);
      if (result.rowCount !== result.rows.length || result.rows.length > limit + 1) {
        throw new Error('Tenant audit page is invalid');
      }
      let prior = afterId;
      const decoded = result.rows.map((row) => {
        const id = typeof row.id === 'string' && /^[1-9]\d*$/.test(row.id) ? Number(row.id) : NaN;
        if (!Number.isSafeInteger(id) || id <= prior || id > upper || typeof row.content !== 'string') {
          throw new Error('Tenant audit page is invalid');
        }
        prior = id;
        let event: DirectoryState['audit'][number];
        try { event = JSON.parse(row.content); } catch { throw new Error('Tenant audit page is invalid'); }
        if (event.organizationId !== this.organizationId || JSON.stringify(event) !== row.content) {
          throw new Error('Tenant audit page is invalid');
        }
        return { id, event };
      });
      const events = decoded.slice(0, limit);
      validateDirectoryState({ ...state, audit: events.map(({ event }) => event) });
      appendScopedAudit(state, { organizationId: this.organizationId, subject: identity.subject,
        action: `organization.audit.page.${purpose}`, outcome: 'allowed', at: new Date().toISOString() });
      validateDirectoryState(state);
      await this.commitPageAudit(client, state);
      await client.query('COMMIT');
      transaction = false;
      return { upperId: upper, nextId: decoded.length > limit ? events[events.length - 1]!.id : null,
        pendingCount: state.pendingAudit?.length ?? 0, events };
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
      }
      throw error;
    } finally { client.release(discard); }
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
        const ledger = await client.query(this.ledgerOnly
          ? `SELECT ${RLS_AUDIT_CURSOR_COLUMNS}
            FROM public.interpreter_enterprise_rls_directory d WHERE d.organization_id = $1`
          : `SELECT COALESCE((SELECT array_agg(a.content ORDER BY a.id)
            FROM public.interpreter_enterprise_rls_audit a WHERE a.organization_id = d.organization_id), ARRAY[]::text[]) AS audit_contents
            FROM public.interpreter_enterprise_rls_directory d WHERE d.organization_id = $1`, [this.organizationId]);
        if (ledger.rowCount !== 1) throw new Error('Tenant audit ledger is out of sync');
        if (this.ledgerOnly) assertLedgerCheckpoint(state, ledger);
        else assertAuditMatches(state, ledger);
      }
      const originalAudit = this.table === 'public.interpreter_enterprise_rls_directory'
        ? JSON.stringify(state.audit) : '';
      const originalAuditCount = state.audit.length;
      const priorLeases = new Map(Object.entries(state.organizations[this.organizationId]?.domainProofs ?? {})
        .map(([domain, proof]) => [domain, proof.verifiedUntil ?? 0]));
      const result = fn(state);
      scopedTenantState(state, this.organizationId);
      if (!state.organizations[this.organizationId]) throw new Error('Tenant is not bootstrapped');
      if (originalAudit && (state.audit.length < originalAuditCount ||
          JSON.stringify(state.audit.slice(0, originalAuditCount)) !== originalAudit)) {
        throw new Error('Tenant audit history cannot be rewritten');
      }
      if (this.table === 'public.interpreter_enterprise_rls_directory') {
        // A claim row exists only for a verified domain. Take it when this
        // transaction sets or extends a live lease (successful DNS
        // verification), never for a mere challenge, in the same row-locked
        // transaction as the proof and audit append. A foreign claim is
        // invisible under RLS but the unique index denies the overlap and
        // rolls back the tentative verification.
        const now = Date.now();
        for (const [domain, proof] of Object.entries(state.organizations[this.organizationId]?.domainProofs ?? {})) {
          const lease = proof.verifiedUntil ?? 0;
          if (lease <= now || priorLeases.get(domain) === lease) continue;
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
          const serialized = JSON.stringify(event);
          if (this.ledgerOnly && Buffer.byteLength(serialized, 'utf8') > MAX_AUDIT_PAGE_EVENT_BYTES) {
            throw new Error('Tenant audit event exceeds page bound');
          }
          const inserted = await client.query(`INSERT INTO public.interpreter_enterprise_rls_audit
            (organization_id, content) VALUES ($1, $2) RETURNING id`,
            [this.organizationId, serialized]);
          if (this.ledgerOnly) {
            const id = inserted.rows[0]?.id;
            if (inserted.rowCount !== 1 || !/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id)) ||
                Number(id) <= state.auditCursor!.lastId) throw new Error('Tenant audit checkpoint is out of sync');
            state.auditCursor = { count: state.auditCursor!.count + 1, lastId: Number(id),
              tailDigest: auditDigest(serialized), latestAt: event.at };
          }
        }
      }
      const content = JSON.stringify(this.ledgerOnly ? { ...state, audit: [] } : state);
      if (Buffer.byteLength(content, 'utf8') > MAX_DIRECTORY_BYTES) throw new Error('Tenant directory capacity reached');
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
