import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { getCodexService, NativeCustodyPhaseError } from '../../src/lib/codex/service';
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
    service.readNativeCustody = async () => { throw new NativeCustodyPhaseError('thread_read', 'deadline'); };
    console.info = (value) => { events.push(String(value)); };
    try {
      const result = await request(app).get(`/api/agent/threads/${id}/native-custody`)
        .set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ phase: 'thread_read', category: 'deadline',
        custodyVerified: false });
      expect(result.body.inspectionId).toMatch(/^[0-9a-f-]{36}$/);
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
