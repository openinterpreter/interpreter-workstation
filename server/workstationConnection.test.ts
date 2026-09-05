import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import {
  createWorkstationConnectionRouter,
  getWorkstationHostPolicy,
  isReadOnlyWorkstationRequest,
  validateWorkstationHostPolicy,
  workstationAccessMiddleware,
  workstationCorsMiddleware,
} from './workstationConnection';

const ENV_KEYS = [
  'INTERPRETER_WORKSTATION_ACCESS',
  'INTERPRETER_WORKSTATION_AUTH',
  'INTERPRETER_WORKSTATION_PASSWORD',
  'INTERPRETER_WORKSTATION_SESSION_SECRET',
  'INTERPRETER_WORKSTATION_ALLOWED_ORIGINS',
  'INTERPRETER_WORKSTATION_SECURE_COOKIE',
] as const;
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnvironment[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function createTestApp() {
  const app = express();
  app.use(workstationCorsMiddleware);
  app.use(express.json());
  app.use('/api/workstation-connection', createWorkstationConnectionRouter());
  app.use(workstationAccessMiddleware);
  app.get('/api/read', (_request, response) => response.json({ ok: true }));
  app.post('/api/write', (_request, response) => response.json({ ok: true }));
  app.get('/api/public-thread/snapshot', (_request, response) => response.json({ public: true }));
  app.get('/api/public-thread-pretender', (_request, response) => response.json({ public: false }));
  return app;
}

describe('remote Workstation host policy', () => {
  test('defaults to the local read-write bridge without authentication', () => {
    const policy = getWorkstationHostPolicy({});
    expect(policy.remote).toBe(false);
    expect(policy.access).toBe('read-write');
    expect(policy.authentication).toBe('none');
  });

  test('requires a password when password authentication is selected', () => {
    const policy = getWorkstationHostPolicy({
      INTERPRETER_WORKSTATION_ACCESS: 'read-write',
      INTERPRETER_WORKSTATION_AUTH: 'password',
    });
    expect(() => validateWorkstationHostPolicy(policy)).toThrow(/requires INTERPRETER_WORKSTATION_PASSWORD/);
  });

  test('allows query-shaped IPC calls but rejects mutations in read-only mode', () => {
    expect(isReadOnlyWorkstationRequest({ method: 'POST', path: '/api/ipc/profiles/list' })).toBe(true);
    expect(isReadOnlyWorkstationRequest({ method: 'POST', path: '/api/ipc/files/read' })).toBe(true);
    expect(isReadOnlyWorkstationRequest({ method: 'POST', path: '/api/ipc/files/write' })).toBe(false);
    expect(isReadOnlyWorkstationRequest({ method: 'POST', path: '/api/ipc/files/getOrCreate' })).toBe(false);
    expect(isReadOnlyWorkstationRequest({ method: 'DELETE', path: '/api/agent/threads/thread-one' })).toBe(false);
  });

  test('creates a durable password session and enforces access independently', async () => {
    process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-write';
    process.env.INTERPRETER_WORKSTATION_AUTH = 'password';
    process.env.INTERPRETER_WORKSTATION_PASSWORD = 'correct horse battery staple';
    process.env.INTERPRETER_WORKSTATION_SESSION_SECRET = 'test-session-secret';
    const app = createTestApp();

    const initial = await request(app)
      .get('/api/workstation-connection')
      .set('Host', 'workstation.test');
    expect(initial.body).toMatchObject({
      host: 'remote',
      access: 'read-write',
      authentication: { method: 'password', required: true, authenticated: false },
    });
    expect((await request(app).get('/api/read')).status).toBe(401);

    const login = await request(app)
      .post('/api/workstation-connection/session')
      .set('Host', 'workstation.test')
      .set('Origin', 'http://workstation.test')
      .send({ password: 'correct horse battery staple' });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    expect((await request(app).get('/api/read').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app)
      .post('/api/write')
      .set('Host', 'workstation.test')
      .set('Origin', 'http://workstation.test')
      .set('Cookie', cookie)).status).toBe(200);

    process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-only';
    expect((await request(app)
      .post('/api/write')
      .set('Host', 'workstation.test')
      .set('Origin', 'http://workstation.test')
      .set('Cookie', cookie)).status).toBe(403);
  });

  test('keeps the publication routes separately token-protected', async () => {
    process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-only';
    process.env.INTERPRETER_WORKSTATION_AUTH = 'password';
    process.env.INTERPRETER_WORKSTATION_PASSWORD = 'password';
    const response = await request(createTestApp()).get('/api/public-thread/snapshot');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ public: true });
    expect((await request(createTestApp()).get('/api/public-thread-pretender')).status).toBe(401);
  });

  test('serves the browser shell before login while keeping APIs private', async () => {
    process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-write';
    process.env.INTERPRETER_WORKSTATION_AUTH = 'password';
    process.env.INTERPRETER_WORKSTATION_PASSWORD = 'test-password';
    const app = createTestApp();
    app.get('/index.html', (_request, response) => response.type('html').send('<main>Workstation</main>'));
    app.get('/assets/app.js', (_request, response) => response.type('js').send('void 0'));

    expect((await request(app).get('/index.html')).status).toBe(200);
    expect((await request(app).get('/assets/app.js')).status).toBe(200);
    expect((await request(app).get('/api/read')).status).toBe(401);
  });
});
