import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import agentRouter from './agent';
import { messageQueueStore } from '../utils/messageQueueStore';
import { agentTabManager } from '../agentTabManager';
import { approvalManager } from '../approvalManager';

const app = express();
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
