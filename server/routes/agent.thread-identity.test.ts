import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { getCodexService, SavedThreadIdentityError } from '../../src/lib/codex/service';
import agentRouter from './agent';

const app = express();
app.use('/api/agent', agentRouter);
const id = '00000000-0000-4000-8000-000000000001';

describe('exact saved-thread identity HTTP', () => {
  test('projects only metadata, without turn text or an active/idle admission decision', async () => {
    const service = getCodexService();
    const original = service.readSavedThreadIdentity;
    service.readSavedThreadIdentity = async (threadId) => {
      expect(threadId).toBe(id);
      return { threadId, cwd: '/workspace/projects/interpreter',
        path: `/workspace/home/sessions/2026/11/13/turn-${threadId}.jsonl`, archived: false };
    };
    try {
      const response = await request(app).get(`/api/agent/threads/${id}/identity`);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['archived', 'cwd', 'path', 'threadId']);
      expect(response.body.threadId).toBe(id);
      expect(JSON.stringify(response.body)).not.toContain('turns');
    } finally { service.readSavedThreadIdentity = original; }
  });

  test('invalid ID, unbound native shell and RPC failure fail closed with fixed metadata only', async () => {
    expect((await request(app).get('/api/agent/threads/not-a-uuid/identity')).status).toBe(400);
    const service = getCodexService();
    const original = service.readSavedThreadIdentity;
    try {
      service.readSavedThreadIdentity = async () => { throw new SavedThreadIdentityError(); };
      expect((await request(app).get(`/api/agent/threads/${id}/identity`)).status).toBe(404);
      service.readSavedThreadIdentity = async () => { throw new Error('PRIVATE PROVIDER PROSE'); };
      const response = await request(app).get(`/api/agent/threads/${id}/identity`);
      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE');
    } finally { service.readSavedThreadIdentity = original; }
  });
});
