#!/usr/bin/env bash
# Isolated, disposable, loopback-only PostgreSQL integration fixture. No system cluster is used.
set -euo pipefail
umask 077
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
fixture="$(mktemp -d /workspace/private/enterprise-pg.XXXXXXXX)"
pgbin=/usr/lib/postgresql/14/bin
stop() {
  if [[ -f "$fixture/data/postmaster.pid" ]]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate -w stop >/dev/null; fi
  rm -rf -- "$fixture"
}
trap stop EXIT
"$pgbin/initdb" -D "$fixture/data" --auth-local=trust --auth-host=scram-sha-256 --no-instructions >"$fixture/init.log"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -sha256 -keyout "$fixture/ca.key" -out "$fixture/ca.pem" -subj '/CN=Interpreter disposable test CA' >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -sha256 -keyout "$fixture/untrusted-ca.key" -out "$fixture/untrusted-ca.pem" -subj '/CN=Untrusted disposable test CA' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 -keyout "$fixture/server.key" -out "$fixture/server.csr" -subj '/CN=127.0.0.1' >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$fixture/server.ext"
openssl x509 -req -in "$fixture/server.csr" -CA "$fixture/ca.pem" -CAkey "$fixture/ca.key" -CAcreateserial -days 1 -sha256 -extfile "$fixture/server.ext" -out "$fixture/server.pem" >/dev/null 2>&1
chmod 600 "$fixture/server.key"
port="${ENTERPRISE_TEST_PORT:-55471}"
[[ "$port" =~ ^[0-9]+$ ]] && ((port > 1024 && port < 65536))
cat >>"$fixture/data/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = $port
unix_socket_directories = '$fixture'
ssl = on
ssl_cert_file = '$fixture/server.pem'
ssl_key_file = '$fixture/server.key'
max_connections = 20
shared_buffers = 32MB
EOF
cat >"$fixture/data/pg_hba.conf" <<EOF
local all all trust
hostssl all all 127.0.0.1/32 scram-sha-256
hostnossl all all 127.0.0.1/32 reject
host all all 0.0.0.0/0 reject
host all all ::0/0 reject
EOF
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -w start >/dev/null
psql_local=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture" -p "$port" -d postgres)
password="$(openssl rand -hex 32)"
tenant_a_password="$(openssl rand -hex 32)"
tenant_b_password="$(openssl rand -hex 32)"
recovery_password="$(openssl rand -hex 32)"
network_password="$(openssl rand -hex 32)"
https_password="$(openssl rand -hex 32)"
printf "CREATE ROLE enterprise_fixture LOGIN PASSWORD '%s';\nCREATE DATABASE enterprise_fixture;\n" "$password" | "${psql_local[@]}" >/dev/null
printf "CREATE ROLE enterprise_fixture_a LOGIN NOINHERIT NOBYPASSRLS PASSWORD '%s';\nCREATE ROLE enterprise_fixture_b LOGIN NOINHERIT NOBYPASSRLS PASSWORD '%s';\n" \
  "$tenant_a_password" "$tenant_b_password" | "${psql_local[@]}" >/dev/null
printf "CREATE ROLE enterprise_fixture_recovery LOGIN NOINHERIT NOBYPASSRLS PASSWORD '%s';\n" "$recovery_password" | "${psql_local[@]}" >/dev/null
printf "CREATE ROLE enterprise_fixture_network LOGIN NOINHERIT NOBYPASSRLS PASSWORD '%s';\nCREATE ROLE enterprise_fixture_https LOGIN NOINHERIT NOBYPASSRLS PASSWORD '%s';\n" \
  "$network_password" "$https_password" | "${psql_local[@]}" >/dev/null
