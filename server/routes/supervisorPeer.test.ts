import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createSupervisorPeerRouter } from './supervisorPeer';
import type { VerifiedSupervisorGrant } from '../utils/supervisorPeerScope';

const threadId = '00000000-0000-4000-8000-000000000001';
const grant: VerifiedSupervisorGrant = {
  issuer: 'enrolled-issuer', subject: 'supervisor-1', sourceComputer: 'source-1',
  targetComputer: 'target-1', threadId,
  capabilities: ['goal:read', 'goal:create', 'goal:resume', 'task:read', 'command:read', 'artifact:read'],
  expiresAt: Date.now() + 60_000,
};
let server: Server | undefined;
afterEach(() => server?.close());

async function fixture(verified: VerifiedSupervisorGrant | null = grant, alteredDocument = false) {
  const calls = { goal: 0, create: 0, resume: 0, terminal: 0, artifact: 0, submission: 0 };
  const app = express();
  app.use(express.json({ limit: '2kb' }));
  app.use('/peer', createSupervisorPeerRouter({
    targetComputer: 'target-1', verify: async () => verified,
    readGoal: async () => { calls.goal++; return { goal: {
      threadId, status: 'blocked', objective: 'retained',
    } as never, revision: { goalId: '00000000-0000-4000-8000-000000000004',
      status: 'blocked', missionRevision: 4, lifecycleRevision: 7 }, document: {
        content: '# retained mission', byteLength: Buffer.byteLength('# retained mission'),
        sha256: createHash('sha256').update(alteredDocument ? '# other mission' : '# retained mission').digest('hex'),
        missionRevision: 4,
      } }; },
    createGoal: async () => { calls.create++; throw new Error('creation outcome unknown'); },
    resumeGoal: async (_thread, expected) => { calls.resume++; return { ...expected, status: 'active' }; },
    readTerminal: async () => { calls.terminal++; throw new Error('private command text'); },
    readJournal: async () => ({ requestId: 'request-1', threadId,
      clientUserMessageId: 'client-1', phase: 'turn_started', turnId: 'turn-1', at: 'now' }),
    readSubmission: async (_thread, clientUserMessageId) => { calls.submission++;
      return { threadId, clientUserMessageId, linkage: 'native_user_item',
        nativeMatch: { turnId: 'turn-1', userItemId: 'item-1', status: 'completed', commandSessions: [] },
        queuedSubmissionIds: [], custodyVerified: true,
        commandSessionScope: 'saved-native-turn-only-not-live-process-custody' as const };
    },
    readArtifact: async (_thread, receipt, content) => { calls.artifact++;
      return { threadId, receiptId: receipt, sha256: 'a'.repeat(64), size: 5,
        path: '/private/storage/never-return-this',
        ...(content ? { content: 'owned' } : {}) };
    },
  }));
  server = createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  return { base: `http://127.0.0.1:${address.port}/peer/threads/${threadId}`, calls };
}

