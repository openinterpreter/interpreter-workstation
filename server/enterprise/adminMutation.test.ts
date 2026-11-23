import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerDirectory } from './serverDirectory';
import { createEnterpriseAdminMutationRouter, createEnterpriseBrowserRouter, createEnterpriseLogoutRouter } from './oidcHttp';

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
  app.use('/api/enterprise', createEnterpriseLogoutRouter(options));
  const path = '/api/enterprise/organizations/org-a/members/carol/deactivate';
  const post = (url = path, token = admin) => request(app).post(url).set('Host', '127.0.0.1:39394')
    .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').set('X-Interpreter-CSRF', '1')
    .set('Cookie', `interpreter-enterprise-session=${token}`).set('Content-Type', 'application/json').send({});
  return { directory, app, admin, member, identity, path, post };
}

describe('unmounted same-origin member deactivation', () => {
  test('active member and last-admin mutation denials commit to the actor tenant only', async () => {
    const { directory, admin, member, identity, path, post } = await fixture();
    const before = (await directory.auditSummary('org-a')).eventCount;
    const foreign = (await directory.auditSummary('org-b')).eventCount;
    expect((await post(path, member)).status).toBe(403);
    expect((await post('/api/enterprise/organizations/org-a/members/alice/deactivate', admin)).status).toBe(403);
    expect((await post('/api/enterprise/organizations/org-a/members/alice/revoke-sessions', admin)).status).toBe(403);
    expect((await directory.auditSummary('org-a')).eventCount).toBe(before + 3);
    expect((await directory.auditSummary('org-b')).eventCount).toBe(foreign);
    const events = await directory.listAudit(identity);
    expect(events.slice(-3).map((event) => [event.subject, event.targetSubject, event.outcome]))
      .toEqual([['carol', 'carol', 'denied'], ['alice', 'alice', 'denied'], ['alice', 'alice', 'denied']]);
    await directory.revokeSession(identity);
    const after = (await directory.auditSummary('org-a')).eventCount;
    expect((await post(path, admin)).status).toBe(403);
    expect((await directory.auditSummary('org-a')).eventCount).toBe(after);
  });
  test('cross-tenant admin URL probes are denied and audited only to an active actor tenant', async () => {
    const { directory, app, admin, identity, post } = await fixture();
    const before = (await directory.auditSummary('org-a')).eventCount;
    const foreignBefore = (await directory.auditSummary('org-b')).eventCount;
    for (const path of ['overview', 'activity', 'activity/export']) {
      expect((await request(app).get(`/api/enterprise/organizations/org-b/${path}`)
        .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${admin}`)).status).toBe(403);
    }
    for (const path of ['members/bob/deactivate', 'members/bob/revoke-sessions', 'session/logout']) {
      expect((await post(`/api/enterprise/organizations/org-b/${path}`)).status).toBe(403);
    }
    expect((await directory.auditSummary('org-a')).eventCount).toBe(before + 6);
    expect((await directory.auditSummary('org-b')).eventCount).toBe(foreignBefore);
    const scoped = await directory.listAudit(identity);
    expect(scoped.slice(-6).map((event) => [event.organizationId, event.targetOrganizationId, event.outcome]))
      .toEqual(Array.from({ length: 6 }, () => ['org-a', 'org-b', 'denied']));
    await expect(directory.recordTenantDenial({ ...identity, organizationId: 'org-b' }, 'org-a', 'overview'))
      .rejects.toThrow('Access denied');
    await directory.revokeSession(identity);
    const after = (await directory.auditSummary('org-a')).eventCount;
    expect((await request(app).get('/api/enterprise/organizations/org-b/overview')
      .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${admin}`)).status).toBe(403);
    expect((await directory.auditSummary('org-a')).eventCount).toBe(after);
  });
  test('full audit export is tenant-scoped, attachment-only and committed before download', async () => {
    const { directory, app, admin, member } = await fixture();
    const url = '/api/enterprise/organizations/org-a/activity/export';
    const get = (path: string, token: string) => request(app).get(path)
      .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
    const before = (await directory.auditSummary('org-a')).eventCount;
    expect((await get(url, member)).status).toBe(403);
    expect((await get('/api/enterprise/organizations/org-b/activity/export', admin)).status).toBe(403);
    expect((await get(url, admin).set('Origin', 'http://untrusted.test')).status).toBe(403);
    expect((await get(url, admin).set('Authorization', `Bearer ${admin}`)).status).toBe(403);
    const downloaded = await get(url, admin);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-disposition']).toBe('attachment; filename="organization-audit.json"');
    expect(downloaded.headers['cache-control']).toBe('no-store');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(downloaded.body.organizationId).toBe('org-a');
    expect(downloaded.body.events).toHaveLength(before + 2); // Member and cross-tenant denials commit before export.
    expect(downloaded.body.events.every((event: { organizationId: string }) => event.organizationId === 'org-a')).toBe(true);
    expect((await directory.auditSummary('org-a')).eventCount).toBe(before + 3);
    const again = await get(url, admin);
    expect(again.body.events.at(-1)).toMatchObject({ action: 'organization.audit.export', outcome: 'allowed' });
    await directory.revokeSession((await directory.verifySession(admin))!);
    expect((await get(url, admin)).status).toBe(403);
  });
  test('admin ends all existing member sessions atomically without deactivating membership', async () => {
    const { directory, admin, member, post } = await fixture();
    const second = await directory.createSession(issuer, 'org-a', 'carol', Date.now() + 60_000);
    const before = await directory.auditSummary('org-a');
    const path = '/api/enterprise/organizations/org-a/members/carol/revoke-sessions';
    expect((await post(path).unset('Origin')).status).toBe(403);
    expect((await post(path).unset('X-Interpreter-CSRF')).status).toBe(403);
    expect((await post(path, member)).status).toBe(403);
    expect((await post('/api/enterprise/organizations/org-b/members/bob/revoke-sessions')).status).toBe(403);
    expect((await post('/api/enterprise/organizations/org-a/members/alice/revoke-sessions')).status).toBe(403);
    expect((await post(path)).status).toBe(204);
    expect(await directory.verifySession(member)).toBeNull();
    expect(await directory.verifySession(second.token)).toBeNull();
    expect(await directory.verifySession(admin)).not.toBeNull();
    expect((await directory.getMember('org-a', 'carol'))?.active).toBe(true);
    expect((await directory.auditSummary('org-a')).eventCount).toBe(before.eventCount + 4); // Three denied attempts and the successful kill.
    expect((await directory.listAudit((await directory.verifySession(admin))!)).some((event) =>
      event.action === 'organization.member.sessions.revoke' && event.subject === 'alice' && event.targetSubject === 'carol')).toBe(true);
    const newLogin = await directory.createSession(issuer, 'org-a', 'carol', Date.now() + 60_000);
    expect(await directory.verifySession(newLogin.token)).not.toBeNull(); // Session kill is not deprovisioning.
  });

  test('session-kill audit outage cannot report success or revoke any session', async () => {
    const { directory, member, post } = await fixture();
    const original = directory.revokeMemberSessions.bind(directory);
    directory.revokeMemberSessions = async () => { throw new Error('audit unavailable'); };
    expect((await post('/api/enterprise/organizations/org-a/members/carol/revoke-sessions')).status).toBe(503);
    directory.revokeMemberSessions = original;
    expect(await directory.verifySession(member)).not.toBeNull();
  });
  test('organization-wide kill is admin-only, tenant-scoped, audited and ends its own caller session', async () => {
    const { directory, app, admin, member, identity, post } = await fixture();
    const second = await directory.createSession(issuer, 'org-a', 'carol', Date.now() + 60_000);
    const foreign = await directory.createSession(issuer, 'org-b', 'bob', Date.now() + 60_000);
    const path = '/api/enterprise/organizations/org-a/sessions/revoke-all';
    const before = (await directory.auditSummary('org-a')).eventCount;
    const foreignBefore = (await directory.auditSummary('org-b')).eventCount;
    expect((await post(path).unset('Origin')).status).toBe(403);
    expect((await post(path).unset('X-Interpreter-CSRF')).status).toBe(403);
    expect((await post(path).send({ organizationId: 'org-b' })).status).toBe(403);
    expect((await post(path, member)).status).toBe(403);
    expect((await post('/api/enterprise/organizations/org-b/sessions/revoke-all')).status).toBe(403);
    expect((await directory.auditSummary('org-a')).eventCount).toBe(before + 2);
    const committed = await post(path);
    expect(committed.status).toBe(204);
    expect(committed.headers['set-cookie'][0]).toContain('interpreter-enterprise-session=;');
    expect(await directory.verifySession(admin)).toBeNull();
    expect(await directory.verifySession(member)).toBeNull();
    expect(await directory.verifySession(second.token)).toBeNull();
    expect(await directory.verifySession(foreign.token)).not.toBeNull();
    expect((await directory.getMember('org-a', 'carol'))?.active).toBe(true);
    expect((await directory.auditSummary('org-a')).eventCount).toBe(before + 3);
    expect((await directory.auditSummary('org-b')).eventCount).toBe(foreignBefore);
    expect((await post(path)).status).toBe(403);
    expect((await request(app).get('/api/enterprise/organizations/org-a/overview')
      .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${admin}`)).status).toBe(403);
    await expect(directory.revokeOrganizationSessions(identity)).rejects.toThrow('Access denied');
    const fresh = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000, 1);
    const events = await directory.listAudit(fresh.identity);
    expect(events.filter((event) => event.action.includes('revoke-all')).map((event) => [event.action, event.outcome])).toEqual([
      ['organization.sessions.revoke-all', 'denied'],
      ['organization.revoke-all-sessions.cross-tenant', 'denied'],
      ['organization.sessions.revoke-all', 'allowed'],
    ]);
  });
  test('organization-wide kill storage outage leaves every session and cookie intact', async () => {
    const { directory, admin, member, post } = await fixture();
    const original = directory.revokeOrganizationSessions.bind(directory);
    directory.revokeOrganizationSessions = async () => { throw new Error('audit unavailable'); };
    const response = await post('/api/enterprise/organizations/org-a/sessions/revoke-all');
    expect(response.status).toBe(503);
    expect(response.headers['set-cookie']).toBeUndefined();
    directory.revokeOrganizationSessions = original;
    expect(await directory.verifySession(admin)).not.toBeNull();
    expect(await directory.verifySession(member)).not.toBeNull();
  });
  test('self logout durably revokes only this tenant session and clears the cookie after the audit commits', async () => {
    const { directory, admin, member, post } = await fixture();
    const logout = '/api/enterprise/organizations/org-a/session/logout';
    const before = await directory.auditSummary('org-a');
    expect((await post(logout).unset('Origin')).status).toBe(403);
    expect((await post(logout).unset('X-Interpreter-CSRF')).status).toBe(403);
    expect((await post(logout).set('Origin', 'http://untrusted.test')).status).toBe(403);
    expect((await post('/api/enterprise/organizations/org-b/session/logout')).status).toBe(403);
    expect((await post(logout).send({ subject: 'carol' })).status).toBe(403);
    expect((await post(logout, '').unset('Cookie')).status).toBe(401);
    const confirmed = await post(logout);
    expect(confirmed.status).toBe(204);
    expect(confirmed.headers['set-cookie'][0]).toContain('interpreter-enterprise-session=;');
    expect(await directory.verifySession(admin)).toBeNull();
    expect(await directory.verifySession(member)).not.toBeNull();
    expect((await directory.auditSummary('org-a')).eventCount).toBe(before.eventCount + 2); // Foreign-target denial and logout.
    expect((await post(logout)).status).toBe(403);
  });

  test('logout storage outage does not clear the cookie or claim revocation', async () => {
    const { directory, admin, post } = await fixture();
    const original = directory.revokeSession.bind(directory);
    directory.revokeSession = async () => { throw new Error('storage unavailable'); };
    const result = await post('/api/enterprise/organizations/org-a/session/logout');
    expect(result.status).toBe(503);
    expect(result.headers['set-cookie']).toBeUndefined();
    directory.revokeSession = original;
    expect(await directory.verifySession(admin)).not.toBeNull();
  });
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
      event.action === 'organization.member.deactivate' && event.subject === 'alice' && event.targetSubject === 'carol')).toBe(true);
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
