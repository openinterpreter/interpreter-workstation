import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { getCodexService } from '../../src/lib/codex/service';
import type { v2 } from '../handlers/codex-generated-types/index';
import agentRouter from './agent';

const app = express();
app.use('/api/agent', agentRouter);
const id = '00000000-0000-4000-8000-000000000001';

const shell = {
  id, preview: 'First question', createdAt: 1, updatedAt: 2, path: '/saved/thread.jsonl',
  cwd: '/workspace', name: 'Saved thread', status: { type: 'active', activeFlags: [] },
} as unknown as v2.Thread;
const turn = (turnId: string, status: v2.Turn['status']) => ({
  id: turnId, status, items: [], itemsView: 'full', error: null,
  startedAt: null, completedAt: null, durationMs: null,
}) as v2.Turn;

function stubService(page: (threadId: string, options: { limit: number; cursor?: string }) =>
  Promise<{ thread: v2.Thread; nextCursor: string | null }>) {
  const service = getCodexService();
  const original = { readThread: service.readThread, readThreadPage: service.readThreadPage };
  const calls = { full: 0, pages: [] as Array<{ threadId: string; limit: number; cursor?: string }> };
  service.readThread = async () => { calls.full++; throw new Error('must not read the whole thread'); };
  service.readThreadPage = async (threadId, options) => {
    calls.pages.push({ threadId, ...options });
    return page(threadId, options);
  };
  return { calls, restore: () => Object.assign(service, original) };
}

describe('thread history page HTTP', () => {
  test('a limited read uses one bounded page and never the full history', async () => {
    const { calls, restore } = stubService(async () => ({
      thread: { ...shell, turns: [turn('turn_1', 'completed'), turn('turn_2', 'inProgress')] },
      nextCursor: 'opaque-older',
    }));
    try {
      const response = await request(app).get(`/api/agent/threads/${id}?limit=2&before=opaque-before`);
      expect(response.status).toBe(200);
      expect(calls.full).toBe(0);
      expect(calls.pages).toEqual([{ threadId: id, limit: 2, cursor: 'opaque-before' }]);
      expect(response.body.historyPage).toEqual({ nextCursor: 'opaque-older', hasMore: true });
      expect(response.body.thread.turns.map((entry: v2.Turn) => entry.id)).toEqual(['turn_1', 'turn_2']);
      expect(response.body.thread).toMatchObject({
        id, preview: 'First question', createdAt: 1, updatedAt: 2, path: '/saved/thread.jsonl',
        cwd: '/workspace', name: 'Saved thread', status: { type: 'active' },
      });
    } finally { restore(); }
  });

  test('the oldest page reports no more history', async () => {
    const { restore } = stubService(async () => ({ thread: { ...shell, turns: [] }, nextCursor: null }));
    try {
      const response = await request(app).get(`/api/agent/threads/${id}?limit=24`);
      expect(response.body.historyPage).toEqual({ nextCursor: null, hasMore: false });
    } finally { restore(); }
  });

  test('an invalid cursor is a 400 before any native read', async () => {
    const { calls, restore } = stubService(async () => { throw new Error('must not read'); });
    try {
      for (const before of ['', 'a'.repeat(1025), 'bad%0Acursor']) {
        const response = await request(app).get(`/api/agent/threads/${id}?limit=24&before=${before}`);
        expect(response.status).toBe(400);
      }
      expect(calls.pages).toHaveLength(0);
      expect(calls.full).toBe(0);
    } finally { restore(); }
  });

  test('a best-effort refresh keeps its soft failure; an interactive read keeps its 500', async () => {
    const { restore } = stubService(async () => { throw new Error('runtime restarting'); });
    try {
      const soft = await request(app).get(`/api/agent/threads/${id}?limit=2&bestEffort=1`);
      expect(soft.status).toBe(200);
      expect(soft.body).toEqual({ thread: null, available: false });
      const hard = await request(app).get(`/api/agent/threads/${id}?limit=24`);
      expect(hard.status).toBe(500);
    } finally { restore(); }
  });

  test('a read without a limit still returns the whole thread', async () => {
    const service = getCodexService();
    const original = service.readThread;
    service.readThread = async () => ({ ...shell, turns: [turn('turn_1', 'completed')] });
    try {
      const response = await request(app).get(`/api/agent/threads/${id}`);
      expect(response.status).toBe(200);
      expect(response.body.historyPage).toBeUndefined();
      expect(response.body.thread.turns).toHaveLength(1);
    } finally { service.readThread = original; }
  });
});
