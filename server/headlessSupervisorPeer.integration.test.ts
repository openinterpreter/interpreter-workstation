import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const threadId = '00000000-0000-4000-8000-000000000001';
const wrongThread = '00000000-0000-4000-8000-000000000002';
const expected = { goalId: '00000000-0000-4000-8000-000000000004',
  status: 'blocked', missionRevision: 1, lifecycleRevision: 7 };
const children: Bun.Subprocess[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function start(home: string, config: 'complete' | 'missing' | 'wrong-target' |
  'wrong-audience' = 'complete',
  standalone = false) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '__tests__',
    'headlessSupervisorPeer.fixture.ts')], {
    cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, HOME: home, INTERPRETER_HOME: home, NODE_ENV: 'test',
      SUPERVISOR_FIXTURE_STATE: join(home, 'goal.json'),
      SUPERVISOR_FIXTURE_STANDALONE: standalone ? '1' : '0',
      INTERPRETER_SUPERVISOR_VERIFY_URL: config === 'wrong-audience'
        ? 'https://different.example.test/verify' : 'https://verifier.example.test/verify',
      INTERPRETER_SUPERVISOR_VERIFY_AUDIENCE: config === 'wrong-audience'
        ? 'https://different.example.test' : 'https://verifier.example.test',
      INTERPRETER_SUPERVISOR_TARGET_COMPUTER: config === 'missing' ? '' :
        config === 'wrong-target' ? 'other-target' : 'fixture-target',
      INTERPRETER_DISABLE_FILE_WATCHER: '1' },
  });
  children.push(child);
  const reader = child.stdout.getReader();
  let output = '';
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now()))
      .then(() => null)]);
    if (result === null) break;
    if (result.done) break;
    output += new TextDecoder().decode(result.value);
    const match = output.match(/FIXTURE_PORT=(\d+)/) ??
      output.match(/"type":"server_ready"[^\n]*"port":(\d+)/);
    if (match) { reader.releaseLock(); return `http://127.0.0.1:${match[1]}`; }
  }
  child.kill();
  const error = await new Response(child.stderr).text();
  throw Error(`Headless fixture failed to start: ${output.slice(-800)} ${error.slice(-1000)}`);
}

describe('actual headless server peer mount', () => {
  test('scoped read, unauthorized denial, native stale CAS, and durable restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'headless-peer-'));
    homes.push(home);
    writeFileSync(join(home, 'goal.json'), JSON.stringify({ status: 'blocked', lifecycleRevision: 7 }));
    let base = await start(home, 'complete', true);
    const url = (id: string) => `${base}/api/interpreter-peer/threads/${id}`;
    const headers = { 'content-type': 'application/json',
      'x-interpreter-supervisor-assertion': 'fixture-assertion' };
    expect((await fetch(`${url(threadId)}/goal`)).status).toBe(403);
    expect((await fetch(`${url(wrongThread)}/goal`, { headers })).status).toBe(403);
    const positive = await fetch(`${url(threadId)}/goal`, { headers });
    expect(positive.status).toBe(200);
    expect(await positive.json()).toMatchObject({ available: true, fixtureState: 'blocked' });
    const post = () => fetch(`${url(threadId)}/goal/resume`, {
      method: 'POST', headers, body: JSON.stringify({ expected }),
    });
    const first = await post();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ revision: { status: 'active', lifecycleRevision: 8 } });
    expect((await post()).status).toBe(409);
    expect(await (await fetch(`${base}/fixture/native-call-count`)).json()).toEqual({ nativeCalls: 2 });
    const old = children.pop()!;
    old.kill();
    await old.exited;
    base = await start(home, 'complete', true);
    const afterRestart = await fetch(`${url(threadId)}/goal`, { headers });
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.json()).toMatchObject({ fixtureState: 'active' });
    expect((await post()).status).toBe(409);
    expect((await fetch(`${url(wrongThread)}/goal/resume`, { method: 'POST', headers,
      body: JSON.stringify({ expected }) })).status).toBe(403);
    expect(await (await fetch(`${base}/fixture/native-call-count`)).json()).toEqual({ nativeCalls: 1 });
  }, 60_000);
  test('incomplete verifier configuration leaves the peer route unmounted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'headless-peer-'));
    homes.push(home);
    writeFileSync(join(home, 'goal.json'), JSON.stringify({ status: 'blocked', lifecycleRevision: 7 }));
    const base = await start(home, 'missing');
    expect((await fetch(`${base}/api/interpreter-peer/threads/${threadId}/goal`)).status).toBe(404);
  }, 60_000);
  test('wrong target and audience never confer peer authority', async () => {
    const home = mkdtempSync(join(tmpdir(), 'headless-peer-'));
    homes.push(home);
    writeFileSync(join(home, 'goal.json'), JSON.stringify({ status: 'blocked', lifecycleRevision: 7 }));
    const headers = { 'x-interpreter-supervisor-assertion': 'fixture-assertion' };
    const target = await start(home, 'wrong-target');
    expect((await fetch(`${target}/api/interpreter-peer/threads/${threadId}/goal`,
      { headers })).status).toBe(403);
    const old = children.pop()!;
    old.kill();
    await old.exited;
    const audience = await start(home, 'wrong-audience');
    // A well-formed but untrusted audience cannot turn an assertion into a grant.
    expect((await fetch(`${audience}/api/interpreter-peer/threads/${threadId}/goal`,
      { headers })).status).toBe(403);
  }, 60_000);
});
