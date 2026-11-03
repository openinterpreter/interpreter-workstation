import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import agentRouter from './agent';
import { messageQueueStore } from '../utils/messageQueueStore';
import { agentTabManager } from '../agentTabManager';
import { approvalManager } from '../approvalManager';
import { wakeSources } from '../utils/wakeSourcesRuntime';
import * as codexService from '../../src/lib/codex/service';
import * as taskService from '../agentTaskService';

const app = express();
app.use(express.json());
app.use('/api/agent', agentRouter);
const url = '/api/agent/custody/global';
const nativeUrl = '/api/agent/custody/native-global';
const previousToken = process.env.WORKSTATION_WAKE_TOKEN;
afterEach(() => {
  if (previousToken === undefined) delete process.env.WORKSTATION_WAKE_TOKEN;
  else process.env.WORKSTATION_WAKE_TOKEN = previousToken;
  messageQueueStore.clear('another-agent');
});

describe('global custody inventory', () => {
  test('cold caller bind is operator-only and requires exact thread/workspace', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'private-test-token';
    const url = '/api/agent/threads/00000000-0000-4000-8000-000000000001/caller/cold-bind';
    expect((await request(app).post(url).send({ workspace: '/workspace' })).status).toBe(401);
    expect((await request(app).post(url).set('Authorization', 'Bearer private-test-token')
      .set('Origin', 'https://elsewhere.example').send({ workspace: '/workspace' })).status).toBe(401);
    expect((await request(app).post(url).set('Authorization', 'Bearer private-test-token')
      .send({})).status).toBe(400);
  });
  test('cold bind denies a previously paused source whose command drain failed', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'private-test-token';
    const id = '00000000-0000-4000-8000-000000000016';
    const source = { id: 'source_1', threadId: id, paused: true, status: 'waiting' };
    const list = spyOn(wakeSources, 'list').mockReturnValue({ sources: [source], events: [] } as ReturnType<typeof wakeSources.list>);
    const pause = spyOn(wakeSources, 'pause').mockRejectedValue(new Error('Wake source drain failed'));
    try {
      const result = await request(app).post(`/api/agent/threads/${id}/caller/cold-bind`)
        .set('Authorization', 'Bearer private-test-token').send({ workspace: '/workspace' });
      expect(result.status).toBe(409);
      expect(pause).toHaveBeenCalledTimes(1);
    } finally {
      list.mockRestore();
      pause.mockRestore();
    }
  });
  test('already-unloaded cold bind uses successful source drain and same thread ID', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'private-test-token';
    const id = '00000000-0000-4000-8000-000000000017';
    const source = { id: 'source_2', threadId: id, paused: true, status: 'waiting' };
    const list = spyOn(wakeSources, 'list').mockReturnValue({ sources: [source], events: [] } as ReturnType<typeof wakeSources.list>);
    const pause = spyOn(wakeSources, 'pause').mockResolvedValue({ source, drain: {
      drained: true, commandInFlight: false, nativeOfferInFlight: false, pendingEvents: 0, offeredEvents: 0,
    } } as Awaited<ReturnType<typeof wakeSources.pause>>);
    const service = spyOn(codexService, 'getCodexService').mockReturnValue({
      withColdCallerTransition: async (_threadId: string, bind: () => Promise<unknown>) => bind(),
    } as ReturnType<typeof codexService.getCodexService>);
    const bind = spyOn(taskService, 'coldBindAgentTaskThread').mockResolvedValue({
      threadId: id, carrier: 'cold-bound', revokedPriorBindings: 0,
    } as Awaited<ReturnType<typeof taskService.coldBindAgentTaskThread>>);
    try {
      const result = await request(app).post(`/api/agent/threads/${id}/caller/cold-bind`)
        .set('Authorization', 'Bearer private-test-token').send({ workspace: '/workspace' });
      expect(result.status).toBe(200);
      expect(result.body.threadId).toBe(id);
      expect(pause).toHaveBeenCalledTimes(1);
      expect(bind).toHaveBeenCalledTimes(1);
    } finally {
      list.mockRestore(); pause.mockRestore(); service.mockRestore(); bind.mockRestore();
    }
  });
  test('cold bind denies a native offer appearing after a successful source drain', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'private-test-token';
    const id = '00000000-0000-4000-8000-000000000018';
    const source = { id: 'source_3', threadId: id, paused: true, status: 'waiting' };
    let reads = 0;
    const list = spyOn(wakeSources, 'list').mockImplementation(() => ({
      sources: [source], events: ++reads < 2 ? [] : [{ sourceId: source.id, status: 'offered' }],
    } as ReturnType<typeof wakeSources.list>));
    const pause = spyOn(wakeSources, 'pause').mockResolvedValue({ source, drain: {
      drained: true, commandInFlight: false, nativeOfferInFlight: false, pendingEvents: 0, offeredEvents: 0,
    } } as Awaited<ReturnType<typeof wakeSources.pause>>);
    try {
      const result = await request(app).post(`/api/agent/threads/${id}/caller/cold-bind`)
        .set('Authorization', 'Bearer private-test-token').send({ workspace: '/workspace' });
      expect(result.status).toBe(409);
      expect(pause).toHaveBeenCalledTimes(1);
      expect(reads).toBeGreaterThanOrEqual(2);
    } finally { list.mockRestore(); pause.mockRestore(); }
  });
  test('native and CUA inventory requires the same local bearer and rejects foreign origins', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'private-test-token';
    expect((await request(app).get(nativeUrl)).status).toBe(401);
    expect((await request(app).get(nativeUrl).set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(app).get(nativeUrl).set('Authorization', 'Bearer private-test-token')
      .set('Origin', 'https://elsewhere.example')).status).toBe(401);
    delete process.env.WORKSTATION_WAKE_TOKEN;
    expect((await request(app).get(nativeUrl).set('Authorization', 'Bearer private-test-token')).status).toBe(401);
  });
  test('fails closed without the configured bearer or from a foreign origin', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'private-test-token';
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(app).get(url).set('Authorization', 'Bearer private-test-token')
      .set('Origin', 'https://elsewhere.example')).status).toBe(401);
    delete process.env.WORKSTATION_WAKE_TOKEN;
    expect((await request(app).get(url).set('Authorization', 'Bearer private-test-token')).status).toBe(401);
  });

  test('reports every in-process queue and unscoped requests without message content', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'private-test-token';
    messageQueueStore.add('another-agent', 'PRIVATE INPUT MUST NOT LEAK');
    const tabs = spyOn(agentTabManager, 'getGlobalCustodyInventory').mockReturnValue({
      pendingRequestIds: ['tab-in-another-window'],
      pendingStartupIds: ['startup-in-another-window'],
      createdRequestIds: ['created-in-another-window'],
    });
    const approvals = spyOn(approvalManager, 'getGlobalPendingRequestIds').mockReturnValue(['approval-in-another-window']);
    try {
      const result = await request(app).get(url).set('Authorization', 'Bearer private-test-token');
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        scope: 'all-in-process',
        appQueues: { count: 1, agentIds: ['another-agent'] },
        pendingTabRequests: { count: 1, requestIds: ['tab-in-another-window'] },
        pendingTabStartups: { count: 1, requestIds: ['startup-in-another-window'] },
        createdTabRequests: { count: 1, requestIds: ['created-in-another-window'] },
        pendingApprovals: { count: 1, requestIds: ['approval-in-another-window'] },
        nativeQueueScope: 'thread-only',
      });
      expect(result.text).not.toContain('PRIVATE INPUT MUST NOT LEAK');
      tabs.mockImplementation(() => { throw new Error('internal diagnostic'); });
      const unavailable = await request(app).get(url).set('Authorization', 'Bearer private-test-token');
      expect(unavailable.status).toBe(503);
      expect(unavailable.text).not.toContain('internal diagnostic');
    } finally {
      tabs.mockRestore();
      approvals.mockRestore();
    }
  });
});
