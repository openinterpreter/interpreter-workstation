import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createSupervisorPeerRouter } from './supervisorPeer';
import { createSupervisorGoal, SupervisorGoalCreateError } from '../utils/supervisorGoalCreate';
import { GoalRevisionConflictError } from '../../src/lib/codex/goal-revision';
import { ManagedGoalDocumentError } from '../../src/lib/codex/goal-document';
import type { VerifiedSupervisorGrant } from '../utils/supervisorPeerScope';

const threadId = '00000000-0000-4000-8000-000000000001';
const createBody = { creationId: 'unique-supervisor-job', objective: 'managed',
  document: 'mission', precondition: { kind: 'completed' as const,
    expectedGoalId: '00000000-0000-4000-8000-000000000004',
    expectedStatus: 'complete' as const, expectedMissionRevision: 4,
    expectedLifecycleRevision: 7 } };
const grant: VerifiedSupervisorGrant = {
  issuer: 'enrolled-issuer', subject: 'supervisor-1', sourceComputer: 'source-1',
  targetComputer: 'target-1', threadId,
  capabilities: ['goal:read', 'goal:create', 'goal:resume', 'task:read', 'command:read', 'artifact:read'],
  expiresAt: Date.now() + 60_000,
};
let server: Server | undefined;
afterEach(() => server?.close());

