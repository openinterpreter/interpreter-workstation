import { open, lstat, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { blankDirectoryState, decodeDirectoryState, MAX_DIRECTORY_BYTES, validateDirectoryState,
  type DirectoryState, type EnterpriseStateStore } from './serverDirectory';

/** Optional single-host transactional backend, not selected by the desktop or deployment. */
export class SqliteDirectoryStore implements EnterpriseStateStore {
  private readonly file: string;
  constructor(file: string) { this.file = resolve(file); }

  private async prepare(create: boolean): Promise<void> {
    const parent = dirname(this.file);
    if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || (parentStat.mode & 0o077) !== 0) throw new Error('Directory permissions are unsafe');
    if (create) {
      try {
        const handle = await open(this.file, 'wx', 0o600);
        try { await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const state = await lstat(this.file);
    if (!state.isFile() || (state.mode & 0o077) !== 0) throw new Error('Directory database is unsafe');
  }

  private connect(): DatabaseSync {
    const db = new DatabaseSync(this.file, { allowExtension: false });
    try {
      db.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private current(db: DatabaseSync): DirectoryState {
    const row = db.prepare('SELECT content FROM enterprise_state WHERE id = 1').get() as { content: unknown } | undefined;
    if (!row || typeof row.content !== 'string') throw new Error('Directory database is uninitialized');
    return decodeDirectoryState(row.content);
  }

  async read(): Promise<DirectoryState> {
    await this.prepare(false);
    const db = this.connect();
    try { return this.current(db); } finally { db.close(); }
  }

  async change<T>(fn: (state: DirectoryState) => T, create = false): Promise<T> {
    await this.prepare(create);
    const db = this.connect();
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
      if (create) {
        db.exec('CREATE TABLE IF NOT EXISTS enterprise_state (id INTEGER PRIMARY KEY CHECK (id = 1), content TEXT NOT NULL) STRICT');
        db.prepare('INSERT OR IGNORE INTO enterprise_state (id, content) VALUES (1, ?)').run(JSON.stringify(blankDirectoryState()));
      }
      const state = this.current(db);
      const result = fn(state);
      validateDirectoryState(state);
      const content = JSON.stringify(state);
      if (Buffer.byteLength(content, 'utf8') > MAX_DIRECTORY_BYTES) throw new Error('Directory capacity reached');
      db.prepare('UPDATE enterprise_state SET content = ? WHERE id = 1').run(content);
      db.exec('COMMIT');
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) db.exec('ROLLBACK');
      throw error;
    } finally { db.close(); }
  }
}
