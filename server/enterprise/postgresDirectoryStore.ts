import pg, { type Pool, type PoolClient } from 'pg';
import {
  blankDirectoryState, decodeDirectoryState, MAX_DIRECTORY_BYTES, validateDirectoryState,
  type DirectoryState, type EnterpriseStateStore,
} from './serverDirectory';

/** Applied by a database operator, never by a browser request or application bootstrap. */
export const ENTERPRISE_DIRECTORY_SCHEMA = `CREATE TABLE interpreter_enterprise_directory (
  id smallint PRIMARY KEY CHECK (id = 1),
  content text NOT NULL
)`;

type QueryResult = { rows: Array<{ content?: unknown }>; rowCount: number | null };
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
    return stateFrom(await this.pool.query('SELECT content FROM interpreter_enterprise_directory WHERE id = 1'));
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
        await client.query('INSERT INTO interpreter_enterprise_directory (id, content) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
          [JSON.stringify(blankDirectoryState())]);
      }
      const state = stateFrom(await client.query('SELECT content FROM interpreter_enterprise_directory WHERE id = 1 FOR UPDATE'));
      const result = fn(state);
      validateDirectoryState(state);
      const content = JSON.stringify(state);
      if (Buffer.byteLength(content, 'utf8') > MAX_DIRECTORY_BYTES) throw new Error('Directory capacity reached');
      const updated = await client.query('UPDATE interpreter_enterprise_directory SET content = $1 WHERE id = 1', [content]);
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
