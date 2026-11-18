import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { getCodexService, NativeCustodyPhaseError,
  NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS,
  NATIVE_CUSTODY_GLOBAL_OPERATOR_DEADLINE_MS } from '../../src/lib/codex/service';
import { nativeSubmissionJournal } from '../utils/nativeSubmissionJournal';
import { SubagentDirectInputError } from '../../src/lib/codex/subagent-input';
import { agentTabManager } from '../agentTabManager';
import agentRouter from './agent';

const app = express();
app.use(express.json());
app.use('/api/agent', agentRouter);
const id = '00000000-0000-4000-8000-000000000001';
const previous = process.env.WORKSTATION_WAKE_TOKEN;
afterEach(() => {
  if (previous === undefined) delete process.env.WORKSTATION_WAKE_TOKEN;
  else process.env.WORKSTATION_WAKE_TOKEN = previous;
});

describe('native custody diagnostic authentication', () => {
  test('bound saved idle input admits directly with its existing scoped native shell', async () => {
    const service = getCodexService();
    const binding = agentTabManager.getBindingForThread;
    const begin = nativeSubmissionJournal.begin;
    const advance = nativeSubmissionJournal.advance;
    const start = service.submitSavedThreadInput;
    const events: Array<string> = [];
    const info = console.info;
    agentTabManager.getBindingForThread = () => ({ agentId: 'agent_1', callerToken: 'agtok_fixture',
      workspacePath: '/workspace/projects/interpreter', threadId: id }) as any;
    nativeSubmissionJournal.begin = async () => ({ requestId: 'request_1', threadId: id,
      clientUserMessageId: 'saved_1', phase: 'received', turnId: null, at: '2026-11-12T00:00:00Z' });
    nativeSubmissionJournal.advance = async (_entry, phase) => { events.push(phase); return {} as any; };
    service.submitSavedThreadInput = async (_id, _message, _cwd, clientId) => {
      expect(clientId).toBe('saved_1');
      return 'turn_1';
    };
    console.info = (value) => { if (String(value).includes('programmatic_task_admission')) events.push(String(value)); };
    try {
      const response = await request(app).post('/api/agent/tasks/stream').send({ mode: 'headless',
        threadId: id, clientUserMessageId: 'saved_1', message: 'new input',
        workspace: '/workspace/projects/interpreter' });
      expect(response.status).toBe(200);
      expect(response.text).toContain('event: turn');
      expect(response.text).toContain('turn_1');
      expect(events).toContain('turn_started');
    } finally {
      agentTabManager.getBindingForThread = binding;
      nativeSubmissionJournal.begin = begin;
      nativeSubmissionJournal.advance = advance;
      service.submitSavedThreadInput = start;
      console.info = info;
    }
  });
  test('the runtime sub-agent refusal is reported as an SSE error with its parent and recorded', async () => {
    const service = getCodexService();
    const parent = '00000000-0000-4000-8000-000000000004';
    const binding = agentTabManager.getBindingForThread;
    const begin = nativeSubmissionJournal.begin;
    const advance = nativeSubmissionJournal.advance;
    const start = service.submitSavedThreadInput;
    const recorded: unknown[] = [];
    agentTabManager.getBindingForThread = () => ({ agentId: 'agent_1', callerToken: 'agtok_fixture',
      workspacePath: '/workspace/projects/interpreter', threadId: id }) as any;
    nativeSubmissionJournal.begin = async () => ({ requestId: 'request_late', threadId: id,
      clientUserMessageId: 'late_1', phase: 'received', turnId: null, at: '2026-11-18T00:00:00Z' });
    nativeSubmissionJournal.advance = async (_entry, phase, turnId, refusal) => {
      recorded.push(refusal ? { phase, turnId, refusal } : phase);
    };
    service.submitSavedThreadInput = async () => { throw new SubagentDirectInputError(id, parent); };
    const info = console.info;
    const admissions: unknown[] = [];
    console.info = (value) => {
      if (String(value).includes('programmatic_task_admission')) admissions.push(JSON.parse(String(value)));
    };
    try {
      const response = await request(app).post('/api/agent/tasks/stream').send({ mode: 'headless',
        threadId: id, clientUserMessageId: 'late_1', message: 'new input',
        workspace: '/workspace/projects/interpreter' });
      // The stream opens before native input; there is no up-front refusal status.
      expect(response.status).toBe(200);
      expect(response.text).toContain('event: error');
      expect(response.text).toContain('"code":"subagent_direct_input_unsupported"');
      expect(response.text).toContain(`"threadId":"${id}"`);
      expect(response.text).toContain(`"parentThreadId":"${parent}"`);
      expect(response.text).toContain(`only takes work through its parent thread ${parent}`);
      expect(response.text).not.toContain('turn_not_acknowledged');
      expect(recorded).toEqual([{ phase: 'terminal_refused', turnId: null,
        refusal: { reason: 'subagent_direct_input_unsupported', parentThreadId: parent } }]);
      expect(admissions.at(-1)).toEqual({ event: 'programmatic_task_admission', requestId: 'request_late',
        phase: 'task_start', status: 'refused', code: 'subagent_direct_input_unsupported' });

      // An unrelated failure keeps its message and is not recorded as a refusal.
      recorded.length = 0;
      service.submitSavedThreadInput = async () => { throw new Error('native resume rejected'); };
      const ordinary = await request(app).post('/api/agent/tasks/stream').send({ mode: 'headless',
        threadId: id, clientUserMessageId: 'late_2', message: 'new input',
        workspace: '/workspace/projects/interpreter' });
      expect(ordinary.text).toContain('native resume rejected');
      expect(ordinary.text).not.toContain('subagent_direct_input_unsupported');
      expect(recorded).toEqual([]);
    } finally {
      console.info = info;
      agentTabManager.getBindingForThread = binding;
      nativeSubmissionJournal.begin = begin;
      nativeSubmissionJournal.advance = advance;
      service.submitSavedThreadInput = start;
    }
  });
  test('slow native preflight reserves the stable ID before a duplicate request', async () => {
    const service = getCodexService();
    const binding = agentTabManager.getBindingForThread;
    const begin = nativeSubmissionJournal.begin;
    const advance = nativeSubmissionJournal.advance;
    const start = service.submitSavedThreadInput;
    let submitted = 0;
    let release!: (turnId: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<string>((resolve) => { release = resolve; });
    agentTabManager.getBindingForThread = () => ({ agentId: 'agent_1', callerToken: 'agtok_fixture',
      workspacePath: '/workspace/projects/interpreter', threadId: id }) as any;
    nativeSubmissionJournal.begin = async () => ++submitted === 1 ? ({ requestId: 'slow_1', threadId: id,
      clientUserMessageId: 'slow_1', phase: 'received', turnId: null, at: '2026-11-12T00:00:00Z' }) : null;
    nativeSubmissionJournal.advance = async () => ({} as any);
    service.submitSavedThreadInput = async () => { entered(); return pending; };
    const lookup = nativeSubmissionJournal.lookup;
    let recorded: any = { requestId: 'slow_1', threadId: id, clientUserMessageId: 'slow_1',
      phase: 'received', turnId: null, at: '2026-11-12T00:00:00Z' };
    nativeSubmissionJournal.lookup = async () => recorded;
    try {
      const body = { mode: 'headless', threadId: id, clientUserMessageId: 'slow_1',
        message: 'single input', workspace: '/workspace/projects/interpreter' };
      const first = request(app).post('/api/agent/tasks/stream').send(body);
      const firstResult = first.then((response) => response);
      await started;
      const repeated = await request(app).post('/api/agent/tasks/stream').send(body);
      expect(repeated.status).toBe(409);
      // A retry learns what the first attempt became, and nothing else.
      expect(repeated.body.recorded).toEqual({ phase: 'received', turnId: null });
      release('turn_1');
      expect((await firstResult).text).toContain('turn_1');
      recorded = { ...recorded, phase: 'turn_started', turnId: 'turn_1' };
      const later = await request(app).post('/api/agent/tasks/stream').send(body);
      expect(later.status).toBe(409);
      expect(later.body.recorded).toEqual({ phase: 'turn_started', turnId: 'turn_1' });
      expect(submitted).toBe(3);
    } finally {
      release('turn_1');
      agentTabManager.getBindingForThread = binding;
      nativeSubmissionJournal.begin = begin;
      nativeSubmissionJournal.lookup = lookup;
      nativeSubmissionJournal.advance = advance;
      service.submitSavedThreadInput = start;
    }
  });
  test('active steer reserves its stable client ID before native submission and rejects repeat', async () => {
    const service = getCodexService();
    const begin = nativeSubmissionJournal.begin;
    const advance = nativeSubmissionJournal.advance;
    const steer = service.steer;
    let claims = 0;
    let submissions = 0;
    nativeSubmissionJournal.begin = async () => ++claims === 1 ? ({ requestId: 'request_2',
      threadId: id, clientUserMessageId: 'steer_1', phase: 'received', turnId: null,
      at: '2026-11-12T00:00:00Z' }) : null;
    nativeSubmissionJournal.advance = async () => ({} as any);
    service.steer = async () => { submissions++; return 'turn_1'; };
    try {
      const body = { threadId: id, turnId: 'turn_1', message: 'new steer',
        clientUserMessageId: 'steer_1', attachments: [], skills: [] };
      expect((await request(app).post('/api/agent/chat/steer').send(body)).status).toBe(200);
      const repeated = await request(app).post('/api/agent/chat/steer').send(body);
      expect(repeated.status).toBe(409);
      expect(repeated.body.code).toBe('submission_already_recorded');
      expect(submissions).toBe(1);
    } finally {
      nativeSubmissionJournal.begin = begin;
      nativeSubmissionJournal.advance = advance;
      service.steer = steer;
    }
  });
  test('global native operator route rejects missing bearer and emits only fixed failure metadata', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const route = '/api/agent/custody/native-global';
    expect((await request(app).get(route)).status).toBe(401);
    const service = getCodexService();
    const original = service.readGlobalNativeCustody;
    const originalInfo = console.info;
    const events: string[] = [];
    let deadline: number | undefined;
    service.readGlobalNativeCustody = async (value) => {
      deadline = value;
      throw new NativeCustodyPhaseError('verify_queue_read', 'deadline');
    };
    console.info = (value) => { events.push(String(value)); };
    try {
      const result = await request(app).get(route).set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(503);
      expect(deadline).toBe(NATIVE_CUSTODY_GLOBAL_OPERATOR_DEADLINE_MS);
      expect(result.body).toMatchObject({ phase: 'verify_queue_read', category: 'deadline',
        custodyVerified: false });
      expect(result.body.inspectionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(events.map((event) => JSON.parse(event).phase)).toEqual(['request', 'verify_queue_read']);
      expect(events.join(' ')).not.toContain('test-private-token');
    } finally {
      service.readGlobalNativeCustody = original;
      console.info = originalInfo;
    }
  });
  test('submission receipt route requires exact thread, client ID and operator bearer', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const route = `/api/agent/threads/${id}/submissions/owned_1/custody`;
    expect((await request(app).get(route)).status).toBe(401);
    expect((await request(app).get(`/api/agent/threads/${id}/submissions/bad%20id/custody`)
      .set('Authorization', 'Bearer test-private-token')).status).toBe(400);
    expect((await request(app).get('/api/agent/threads/invalid/submissions/owned_1/custody')
      .set('Authorization', 'Bearer test-private-token')).status).toBe(400);
  });
  test('exact submission custody returns only correlated synthetic receipt metadata', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const service = getCodexService();
    const originalRead = service.readNativeSubmissionCustody;
    const originalLookup = nativeSubmissionJournal.lookup;
    nativeSubmissionJournal.lookup = async () => ({ requestId: 'request_1', threadId: id,
      clientUserMessageId: 'owned_1', phase: 'received', turnId: null,
      at: '2026-11-07T00:00:00.000Z' });
    service.readNativeSubmissionCustody = async () => ({ threadId: id,
      clientUserMessageId: 'owned_1', linkage: 'not_observed', nativeMatch: null,
      queuedSubmissionIds: [], custodyVerified: true,
      commandSessionScope: 'saved-native-turn-only-not-live-process-custody' });
    try {
      const result = await request(app).get(`/api/agent/threads/${id}/submissions/owned_1/custody`)
        .set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ phase: 'received', requestId: 'request_1',
        threadId: id, clientUserMessageId: 'owned_1', turnId: null,
        native: { linkage: 'not_observed', custodyVerified: true,
          commandSessionScope: 'saved-native-turn-only-not-live-process-custody' } });
      expect(result.body.inspectionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(result.body)).not.toContain('test-private-token');
    } finally {
      service.readNativeSubmissionCustody = originalRead;
      nativeSubmissionJournal.lookup = originalLookup;
    }
  });
  test('exact native-only client ID is observable without inventing a journal claim', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const service = getCodexService();
    const originalRead = service.readNativeSubmissionCustody;
    const originalLookup = nativeSubmissionJournal.lookup;
    nativeSubmissionJournal.lookup = async () => null;
    service.readNativeSubmissionCustody = async () => ({ threadId: id,
      clientUserMessageId: 'owned_2', linkage: 'native_user_item',
      nativeMatch: { turnId: 'turn_1', userItemId: 'item_1', status: 'inProgress', commandSessions: [] },
      queuedSubmissionIds: [], custodyVerified: true,
      commandSessionScope: 'saved-native-turn-only-not-live-process-custody' });
    try {
      const result = await request(app).get(`/api/agent/threads/${id}/submissions/owned_2/custody`)
        .set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ requestId: null, phase: null, turnId: null,
        native: { linkage: 'native_user_item', custodyVerified: true } });
    } finally {
      service.readNativeSubmissionCustody = originalRead;
      nativeSubmissionJournal.lookup = originalLookup;
    }
  });
  test('rejects absent bearer and invalid thread without invoking the native client', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const denied = await request(app).get(`/api/agent/threads/${id}/native-custody`);
    expect(denied.status).toBe(401);
    const malformed = await request(app)
      .get('/api/agent/threads/not-an-id/native-custody')
      .set('Authorization', 'Bearer test-private-token');
    expect(malformed.status).toBe(400);
  });

  test('rejects absent configured secret even with caller bearer', async () => {
    delete process.env.WORKSTATION_WAKE_TOKEN;
    const denied = await request(app)
      .get(`/api/agent/threads/${id}/native-custody`)
      .set('Authorization', 'Bearer test-private-token');
    expect(denied.status).toBe(401);
  });

  test('returns only fixed phase metadata on a bounded native failure', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const service = getCodexService();
    const original = service.readNativeCustody;
    const originalInfo = console.info;
    const events: string[] = [];
    let observedDeadline: number | undefined;
    service.readNativeCustody = async (_thread, deadline) => {
      observedDeadline = deadline;
      throw new NativeCustodyPhaseError('thread_read', 'deadline');
    };
    console.info = (value) => { events.push(String(value)); };
    try {
      const result = await request(app).get(`/api/agent/threads/${id}/native-custody`)
        .set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ phase: 'thread_read', category: 'deadline',
        custodyVerified: false });
      expect(result.body.inspectionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(observedDeadline).toBe(NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS);
      expect(events.map((event) => JSON.parse(event).phase)).toEqual(['request', 'thread_read']);
      expect(events.join(' ')).not.toContain('test-private-token');
    } finally {
      service.readNativeCustody = original;
      console.info = originalInfo;
    }
  });

  test('exact turn receipt requires bearer and both exact native IDs', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const turn = '00000000-0000-4000-8000-000000000002';
    const url = `/api/agent/threads/${id}/native-turn-receipt/${turn}`;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(`/api/agent/threads/${id}/native-turn-receipt/nope`)
      .set('Authorization', 'Bearer test-private-token')).status).toBe(400);
    expect((await request(app).get(`/api/agent/threads/nope/native-turn-receipt/${turn}`)
      .set('Authorization', 'Bearer test-private-token')).status).toBe(400);
  });

  test('exact turn receipt reports only a fixed deadline phase, never private native output', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const service = getCodexService();
    const original = service.readNativeTurnReceipt;
    const originalInfo = console.info;
    const events: string[] = [];
    let observedDeadline: number | undefined;
    service.readNativeTurnReceipt = async (_thread, _turn, deadline) => {
      observedDeadline = deadline;
      throw new NativeCustodyPhaseError('thread_read', 'deadline');
    };
    console.info = (value) => { events.push(String(value)); };
    try {
      const result = await request(app)
        .get(`/api/agent/threads/${id}/native-turn-receipt/00000000-0000-4000-8000-000000000002`)
        .set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ phase: 'thread_read', category: 'deadline', custodyVerified: false });
      expect(result.body.inspectionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(observedDeadline).toBe(NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS);
      expect(events.map((event) => JSON.parse(event).phase)).toEqual(['request', 'thread_read']);
      expect(events.join(' ')).not.toContain('test-private-token');
    } finally {
      service.readNativeTurnReceipt = original;
      console.info = originalInfo;
    }
  });

  test('ambiguous offer disposition requires the private bearer and an exact no-replay confirmation', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const route = `/api/agent/threads/${id}/wake-events/source/event/hold`;
    expect((await request(app).post(route).send({ turnId: 'turn-1', confirmedNoReplay: true })).status).toBe(401);
    expect((await request(app).post(route).set('Authorization', 'Bearer test-private-token')
      .send({ turnId: 'turn-1' })).status).toBe(400);
    expect((await request(app).post(route).set('Authorization', 'Bearer test-private-token')
      .send({ confirmedNoReplay: true })).status).toBe(400);
  });
  test('historical hold requires private bearer, exact native snapshot, and explicit no-replay decision', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const route = `/api/agent/threads/${id}/wake-events/source/event/hold-historical`;
    const body = { expectedClientId: 'wake_123', expectedLatestTurnId: 'latest',
      decisionRef: 'operator-ticket-1', confirmedNoReplay: true };
    expect((await request(app).post(route).send(body)).status).toBe(401);
    expect((await request(app).post(route).set('Authorization', 'Bearer test-private-token')
      .send({ ...body, confirmedNoReplay: false })).status).toBe(400);
    expect((await request(app).post(route).set('Authorization', 'Bearer test-private-token')
      .send({ expectedLatestTurnId: 'latest', confirmedNoReplay: true })).status).toBe(400);
  });
});
