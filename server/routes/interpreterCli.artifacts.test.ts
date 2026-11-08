import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { agentTabManager } from '../agentTabManager';
import { INTERPRETER_CLI_CALLER_TOKEN_HEADER } from '../utils/interpreterCliRuntime';
import interpreterCliRouter from './interpreterCli';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/interpreter-cli', interpreterCliRouter);

describe('thread artifact caller scope', () => {
  test('normal bound caller can create and read back, unbound and other thread cannot', async () => {
    const threadId = randomUUID();
    const other = randomUUID();
    const token = randomUUID();
    agentTabManager.registerAgentRuntime({ agentId: randomUUID(), callerToken: token, threadId, workspacePath: '/tmp' });
    const data = Buffer.from('owned artifact');
    const body = { receiptId: randomUUID(), base64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') };
    const url = `/api/interpreter-cli/threads/${threadId}/artifacts`;
    expect((await request(app).post(url).send(body)).status).toBe(401);
    expect((await request(app).post(url).set(INTERPRETER_CLI_CALLER_TOKEN_HEADER, 'not-bound').send(body)).status).toBe(403);
    expect((await request(app).post(`/api/interpreter-cli/threads/${other}/artifacts`).set(INTERPRETER_CLI_CALLER_TOKEN_HEADER, token).send(body)).status).toBe(403);
    const created = await request(app).post(url).set(INTERPRETER_CLI_CALLER_TOKEN_HEADER, token).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ threadId, receiptId: body.receiptId, sha256: body.sha256, size: data.length });
    expect((await request(app).post(url).set(INTERPRETER_CLI_CALLER_TOKEN_HEADER, token).send(body)).status).toBe(200);
    expect((await request(app).get(`${url}/${body.receiptId}`).set(INTERPRETER_CLI_CALLER_TOKEN_HEADER, token)).body.sha256).toBe(body.sha256);
    expect((await request(app).post(url).set(INTERPRETER_CLI_CALLER_TOKEN_HEADER, token).send({ ...body, sha256: '0'.repeat(64) })).status).toBe(400);
    const replacement = randomUUID();
    agentTabManager.registerAgentRuntime({ agentId: randomUUID(), callerToken: replacement, threadId, workspacePath: '/tmp' });
    expect((await request(app).post(url).set(INTERPRETER_CLI_CALLER_TOKEN_HEADER, token).send(body)).status).toBe(403);
  });
});
