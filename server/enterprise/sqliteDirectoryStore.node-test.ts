import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Node-only suite: Bun's unit-test discovery does not implement node:sqlite.
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ServerDirectory } from './serverDirectory';
import { SqliteDirectoryStore } from './sqliteDirectoryStore';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'enterprise-sqlite-'));
  paths.push(parent);
  const file = join(parent, 'private', 'directory.sqlite');
  const directory = new ServerDirectory(new SqliteDirectoryStore(file));
  await directory.bootstrap('org-a', 'Acme', 'https://idp.example/a',
    { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
  await directory.bootstrap('org-b', 'Beta', 'https://idp.example/b',
    { organizationId: 'org-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
  return { file, directory };
}

test('SQLite backend persists audited tenant-scoped sessions across instances with restrictive file modes', async () => {
  const { file, directory } = await fixture();
  const { token } = await directory.createSession('https://idp.example/a', 'org-a', 'alice', Date.now() + 60_000);
  const resumed = new ServerDirectory(new SqliteDirectoryStore(file));
  const identity = await resumed.verifySession(token);
  assert.ok(identity);
  assert.equal((await resumed.readAdmin(identity, 'overview') as { organization: { id: string } }).organization.id, 'org-a');
  assert.equal(await resumed.readAdmin({ ...identity, organizationId: 'org-b' }, 'members'), null);
  assert.equal((await resumed.auditSummary('org-b')).eventCount, 2); // bootstrap and denied cross-tenant read
  await resumed.revokeSession(identity);
  assert.equal(await directory.verifySession(token), null);
  assert.equal((await stat(file)).mode & 0o077, 0);
  assert.equal((await stat(join(file, '..'))).mode & 0o077, 0);
  assert.equal((await readFile(file)).includes(Buffer.from(token)), false);
});

test('SQLite transaction rollback preserves evidence and corrupted tenant state fails closed', async () => {
  const { file, directory } = await fixture();
  const before = await directory.auditSummary('org-a');
  await assert.rejects(new SqliteDirectoryStore(file).change((state) => {
    state.audit.push({ organizationId: 'org-a', subject: 'alice', action: 'incomplete', outcome: 'allowed', at: new Date().toISOString() });
    throw new Error('audit failure');
  }));
  assert.deepEqual(await directory.auditSummary('org-a'), before);
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare('SELECT content FROM enterprise_state WHERE id = 1').get() as { content: string };
    const state = JSON.parse(row.content);
    state.organizations['org-a'].members.alice.organizationId = 'org-b';
    db.prepare('UPDATE enterprise_state SET content = ? WHERE id = 1').run(JSON.stringify(state));
  } finally { db.close(); }
  await assert.rejects(directory.listMembers('org-a'));
  await assert.rejects(directory.compactExpired());
});

test('separate processes serialize audit writes without losing a tenant event', async () => {
  const { file, directory } = await fixture();
  const worker = `import { SqliteDirectoryStore } from './server/enterprise/sqliteDirectoryStore.ts';
    const store = new SqliteDirectoryStore(process.argv[1]);
    for (let i = 0; i < 10; i++) await store.change((data) => {
      data.audit.push({ organizationId: 'org-a', subject: 'alice', action: 'fixture.write',
        outcome: 'allowed', at: new Date().toISOString() });
    });`;
  const run = promisify(execFile);
  await Promise.all([0, 1].map(() => run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', worker, file],
    { cwd: process.cwd(), timeout: 15_000, maxBuffer: 4096 })));
  assert.equal((await directory.auditSummary('org-a')).eventCount, 21); // bootstrap + two writers
});
