import { createHmac } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { Pool } from 'pg';

/** Applied by an operator to the existing FORCE-RLS tenant directory, never
 * by an anonymous request. For each tenant and operation at most 4096 slots
 * can exist; a collision denies rather than evicting another live client.
 * Grant each tenant role SELECT, INSERT, UPDATE(network_digest,window_bucket,hits)
 * only. Do not grant DELETE, TRUNCATE, table ownership or BYPASSRLS. */
export const ENTERPRISE_RLS_LOGIN_INGRESS_SCHEMA = `CREATE TABLE public.interpreter_enterprise_rls_login_ingress (
  organization_id text NOT NULL REFERENCES public.interpreter_enterprise_rls_directory(organization_id),
  database_role name NOT NULL,
  slot smallint NOT NULL CHECK (slot BETWEEN 0 AND 4095),
  operation text NOT NULL CHECK (operation IN ('login','domain-recovery','callback')),
  network_digest char(64) NOT NULL CHECK (network_digest ~ '^[0-9a-f]{64}$'),
  window_bucket bigint NOT NULL CHECK (window_bucket > 0),
  hits smallint NOT NULL CHECK (hits BETWEEN 1 AND 120),
  PRIMARY KEY (organization_id, operation, slot)
);
ALTER TABLE public.interpreter_enterprise_rls_login_ingress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interpreter_enterprise_rls_login_ingress FORCE ROW LEVEL SECURITY;
CREATE POLICY enterprise_login_ingress_tenant_role ON public.interpreter_enterprise_rls_login_ingress
  USING (database_role = current_user AND organization_id IN (
    SELECT d.organization_id FROM public.interpreter_enterprise_rls_directory d WHERE d.database_role = current_user))
  WITH CHECK (database_role = current_user AND organization_id IN (
    SELECT d.organization_id FROM public.interpreter_enterprise_rls_directory d WHERE d.database_role = current_user))`;

export type LoginIngressOperation = 'login' | 'domain-recovery' | 'callback';
const SLOT_COUNT = 4096;
const LIMITS: Record<LoginIngressOperation, number> = { login: 12, 'domain-recovery': 6, callback: 60 };
const TABLE = 'public.interpreter_enterprise_rls_login_ingress';

/** A private, stable key shared by all HTTP hosts for this tenant. The
 * digest is never returned to clients or logged. Changing the key may deny
 * one colliding network until the current minute expires. */
export class PostgresEnterpriseLoginIngress {
  private constructor(private readonly pool: Pool, private readonly organizationId: string,
    private readonly hmacKey: Buffer) {}

  static async connect(pool: Pool, organizationId: string, hmacKey: Buffer): Promise<PostgresEnterpriseLoginIngress> {
    if (!/^[A-Za-z0-9._@:-]{1,160}$/.test(organizationId) || !Buffer.isBuffer(hmacKey) ||
        hmacKey.length < 32 || hmacKey.length > 128) throw new Error('Invalid tenant ingress configuration');
    const tls = pool.options.ssl;
    if (!tls || typeof tls !== 'object' || tls.rejectUnauthorized !== true ||
        typeof tls.ca !== 'string' || !tls.ca.includes('-----BEGIN CERTIFICATE-----') ||
        tls.servername !== pool.options.host) throw new Error('Pinned tenant ingress TLS is required');
    const ingress = new PostgresEnterpriseLoginIngress(pool, organizationId, Buffer.from(hmacKey));
    const result = await pool.query(`SELECT current_user::text AS role, s.ssl, r.rolsuper, r.rolbypassrls,
      r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
      d.organization_id, directory.relrowsecurity AS directory_rls, directory.relforcerowsecurity AS directory_force,
      limiter.relrowsecurity AS limiter_rls, limiter.relforcerowsecurity AS limiter_force,
      pg_get_userbyid(limiter.relowner) = current_user AS table_owner,
      has_table_privilege(current_user, '${TABLE}', 'DELETE') AS can_delete,
      has_table_privilege(current_user, '${TABLE}', 'TRUNCATE') AS can_truncate,
      has_table_privilege(current_user, '${TABLE}', 'SELECT') AS can_select,
      has_table_privilege(current_user, '${TABLE}', 'INSERT') AS can_insert,
      has_column_privilege(current_user, '${TABLE}', 'network_digest', 'UPDATE') AS can_update_digest,
      has_column_privilege(current_user, '${TABLE}', 'window_bucket', 'UPDATE') AS can_update_window,
      has_column_privilege(current_user, '${TABLE}', 'hits', 'UPDATE') AS can_update_hits
      FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_stat_ssl s ON s.pid = pg_backend_pid()
      JOIN pg_catalog.pg_class directory ON directory.oid = 'public.interpreter_enterprise_rls_directory'::regclass
      JOIN pg_catalog.pg_class limiter ON limiter.oid = '${TABLE}'::regclass
      LEFT JOIN public.interpreter_enterprise_rls_directory d
        ON d.organization_id = $1 AND d.database_role = current_user
      WHERE r.rolname = current_user`, [organizationId]);
    const row = result.rows[0];
    if (result.rowCount !== 1 || row?.ssl !== true || row?.rolsuper !== false || row?.rolbypassrls !== false ||
        row?.rolinherit !== false || row?.rolcreaterole !== false || row?.rolcreatedb !== false ||
        row?.rolreplication !== false ||
        row?.organization_id !== organizationId || row?.directory_rls !== true || row?.directory_force !== true ||
        row?.limiter_rls !== true || row?.limiter_force !== true || row?.table_owner !== false ||
        row?.can_delete !== false || row?.can_truncate !== false || row?.can_select !== true ||
        row?.can_insert !== true || row?.can_update_digest !== true ||
        row?.can_update_window !== true || row?.can_update_hits !== true) {
      throw new Error('Tenant ingress RLS and TLS boundary is unsafe');
    }
    return ingress;
  }

  async admit(organizationId: string, clientNetwork: string, operation: LoginIngressOperation): Promise<boolean> {
    if (organizationId !== this.organizationId || !Object.prototype.hasOwnProperty.call(LIMITS, operation) ||
        !(isIPv4(clientNetwork) || /^(?:[0-9a-f]{1,4}:){3}[0-9a-f]{1,4}::\/64$/.test(clientNetwork))) {
      return false;
    }
    const digest = createHmac('sha256', this.hmacKey)
      .update(`${organizationId}\0${operation}\0${clientNetwork}`).digest('hex');
    const slot = parseInt(digest.slice(0, 8), 16) % SLOT_COUNT;
    // The database clock, not independently skewed HTTP hosts, owns the
    // window. An exhausted or collided slot returns no row and never takes
    // the directory row lock or rewrites the tenant's audit snapshot.
    const result = await this.pool.query(`INSERT INTO ${TABLE} AS existing
      (organization_id, database_role, slot, operation, network_digest, window_bucket, hits)
      VALUES ($1, current_user, $2, $3, $4, floor(extract(epoch from clock_timestamp()) / 60)::bigint, 1)
      ON CONFLICT (organization_id, operation, slot) DO UPDATE SET
        network_digest = EXCLUDED.network_digest,
        window_bucket = EXCLUDED.window_bucket,
        hits = CASE WHEN existing.window_bucket = EXCLUDED.window_bucket THEN existing.hits + 1 ELSE 1 END
      WHERE existing.window_bucket <> EXCLUDED.window_bucket OR
        (existing.network_digest = EXCLUDED.network_digest AND existing.hits < $5)
      RETURNING hits`, [organizationId, slot, operation, digest, LIMITS[operation]]);
    return result.rowCount === 1;
  }
}