"${psql_local[@]}" -d enterprise_fixture -c 'REVOKE CREATE ON SCHEMA public FROM PUBLIC' >/dev/null
# All three fixture backends execute the application-exported operator DDL,
# never a second handwritten schema that can silently drift from source.
bun -e 'import { ENTERPRISE_DIRECTORY_SCHEMA, ENTERPRISE_TENANT_DIRECTORY_SCHEMA, ENTERPRISE_RLS_TENANT_DIRECTORY_SCHEMA } from "./server/enterprise/postgresDirectoryStore.ts"; process.stdout.write([ENTERPRISE_DIRECTORY_SCHEMA, ENTERPRISE_TENANT_DIRECTORY_SCHEMA, ENTERPRISE_RLS_TENANT_DIRECTORY_SCHEMA].join(";\n") + ";\n")' |
  "${psql_local[@]}" -d enterprise_fixture >/dev/null
"${psql_local[@]}" -d enterprise_fixture >/dev/null <<'SQL'
GRANT CONNECT ON DATABASE enterprise_fixture TO enterprise_fixture;
GRANT SELECT, INSERT, UPDATE ON public.interpreter_enterprise_directory TO enterprise_fixture;
GRANT SELECT, INSERT, UPDATE ON public.interpreter_enterprise_tenant_directory TO enterprise_fixture;
GRANT CONNECT ON DATABASE enterprise_fixture TO enterprise_fixture_a, enterprise_fixture_b, enterprise_fixture_recovery, enterprise_fixture_network, enterprise_fixture_https;
GRANT SELECT, UPDATE(content) ON public.interpreter_enterprise_rls_directory TO enterprise_fixture_a, enterprise_fixture_b, enterprise_fixture_recovery, enterprise_fixture_network, enterprise_fixture_https;
GRANT SELECT ON public.interpreter_enterprise_rls_audit TO enterprise_fixture_a, enterprise_fixture_b, enterprise_fixture_recovery, enterprise_fixture_network, enterprise_fixture_https;
GRANT INSERT(organization_id, content) ON public.interpreter_enterprise_rls_audit TO enterprise_fixture_a, enterprise_fixture_b, enterprise_fixture_recovery, enterprise_fixture_network, enterprise_fixture_https;
GRANT SELECT ON public.interpreter_enterprise_rls_domain_claim TO enterprise_fixture_a, enterprise_fixture_b, enterprise_fixture_recovery, enterprise_fixture_network, enterprise_fixture_https;
GRANT INSERT(domain, organization_id, database_role, issuer) ON public.interpreter_enterprise_rls_domain_claim TO enterprise_fixture_a, enterprise_fixture_b, enterprise_fixture_recovery, enterprise_fixture_network, enterprise_fixture_https;
-- PostgreSQL row-locking SELECT requires UPDATE privilege on at least one
-- column. Only the RLS-constrained, self-equal role column can be updated;
-- claim identity and ownership columns remain operator-owned.
GRANT UPDATE(database_role) ON public.interpreter_enterprise_rls_domain_claim TO enterprise_fixture_a, enterprise_fixture_b, enterprise_fixture_recovery, enterprise_fixture_network, enterprise_fixture_https;
INSERT INTO public.interpreter_enterprise_rls_directory (organization_id, database_role, content)
  VALUES ('rls-a', 'enterprise_fixture_a', '{"version":1,"organizations":{},"attempts":{},"sessions":{},"audit":[]}'),
         ('rls-b', 'enterprise_fixture_b', '{"version":1,"organizations":{},"attempts":{},"sessions":{},"audit":[]}'),
         ('rls-recovery', 'enterprise_fixture_recovery', '{"version":1,"organizations":{},"attempts":{},"sessions":{},"audit":[]}'),
         ('network-org', 'enterprise_fixture_network', '{"version":1,"organizations":{},"attempts":{},"sessions":{},"audit":[]}'),
         ('https-org', 'enterprise_fixture_https', '{"version":1,"organizations":{},"attempts":{},"sessions":{},"audit":[]}');
