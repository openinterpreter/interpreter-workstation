import { describe, expect, test } from 'bun:test';
import express from 'express';
import { request as httpRequest } from 'node:http';
import request from 'supertest';
import { createEnterpriseAdminMutationRouter, createEnterpriseBrowserRouter, createEnterpriseLogoutRouter, createOidcHttpRouter } from './oidcHttp';
import { OidcIntegration, type OidcConfiguration } from './oidc';
import type { ServerDirectory } from './serverDirectory';

const config: OidcConfiguration = {
  organizationId: 'org-a', issuer: 'http://127.0.0.1:39393/tenant', clientId: 'fixture',
  authorizationEndpoint: 'http://127.0.0.1:39393/tenant/authorize',
  tokenEndpoint: 'http://127.0.0.1:39393/tenant/token',
  jwksUri: 'http://127.0.0.1:39393/tenant/keys',
  redirectUri: 'http://127.0.0.1:39394/enterprise/callback',
  allowInsecureLoopbackForTests: true,
};
const origin = 'http://127.0.0.1:39394';
const host = '127.0.0.1:39394';
const binding = 'a'.repeat(43);
const session = 'b'.repeat(43);
const state = 'c'.repeat(43);

function fixture() {
  let completed = 0;
  const integration = {
    begin: async () => ({ authorizationUrl: `${config.authorizationEndpoint}?state=${state}`, state, browserBinding: binding }),
    complete: async (value: { code: string; state: string; browserBinding: string }) => {
      completed++;
      if (value.code !== 'fixture-code' || value.state !== state || value.browserBinding !== binding) throw new Error('Rejected');
      return { token: session, expiresAt: Date.now() + 60_000 };
    },
  } as OidcIntegration;
  const app = express();
  app.use(createOidcHttpRouter({ config, integration, applicationOrigin: origin, successPath: '/settings' }));
  return { app, completed: () => completed };
}

