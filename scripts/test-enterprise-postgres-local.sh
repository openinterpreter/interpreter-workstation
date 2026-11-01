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
printf "CREATE ROLE enterprise_fixture LOGIN PASSWORD '%s';\nCREATE DATABASE enterprise_fixture;\n" "$password" | "${psql_local[@]}" >/dev/null
"${psql_local[@]}" -d enterprise_fixture -c 'CREATE TABLE interpreter_enterprise_directory (id smallint PRIMARY KEY CHECK (id = 1), content text NOT NULL); GRANT CONNECT ON DATABASE enterprise_fixture TO enterprise_fixture; GRANT SELECT, INSERT, UPDATE ON interpreter_enterprise_directory TO enterprise_fixture;' >/dev/null
"${psql_local[@]}" -d enterprise_fixture -c "INSERT INTO interpreter_enterprise_directory (id, content) VALUES (1, '{\"version\":1,\"organizations\":{},\"attempts\":{},\"sessions\":{},\"audit\":[]}');" >/dev/null
export ENTERPRISE_TEST_DB_PORT="$port" ENTERPRISE_TEST_DB_PASSWORD="$password" ENTERPRISE_TEST_DB_CA="$fixture/ca.pem" ENTERPRISE_TEST_DB_FIXTURE="$fixture"
export NODE_ENV=test
printf 'Live PostgreSQL fixture: version %s, loopback-only TLS with ephemeral CA, restricted application role.\n' "$("$pgbin/postgres" --version)"
cd "$root"
bun test server/enterprise/postgresDirectoryStore.live.test.ts
