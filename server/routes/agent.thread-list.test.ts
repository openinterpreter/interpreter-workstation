import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { getCodexService, NativeCustodyPhaseError } from '../../src/lib/codex/service';
import agentRouter from './agent';

const app = express();
app.use('/api/agent', agentRouter);

describe('thread list HTTP', () => {
  test('passes the native page through on success', async () => {
    const service = getCodexService();
    const original = service.listThreads;
    service.listThreads = async () => ({ data: [], nextCursor: 'opaque-next' });
    try {
      const result = await request(app).get('/api/agent/threads?cursor=opaque-before');
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ data: [], nextCursor: 'opaque-next' });
    } finally { service.listThreads = original; }
  });

  for (const category of ['deadline', 'native_unavailable'] as const) {
    test(`a ${category} native failure returns typed 503, never an empty list`, async () => {
      const service = getCodexService();
      const original = service.listThreads;
      service.listThreads = async () => { throw new NativeCustodyPhaseError('thread_list', category); };
      try {
        const result = await request(app).get('/api/agent/threads');
        expect(result.status).toBe(503);
        expect(result.body).toEqual({
          error: 'Native thread list unavailable.', phase: 'thread_list', category, available: false,
        });
        expect(result.body.data).toBeUndefined();
      } finally { service.listThreads = original; }
    });
  }

  test('unexpected native exception prose is not returned to the caller', async () => {
    const service = getCodexService();
    const original = service.listThreads;
    service.listThreads = async () => { throw new Error('PRIVATE native exception'); };
    try {
      const result = await request(app).get('/api/agent/threads');
      expect(result.status).toBe(503);
      expect(result.body.category).toBe('native_unavailable');
      expect(result.text).not.toContain('PRIVATE');
    } finally { service.listThreads = original; }
  });
});