SQL
"${psql_local[@]}" -d enterprise_fixture -c "INSERT INTO public.interpreter_enterprise_directory (id, content) VALUES (1, '{\"version\":1,\"organizations\":{},\"attempts\":{},\"sessions\":{},\"audit\":[]}');" >/dev/null
# Exercise the operator migration on real, ordered legacy jsonb audit rows
# before the normal TLS tests. A forged old ledger must abort and remain jsonb;
# a valid old ledger must retain canonical event spelling and sequence IDs.
"${psql_local[@]}" -d enterprise_fixture >/dev/null <<'SQL'
INSERT INTO public.interpreter_enterprise_rls_directory (organization_id, database_role, content)
VALUES ('rls-migration', 'enterprise_fixture_migration',
  '{"version":1,"organizations":{},"attempts":{},"sessions":{},"audit":[{"organizationId":"rls-migration","subject":"legacy|one","action":"seed.one","outcome":"allowed","at":"2026-01-01T00:00:00.000Z"},{"organizationId":"rls-migration","subject":"legacy|two","targetSubject":"opaque|three","action":"seed.two","outcome":"denied","at":"2026-01-02T00:00:00.000Z"}]}');
INSERT INTO public.interpreter_enterprise_rls_audit (organization_id, content)
SELECT 'rls-migration', e.event::text FROM
  public.interpreter_enterprise_rls_directory d,
  LATERAL json_array_elements(d.content::json->'audit') WITH ORDINALITY AS e(event, ordinality)
WHERE d.organization_id = 'rls-migration' ORDER BY e.ordinality;
ALTER TABLE public.interpreter_enterprise_rls_audit DROP CONSTRAINT interpreter_enterprise_rls_audit_check;
ALTER TABLE public.interpreter_enterprise_rls_audit ALTER COLUMN content TYPE jsonb USING content::jsonb;
ALTER TABLE public.interpreter_enterprise_rls_audit ADD CONSTRAINT interpreter_enterprise_rls_audit_check
  CHECK (jsonb_typeof(content) = 'object');
UPDATE public.interpreter_enterprise_rls_audit SET content = jsonb_set(content, '{action}', '"forged"'::jsonb)
WHERE organization_id = 'rls-migration' AND id =
  (SELECT min(id) FROM public.interpreter_enterprise_rls_audit WHERE organization_id = 'rls-migration');
SQL
original_audit_ids="$("${psql_local[@]}" -d enterprise_fixture -tA -c "SELECT string_agg(id::text, ',' ORDER BY id) FROM public.interpreter_enterprise_rls_audit WHERE organization_id = 'rls-migration'")"
if printf 'SET ROLE enterprise_fixture_a;\n\\i scripts/migrate-enterprise-rls-audit-jsonb-to-text.sql\n' | \
  "${psql_local[@]}" -d enterprise_fixture >/dev/null 2>&1; then
  echo 'Tenant-scoped operator unexpectedly migrated a FORCE RLS ledger' >&2; exit 1
fi
[[ "$("${psql_local[@]}" -d enterprise_fixture -tA -c "SELECT atttypid::regtype FROM pg_attribute WHERE attrelid = 'public.interpreter_enterprise_rls_audit'::regclass AND attname = 'content'")" == jsonb ]]
ENTERPRISE_TEST_DB_PORT="$port" ENTERPRISE_TEST_DB_CA="$fixture/ca.pem" ENTERPRISE_TEST_DB_PASSWORD_A="$tenant_a_password" bun -e '
import { readFileSync } from "node:fs";
import { ServerDirectory } from "./server/enterprise/serverDirectory.ts";
import { createEnterprisePostgresPool, TenantPostgresDirectoryStore } from "./server/enterprise/postgresDirectoryStore.ts";
const pool = createEnterprisePostgresPool({ host: "127.0.0.1", port: Number(process.env.ENTERPRISE_TEST_DB_PORT),
  database: "enterprise_fixture", user: "enterprise_fixture_a", password: process.env.ENTERPRISE_TEST_DB_PASSWORD_A!,
  caCertificate: readFileSync(process.env.ENTERPRISE_TEST_DB_CA!, "utf8") });
