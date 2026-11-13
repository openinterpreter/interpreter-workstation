#!/usr/bin/env bash
# Isolated, disposable, loopback-only PostgreSQL integration fixture. No system cluster is used.
set -euo pipefail
umask 077
root="$(cd "$(dirname "$0")/.." && pwd)"
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
printf "CREATE ROLE enterprise_fixture LOGIN PASSWORD '%s';\nCREATE DATABASE enterprise_fixture;\n" "$password" | "${psql_local[@]}" >/dev/null
printf "CREATE ROLE enterprise_fixture_a LOGIN NOINHERIT NOBYPASSRLS PASSWORD '%s';\nCREATE ROLE enterprise_fixture_b LOGIN NOINHERIT NOBYPASSRLS PASSWORD '%s';\n" \
  "$tenant_a_password" "$tenant_b_password" | "${psql_local[@]}" >/dev/null
"${psql_local[@]}" -d enterprise_fixture -c 'CREATE TABLE public.interpreter_enterprise_directory (id smallint PRIMARY KEY CHECK (id = 1), content text NOT NULL); GRANT CONNECT ON DATABASE enterprise_fixture TO enterprise_fixture; GRANT SELECT, INSERT, UPDATE ON public.interpreter_enterprise_directory TO enterprise_fixture;' >/dev/null
"${psql_local[@]}" -d enterprise_fixture -c "CREATE TABLE public.interpreter_enterprise_tenant_directory (organization_id text PRIMARY KEY CHECK (char_length(organization_id) BETWEEN 1 AND 160 AND organization_id ~ '^[A-Za-z0-9._@:-]+$'), content text NOT NULL); GRANT SELECT, INSERT, UPDATE ON public.interpreter_enterprise_tenant_directory TO enterprise_fixture;" >/dev/null
"${psql_local[@]}" -d enterprise_fixture >/dev/null <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE public.interpreter_enterprise_rls_directory (
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
    WHERE d.database_role = current_user));
GRANT CONNECT ON DATABASE enterprise_fixture TO enterprise_fixture_a, enterprise_fixture_b;
GRANT SELECT, UPDATE(content) ON public.interpreter_enterprise_rls_directory TO enterprise_fixture_a, enterprise_fixture_b;
GRANT SELECT ON public.interpreter_enterprise_rls_audit TO enterprise_fixture_a, enterprise_fixture_b;
GRANT INSERT(organization_id, content) ON public.interpreter_enterprise_rls_audit TO enterprise_fixture_a, enterprise_fixture_b;
INSERT INTO public.interpreter_enterprise_rls_directory (organization_id, database_role, content)
  VALUES ('rls-a', 'enterprise_fixture_a', '{"version":1,"organizations":{},"attempts":{},"sessions":{},"audit":[]}'),
         ('rls-b', 'enterprise_fixture_b', '{"version":1,"organizations":{},"attempts":{},"sessions":{},"audit":[]}');
SQL
"${psql_local[@]}" -d enterprise_fixture -c "INSERT INTO public.interpreter_enterprise_directory (id, content) VALUES (1, '{\"version\":1,\"organizations\":{},\"attempts\":{},\"sessions\":{},\"audit\":[]}');" >/dev/null
export ENTERPRISE_TEST_DB_PORT="$port" ENTERPRISE_TEST_DB_PASSWORD="$password" ENTERPRISE_TEST_DB_CA="$fixture/ca.pem" ENTERPRISE_TEST_DB_FIXTURE="$fixture"
export ENTERPRISE_TEST_DB_PASSWORD_A="$tenant_a_password" ENTERPRISE_TEST_DB_PASSWORD_B="$tenant_b_password"
export NODE_ENV=test
printf 'Live PostgreSQL fixture: version %s, loopback-only TLS with ephemeral CA, restricted application role.\n' "$("$pgbin/postgres" --version)"
cd "$root"
bun test server/enterprise/postgresDirectoryStore.live.test.ts
