import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'bun:test';
import { createEnterpriseControlPlane, ENTERPRISE_READINESS, type EnterpriseDependencies, type VerifiedIdentity } from './controlPlane';

const alice: VerifiedIdentity = { issuer: 'http://127.0.0.1/mock-idp', subject: 'alice', organizationId: 'org-a', sessionId: 'session-a' };

function fixture(overrides: Partial<EnterpriseDependencies> = {}) {
  let active = true;
  const audit: Array<{ action: string; outcome: string; organizationId: string }> = [];
  const deps: EnterpriseDependencies = {
    verifyBearer: async (token) => token === 'local-fixture-token' ? alice : null,
    directory: {
      readAdmin: async (identity, view) => {
        const allowed = active && identity.organizationId === 'org-a' && identity.subject === 'alice';
        audit.push({ organizationId: identity.organizationId, subject: identity.subject, action: `organization.${view}.read`, outcome: allowed ? 'allowed' : 'denied' });
        return allowed ? view === 'members'
          ? { organizationId: 'org-a', members: [{ subject: 'alice', displayName: 'Alice', role: 'admin', active: true }] }
          : { organization: { id: 'org-a', name: 'Acme' } } : null;
      },
      recordAudit: async (event) => { audit.push(event); },
    },
    ...overrides,
  };
  const app = express();
  app.use(createEnterpriseControlPlane(deps));
  return { app, audit, revoke: () => { active = false; } };
}

describe('enterprise control-plane boundary (mock IdP only)', () => {
  test('shipped readiness is explicitly unavailable', () => {
    expect(ENTERPRISE_READINESS.available).toBe(false);
    expect(ENTERPRISE_READINESS.provisioning).toBe('not available');
  });

  test('admits only verified, active organization admin and audits the read', async () => {
    const { app, audit } = fixture();
    const response = await request(app).get('/organizations/org-a/members').set('Authorization', 'Bearer local-fixture-token');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.members).toEqual([{ subject: 'alice', displayName: 'Alice', role: 'admin', active: true }]);
    expect(audit).toEqual([{ organizationId: 'org-a', subject: 'alice', action: 'organization.members.read', outcome: 'allowed' }]);
  });

  test('rejects missing/forged bearer and cross-tenant request, even with trusted admin', async () => {
    const { app, audit } = fixture();
    for (const [path, token, status] of [
      ['/organizations/org-a/members', '', 401],
      ['/organizations/org-a/members', 'Bearer fabricated', 403],
      ['/organizations/org-b/members', 'Bearer local-fixture-token', 403],
    ] as const) {
      const response = await request(app).get(path).set('Authorization', token);
      expect(response.status).toBe(status);
      expect(response.body.members).toBeUndefined();
    }
    expect(audit).toEqual([]);
  });

  test('revocation and role removal deny immediately and are audited', async () => {
    const fixtureA = fixture();
    fixtureA.revoke();
    const revoked = await request(fixtureA.app).get('/organizations/org-a/members').set('Authorization', 'Bearer local-fixture-token');
    expect(revoked.status).toBe(403);
    expect(fixtureA.audit[0]?.outcome).toBe('denied');

    const fixtureB = fixture({ directory: {
      readAdmin: async () => null,
      recordAudit: async () => {},
    } });
    expect((await request(fixtureB.app).get('/organizations/org-a/members').set('Authorization', 'Bearer local-fixture-token')).status).toBe(403);
  });

  test('audit outage fails closed without disclosing members or secrets', async () => {
    const baseline = fixture();
    const broken = fixture({ directory: { ...baselineDirectory(), readAdmin: async () => { throw new Error('secret fixture detail'); } } });
    const response = await request(broken.app).get('/organizations/org-a/members').set('Authorization', 'Bearer local-fixture-token');
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  test('rejects faulty directory returning a member from another organization', async () => {
    const app = fixture({ directory: {
      ...baselineDirectory(),
      readAdmin: async () => { throw new Error('Cross-tenant directory records'); },
    } }).app;
    const response = await request(app).get('/organizations/org-a/members').set('Authorization', 'Bearer local-fixture-token');
    expect(response.status).toBe(503);
    expect(response.body.members).toBeUndefined();
  });
});

function baselineDirectory(): EnterpriseDependencies['directory'] {
  return {
    readAdmin: async () => ({ organizationId: 'org-a', members: [{ subject: 'alice', displayName: 'Alice', role: 'admin', active: true }] }),
    recordAudit: async () => {},
  };
}