describe('enrolled supervisor peer route seam', () => {
  it('permits only exact verified scope and retains a full Goal plus revision', async () => {
    const { base, calls } = await fixture();
    const allowed = await fetch(`${base}/goal`);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ available: true, goal: { threadId,
      status: 'blocked', objective: 'retained' }, revision: {
      goalId: '00000000-0000-4000-8000-000000000004', status: 'blocked',
      missionRevision: 4, lifecycleRevision: 7 }, document: {
      content: '# retained mission', byteLength: Buffer.byteLength('# retained mission'),
      sha256: createHash('sha256').update('# retained mission').digest('hex'),
      missionRevision: 4,
    } });
    const denied = await fetch(`${base.replace(threadId, '00000000-0000-4000-8000-000000000002')}/goal`);
    expect(denied.status).toBe(403);
    expect(calls.goal).toBe(1);
  });
  it('denies missing identity without invoking any dependency', async () => {
    const { base, calls } = await fixture(null);
    expect((await fetch(`${base}/goal`)).status).toBe(403);
    expect((await fetch(`${base}/artifacts/receipt-1?content=true`)).status).toBe(403);
    expect(calls).toEqual({ goal: 0, create: 0, resume: 0, terminal: 0, artifact: 0, submission: 0 });
  });
  it('denies cross-thread creation before a native call and keeps uncertain creation typed', async () => {
    const { base, calls } = await fixture();
    const create = (url: string) => fetch(`${url}/goal/create`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: 'mission' }) });
    const denied = await create(base.replace(threadId, '00000000-0000-4000-8000-000000000002'));
    expect(denied.status).toBe(403);
    expect(calls.create).toBe(0);
    const uncertain = await create(base);
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toEqual({ available: false, category: 'mutation_unconfirmed' });
    expect(calls.create).toBe(1);
  });
  it('accepts a large managed mission only on the scoped peer JSON transport', async () => {
    const app = express();
    app.use('/peer', express.json({ limit: '1050000b' }));
    app.use(express.json());
    const mission = '# Mission\n' + 'A retained requirement.\n'.repeat(7_000);
    const digest = createHash('sha256').update(mission).digest('hex');
    let received = '';
    app.use('/peer', createSupervisorPeerRouter({ targetComputer: 'target-1',
      verify: async () => grant,
      readGoal: async () => ({ goal: null, revision: null, document: null }),
      createGoal: async (_id, document) => { received = document; return {
        goal: { threadId, status: 'active', objective: 'managed' } as never,
        revision: { goalId: '00000000-0000-4000-8000-000000000004',
          status: 'active', missionRevision: 1, lifecycleRevision: 1 },
        document: { content: document, sha256: digest, byteLength: Buffer.byteLength(document),
          missionRevision: 1 },
      }; },
      resumeGoal: async () => { throw Error('unused'); },
      readTerminal: async () => { throw Error('unused'); },
    }));
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No listener');
    const response = await fetch(`http://127.0.0.1:${address.port}/peer/threads/${threadId}/goal/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: mission }),
    });
    expect(mission.length).toBeGreaterThan(100_000);
    expect(response.status).toBe(200);
    expect(received).toBe(mission);
  });
  it('authorizes exact task scope before projecting a saved current turn and denies cross-thread reads', async () => {
    const app = express();
    let calls = 0;
    app.use('/peer', createSupervisorPeerRouter({ targetComputer: 'target-1', verify: async () => grant,
      readGoal: async () => ({ goal: null, revision: null, document: null }),
      resumeGoal: async () => { throw Error('unused'); },
      readTerminal: async () => { throw Error('unused'); },
      readThread: async () => { calls++; return { id: threadId, preview: 'private obsolete wait',
        turns: [{ id: 'current', status: 'inProgress', items: [],
          startedAt: 1, completedAt: null }] } as never; },
    }));
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No listener');
    const base = `http://127.0.0.1:${address.port}/peer/threads/${threadId}/turns/current`;
    expect((await fetch(base.replace(threadId, '00000000-0000-4000-8000-000000000002'))).status).toBe(403);
    const response = await fetch(base);
    expect(response.status).toBe(200);
    const result = await response.json() as Record<string, unknown>;
    expect(result.preview).toEqual({ relation: 'initial-thread-historical-non-authoritative' });
    expect(result.turn).toEqual({ id: 'current', status: 'inProgress', startedAt: 1, completedAt: null });
    expect(JSON.stringify(result)).not.toContain('private obsolete wait');
    expect(calls).toBe(1);
  });
  it('rejects a mismatched managed mission rather than returning partial Goal custody', async () => {
    const { base } = await fixture(grant, true);
    const result = await fetch(`${base}/goal`);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ available: false, category: 'read_unavailable' });
  });
  it('keeps uncertain native terminal failures content-free and artifact export scoped', async () => {
    const { base, calls } = await fixture();
    const terminal = await fetch(`${base}/terminals/status`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        turnId: '00000000-0000-4000-8000-000000000003',
        itemId: 'item-1', nativeProcessId: 'process-1', terminalGeneration: 1,
      }) });
    expect(terminal.status).toBe(503);
    expect(JSON.stringify(await terminal.json())).not.toContain('private command text');
    const metadata = await (await fetch(`${base}/artifacts/receipt-1`)).json() as Record<string, unknown>;
    expect(metadata.content).toBeUndefined();
    expect(metadata.path).toBeUndefined();
    const content = await (await fetch(`${base}/artifacts/receipt-1?content=true`)).json() as Record<string, unknown>;
    expect(content.content).toBe('owned');
    expect(content.path).toBeUndefined();
    expect(calls.artifact).toBe(2);
  });
  it('uses the exact native Goal revision for a conditional resume, never a read-then-write', async () => {
    const { base, calls } = await fixture();
    const expected = { goalId: '00000000-0000-4000-8000-000000000004',
      status: 'blocked', missionRevision: 4, lifecycleRevision: 7 };
    const request = (value: unknown) => fetch(`${base}/goal/resume`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected: value }) });
    expect((await request({ ...expected, lifecycleRevision: -1 })).status).toBe(503);
    expect(calls.resume).toBe(0);
    const accepted = await request(expected);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ available: true,
      revision: { ...expected, status: 'active' } });
    expect(calls.resume).toBe(1);
  });
  it('joins an exact client ID to content-free saved native custody, not live OS status', async () => {
    const { base, calls } = await fixture();
    const response = await fetch(`${base}/submissions/client-1`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.observation).toBe('native-thread-read-not-live-process-custody');
    expect((body.journal as Record<string, unknown>).phase).toBe('turn_started');
    expect(JSON.stringify(body)).not.toContain('private command text');
    expect(calls.submission).toBe(1);
  });
});
