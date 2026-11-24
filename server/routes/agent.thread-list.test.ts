import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { getCodexService, NativeCustodyPhaseError } from '../../src/lib/codex/service';
import type { v2 } from '../handlers/codex-generated-types/index';
import agentRouter from './agent';

const app = express();
app.use('/api/agent', agentRouter);
const page = (ids: string[], nextCursor: string | null = null): v2.ThreadListResponse => ({
  data: ids.map((id) => ({ id }) as v2.Thread), nextCursor,
});

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

  test('DB pages preserve source kinds, providers, sort, archive filter and cursor', async () => {
    const service = getCodexService();
    const original = service.listThreads;
    const calls: Array<{ params?: v2.ThreadListParams; deadline?: number }> = [];
    service.listThreads = async (params, deadline) => {
      calls.push({ params, deadline });
      return calls.length === 1 ? page(['first'], 'next-page') : page(['second']);
    };
    try {
      const first = await request(app).get('/api/agent/threads?archived=1');
      const second = await request(app).get('/api/agent/threads?archived=1&cursor=next-page');
      expect(first.status).toBe(200);
      expect(first.body.nextCursor).toBe('next-page');
      expect(second.body.data.map((entry: v2.Thread) => entry.id)).toEqual(['second']);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.params).toEqual({ sortKey: 'updated_at', sourceKinds: ['vscode', 'appServer'],
        modelProviders: [], archived: true, useStateDbOnly: true });
      expect(calls[1]?.params).toEqual({ sortKey: 'updated_at', sourceKinds: ['vscode', 'appServer'],
        modelProviders: [], archived: true, cursor: 'next-page', useStateDbOnly: true });
      expect(calls[0]?.deadline).toBeGreaterThan(0);
    } finally { service.listThreads = original; }
  });

  test('empty first DB page is confirmed empty by exactly one default scan inside the same deadline', async () => {
    const service = getCodexService();
    const original = service.listThreads;
    const calls: Array<{ params?: v2.ThreadListParams; deadline?: number }> = [];
    service.listThreads = async (params, deadline) => { calls.push({ params, deadline }); return page([]); };
    try {
      const result = await request(app).get('/api/agent/threads');
      expect(result.status).toBe(200);
      expect(result.body).toEqual(page([]));
      expect(calls.map(({ params }) => params?.useStateDbOnly)).toEqual([true, undefined]);
      expect(calls[1]?.params).toMatchObject({ sortKey: 'updated_at', archived: false });
      expect(calls[1]?.deadline).toBeGreaterThan(0);
      expect(calls[1]?.deadline).toBeLessThanOrEqual(calls[0]!.deadline!);
    } finally { service.listThreads = original; }
  });

  test('empty DB with nonempty scan returns scanned page and fixed disagreement category', async () => {
    const service = getCodexService();
    const original = service.listThreads;
    const warn = console.warn;
    const warnings: unknown[][] = [];
    let calls = 0;
    service.listThreads = async () => ++calls === 1 ? page([]) : page(['found'], 'scan-next');
    console.warn = (...args) => { warnings.push(args); };
    try {
      const result = await request(app).get('/api/agent/threads');
      expect(result.status).toBe(200);
      expect(result.body).toEqual(page(['found'], 'scan-next'));
      expect(calls).toBe(2);
      expect(warnings).toContainEqual(['[Agent API] Native thread list DB disagreement.', 'db_disagreement']);
    } finally { service.listThreads = original; console.warn = warn; }
  });

  test('empty DB page with cursor returns the scanned page and fixed disagreement category', async () => {
    const service = getCodexService();
    const original = service.listThreads;
    const warn = console.warn;
    const warnings: unknown[][] = [];
    const calls: Array<{ params?: v2.ThreadListParams; deadline?: number }> = [];
    service.listThreads = async (params, deadline) => {
      calls.push({ params, deadline });
      return calls.length === 1 ? page([]) : page(['late-found'], 'scan-next');
    };
    console.warn = (...args) => { warnings.push(args); };
    try {
      const result = await request(app).get('/api/agent/threads?cursor=opaque-before&archived=1');
      expect(result.status).toBe(200);
      expect(result.body).toEqual(page(['late-found'], 'scan-next'));
      expect(calls).toHaveLength(2);
      expect(calls.map(({ params }) => params?.useStateDbOnly)).toEqual([true, undefined]);
      expect(calls[1]?.params?.cursor).toBe('opaque-before');
      expect(calls[1]?.params?.archived).toBe(true);
      expect(calls[1]?.deadline).toBeGreaterThan(0);
      expect(calls[1]?.deadline).toBeLessThanOrEqual(calls[0]!.deadline!);
      expect(warnings).toContainEqual(['[Agent API] Native thread list DB disagreement.', 'db_disagreement']);
    } finally { service.listThreads = original; console.warn = warn; }
  });

  for (const failure of [new Error('PRIVATE late scan error'), new NativeCustodyPhaseError('thread_list', 'deadline')]) {
    test(`empty DB page with cursor and scan ${failure instanceof NativeCustodyPhaseError ? 'deadline' : 'error'} returns typed 503`, async () => {
      const service = getCodexService();
      const original = service.listThreads;
      const calls: Array<v2.ThreadListParams | undefined> = [];
      service.listThreads = async (params) => {
        calls.push(params);
        if (calls.length === 1) return page([]);
        throw failure;
      };
      try {
        const result = await request(app).get('/api/agent/threads?cursor=opaque-before');
        expect(result.status).toBe(503);
        expect(result.body).toMatchObject({ phase: 'thread_list',
          category: failure instanceof NativeCustodyPhaseError ? 'deadline' : 'native_unavailable', available: false });
        expect(result.text).not.toContain('PRIVATE');
        expect(calls).toHaveLength(2);
        expect(calls[1]?.cursor).toBe('opaque-before');
      } finally { service.listThreads = original; }
    });
  }

  for (const failure of [new Error('PRIVATE scan error'), new NativeCustodyPhaseError('thread_list', 'deadline')]) {
    test(`empty DB with scan ${failure instanceof NativeCustodyPhaseError ? 'deadline' : 'error'} is typed 503`, async () => {
      const service = getCodexService();
      const original = service.listThreads;
      let calls = 0;
      service.listThreads = async () => { if (++calls === 1) return page([]); throw failure; };
      try {
        const result = await request(app).get('/api/agent/threads');
        expect(result.status).toBe(503);
        expect(result.body).toMatchObject({ phase: 'thread_list',
          category: failure instanceof NativeCustodyPhaseError ? 'deadline' : 'native_unavailable', available: false });
        expect(result.text).not.toContain('PRIVATE');
        expect(calls).toBe(2);
      } finally { service.listThreads = original; }
    });
  }

  test('DB error never becomes a successful empty list or a fallback scan', async () => {
    const service = getCodexService();
    const original = service.listThreads;
    let calls = 0;
    service.listThreads = async () => { calls++; throw new Error('PRIVATE DB error'); };
    try {
      const result = await request(app).get('/api/agent/threads');
      expect(result.status).toBe(503);
      expect(result.body.category).toBe('native_unavailable');
      expect(result.text).not.toContain('PRIVATE');
      expect(calls).toBe(1);
    } finally { service.listThreads = original; }
  });
});
