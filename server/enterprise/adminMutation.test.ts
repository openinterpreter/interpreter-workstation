import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerDirectory } from './serverDirectory';
import { createEnterpriseAdminMutationRouter, createEnterpriseBrowserRouter } from './oidcHttp';

const origin = 'http://127.0.0.1:39394';
const issuer = 'https://idp.example/tenant';
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'enterprise-admin-'));
  paths.push(parent);
  const directory = new ServerDirectory(join(parent, 'private', 'directory.json'));
  await directory.bootstrap('org-a', 'Acme', issuer,
    { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
  await directory.bootstrap('org-b', 'Beta', issuer,
    { organizationId: 'org-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
  const { token: admin, identity } = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000);
  await directory.setMember(identity,
    { organizationId: 'org-a', subject: 'carol', displayName: 'Carol', role: 'member', active: true });
  const { token: member } = await directory.createSession(issuer, 'org-a', 'carol', Date.now() + 60_000);
  const app = express();
  const options = { applicationOrigin: origin, allowInsecureLoopbackForTests: true,
    verifySession: (token: string) => directory.verifySession(token), directory };
  app.use('/api/enterprise', createEnterpriseBrowserRouter(options));
  app.use('/api/enterprise', createEnterpriseAdminMutationRouter(options));
  const path = '/api/enterprise/organizations/org-a/members/carol/deactivate';
  const post = (url = path, token = admin) => request(app).post(url).set('Host', '127.0.0.1:39394')
    .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').set('X-Interpreter-CSRF', '1')
    .set('Cookie', `interpreter-enterprise-session=${token}`).set('Content-Type', 'application/json').send({});
  return { directory, app, admin, member, identity, path, post };
}

describe('unmounted same-origin member deactivation', () => {
  test('parallel dashboard reads serialize without losing any audit event', async () => {
    const { directory, app, admin } = await fixture();
    const before = await directory.auditSummary('org-a');
    const urls = ['overview', 'members', 'overview', 'members'];
    const responses = await Promise.all(urls.map((view) => request(app)
      .get(`/api/enterprise/organizations/org-a/${view}`)
      .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${admin}`)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect((await directory.auditSummary('org-a')).eventCount).toBe(before.eventCount + 4);
  });

  test('admin deactivation atomically revokes member sessions and records scoped audit', async () => {
    const { directory, app, admin, member, post } = await fixture();
    expect((await post()).status).toBe(204);
    expect(await directory.verifySession(member)).toBeNull();
    expect((await directory.getMember('org-a', 'carol'))?.active).toBe(false);
    const overview = await request(app).get('/api/enterprise/organizations/org-a/overview')
      .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${admin}`);
    expect(overview.status).toBe(200);
    expect(overview.body.users).toMatchObject({ total: 2, active: 1, admins: 1 });
    expect((await directory.listAudit((await directory.verifySession(admin))!)).some((event) =>
      event.action === 'organization.member.deactivate' && event.subject === 'alice')).toBe(true);
  });

  test('rejects CSRF, cross-tenant, member actor, last admin and replay without mutation', async () => {
    const { directory, member, admin, identity, post, path } = await fixture();
    expect((await post().unset('Origin')).status).toBe(403);
    expect((await post().unset('X-Interpreter-CSRF')).status).toBe(403);
    expect((await post().set('Origin', 'http://untrusted.test')).status).toBe(403);
    expect((await post().set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await post().send({ active: true })).status).toBe(403);
    expect((await post(path, member)).status).toBe(403);
    expect((await post('/api/enterprise/organizations/org-b/members/bob/deactivate')).status).toBe(403);
    expect((await post('/api/enterprise/organizations/org-a/members/alice/deactivate')).status).toBe(403);
    expect((await directory.getMember('org-a', 'carol'))?.active).toBe(true);
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(403);
    await directory.revokeSession(identity);
    expect((await post(path, admin)).status).toBe(403);
    expect((await directory.getMember('org-b', 'bob'))?.active).toBe(true);
  });

  test('directory outage fails closed before any successful response', async () => {
    const { directory, post } = await fixture();
    const original = directory.deactivateMember.bind(directory);
    directory.deactivateMember = async () => { throw new Error('storage unavailable'); };
    expect((await post()).status).toBe(503);
    directory.deactivateMember = original;
    expect((await directory.getMember('org-a', 'carol'))?.active).toBe(true);
  });
});
