import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createEnterpriseBrowserRouter, createOidcHttpRouter } from './oidcHttp';
import type { OidcConfiguration, OidcIntegration } from './oidc';

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

function fixture() {
  let completed = 0;
  const integration = {
    begin: async () => ({ authorizationUrl: `${config.authorizationEndpoint}?state=fixture`, state: 'fixture', browserBinding: binding }),
    complete: async (value: { code: string; state: string; browserBinding: string }) => {
      completed++;
      if (value.code !== 'fixture-code' || value.state !== 'fixture' || value.browserBinding !== binding) throw new Error('Rejected');
      return { token: session, expiresAt: Date.now() + 60_000 };
    },
  } as OidcIntegration;
  const app = express();
  app.use(createOidcHttpRouter({ config, integration, applicationOrigin: origin, successPath: '/settings' }));
  return { app, completed: () => completed };
}

describe('unmounted HTTP boundary, deterministic local callback fixture', () => {
  test('pins origin and tenant before issuing browser binding', async () => {
    const { app } = fixture();
    expect((await request(app).get('/organizations/org-b/login').set('Host', host)).status).toBe(403);
    expect((await request(app).get('/organizations/org-a/login').set('Host', 'untrusted.test').set('X-Forwarded-Host', host)).status).toBe(403);
    const started = await request(app).get('/organizations/org-a/login').set('Host', host);
    expect(started.status).toBe(302);
    expect(started.headers.location).toBe(`${config.authorizationEndpoint}?state=fixture`);
    expect(started.headers['set-cookie'][0]).toContain('interpreter-oidc-binding=');
    expect(started.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(started.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(started.headers['cache-control']).toBe('no-store');
  });

  test('callback requires one state/code and exact bound cookie; session is cookie-only', async () => {
    const { app, completed } = fixture();
    const path = '/enterprise/callback?code=fixture-code&state=fixture';
    for (const url of [path + '&state=fixture', path + '&extra=1', '/enterprise/callback?code=fixture-code']) {
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

  test('rejects unsafe callback origins and success destinations at construction', () => {
    const integration = {} as OidcIntegration;
    for (const applicationOrigin of ['https://untrusted.test', 'http://untrusted.test', 'http://127.0.0.1:39394/path']) {
      expect(() => createOidcHttpRouter({ config, integration, applicationOrigin, successPath: '/settings' })).toThrow();
    }
    expect(() => createOidcHttpRouter({ config, integration, applicationOrigin: origin, successPath: '//untrusted.test' })).toThrow();
    expect(() => createOidcHttpRouter({ config: { ...config, allowInsecureLoopbackForTests: false }, integration, applicationOrigin: origin, successPath: '/settings' })).toThrow();
  });

  test('browser directory API verifies HttpOnly-cookie session server-side and denies cross-tenant, cross-origin, revoked and audit failures', async () => {
    let active = true;
    let auditWorks = true;
    const app = express();
    app.use('/api/enterprise', createEnterpriseBrowserRouter({
      applicationOrigin: origin, allowInsecureLoopbackForTests: true,
      verifySession: async (token) => active && token === session
        ? { organizationId: 'org-a', issuer: config.issuer, subject: 'alice', sessionId: 'digest-only' } : null,
      directory: { recordAudit: async () => {}, readAdmin: async (_identity, view) => {
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
    active = false;
    expect((await scoped()).status).toBe(403);
    active = true;
    auditWorks = false;
    expect((await scoped()).status).toBe(503);
  });
});
