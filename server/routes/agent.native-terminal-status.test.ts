import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { getCodexService, NativeCustodyPhaseError } from '../../src/lib/codex/service';
import agentRouter from './agent';

const app = express();
app.use(express.json());
app.use('/api/agent', agentRouter);
const threadId = '00000000-0000-4000-8000-000000000001';
const route = `/api/agent/threads/${threadId}/native-terminal-status`;
const listRoute = `/api/agent/threads/${threadId}/native-terminal-owners`;
const body = { turnId: 'turn_1', itemId: 'item_1', nativeProcessId: 'native_1', terminalGeneration: 3 };
const prior = process.env.WORKSTATION_WAKE_TOKEN;
afterEach(() => {
  if (prior === undefined) delete process.env.WORKSTATION_WAKE_TOKEN;
  else process.env.WORKSTATION_WAKE_TOKEN = prior;
});

describe('native terminal operator read', () => {
  test('both routes require the existing bearer; invalid or cross-thread identity never calls native', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    expect((await request(app).post(route).send(body)).status).toBe(401);
    expect((await request(app).get(listRoute)).status).toBe(401);
    const service = getCodexService();
    const old = service.readNativeTerminalStatus;
    let calls = 0;
    service.readNativeTerminalStatus = async () => { calls++; throw new Error('not expected'); };
    try {
      const wrong = await request(app).post(route).set('Authorization', 'Bearer test-private-token')
        .send({ ...body, threadId: '00000000-0000-4000-8000-000000000002' });
      expect(wrong.status).toBe(400);
      expect((await request(app).post(route).set('Authorization', 'Bearer test-private-token')
        .send({ ...body, terminalGeneration: 0 })).status).toBe(400);
      expect(calls).toBe(0);
    } finally { service.readNativeTerminalStatus = old; }
  });

  test('successful response exposes only status and metadata; deadline never asserts custody', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const service = getCodexService();
    const old = service.readNativeTerminalStatus;
    const oldInfo = console.info;
    const logs: string[] = [];
    console.info = (value) => { logs.push(String(value)); };
    try {
      service.readNativeTerminalStatus = async () => ({ phase: 'exited', outputBytes: 12,
        outputSha256: 'a'.repeat(64), outputCapReached: false, exitCode: 0,
        terminalGeneration: 3, observationTimedOut: false });
      const result = await request(app).post(route).set('Authorization', 'Bearer test-private-token').send(body);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ phase: 'exited', terminalGeneration: 3, custodyVerified: true });
      expect(JSON.stringify(result.body) + logs.join(' ')).not.toMatch(/private-token|PRIVATE OUTPUT/);
      service.readNativeTerminalStatus = async () => { throw new NativeCustodyPhaseError('terminal_status', 'deadline'); };
      const failure = await request(app).post(route).set('Authorization', 'Bearer test-private-token').send(body);
      expect(failure.status).toBe(503);
      expect(failure.body).toMatchObject({ phase: 'terminal_status', category: 'deadline', custodyVerified: false });
    } finally { service.readNativeTerminalStatus = old; console.info = oldInfo; }
  });

  test('list projects owner identifiers only and suppresses native errors', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const service = getCodexService();
    const old = service.listNativeTerminalOwners;
    try {
      service.listNativeTerminalOwners = async () => ({ data: [{ threadId, ...body }], nextCursor: null });
      const result = await request(app).get(listRoute).set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual([{ threadId, ...body }]);
      service.listNativeTerminalOwners = async () => { throw new Error('PRIVATE COMMAND'); };
      const failure = await request(app).get(listRoute).set('Authorization', 'Bearer test-private-token');
      expect(failure.status).toBe(503);
      expect(JSON.stringify(failure.body)).not.toContain('PRIVATE COMMAND');
    } finally { service.listNativeTerminalOwners = old; }
  });
});