async function fixture(verified: VerifiedSupervisorGrant | null = grant, alteredDocument = false,
  resumeError?: Error) {
  const calls = { goal: 0, create: 0, resume: 0, update: 0, objective: 0, document: 0,
    terminal: 0, terminalList: 0,
    artifact: 0, submission: 0 };
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
    resumeGoal: async (_thread, expected) => { calls.resume++;
      if (resumeError) throw resumeError;
      return { ...expected, status: 'active' }; },
    updateGoalStatus: async (_thread, expected, status) => { calls.update++;
      if (resumeError) throw resumeError;
      return { ...expected, status, lifecycleRevision: expected.lifecycleRevision + 1 }; },
    updateGoalObjective: async (_thread, expected) => { calls.objective++;
      if (resumeError) throw resumeError;
      return { ...expected, missionRevision: expected.missionRevision + 1,
        lifecycleRevision: expected.lifecycleRevision + 1 }; },
    updateGoalDocument: async (_thread, expected, document) => { calls.document++;
      if (resumeError) throw resumeError;
      return { revision: { ...expected, missionRevision: expected.missionRevision + 1,
        lifecycleRevision: expected.lifecycleRevision + 1 }, document: {
        path: 'opaque-native-path', sha256: createHash('sha256').update(document).digest('hex'),
        byteLength: Buffer.byteLength(document), missionRevision: expected.missionRevision + 1 } }; },
    readTerminal: async () => { calls.terminal++; throw new Error('private command text'); },
    listTerminalOwners: async () => { calls.terminalList++; return { data: [{ threadId,
      turnId: '00000000-0000-4000-8000-000000000003', itemId: 'item-1',
      nativeProcessId: 'process-1', terminalGeneration: 1 }], nextCursor: null }; },
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
  it('status update requires exact enrolled grant, active CAS, and a paused/blocked-only change', async () => {
    const expected = { goalId: '00000000-0000-4000-8000-000000000004',
      status: 'active', missionRevision: 4, lifecycleRevision: 7 };
    const own = { ...grant,
      capabilities: [...grant.capabilities, 'goal:status-update' as const] };
    const post = (url: string, body: unknown) => fetch(`${url}/goal/status`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const absent = await fixture({ ...own, capabilities: grant.capabilities });
    expect((await post(absent.base, { expected, status: 'paused' })).status).toBe(403);
    expect(absent.calls.update).toBe(0);
    server?.close();
    const wrongTarget = await fixture({ ...own, targetComputer: 'foreign-host' });
    expect((await post(wrongTarget.base, { expected, status: 'paused' })).status).toBe(403);
    expect(wrongTarget.calls.update).toBe(0);
    server?.close();
    const { base, calls } = await fixture(own);
    expect((await post(base.replace(threadId, '00000000-0000-4000-8000-000000000002'),
      { expected, status: 'paused' })).status).toBe(403);
    for (const body of [
      { expected: { ...expected, status: 'blocked' }, status: 'paused' },
      { expected, status: 'active' }, { expected, status: 'complete' },
      { expected, status: 'paused', objective: 'overreach' },
      { expected: { ...expected, lifecycleRevision: 0 }, status: 'paused' },
    ]) expect((await post(base, body)).status).toBe(400);
    expect(calls.update).toBe(0);
    const result = await post(base, { expected, status: 'paused' });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ available: true, revision: {
      ...expected, status: 'paused', lifecycleRevision: 8 } });
    expect(calls.update).toBe(1);
  });
  it('classifies native CAS conflict and unknown mutation without retry or content leak', async () => {
    const own = { ...grant,
      capabilities: [...grant.capabilities, 'goal:status-update' as const] };
    const body = JSON.stringify({ status: 'blocked', expected: {
      goalId: '00000000-0000-4000-8000-000000000004',
      status: 'active', missionRevision: 4, lifecycleRevision: 7 } });
    const request = (base: string) => fetch(`${base}/goal/status`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body });
    const conflict = await fixture(own, false, new GoalRevisionConflictError());
    const rejected = await request(conflict.base);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ available: false, category: 'stale_revision' });
    expect(conflict.calls.update).toBe(1);
    server?.close();
    const unknown = await fixture(own, false, Error('secret native content'));
    const unconfirmed = await request(unknown.base);
    expect(unconfirmed.status).toBe(503);
    expect(await unconfirmed.json()).toEqual({ available: false, category: 'mutation_unconfirmed' });
    expect(unknown.calls.update).toBe(1);
  });
  it('amends an exact cross-host assigned Goal objective or document through independent native CAS', async () => {
    const exact = { ...grant, capabilities: [...grant.capabilities,
      'goal:objective-update' as const, 'goal:document-update' as const] };
    const expected = { goalId: '00000000-0000-4000-8000-000000000004',
      status: 'active', missionRevision: 4, lifecycleRevision: 7 };
    const post = (base: string, path: string, body: unknown) => fetch(`${base}/goal/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { base, calls } = await fixture(exact);
    expect((await post(base.replace(threadId, '00000000-0000-4000-8000-000000000002'),
      'objective', { expected, objective: 'assigned' })).status).toBe(403);
    expect((await post(base, 'objective', { expected, objective: '' })).status).toBe(400);
    expect((await post(base, 'objective', { expected, objective: 'assigned', tokenBudget: 1 })).status).toBe(400);
    const objective = await post(base, 'objective', { expected, objective: 'New bounded objective' });
    expect(objective.status).toBe(200);
    expect(await objective.json()).toEqual({ available: true, revision: {
      ...expected, missionRevision: 5, lifecycleRevision: 8 } });
    const document = 'Preserve the full mission.\n';
    expect((await post(base, 'document', { expected, document: ' ' })).status).toBe(400);
    const updated = await post(base, 'document', { expected, document });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ available: true, revision: {
      ...expected, missionRevision: 5, lifecycleRevision: 8 }, document: {
      sha256: createHash('sha256').update(document).digest('hex'),
      byteLength: Buffer.byteLength(document), missionRevision: 5 } });
    expect(calls.objective).toBe(1);
    expect(calls.document).toBe(1);
    server?.close();
    const denied = await fixture({ ...grant, capabilities: ['goal:read'] });
    expect((await post(denied.base, 'objective', { expected, objective: 'no' })).status).toBe(403);
    expect((await post(denied.base, 'document', { expected, document })).status).toBe(403);
    expect(denied.calls.objective).toBe(0);
    expect(denied.calls.document).toBe(0);
  });
  it('does not misclassify an uncertain document write as stale, and only fixed native CAS conflict is stale', async () => {
    const exact = { ...grant, capabilities: ['goal:document-update' as const] };
    const expected = { goalId: '00000000-0000-4000-8000-000000000004',
      status: 'active', missionRevision: 4, lifecycleRevision: 7 };
    const post = (base: string) => fetch(`${base}/goal/document`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected, document: '# bounded mission' }) });
    const conflict = await fixture(exact, false, new ManagedGoalDocumentError('stale_revision'));
    expect((await post(conflict.base)).status).toBe(409);
    expect(conflict.calls.document).toBe(1);
    server?.close();
    const unknown = await fixture(exact, false, Error('private native diagnostics'));
    const response = await post(unknown.base);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ available: false, category: 'mutation_unconfirmed' });
    expect(unknown.calls.document).toBe(1);
  });
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
    expect(calls).toEqual({ goal: 0, create: 0, resume: 0, update: 0, objective: 0, document: 0, terminal: 0,
      terminalList: 0, artifact: 0, submission: 0 });
  });
  it('denies cross-thread creation before a native call and keeps uncertain creation typed', async () => {
    const { base, calls } = await fixture();
    const create = (url: string) => fetch(`${url}/goal/create`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody) });
    const denied = await create(base.replace(threadId, '00000000-0000-4000-8000-000000000002'));
    expect(denied.status).toBe(403);
    expect(calls.create).toBe(0);
    const uncertain = await create(base);
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toEqual({ available: false, category: 'mutation_unconfirmed' });
    expect(calls.create).toBe(1);
  });
  it('creates an initial native-managed Goal only for the exact enrolled thread', async () => {
    const full = '# First full mission\n' + 'Retain this task.\n'.repeat(300);
    const sha = createHash('sha256').update(full).digest('hex');
    const first = { creationId: 'peer-first-mission', objective: 'first mission pointer',
      document: full, precondition: { kind: 'absent' as const,
        admissionState: 'noGoal' as const } };
    const goal = { threadId, status: 'active', objective: first.objective };
    const revision = { goalId: '00000000-0000-4000-8000-000000000005',
      status: 'active', missionRevision: 1, lifecycleRevision: 1 };
    const document = { path: `managed-goals/${threadId}/mission-1-${sha}.md`,
      sha256: sha, byteLength: Buffer.byteLength(full), missionRevision: 1 };
    let writes = 0;
    let effects = 0;
    const native = {
      createThreadGoalDocument: async () => { writes++;
        if (writes === 1) effects++;
        return { goal, revision, document, previousRevision: null,
          creationId: first.creationId, replayed: writes > 1 }; },
      getThreadGoalWithRevision: async () => ({ goal, revision }),
      getThreadGoalDocument: async () => ({ goal, document, content: full }),
    } as never;
    const app = express();
    app.use(express.json());
    app.use('/peer', createSupervisorPeerRouter({ targetComputer: 'target-1',
      verify: async () => grant,
      readGoal: async () => ({ goal: null, revision: null, document: null }),
      createGoal: (id, input) => createSupervisorGoal(native, id, input),
      resumeGoal: async () => { throw Error('unused'); },
      readTerminal: async () => { throw Error('unused'); },
    }));
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No listener');
    const base = `http://127.0.0.1:${address.port}/peer/threads/${threadId}/goal/create`;
    const post = (url: string, body: unknown) => fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(base.replace(threadId, '00000000-0000-4000-8000-000000000002'),
      first)).status).toBe(403);
    expect(writes).toBe(0);
    const created = await post(base, first);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ available: true, creationId: first.creationId,
      previousRevision: null, replayed: false, document: { content: full } });
    const replay = await post(base, first);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, previousRevision: null });
    expect(writes).toBe(2); // Two explicit requests, one native effect under its creation ID.
    expect(effects).toBe(1);
  });
  it('accepts a large managed mission only on the scoped peer JSON transport', async () => {
    const app = express();
    app.use('/peer/threads/:threadId/goal/create', express.json({ limit: '6292000b' }));
    app.use(express.json());
    const mission = '# Mission\n' + 'A retained requirement.\n'.repeat(7_000) + '\n'.repeat(600_000);
    const digest = createHash('sha256').update(mission).digest('hex');
    let received = '';
    let receivedCreationId = '';
    app.use('/peer', createSupervisorPeerRouter({ targetComputer: 'target-1',
      verify: async () => grant,
      readGoal: async () => ({ goal: null, revision: null, document: null }),
      createGoal: async (_id, input) => { received = input.document;
        receivedCreationId = input.creationId;
        return {
        goal: { threadId, status: 'active', objective: 'managed' } as never,
        revision: { goalId: '00000000-0000-4000-8000-000000000004',
          status: 'active', missionRevision: 1, lifecycleRevision: 1 },
        document: { content: input.document, sha256: digest,
          byteLength: Buffer.byteLength(input.document),
          missionRevision: 1 },
        creationId: input.creationId, replayed: false,
        previousRevision: input.precondition.kind === 'completed' ? {
          goalId: input.precondition.expectedGoalId, status: 'complete',
          missionRevision: input.precondition.expectedMissionRevision,
          lifecycleRevision: input.precondition.expectedLifecycleRevision } : null,
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
      body: JSON.stringify({ ...createBody, document: mission }),
    });
    expect(mission.length).toBeGreaterThan(100_000);
    expect(Buffer.byteLength(mission)).toBeLessThan(1_048_576);
    expect(Buffer.byteLength(JSON.stringify({ document: mission }))).toBeGreaterThan(1_050_000);
    expect(response.status).toBe(200);
    expect(received).toBe(mission);
    expect(receivedCreationId).toBe(createBody.creationId);
    const oversized = await fetch(`http://127.0.0.1:${address.port}/peer/threads/${threadId}/goal/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: '\n'.repeat(3_200_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(received).toBe(mission);
    const unrelated = await fetch(`http://127.0.0.1:${address.port}/peer/threads/${threadId}/goal/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected: '\n'.repeat(60_000) }),
    });
    expect(unrelated.status).toBe(413);
  });
  it('returns a typed predecessor conflict without leaking native text or changing source scope', async () => {
    const app = express();
    app.use(express.json());
    let calls = 0;
    app.use('/peer', createSupervisorPeerRouter({ targetComputer: 'target-1',
      verify: async () => grant,
      readGoal: async () => ({ goal: null, revision: null, document: null }),
      createGoal: async () => { calls++;
        throw new SupervisorGoalCreateError('stale_predecessor'); },
      resumeGoal: async () => { throw Error('unused'); },
      readTerminal: async () => { throw Error('unused'); },
    }));
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No listener');
    const response = await fetch(`http://127.0.0.1:${address.port}/peer/threads/${threadId}/goal/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ available: false, category: 'stale_predecessor' });
    expect(calls).toBe(1);
  });
  it('authorizes exact task scope before projecting a saved current turn and denies cross-thread reads', async () => {
    const app = express();
    let calls = 0;
    app.use('/peer', createSupervisorPeerRouter({ targetComputer: 'target-1', verify: async () => grant,
      readGoal: async () => ({ goal: null, revision: null, document: null }),
      resumeGoal: async () => { throw Error('unused'); },
      readTerminal: async () => { throw Error('unused'); },
      readThread: async () => { calls++; return { id: threadId, preview: 'private obsolete wait',
        turns: [{ id: 'current', status: 'inProgress', itemsView: 'full', items: [],
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
  it('lists only scoped native terminal owner IDs, not process status or private output', async () => {
    const { base, calls } = await fixture();
    const denied = await fetch(`${base.replace(threadId,
      '00000000-0000-4000-8000-000000000002')}/terminals`);
    expect(denied.status).toBe(403);
    expect(calls.terminalList).toBe(0);
    const malformed = await fetch(`${base}/terminals?cursor=../other`);
    expect(malformed.status).toBe(400);
    expect(calls.terminalList).toBe(0);
    const response = await fetch(`${base}/terminals`);
    expect(response.status).toBe(200);
    const value = await response.json() as Record<string, unknown>;
    expect(value).toMatchObject({ available: true, threadId,
      observation: 'native-terminal-owners-only-not-process-status',
      data: [{ threadId, turnId: '00000000-0000-4000-8000-000000000003',
        itemId: 'item-1', nativeProcessId: 'process-1', terminalGeneration: 1 }] });
    expect(JSON.stringify(value)).not.toMatch(/private|output|running|exited/);
    expect(calls.terminalList).toBe(1);
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
  it('reports only an authoritative native CAS conflict as stale, never private text or a successful resume', async () => {
    const expected = { goalId: '00000000-0000-4000-8000-000000000004',
      status: 'blocked', missionRevision: 4, lifecycleRevision: 7 };
    const send = async (error: Error) => {
      const { base, calls } = await fixture(grant, false, error);
      const result = await fetch(`${base}/goal/resume`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected }) });
      expect(calls.resume).toBe(1);
      return result;
    };
    const conflict = await send(new GoalRevisionConflictError());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ available: false, category: 'stale_revision' });
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    const unknown = await send(Error('PRIVATE transport outcome'));
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toEqual({ available: false, category: 'mutation_unconfirmed' });
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
