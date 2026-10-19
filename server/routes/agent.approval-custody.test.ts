import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import agentRouter from './agent';
import { approvalManager } from '../approvalManager';
import type { ApprovalOwnerKind, QuestionRequestInternal } from '../../shared/types/approval';

const app = express();
app.use('/api/agent', agentRouter);
const token = 'private-test-token';
const threadA = '00000000-0000-4000-8000-000000000001';
const threadB = '00000000-0000-4000-8000-000000000002';
const path = (id: string) => `/api/agent/custody/approvals/${id}`;
const requests = (approvalManager as unknown as { requests: Map<string, QuestionRequestInternal> }).requests;
const previousToken = process.env.WORKSTATION_WAKE_TOKEN;

function pending(id: string, kind: ApprovalOwnerKind, threadId: string | null, windowSessionKey: string | null) {
  requests.set(id, {
    id,
    toolName: 'codex_apps__sites.create_site',
    serverId: 'private-server-identifier',
    questions: [{ question: 'SENSITIVE QUESTION', options: [{ label: 'SENSITIVE CHOICE', value: 'yes' }] }],
    context: { args: 'SENSITIVE ARGUMENTS' },
    timestamp: Date.now(),
    owner: {
      approvalOwnerKind: kind,
      capturedAt: Date.now(),
      displayName: 'SENSITIVE DISPLAY NAME',
      color: '#000000',
      identity: {
        agentId: kind === 'cli' ? null : `agent-${id}`,
        ...(threadId ? { threadId } : {}),
        windowSessionKey,
        workspacePath: '/workspace/owner',
      },
    },
    resolve: () => {},
    reject: () => {},
  });
}

afterEach(() => {
  for (const id of ['approval-a', 'approval-b', 'approval-cli', 'approval-unknown']) requests.delete(id);
  if (previousToken === undefined) delete process.env.WORKSTATION_WAKE_TOKEN;
  else process.env.WORKSTATION_WAKE_TOKEN = previousToken;
});

describe('exact approval custody metadata', () => {
  test('requires local private bearer, exact ID and owner scope', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = token;
    pending('approval-a', 'normal-agent', threadA, 'owner-window');
    expect((await request(app).get(`${path('approval-a')}?threadId=${threadA}`)).status).toBe(401);
    expect((await request(app).get(`${path('approval-a')}?threadId=${threadA}`)
      .set('Authorization', `Bearer ${token}`).set('Origin', 'https://elsewhere.example')).status).toBe(401);
    expect((await request(app).get(path('approval-a')).set('Authorization', `Bearer ${token}`)).status).toBe(400);
    expect((await request(app).get(`${path('approval-a')}?cliUnbound=1&threadId=${threadA}`)
      .set('Authorization', `Bearer ${token}`)).status).toBe(400);
  });

  test('cannot inspect another thread, even with its exact ID or a different window', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = token;
    pending('approval-a', 'normal-agent', threadA, 'window-a');
    pending('approval-b', 'normal-agent', threadB, 'window-b');
    const denied = await request(app).get(`${path('approval-b')}?threadId=${threadA}`)
      .set('Authorization', `Bearer ${token}`);
    expect(denied.status).toBe(404);
    expect(denied.text).not.toContain('window-b');
    expect((await request(app).get(`${path('approval-b')}?cliUnbound=1`)
      .set('Authorization', `Bearer ${token}`)).status).toBe(404);

    const allowed = await request(app).get(`${path('approval-a')}?threadId=${threadA}`)
      .set('Authorization', `Bearer ${token}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({
      id: 'approval-a', status: 'pending', toolName: 'codex_apps__sites.create_site',
      owner: { kind: 'normal-agent', threadId: threadA,
        windowSessionKey: 'window-a', workspacePath: '/workspace/owner' },
    });
    expect(allowed.text).not.toMatch(/SENSITIVE|private-server-identifier/);
    requests.delete('approval-a');
    expect((await request(app).get(`${path('approval-a')}?threadId=${threadA}`)
      .set('Authorization', `Bearer ${token}`)).status).toBe(404);
  });

  test('requires explicit CLI-unbound scope and rejects an unbound normal agent', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = token;
    pending('approval-cli', 'cli', null, null);
    pending('approval-unknown', 'normal-agent', null, 'elsewhere');
    expect((await request(app).get(`${path('approval-cli')}?threadId=${threadA}`)
      .set('Authorization', `Bearer ${token}`)).status).toBe(404);
    expect((await request(app).get(`${path('approval-unknown')}?cliUnbound=1`)
      .set('Authorization', `Bearer ${token}`)).status).toBe(404);
    const cli = await request(app).get(`${path('approval-cli')}?cliUnbound=1`)
      .set('Authorization', `Bearer ${token}`);
    expect(cli.body).toEqual({
      id: 'approval-cli', status: 'pending', toolName: 'codex_apps__sites.create_site',
      owner: { kind: 'cli', threadId: null, windowSessionKey: null, workspacePath: '/workspace/owner' },
    });
  });

  test('malformed tool identifiers fail closed, not as empty or leaked content', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = token;
    pending('approval-a', 'normal-agent', threadA, 'owner-window');
    requests.get('approval-a')!.toolName = 'SENSITIVE PROVIDER TEXT';
    const result = await request(app).get(`${path('approval-a')}?threadId=${threadA}`)
      .set('Authorization', `Bearer ${token}`);
    expect(result.status).toBe(503);
    expect(result.text).not.toContain('SENSITIVE');
  });
});
