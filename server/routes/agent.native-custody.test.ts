import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { getCodexService, NativeCustodyPhaseError,
  NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS,
  NATIVE_CUSTODY_GLOBAL_OPERATOR_DEADLINE_MS } from '../../src/lib/codex/service';
import { nativeSubmissionJournal } from '../utils/nativeSubmissionJournal';
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
