import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import express from 'express';
import request from 'supertest';
import ipcRouter from '../routes/ipc';
import {
  createWorkstationConnectionRouter,
  workstationAccessMiddleware,
  workstationCorsMiddleware,
} from '../workstationConnection';
import { createEnterpriseBrowserRouter } from './oidcHttp';
import { createEnterpriseRuntimeGate } from './runtimeGate';
import { ServerDirectory } from './serverDirectory';

const origin = 'http://127.0.0.1:39394';
const host = '127.0.0.1:39394';
const keys = [
  'INTERPRETER_WORKSTATION_ACCESS', 'INTERPRETER_WORKSTATION_AUTH',
  'INTERPRETER_WORKSTATION_PASSWORD', 'INTERPRETER_WORKSTATION_SESSION_SECRET',
  'INTERPRETER_WORKSTATION_ALLOWED_ORIGINS',
  'NODE_ENV',
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const directories: string[] = [];

afterEach(async () => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('remote Workstation and enterprise session boundaries', () => {
  test('neither cookie substitutes for the other; tenant revocation does not revoke the host password cookie', async () => {
    process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-write';
    process.env.INTERPRETER_WORKSTATION_AUTH = 'password';
    process.env.INTERPRETER_WORKSTATION_PASSWORD = 'synthetic-host-password';
    process.env.INTERPRETER_WORKSTATION_SESSION_SECRET = 'synthetic-host-session-secret';
    process.env.INTERPRETER_WORKSTATION_ALLOWED_ORIGINS = origin;

    const parent = await mkdtemp(join(tmpdir(), 'enterprise-host-boundary-'));
    directories.push(parent);
    const directory = new ServerDirectory(join(parent, 'directory.json'));
    const issuer = 'https://idp.example.test/tenant';
    await directory.bootstrap('org-a', 'Acme', issuer,
      { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
    await directory.bootstrap('org-b', 'Beta', issuer,
      { organizationId: 'org-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
    const session = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000);

    // Mirror server.ts ordering: connection login is public, then the host
    // password gate precedes any separately opted-in enterprise route.
    const app = express();
    app.use(workstationCorsMiddleware);
    app.use(express.json());
    app.use('/api/workstation-connection', createWorkstationConnectionRouter());
    app.use(workstationAccessMiddleware);
    app.use('/api/ipc', ipcRouter);
    app.use('/api/enterprise', createEnterpriseBrowserRouter({
      applicationOrigin: origin, allowInsecureLoopbackForTests: true,
      verifySession: (token) => directory.verifySession(token), directory,
    }));
    const login = await request(app).post('/api/workstation-connection/session')
      .set('Host', host).set('Origin', origin).send({ password: 'synthetic-host-password' });
    expect(login.status).toBe(200);
    const hostCookie = login.headers['set-cookie'][0].split(';')[0];
    const orgCookie = `interpreter-enterprise-session=${session.token}`;
    const overview = '/api/enterprise/organizations/org-a/overview';
    const get = (path: string, cookie: string) => request(app).get(path).set('Host', host).set('Cookie', cookie);
    const foreignAuditBefore = (await directory.auditSummary('org-b')).eventCount;

    expect((await get(overview, hostCookie)).status).toBe(401);
    expect((await get(overview, orgCookie)).status).toBe(401);
    expect((await get(overview, `${hostCookie}; ${orgCookie}`)).status).toBe(200);
    expect((await get('/api/enterprise/organizations/org-b/overview', `${hostCookie}; ${orgCookie}`)).status).toBe(403);
    expect((await directory.auditSummary('org-b')).eventCount).toBe(foreignAuditBefore);

    await directory.revokeSession(session.identity);
    expect((await get(overview, `${hostCookie}; ${orgCookie}`)).status).toBe(403);
    // The real browser IPC dispatch still accepts the host password cookie
    // after org revocation. This operation is intentionally side-effect-free;
    // it proves a path gap, not the safety of other IPC methods or native IPC.
    const ipc = await request(app).post('/api/ipc/browser/create')
      .set('Host', host).set('Origin', origin).set('Cookie', hostCookie).send([]);
    expect(ipc.status).toBe(200);
    expect(ipc.body).toEqual({ success: false, error: 'Not available in browser mode' });
  });

  test('an explicit execution gate blocks real browser IPC without a current tenant policy, including after revocation', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.INTERPRETER_WORKSTATION_ACCESS;
    const parent = await mkdtemp(join(tmpdir(), 'enterprise-runtime-boundary-'));
    directories.push(parent);
    const directory = new ServerDirectory(join(parent, 'directory.json'));
    const issuer = 'https://idp.example.test/tenant';
    await directory.bootstrap('org-a', 'Acme', issuer,
      { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
    await directory.bootstrap('org-b', 'Beta', issuer,
      { organizationId: 'org-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
    const session = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000);
    const foreign = await directory.createSession(issuer, 'org-b', 'bob', Date.now() + 60_000);
    await directory.createWorkspace(session.identity, 'engineering', 'Engineering');
    const options = { applicationOrigin: origin, organizationId: 'org-a', issuer,
      workspaceId: 'engineering', action: 'tool.invoke' as const, routePath: '/browser/create', directory,
      allowInsecureLoopbackForTests: true };
    process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-write';
    expect(() => createEnterpriseRuntimeGate(options)).toThrow('remote Workstation host session');
    delete process.env.INTERPRETER_WORKSTATION_ACCESS;
    const app = express();
    app.use(express.json());
    app.use('/api/ipc', createEnterpriseRuntimeGate(options), ipcRouter);
    const invoke = (cookie?: string) => {
      const call = request(app).post('/api/ipc/browser/create').set('Host', host)
        .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').set('X-Interpreter-CSRF', '1');
      return (cookie ? call.set('Cookie', cookie) : call).send([]);
    };
    expect((await invoke()).status).toBe(401);
    expect((await invoke('interpreter_workstation_session=synthetic')).status).toBe(401);
    expect((await invoke(`interpreter-enterprise-session=${foreign.token}`)).status).toBe(403);
    expect((await invoke(`interpreter-enterprise-session=${session.token}`)).status).toBe(403);
    expect((await invoke(`interpreter-enterprise-session=${session.token}`)
      .set('Origin', 'https://attacker.test').set('X-Forwarded-Proto', 'https')).status).toBe(403);
    expect((await invoke(`interpreter-enterprise-session=${session.token}`)
      .set('X-Interpreter-CSRF', '0')).status).toBe(403);
    expect((await directory.listAudit(session.identity)).filter((event) =>
      event.action === 'runtime.tool.invoke' && event.outcome === 'denied')).toHaveLength(1);
    expect((await directory.listAudit(foreign.identity)).filter((event) =>
      event.action === 'runtime.tool.invoke')).toHaveLength(0);
    const wrongIssuer = express();
    let wrongIssuerAuthorized = false;
    wrongIssuer.use('/api/ipc', createEnterpriseRuntimeGate({ ...options,
      directory: {
        verifySession: async () => ({ ...session.identity, issuer: 'https://other.example.test' }),
        verifyBoundSession: async () => null,
        authorizeRuntime: async () => { wrongIssuerAuthorized = true; return true; },
      },
    }), ipcRouter);
    expect((await request(wrongIssuer).post('/api/ipc/browser/create').set('Host', host)
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').set('X-Interpreter-CSRF', '1')
      .set('Cookie', `interpreter-enterprise-session=${session.token}`).send([])).status).toBe(403);
    expect(wrongIssuerAuthorized).toBe(false);
    expect((await invoke(`interpreter-enterprise-session=${session.token}; interpreter-enterprise-session=${session.token}`)).status).toBe(401);
    await directory.setRuntimeGrant(session.identity, 'engineering', 'alice', 'tool.invoke', true);
    const authorized = await invoke(`interpreter-enterprise-session=${session.token}`);
    expect(authorized.status).toBe(200);
    expect(authorized.body).toEqual({ success: false, error: 'Not available in browser mode' });
    // A proxy-form target may name a different authority even with a pinned
    // Host header. Reject it before the tenant policy is asked for a grant.
    const server = app.listen(0, '127.0.0.1');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback fixture unavailable');
      const before = (await directory.listAudit(session.identity)).filter((event) =>
        event.action === 'runtime.tool.invoke').length;
      const absoluteStatus = await new Promise<number>((resolve, reject) => {
        const call = httpRequest({ host: '127.0.0.1', port: address.port, method: 'POST',
          path: 'http://untrusted.test/api/ipc/browser/create', headers: {
            Host: host, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-Interpreter-CSRF': '1',
            Cookie: `interpreter-enterprise-session=${session.token}`,
            'Content-Type': 'application/json', 'Content-Length': '2',
          } }, (response) => {
          response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
        });
        call.on('error', reject); call.end('[]');
      });
      expect(absoluteStatus).toBe(403);
      expect((await directory.listAudit(session.identity)).filter((event) =>
        event.action === 'runtime.tool.invoke')).toHaveLength(before);
    } finally { server.close(); }
    expect((await request(app).post('/api/ipc/settings/setTelemetryEnabled').set('Host', host)
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').set('X-Interpreter-CSRF', '1')
      .set('Cookie', `interpreter-enterprise-session=${session.token}`).send([true])).status).toBe(403);
    await directory.setRuntimeGrant(session.identity, 'engineering', 'alice', 'tool.invoke', false);
    expect((await invoke(`interpreter-enterprise-session=${session.token}`)).status).toBe(403);
    await directory.revokeSession(session.identity);
    expect((await invoke(`interpreter-enterprise-session=${session.token}`)).status).toBe(403);
    process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-write';
    expect((await invoke(`interpreter-enterprise-session=${foreign.token}`)).status).toBe(503);
  });
});
