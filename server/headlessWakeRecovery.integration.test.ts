import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wakeClientId } from './utils/wakeSources';

const threadId = '00000000-0000-4000-8000-000000000001';
const wrongThread = '00000000-0000-4000-8000-000000000002';
const children: Bun.Subprocess[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function start(home: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '__tests__',
    'wakeRecovery.fixture.ts')], {
    cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, HOME: home, INTERPRETER_HOME: home, NODE_ENV: 'test',
      WAKE_FIXTURE_RECEIPT: join(home, 'receipt.json'),
      INTERPRETER_DISABLE_FILE_WATCHER: '1' },
  });
  children.push(child);
  const reader = child.stdout.getReader();
  let output = '';
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now()))
      .then(() => null)]);
    if (!result || result.done) break;
    output += new TextDecoder().decode(result.value);
    const match = output.match(/"type":"server_ready"[^\n]*"port":(\d+)/);
    if (match) { reader.releaseLock(); return `http://127.0.0.1:${match[1]}`; }
  }
  child.kill();
  const error = await new Response(child.stderr).text();
  throw Error(`Fixture failed to start: ${output.slice(-500)} ${error.slice(-800)}`);
}
function create(home: string, sequence: number, status: 'held' | 'offered') {
  const eventId = `daily-${sequence}`;
  writeFileSync(join(home, 'receipt.json'), '[]');
  writeFileSync(join(home, 'wake-sources.json'), JSON.stringify({
    sources: [{ id: 'daily', threadId, kind: 'schedule', message: 'Fixture input',
      dailyAt: '07:00', timeZone: 'America/Los_Angeles', status: 'error', sequence }],
    events: [{ threadId, sourceId: 'daily', eventId, message: 'Fixture input',
      status, createdAt: '2026-11-01T00:00:00.000Z',
      ...(status === 'offered' ? { offeredAt: '2026-11-01T00:00:00.000Z' } : {}) }],
  }));
  return eventId;
}
const headers = { 'content-type': 'application/json', 'x-fixture-assertion': 'fixture-own-thread',
  'x-fixture-thread': threadId };
async function tool(base: string, action: string, fields: Record<string, string> = {},
  h: Record<string, string> = headers) {
  const response = await fetch(`${base}/fixture/recovery-tool`, { method: 'POST', headers: h,
    body: JSON.stringify({ action, id: 'daily', ...fields }) });
  return { status: response.status, result: (response.status === 403 ? null : await response.json()) as {
    isError?: boolean; content: Array<{ text: string }> } };
}
const value = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);

describe('actual standalone own-thread daily recovery tool', () => {
  test('held occurrence stays held, future-only CAS survives restart; unauthorized and stale refuse', async () => {
    const home = mkdtempSync(join(tmpdir(), 'headless-wake-')); homes.push(home);
    const eventId = create(home, 17, 'held');
    let base = await start(home);
    expect((await tool(base, 'inspect-recovery', {}, { 'content-type': 'application/json' })).status).toBe(403);
    const wrong = await tool(base, 'inspect-recovery', {}, { ...headers, 'x-fixture-thread': wrongThread });
    expect(wrong.result.isError).toBe(true);
    const prior = value((await tool(base, 'inspect-recovery')).result);
    expect(prior.events).toEqual([{ eventId, status: 'held' }]);
    const fields = { eventId, expectedRevision: prior.revision };
    const first = value((await tool(base, 'recover-future', fields)).result);
    expect(first.source.status).toBe('waiting');
    expect(Date.parse(first.source.nextAt)).toBeGreaterThan(Date.now());
    expect(first.events).toEqual(prior.events);
    expect(value((await tool(base, 'recover-future', fields)).result))
      .toEqual({ available: false, category: 'stale_revision' });
    const old = children.pop()!; old.kill(); await old.exited;
    base = await start(home);
    const restart = value((await tool(base, 'inspect-recovery')).result);
    expect(restart).toEqual(first);
    expect(value((await tool(base, 'recover-future', fields)).result).category).toBe('stale_revision');
    expect((await fetch(`${base}/fixture/native-starts`).then(r => r.json()))).toEqual({ starts: 0 });
  }, 60_000);

  test('offered unknown receipt refuses without replay; later positive marker admits once after restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'headless-wake-')); homes.push(home);
    const eventId = create(home, 21, 'offered');
    let base = await start(home);
    const prior = value((await tool(base, 'inspect-recovery')).result);
    const fields = { eventId, expectedRevision: prior.revision };
    expect(value((await tool(base, 'recover-future', fields)).result).category).toBe('refused_ambiguous');
    expect(value((await tool(base, 'reconcile-offered', fields)).result).category).toBe('refused_ambiguous');
    expect(value((await tool(base, 'inspect-recovery')).result)).toEqual(prior);
    const old = children.pop()!; old.kill(); await old.exited;
    base = await start(home);
    writeFileSync(join(home, 'receipt.json'), JSON.stringify([wakeClientId({ threadId, sourceId: 'daily', eventId })]));
    const admitted = value((await tool(base, 'reconcile-offered', fields)).result);
    expect(admitted.events).toEqual([{ eventId, status: 'admitted' }]);
    expect(value((await tool(base, 'reconcile-offered', fields)).result).category).toBe('stale_revision');
    expect((await fetch(`${base}/fixture/native-starts`).then(r => r.json()))).toEqual({ starts: 0 });
    const persisted = JSON.parse(readFileSync(join(home, 'wake-sources.json'), 'utf8'));
    expect(persisted.events[0].status).toBe('admitted');
  }, 60_000);
});
