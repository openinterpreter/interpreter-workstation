import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { getCodexService } from '../../src/lib/codex/service';
import { GoalRevisionConflictError } from '../../src/lib/codex/goal-revision';
import agentRouter from './agent';

const app = express();
app.use(express.json());
app.use('/api/agent', agentRouter);
const threadId = '00000000-0000-4000-8000-000000000001';
const goal = { threadId, objective: 'Retain existing work', status: 'paused' as const,
  createdAt: 1794006266, updatedAt: 1794631156, tokensUsed: 12,
  timeUsedSeconds: 10, tokenBudget: null };
const expected = { goalId: '00000000-0000-4000-8000-000000000002',
  status: 'paused' as const, missionRevision: 2, lifecycleRevision: 3 };
const url = `/api/agent/threads/${threadId}/goal`;

describe('authenticated loopback Goal CAS bridge', () => {
  test('revision read rejects rebinding and cross-origin requests before native access', async () => {
    const service = getCodexService();
    const original = service.getThreadGoalWithRevision;
    let reads = 0;
    service.getThreadGoalWithRevision = async () => { reads++; return { goal, revision: expected } as any; };
    try {
      for (const [host, origin] of [
        ['attacker.example:3000', 'http://attacker.example:3000'],
        ['localhost:3000', 'https://attacker.example'],
      ]) {
        const response = await request(app).get(`${url}/revision`)
          .set('Host', host).set('Origin', origin);
        expect(response.status).toBe(403);
      }
      expect(reads).toBe(0);
      expect((await request(app).get('/api/agent/threads/not-a-uuid/goal/revision')).status).toBe(400);
      const response = await request(app).get(`${url}/revision`).set('Host', '127.0.0.1:3000');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ goal, revision: expected });
      expect(reads).toBe(1);
    } finally { service.getThreadGoalWithRevision = original; }
  });

  test('one exact paused-to-active native CAS preserves native Goal identity', async () => {
    const service = getCodexService();
    const original = service.setThreadGoalWithRevision;
    const oldLegacy = service.setThreadGoal;
    let calls = 0;
    service.setThreadGoal = async () => { throw Error('legacy must not run'); };
    service.setThreadGoalWithRevision = async (id, revision, change) => {
      calls++;
      expect({ id, revision, change }).toEqual({ id: threadId, revision: expected,
        change: { status: 'active' } });
      return { goal: { ...goal, status: 'active' },
        revision: { ...expected, status: 'active', lifecycleRevision: 4 } } as any;
    };
    try {
      const response = await request(app).put(url).send({ expected, status: 'active' });
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.goal.createdAt).toBe(goal.createdAt);
      expect(response.body.revision.lifecycleRevision).toBe(4);
      expect(calls).toBe(1);
    } finally {
      service.setThreadGoalWithRevision = original;
      service.setThreadGoal = oldLegacy;
    }
  });

  test('malformed, wrong-origin, conflict and unknown effect fail closed without fallback', async () => {
    const service = getCodexService();
    const original = service.setThreadGoalWithRevision;
    const oldLegacy = service.setThreadGoal;
    let calls = 0;
    service.setThreadGoal = async () => { throw Error('legacy must not run'); };
    service.setThreadGoalWithRevision = async () => { calls++; throw new GoalRevisionConflictError(); };
    try {
      expect((await request(app).put(url).send({ expected, status: 'active' })
        .set('Origin', 'https://attacker.example')).status).toBe(403);
      for (const body of [
        { expected: { ...expected, lifecycleRevision: 0 }, status: 'active' },
        { expected, status: 'complete' },
        { expected, status: 'active', objective: 'unexpected' },
        { expected: { ...expected, invented: true }, status: 'active' },
      ]) expect((await request(app).put(url).send(body)).status).toBe(400);
      expect(calls).toBe(0);
      const conflict = await request(app).put(url).send({ expected, status: 'active' });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({ error: 'Native Goal revision changed.' });
      expect(calls).toBe(1);
      service.setThreadGoalWithRevision = async () => { throw Error('private runtime prose'); };
      const unknown = await request(app).put(url).send({ expected, status: 'active' });
      expect(unknown.status).toBe(503);
      expect(JSON.stringify(unknown.body)).not.toContain('private');
    } finally {
      service.setThreadGoalWithRevision = original;
      service.setThreadGoal = oldLegacy;
    }
  });
});