try {
  await new ServerDirectory(new TenantPostgresDirectoryStore(pool, "rls-a", "rls")).getMember("rls-a", "alice");
  throw new Error("Old jsonb audit schema was not refused");
} catch (error) {
  if (!String(error).includes("Enterprise tenant database boundary is unsafe")) throw error;
} finally { await pool.end(); }
'
if "${psql_local[@]}" -d enterprise_fixture -f scripts/migrate-enterprise-rls-audit-jsonb-to-text.sql >/dev/null 2>&1; then
  echo 'Corrupt legacy audit unexpectedly migrated' >&2; exit 1
fi
[[ "$("${psql_local[@]}" -d enterprise_fixture -tA -c "SELECT atttypid::regtype FROM pg_attribute WHERE attrelid = 'public.interpreter_enterprise_rls_audit'::regclass AND attname = 'content'")" == jsonb ]]
"${psql_local[@]}" -d enterprise_fixture >/dev/null <<'SQL'
WITH first_event AS (
  SELECT (d.content::json->'audit'->0)::jsonb AS content
  FROM public.interpreter_enterprise_rls_directory d WHERE d.organization_id = 'rls-migration'
)
UPDATE public.interpreter_enterprise_rls_audit a SET content = e.content FROM first_event e
WHERE a.organization_id = 'rls-migration' AND a.id =
  (SELECT min(id) FROM public.interpreter_enterprise_rls_audit WHERE organization_id = 'rls-migration');
SQL
"${psql_local[@]}" -d enterprise_fixture -f scripts/migrate-enterprise-rls-audit-jsonb-to-text.sql >/dev/null
[[ "$("${psql_local[@]}" -d enterprise_fixture -tA -c "SELECT atttypid::regtype FROM pg_attribute WHERE attrelid = 'public.interpreter_enterprise_rls_audit'::regclass AND attname = 'content'")" == text ]]
[[ "$("${psql_local[@]}" -d enterprise_fixture -tA -c "SELECT string_agg(id::text, ',' ORDER BY id) FROM public.interpreter_enterprise_rls_audit WHERE organization_id = 'rls-migration'")" == "$original_audit_ids" ]]
if "${psql_local[@]}" -d enterprise_fixture -f scripts/migrate-enterprise-rls-audit-jsonb-to-text.sql >/dev/null 2>&1; then
  echo 'A second migration unexpectedly rewrote an already migrated ledger' >&2; exit 1
fi
"${psql_local[@]}" -d enterprise_fixture >/dev/null <<'SQL'
DELETE FROM public.interpreter_enterprise_rls_audit WHERE organization_id = 'rls-migration';
DELETE FROM public.interpreter_enterprise_rls_directory WHERE organization_id = 'rls-migration';
SQL
printf 'Legacy jsonb migration: corrupt ledger refused; two ordered events preserved by validated text migration.\n'
export ENTERPRISE_TEST_DB_PORT="$port" ENTERPRISE_TEST_DB_PASSWORD="$password" ENTERPRISE_TEST_DB_CA="$fixture/ca.pem" ENTERPRISE_TEST_DB_FIXTURE="$fixture"
export ENTERPRISE_TEST_DB_PASSWORD_A="$tenant_a_password" ENTERPRISE_TEST_DB_PASSWORD_B="$tenant_b_password"
export ENTERPRISE_TEST_DB_PASSWORD_RECOVERY="$recovery_password"
export ENTERPRISE_TEST_DB_PASSWORD_NETWORK="$network_password" ENTERPRISE_TEST_DB_PASSWORD_HTTPS="$https_password"
export NODE_ENV=test
printf 'Live PostgreSQL fixture: version %s, loopback-only TLS with ephemeral CA, restricted application role.\n' "$("$pgbin/postgres" --version)"
cd "$root"
bun test --timeout 60000 server/enterprise/postgresDirectoryStore.live.test.ts