describe('unmounted HTTP boundary, deterministic local callback fixture', () => {
  test('domain recovery is absent by default and opt-in callback stays on its pinned renewal destination', async () => {
    const pinned = { ...config, accountDomain: 'acme.example' };
    const recoveryPath = '/settings/enterprise/domain-recovery';
    const calls: string[] = [];
    const integration = {
      begin: async () => ({ authorizationUrl: config.authorizationEndpoint, state, browserBinding: binding }),
      beginDomainRecovery: async () => {
        calls.push('recovery-start');
        return { authorizationUrl: config.authorizationEndpoint, state, browserBinding: binding };
      },
      complete: async (input: { code: string }, options: { allowDomainRecovery?: boolean }) => {
        calls.push(options.allowDomainRecovery ? 'callback-opted-in' : 'callback-disabled');
        return input.code === 'normal' ? { token: session, expiresAt: Date.now() + 60_000 }
          : { token: session, expiresAt: Date.now() + 60_000, recoveryOnly: true as const };
      },
    } as unknown as OidcIntegration;
    const start = '/organizations/org-a/domain-recovery/login';
    const callback = `/enterprise/callback?code=fixture-code&state=${state}`;
    const defaults = express();
    defaults.use(createOidcHttpRouter({ config: pinned, integration, applicationOrigin: origin, successPath: '/settings' }));
    expect((await request(defaults).get(start).set('Host', host)).status).toBe(404);
    const disabled = await request(defaults).get(callback).set('Host', host)
      .set('Cookie', `interpreter-oidc-binding=${binding}`);
    expect(disabled.status).toBe(401);
    expect(String(disabled.headers['set-cookie'])).not.toContain(`interpreter-enterprise-session=${session}`);
    expect(calls).toEqual(['callback-disabled']);
    for (const unsafe of ['//untrusted.test', '/settings?recovery=1', '/settings', '/\\untrusted.test']) {
      expect(() => createOidcHttpRouter({ config: pinned, integration, applicationOrigin: origin,
        successPath: '/settings', recoverySuccessPath: unsafe })).toThrow('Invalid application origin');
    }
    const enabled = express();
    enabled.use(createOidcHttpRouter({ config: pinned, integration, applicationOrigin: origin,
      successPath: '/settings', recoverySuccessPath: recoveryPath }));
    expect((await request(enabled).get(start).set('Host', 'untrusted.test')).status).toBe(403);
    expect((await request(enabled).get('/organizations/org-b/domain-recovery/login').set('Host', host)).status).toBe(403);
    expect(calls).toEqual(['callback-disabled']);
    const login = await request(enabled).get(start).set('Host', host);
    expect(login.status).toBe(302);
    expect(String(login.headers['set-cookie'])).toContain(`interpreter-oidc-binding=${binding}`);
    const result = await request(enabled).get(callback).set('Host', host)
      .set('Cookie', `interpreter-oidc-binding=${binding}`);
    expect(result.status).toBe(303);
    expect(result.headers.location).toBe(recoveryPath);
    expect(String(result.headers['set-cookie'])).toContain(`interpreter-enterprise-session=${session}`);
    expect(String(result.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(result.headers['set-cookie'])).toContain('SameSite=Lax');
    const normal = await request(enabled).get(`/enterprise/callback?code=normal&state=${state}`)
      .set('Host', host).set('Cookie', `interpreter-oidc-binding=${binding}`);
    expect(normal.status).toBe(303);
    expect(normal.headers.location).toBe('/settings');
    expect(calls).toEqual(['callback-disabled', 'recovery-start', 'callback-opted-in', 'callback-opted-in']);
  });
  test('production cannot opt into the plaintext test bypass at any independent seam', () => {
    const prior = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const integration = {} as OidcIntegration;
      const options = { applicationOrigin: origin, allowInsecureLoopbackForTests: true,
        verifySession: async () => null, directory: {} as ServerDirectory };
      expect(() => new OidcIntegration(config, {} as ServerDirectory)).toThrow('isolated test process');
      expect(() => createOidcHttpRouter({ config, integration, applicationOrigin: origin, successPath: '/settings' })).toThrow('isolated test process');
      expect(() => createEnterpriseBrowserRouter(options)).toThrow('isolated test process');
      expect(() => createEnterpriseAdminMutationRouter(options)).toThrow('isolated test process');
      expect(() => createEnterpriseLogoutRouter(options)).toThrow('isolated test process');
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });
  test('pins origin and tenant before issuing browser binding', async () => {
    const { app } = fixture();
    expect((await request(app).get('/organizations/org-b/login').set('Host', host)).status).toBe(403);
    expect((await request(app).get('/organizations/org-a/login').set('Host', 'untrusted.test').set('X-Forwarded-Host', host)).status).toBe(403);
    const started = await request(app).get('/organizations/org-a/login').set('Host', host);
    expect(started.status).toBe(302);
    expect(started.headers.location).toBe(`${config.authorizationEndpoint}?state=${state}`);
    expect(started.headers['set-cookie'][0]).toContain('interpreter-oidc-binding=');
    expect(started.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(started.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(started.headers['cache-control']).toBe('no-store');
  });
  test('attempt-capacity denial cannot issue a browser binding or a redirect', async () => {
    const app = express();
    app.use(createOidcHttpRouter({ config, integration: {
      begin: async () => { throw new Error('OIDC login capacity reached'); },
    } as OidcIntegration, applicationOrigin: origin, successPath: '/settings' }));
    const response = await request(app).get('/organizations/org-a/login').set('Host', host);
    expect(response.status).toBe(503);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
  });

  test('callback requires one state/code and exact bound cookie; session is cookie-only', async () => {
    const { app, completed } = fixture();
    const path = `/enterprise/callback?code=fixture-code&state=${state}`;
    for (const url of [path + `&state=${state}`, path + '&extra=1', '/enterprise/callback?code=fixture-code', '/enterprise/callback?code=fixture-code&state=short']) {
      expect((await request(app).get(url).set('Host', host).set('Cookie', `interpreter-oidc-binding=${binding}`)).status).toBe(400);
    }
    expect((await request(app).get(path).set('Host', host)).status).toBe(400);
    expect((await request(app).get(path).set('Host', host).set('Cookie', `interpreter-oidc-binding=${binding}; interpreter-oidc-binding=${binding}`)).status).toBe(400);
    expect((await request(app).get(path).set('Host', 'untrusted.test').set('X-Forwarded-Host', host).set('Cookie', `interpreter-oidc-binding=${binding}`)).status).toBe(403);
    expect(completed()).toBe(0);
    const completedResponse = await request(app).get(path).set('Host', host).set('Cookie', `interpreter-oidc-binding=${binding}`);
    expect(completedResponse.status).toBe(303);
    expect(completedResponse.headers.location).toBe('/settings');
    expect(completedResponse.headers.location).not.toContain(session);
    expect(completedResponse.headers['set-cookie'].join(';')).toContain(`interpreter-enterprise-session=${session}`);
    expect(completedResponse.headers['set-cookie'].join(';')).toContain('HttpOnly');
    expect(completedResponse.headers['set-cookie'].join(';')).toContain('SameSite=Lax');
    expect(completedResponse.text).not.toContain(session);
    expect(completed()).toBe(1);
  });

  test('absolute-form callback targets cannot override the pinned application origin', async () => {
    const { app, completed } = fixture();
    const server = app.listen(0, '127.0.0.1');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback fixture unavailable');
      const status = await new Promise<number>((resolve, reject) => {
        const call = httpRequest({ host: '127.0.0.1', port: address.port,
          path: `http://untrusted.test/enterprise/callback?code=fixture-code&state=${state}`,
          headers: { Host: host, Cookie: `interpreter-oidc-binding=${binding}` } }, (response) => {
          response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
        });
        call.on('error', reject); call.end();
      });
      expect(status).toBe(403);
      expect(completed()).toBe(0);
    } finally { server.close(); }
  });

  test('absolute-form login target cannot issue a browser binding for a foreign authority', async () => {
    let begins = 0;
    const app = express();
    app.use(createOidcHttpRouter({ config, integration: {
      begin: async () => { begins++; return { authorizationUrl: config.authorizationEndpoint, state, browserBinding: binding }; },
    } as OidcIntegration, applicationOrigin: origin, successPath: '/settings' }));
    const server = app.listen(0, '127.0.0.1');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback fixture unavailable');
      const response = await new Promise<{ status: number; cookie: string | string[] | undefined }>((resolve, reject) => {
        const call = httpRequest({ host: '127.0.0.1', port: address.port,
          path: 'http://untrusted.test/organizations/org-a/login', headers: { Host: host } }, (incoming) => {
          incoming.resume(); incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0,
            cookie: incoming.headers['set-cookie'] }));
        });
        call.on('error', reject); call.end();
      });
      expect(response.status).toBe(403);
      expect(response.cookie).toBeUndefined();
      expect(begins).toBe(0);
    } finally { server.close(); }
  });

  test('absolute-form admin read cannot consult a session under a foreign authority', async () => {
    let verified = 0;
    const app = express();
    app.use(createEnterpriseBrowserRouter({ applicationOrigin: origin, allowInsecureLoopbackForTests: true,
      verifySession: async () => { verified++; return null; }, directory: {} as ServerDirectory }));
    const server = app.listen(0, '127.0.0.1');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback fixture unavailable');
      const status = await new Promise<number>((resolve, reject) => {
        const call = httpRequest({ host: '127.0.0.1', port: address.port,
          path: 'http://untrusted.test/organizations/org-a/overview',
          headers: { Host: host, Cookie: `interpreter-enterprise-session=${session}` } }, (incoming) => {
          incoming.resume(); incoming.on('end', () => resolve(incoming.statusCode ?? 0));
        });
        call.on('error', reject); call.end();
      });
      expect(status).toBe(403);
      expect(verified).toBe(0);
    } finally { server.close(); }
  });

  test('rejects unsafe callback origins and success destinations at construction', () => {
    const integration = {} as OidcIntegration;
    for (const applicationOrigin of ['https://untrusted.test', 'http://untrusted.test', 'http://127.0.0.1:39394/path', 'http://user:secret@127.0.0.1:39394']) {
      expect(() => createOidcHttpRouter({ config, integration, applicationOrigin, successPath: '/settings' })).toThrow();
    }
    expect(() => createOidcHttpRouter({ config, integration, applicationOrigin: origin, successPath: '//untrusted.test' })).toThrow();
    for (const successPath of ['/\t/untrusted.test', '/\n/untrusted.test', '/\r/untrusted.test']) {
      expect(new URL(successPath, origin).origin).toBe('http://untrusted.test');
      expect(() => createOidcHttpRouter({ config, integration, applicationOrigin: origin, successPath })).toThrow();
    }
    expect(() => createOidcHttpRouter({ config: { ...config, allowInsecureLoopbackForTests: false }, integration, applicationOrigin: origin, successPath: '/settings' })).toThrow();
    expect(() => createOidcHttpRouter({ config: { ...config, redirectUri: 'http://user:secret@127.0.0.1:39394/enterprise/callback' },
      integration, applicationOrigin: origin, successPath: '/settings' })).toThrow();
  });

  test('forwarded HTTPS headers do not authorize a plain HTTP production callback', async () => {
    let started = 0;
    const productionConfig = { ...config, redirectUri: 'https://enterprise.example/enterprise/callback',
      allowInsecureLoopbackForTests: false, accountDomain: 'enterprise.example' };
    expect(() => createOidcHttpRouter({ config: { ...productionConfig, accountDomain: undefined },
      integration: {} as OidcIntegration, applicationOrigin: 'https://enterprise.example', successPath: '/settings' }))
      .toThrow('pinned account domain');
    expect(() => new OidcIntegration({ ...productionConfig, accountDomain: undefined,
      issuer: 'https://issuer.example/tenant', authorizationEndpoint: 'https://issuer.example/tenant/authorize',
      tokenEndpoint: 'https://issuer.example/tenant/token', jwksUri: 'https://issuer.example/tenant/keys' }, {} as ServerDirectory))
      .toThrow('pinned account domain');
    const app = express();
    app.use(createOidcHttpRouter({ config: productionConfig, integration: {
      begin: async () => { started++; throw new Error('must not run'); },
    } as OidcIntegration, applicationOrigin: 'https://enterprise.example', successPath: '/settings' }));
    const response = await request(app).get('/organizations/org-a/login').set('Host', 'enterprise.example')
      .set('X-Forwarded-Proto', 'https').set('X-Forwarded-Host', 'enterprise.example');
    expect(response.status).toBe(403);
    expect(started).toBe(0);
    expect((await request(app).get(`/enterprise/callback?code=x&state=${state}`).set('Host', 'enterprise.example')
      .set('X-Forwarded-Proto', 'https').set('Cookie', `__Host-interpreter-oidc-binding=${binding}`)).status).toBe(403);
  });

  test('browser directory API verifies HttpOnly-cookie session server-side and denies cross-tenant, cross-origin, revoked and audit failures', async () => {
    let active = true;
    let auditWorks = true;
    const app = express();
    app.use('/api/enterprise', createEnterpriseBrowserRouter({
      applicationOrigin: origin, allowInsecureLoopbackForTests: true,
      verifySession: async (token) => active && token === session
        ? { organizationId: 'org-a', issuer: config.issuer, subject: 'alice', sessionId: 'digest-only' } : null,
      directory: { recordAudit: async () => {}, recordTenantDenial: async () => {}, listAudit: async () => {
        if (!auditWorks) throw new Error('audit failure');
        return [{ organizationId: 'org-a', subject: 'alice', action: 'organization.read', outcome: 'allowed', at: '2026-11-08T00:00:00.000Z' }];
      }, readAdmin: async (_identity, view) => {
        if (!auditWorks) throw new Error('audit failure');
        return view === 'members' ? { organizationId: 'org-a', members: [] } : { organization: { id: 'org-a', name: 'Acme' } };
      } },
    }));
    const url = '/api/enterprise/organizations/org-a/overview';
    const scoped = () => request(app).get(url).set('Host', host).set('Cookie', `interpreter-enterprise-session=${session}`);
    expect((await request(app).get(url).set('Host', host)).status).toBe(401);
    expect((await scoped().set('Origin', 'http://untrusted.test')).status).toBe(403);
    expect((await scoped().set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await scoped().set('Authorization', `Bearer ${session}`)).status).toBe(403);
    expect((await request(app).get('/api/enterprise/organizations/org-b/overview').set('Host', host).set('Cookie', `interpreter-enterprise-session=${session}`)).status).toBe(403);
    const allowed = await scoped().set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');
    expect(allowed.status).toBe(200);
    expect(allowed.body.organization.name).toBe('Acme');
    expect(allowed.headers['cache-control']).toBe('no-store');
    const activity = await request(app).get('/api/enterprise/organizations/org-a/activity')
      .set('Host', host).set('Cookie', `interpreter-enterprise-session=${session}`);
    expect(activity.status).toBe(200);
    expect(activity.body).toEqual({ organizationId: 'org-a', events: [{ organizationId: 'org-a', subject: 'alice',
      action: 'organization.read', outcome: 'allowed', at: '2026-11-08T00:00:00.000Z' }] });
    expect(activity.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/api/enterprise/organizations/org-b/activity')
      .set('Host', host).set('Cookie', `interpreter-enterprise-session=${session}`)).status).toBe(403);
    active = false;
    expect((await scoped()).status).toBe(403);
    expect((await request(app).get('/api/enterprise/organizations/org-a/activity')
      .set('Host', host).set('Cookie', `interpreter-enterprise-session=${session}`)).status).toBe(403);
    active = true;
    auditWorks = false;
    expect((await scoped()).status).toBe(503);
    expect((await request(app).get('/api/enterprise/organizations/org-a/activity')
      .set('Host', host).set('Cookie', `interpreter-enterprise-session=${session}`)).status).toBe(503);
  });
});
