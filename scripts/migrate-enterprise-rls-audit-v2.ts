/** Operator-only, offline migration of the opt-in RLS tenant directory.
 * Stop writers and verify a restorable backup before running this script.
 * Required private environment: ENTERPRISE_AUDIT_MIGRATION_DB_HOST, _DB_PORT,
 * _DB_NAME, _DB_USER, _DB_PASSWORD, _DB_CA_FILE, _BACKUP_FILE, _BACKUP_SHA256.
 * No application route imports this script; do not run it as a tenant role. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEnterprisePostgresPool } from '../server/enterprise/postgresDirectoryStore';
import { migrateEnterpriseRlsAuditSnapshots } from '../server/enterprise/rlsAuditMigration';

async function verifiedBackup(path: string, expected: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('A verified backup checksum is required');
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 ||
      (metadata.mode & 0o077) !== 0 || await realpath(absolute) !== absolute) {
    throw new Error('Unsafe backup evidence');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolute)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('Backup checksum mismatch');
}

async function main(): Promise<void> {
  const env = process.env;
  const get = (name: string) => {
    const value = env[`ENTERPRISE_AUDIT_MIGRATION_${name}`];
    if (!value) throw new Error(`Missing migration input: ${name}`);
    return value;
  };
  await verifiedBackup(get('BACKUP_FILE'), get('BACKUP_SHA256'));
  const ca = await readFile(get('DB_CA_FILE'), 'utf8');
  const pool = createEnterprisePostgresPool({ host: get('DB_HOST'), port: Number(get('DB_PORT')),
    database: get('DB_NAME'), user: get('DB_USER'), password: get('DB_PASSWORD'), caCertificate: ca },
  { offlineMigration: true });
  try {
    const migrated = await migrateEnterpriseRlsAuditSnapshots(pool);
    process.stdout.write(`Validated and migrated ${migrated} tenant snapshots; audit rows retained.\n`);
  } finally { await pool.end(); }
}

if (import.meta.main) await main();
