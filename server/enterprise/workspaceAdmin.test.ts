import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountEnterpriseAdminRoutes } from './adminMount';
import { ServerDirectory } from './serverDirectory';

const origin = 'http://127.0.0.1:39394';
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('unmounted workspace administration registry', () => {
  test('default route absent; opt-in audit, role, tenant and revocation are server-owned', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'enterprise-workspaces-'));
    paths.push(parent);
    const directory = new ServerDirectory(join(parent, 'private', 'directory.json'));
    const issuer = 'https://issuer.invalid/fixture';
    await directory.bootstrap('org-a', 'Alpha', issuer,
      { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
    await directory.bootstrap('org-b', 'Beta', issuer,
      { organizationId: 'org-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
    const admin = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000);
    await directory.setMember(admin.identity,
      { organizationId: 'org-a', subject: 'carol', displayName: 'Carol', role: 'member', active: true });
    const member = await directory.createSession(issuer, 'org-a', 'carol', Date.now() + 60_000);
    const other = await directory.createSession(issuer, 'org-b', 'bob', Date.now() + 60_000);
    const options = { enabled: true as const, applicationOrigin: origin, allowInsecureLoopbackForTests: true,
      organizationId: 'org-a', issuer, directory, verifySession: (token: string) => directory.verifySession(token) };
    const absent = express();
    expect(mountEnterpriseAdminRoutes(absent, options)).toBe(true);
    expect((await request(absent).get('/api/enterprise/organizations/org-a/workspaces')
      .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${admin.token}`)).status).toBe(404);
    const app = express();
    expect(mountEnterpriseAdminRoutes(app, { ...options, enableWorkspaceAdministration: true })).toBe(true);
    const path = '/api/enterprise/organizations/org-a/workspaces';
    const get = (url: string, token = admin.token) => request(app).get(url)
      .set('Host', '127.0.0.1:39394').set('Cookie', `interpreter-enterprise-session=${token}`);
    const post = (url: string, body: object, token = admin.token) => request(app).post(url)
      .set('Host', '127.0.0.1:39394').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin')
      .set('X-Interpreter-CSRF', '1').set('Cookie', `interpreter-enterprise-session=${token}`)
      .set('Content-Type', 'application/json').send(body);
    expect((await get(path)).body).toEqual({ organizationId: 'org-a', workspaces: [] });
    expect((await post(path, { id: 'research', name: 'Research' }).unset('Origin')).status).toBe(403);
    expect((await post(path, { id: 'research', name: 'Research' }, member.token)).status).toBe(403);
    expect((await post('/api/enterprise/organizations/org-b/workspaces', { id: 'research', name: 'Research' })).status).toBe(403);
    expect((await post(path, { id: 'research', name: 'Research' })).status).toBe(204);
    expect((await post(path, { id: 'research', name: 'Duplicate' })).status).toBe(403);
    expect((await get(path)).body.workspaces).toEqual([{ id: 'research', name: 'Research', active: true }]);
    expect((await get(path, member.token)).status).toBe(403);
    expect((await get('/api/enterprise/organizations/org-b/workspaces')).status).toBe(403);
    expect((await get(path, other.token)).status).toBe(403);
    const grants = `${path}/research/grants`;
    expect((await get(grants)).body).toEqual({ organizationId: 'org-a', workspaceId: 'research', grants: [] });
    expect((await get(grants, member.token)).status).toBe(403);
    expect((await get('/api/enterprise/organizations/org-b/workspaces/research/grants')).status).toBe(403);
    expect((await post(grants, { subject: 'carol', action: 'tool.invoke', granted: true }, member.token)).status).toBe(403);
    expect((await post(grants, { subject: 'bob', action: 'tool.invoke', granted: true })).status).toBe(403);
    expect((await post(grants, { subject: 'carol', action: 'tool.invoke', granted: true }).unset('X-Interpreter-CSRF')).status).toBe(403);
    expect((await post(grants, { subject: 'carol', action: 'scim.provision', granted: true })).status).toBe(403);
    expect((await post(grants, { subject: 'carol', action: 'tool.invoke', granted: true })).status).toBe(204);
    expect((await get(grants)).body.grants).toEqual([{ subject: 'carol', actions: ['tool.invoke'] }]);
    expect(await directory.authorizeRuntime(member.identity, 'tool.invoke', 'research')).toBe(true);
    expect((await post(grants, { subject: 'carol', action: 'tool.invoke', granted: true })).status).toBe(403);
    expect((await post(grants, { subject: 'carol', action: 'tool.invoke', granted: false })).status).toBe(204);
    expect((await get(grants)).body.grants).toEqual([]);
    expect(await directory.authorizeRuntime(member.identity, 'tool.invoke', 'research')).toBe(false);
    expect((await post(grants, { subject: 'carol', action: 'tool.invoke', granted: true })).status).toBe(204);
    expect((await post(`${path}/research/deactivate`, {})).status).toBe(204);
    expect((await get(path)).body.workspaces).toEqual([{ id: 'research', name: 'Research', active: false }]);
    expect((await get(grants)).status).toBe(403);
    expect(await directory.authorizeRuntime(member.identity, 'tool.invoke', 'research')).toBe(false);
    expect((await post(`${path}/research/deactivate`, {})).status).toBe(403);
    expect((await directory.listWorkspaces(other.identity)).length).toBe(0);
    const events = await directory.listAudit(admin.identity);
    expect(events.some((event) => event.targetWorkspaceId === 'research' && event.action === 'organization.workspace.create' && event.outcome === 'allowed')).toBe(true);
    expect(events.some((event) => event.targetDigest === `organization:${createHash('sha256').update('org-b').digest('hex').slice(0, 16)}` &&
      event.targetOrganizationId === undefined && event.action === 'organization.workspace.read.cross-tenant')).toBe(true);
    await directory.revokeSession(admin.identity);
    expect((await get(path)).status).toBe(403);
    expect((await post(path, { id: 'after', name: 'After' })).status).toBe(403);
    expect((await directory.listWorkspaces(other.identity)).length).toBe(0);
  });
});
