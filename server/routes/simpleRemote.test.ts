import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import request from 'supertest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteSimplePairing } from '../remoteSimplePairing';
import { SimpleInterfaceProjects } from '../simpleInterfaceProjects';
import { createSimpleRemoteRouter } from './simpleRemote';
import { createRemoteSimpleListener } from '../remoteSimpleListener';

const endpoint = 'https://workstation.example.ts.net';
const host = 'workstation.example.ts.net';
const windowId = '8b998041-3299-43c3-8cc0-49486998e6aa';
const threadId = 'e789617d-032e-4412-87cc-99fbcf0953cb';
let scratch = '';
let oldAccess: string | undefined;
let oldAuth: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'simple-remote-route-'));
  await mkdir(join(scratch, 'control'));
  oldAccess = process.env.INTERPRETER_WORKSTATION_ACCESS;
  oldAuth = process.env.INTERPRETER_WORKSTATION_AUTH;
  process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-write';
  process.env.INTERPRETER_WORKSTATION_AUTH = 'password';
});
afterEach(async () => {
  if (oldAccess === undefined) delete process.env.INTERPRETER_WORKSTATION_ACCESS;
  else process.env.INTERPRETER_WORKSTATION_ACCESS = oldAccess;
  if (oldAuth === undefined) delete process.env.INTERPRETER_WORKSTATION_AUTH;
  else process.env.INTERPRETER_WORKSTATION_AUTH = oldAuth;
  await rm(scratch, { recursive: true, force: true });
});

async function harness(allowed = true) {
  const projects = new SimpleInterfaceProjects(join(scratch, 'registry'), async () => join(scratch, 'control'));
  const project = await projects.create(scratch, allowed ? 'Interface' : 'InterfaceUnavailable', windowId);
  const pairing = new RemoteSimplePairing(join(scratch, 'pairing'), async id => Boolean(await projects.resolve(id)));
  const offer = await pairing.create({ endpoint, projectId: project.id, threadId });
  const enqueue: string[] = [];
  const app = createRemoteSimpleListener(createSimpleRemoteRouter({ endpoint, projects, pairing,
    preflight: () => { if (!allowed) throw new Error('No private Serve grant'); },
    thread: async id => ({ id, cwd: project.path, turns: [] }),
    enqueue: async (id, _eventId, message) => {
      if (id !== threadId) throw new Error('Wrong durable thread');
      enqueue.push(message); return { status: 'queued' };
    },
    interrupt: async () => {},
  }));
  const paired = await request(app).post('/api/simple-remote/v1/pair').set('Host', host).set('X-Interpreter-Client', 'desktop')
    .send({ challengeId: offer.qr.challengeId, projectId: project.id, code: offer.code });
  return { app, project, offer, paired, enqueue };
}

describe('project-scoped remote HTTP boundary', () => {
  test('pairs once, admits only the project bearer, and queues into its durable thread', async () => {
    const { app, project, offer, paired, enqueue } = await harness();
    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ projectId: project.id, threadId });
    const scope = `/api/simple-remote/v1/sessions/${paired.body.sessionId}/projects/${project.id}`;
    const authorized = (method: 'get' | 'post', path: string) => request(app)[method](scope + path)
      .set('Host', host).set('X-Interpreter-Client', 'desktop').set('Authorization', `Bearer ${paired.body.token}`);
    const replay = await request(app).post('/api/simple-remote/v1/pair').set('Host', host).set('X-Interpreter-Client', 'desktop')
      .send({ challengeId: offer.qr.challengeId, projectId: project.id, code: offer.code });
    expect(replay.status).toBe(401);
    const capability = await authorized('get', '/capabilities');
    expect(capability.body.interface).toEqual({ executableReact: true, hotReload: true, lastKnownGood: true });
    expect(capability.body.tools.localComputer).toBe(false);
    const message = await authorized('post', '/messages').send({ version: 1, windowId,
      eventId: 'd179bf25-49d5-4671-b874-778379d51f11', source: 'voice', message: 'Continue the plan' });
    expect(message.status).toBe(202);
    expect(enqueue[0]).toContain(`project ${project.id}`);
    expect(enqueue[0]).toContain('Remote voice');
    expect(enqueue[0]).toContain('Continue the plan');
    const selection = await authorized('post', '/messages').send({ version: 1, windowId,
      eventId: '26dc90dd-b9c7-4b45-9d91-a88693af5589', source: 'composer',
      message: 'Summarize this', selectedText: 'Explicitly selected on the display' });
    expect(selection.status).toBe(202);
    expect(enqueue[1]).toContain('Explicit selection: Explicitly selected on the display');
    expect((await authorized('post', '/messages').send({ version: 1, windowId,
      eventId: '40c69983-cd8d-4401-9d45-08204cc0b7a1', source: 'composer', message: 'Read this',
      filePath: '/private/arbitrary' })).status).toBe(400);
    expect((await authorized('post', '/disconnect').send({})).status).toBe(200);
    expect((await authorized('get', '/capabilities')).status).toBe(401);
  });

  test('rejects unavailable Serve/ACL, invalid origin, wrong host, missing and wrong-project token', async () => {
    const { app, project, paired } = await harness();
    const scope = `/api/simple-remote/v1/sessions/${paired.body.sessionId}/projects/${project.id}`;
    expect((await request(app).get('/api/agent/threads')).status).toBe(404);
    expect((await request(app).get('/')).status).toBe(404);
    expect((await request(app).get(scope + '/capabilities').set('Host', host).set('X-Interpreter-Client', 'desktop')).status).toBe(401);
    expect((await request(app).get(scope + '/capabilities').set('Host', 'example.com').set('X-Interpreter-Client', 'desktop')).status).toBe(403);
    expect((await request(app).get(scope + '/capabilities').set('Host', host).set('Origin', 'https://attacker.example')).status).toBe(403);
    const anotherProject = '1f71c16f-c36b-449b-8118-5f89e63b7c1a';
    expect((await request(app).get(`/api/simple-remote/v1/sessions/${paired.body.sessionId}/projects/${anotherProject}/capabilities`)
      .set('Host', host).set('X-Interpreter-Client', 'desktop').set('Authorization', `Bearer ${paired.body.token}`)).status).toBe(401);
    const unavailable = await harness(false);
    expect(unavailable.paired.status).toBe(503);
  });
});
