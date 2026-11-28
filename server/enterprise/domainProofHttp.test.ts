import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountEnterpriseAdminRoutes } from './adminMount';
import { ServerDirectory } from './serverDirectory';

const origin = 'http://127.0.0.1:39394';
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'enterprise-domain-http-'));
  paths.push(parent);
  const file = join(parent, 'private', 'directory.json');
  let answer: string[][] = [];
  let outage = false;
  const queries: string[] = [];
  const directory = new ServerDirectory(file, async (name) => {
    queries.push(name);
    if (outage) throw new Error('Synthetic DNS outage');
    return answer;
  });
  await directory.bootstrap('org-a', 'Alpha', 'https://idp.example/a',
    { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
  await directory.bootstrap('org-b', 'Beta', 'https://idp.example/b',
    { organizationId: 'org-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
  const { token: admin, identity } = await directory.createSession('https://idp.example/a', 'org-a', 'alice', Date.now() + 60_000);
  const { token: foreign } = await directory.createSession('https://idp.example/b', 'org-b', 'bob', Date.now() + 60_000);
  await directory.setMember(identity,
    { organizationId: 'org-a', subject: 'carol', displayName: 'Carol', role: 'member', active: true });
  const { token: member } = await directory.createSession('https://idp.example/a', 'org-a', 'carol', Date.now() + 60_000);
  const app = express();
  const options = { enabled: true as const, enableDomainSetup: true, applicationOrigin: origin,
    organizationId: 'org-a', issuer: 'https://idp.example/a', allowInsecureLoopbackForTests: true,
    verifySession: (token: string) => directory.verifySession(token), directory };
  const post = (action: 'challenge' | 'verify', token: string, organizationId = 'org-a') => request(app)
    .post(`/api/enterprise/organizations/${organizationId}/domains/${action}`)
    .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
    .set('X-Interpreter-CSRF', '1').set('Content-Type', 'application/json')
    .set('Cookie', `interpreter-enterprise-session=${token}`).send({ domain: 'example.test' });
  const status = (token: string, organizationId = 'org-a') => request(app)
    .get(`/api/enterprise/organizations/${organizationId}/domains/status?domain=example.test`)
    .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
  return { app, options, post, status, directory, file, queries, admin, member, foreign, identity,
    dns: (records: string[][]) => { answer = records; }, outage: (value: boolean) => { outage = value; } };
}

describe('separately opted-in unmounted domain setup HTTP boundary', () => {
  test('default mount has no domain API; explicit setup binds one admin, issuer and real session', async () => {
    const { app, options, post, status, directory, file, queries, admin, member, foreign, identity, dns } = await fixture();
    expect(mountEnterpriseAdminRoutes(app)).toBe(false);
    expect((await post('challenge', admin)).status).toBe(404);
    expect((await status(admin)).status).toBe(404);
    expect(mountEnterpriseAdminRoutes(app, { ...options, enableDomainSetup: false })).toBe(true);
    expect((await post('challenge', admin)).status).toBe(404);
    expect((await status(admin)).status).toBe(404);
    expect(mountEnterpriseAdminRoutes(app, options)).toBe(true);
    expect((await post('challenge', member)).status).toBe(403);
    expect((await post('verify', member)).status).toBe(403);
    expect(queries).toEqual([]);
    expect((await post('challenge', foreign)).status).toBe(403);
    expect((await post('challenge', admin, 'org-b')).status).toBe(403);
    const challenge = await post('challenge', admin);
    expect(challenge.status).toBe(200);
    expect(challenge.headers['cache-control']).toBe('no-store');
    expect(challenge.body).toMatchObject({ name: '_interpreter-workstation.example.test' });
    expect(challenge.body.value).toMatch(/^interpreter-workstation-verification=[A-Za-z0-9_-]{43}$/);
    expect(await readFile(file, 'utf8')).not.toContain(challenge.body.value.split('=')[1]);
    dns([[challenge.body.value]]);
    expect((await post('verify', admin)).status).toBe(204);
    expect(queries).toEqual(['_interpreter-workstation.example.test']);
    expect(await directory.domainVerified('org-a', identity.issuer, 'example.test')).toBe(true);
    expect(await directory.domainVerified('org-b', 'https://idp.example/b', 'example.test')).toBe(false);
    const events = await directory.listAudit(identity);
    expect(events.some((event) => event.action === 'organization.domain.challenge.cross-tenant' &&
      event.targetDigest === `organization:${createHash('sha256').update('org-b').digest('hex').slice(0, 16)}` &&
      event.targetOrganizationId === undefined && event.outcome === 'denied')).toBe(true);
    const deniedDomain = `domain:${createHash('sha256').update('example.test').digest('hex').slice(0, 16)}`;
    expect(events.filter((event) => event.targetDigest === deniedDomain)
      .map((event) => [event.action, event.outcome, event.count])).toEqual([
        ['organization.domain.challenge', 'denied', 1], ['organization.domain.verify', 'denied', 1],
      ]);
    expect(events.filter((event) => event.targetDomain === 'example.test')
      .map((event) => [event.outcome, event.targetDomain])).toEqual([
        ['allowed', 'example.test'], ['allowed', 'example.test'],
      ]);
    expect((await status(member)).status).toBe(403);
    expect((await status(admin, 'org-b')).status).toBe(403);
    expect((await status(foreign)).status).toBe(403);
    expect((await status(admin).query({ domain: 'other.test' })).status).toBe(403); // Duplicate parameter.
    const observed = await status(admin);
    expect(observed.status).toBe(200);
    expect(observed.headers['cache-control']).toBe('no-store');
    expect(observed.body).toMatchObject({ domain: 'example.test', challengeExpiresAt: expect.any(Number),
      verifiedUntil: expect.any(Number) });
    expect(JSON.stringify(observed.body)).not.toContain(challenge.body.value.split('=')[1]);
  });

  test('CSRF, host, cookie, request shape, role loss and DNS outage fail closed without enabling SSO', async () => {
    const { app, options, post, status, directory, admin, identity, dns, outage, queries } = await fixture();
    mountEnterpriseAdminRoutes(app, options);
    expect((await post('challenge', admin).unset('Origin')).status).toBe(403);
    expect((await post('challenge', admin).unset('X-Interpreter-CSRF')).status).toBe(403);
    expect((await post('challenge', admin).set('Host', 'untrusted.test')).status).toBe(403);
    expect((await post('challenge', admin).set('Authorization', `Bearer ${admin}`)).status).toBe(403);
    expect((await post('challenge', admin).send({ domain: 'example.test', organizationId: 'org-b' })).status).toBe(403);
    expect((await post('challenge', admin).set('Cookie', `interpreter-enterprise-session=${admin}; interpreter-enterprise-session=${admin}`)).status).toBe(401);
    expect(queries).toEqual([]);
    const challenge = await post('challenge', admin);
    expect(challenge.status).toBe(200);
    dns([[challenge.body.value]]);
    outage(true);
    expect((await post('verify', admin)).status).toBe(503);
    expect(await directory.domainVerified('org-a', identity.issuer, 'example.test')).toBe(false);
    outage(false);
    await directory.revokeSession(identity);
    expect((await post('verify', admin)).status).toBe(403);
    expect((await status(admin)).status).toBe(403);
    expect(queries).toEqual(['_interpreter-workstation.example.test']);
    expect((await request(app).get('/organizations/org-a/login')).status).toBe(404); // Never mounts OIDC.
  });
});
