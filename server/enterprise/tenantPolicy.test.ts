import { describe, expect, test } from 'bun:test';
import { evaluateTenantPolicy, type TenantAction } from './tenantPolicy';
import type { VerifiedIdentity, OrganizationMember } from './controlPlane';

const identity: VerifiedIdentity = { organizationId: 'org-a', issuer: 'https://idp.example/tenant-a', subject: 'alice', sessionId: 'opaque-hash' };
const member: OrganizationMember = { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true };
const base = { identity, organizationId: 'org-a', issuer: identity.issuer, member, sessionActive: true, action: 'organization.read' as TenantAction };

describe('server-owned tenant-policy seam, not an enabled execution policy', () => {
  test('only current administrator directory actions are permitted', () => {
    for (const action of ['organization.read', 'audit.read', 'member.manage'] as const) {
      expect(evaluateTenantPolicy({ ...base, action })).toBe(true);
    }
    for (const action of ['agent.execute', 'tool.invoke', 'scim.provision'] as const) {
      expect(evaluateTenantPolicy({ ...base, action })).toBe(false);
    }
    for (const action of ['agent.execute', 'tool.invoke', 'simple.execute'] as const) {
      expect(evaluateTenantPolicy({ ...base, action, workspaceActive: true, runtimeGrant: true })).toBe(true);
      expect(evaluateTenantPolicy({ ...base, action, workspaceActive: false, runtimeGrant: true })).toBe(false);
      expect(evaluateTenantPolicy({ ...base, action, workspaceActive: true, runtimeGrant: false })).toBe(false);
      expect(evaluateTenantPolicy({ ...base, member: { ...member, role: 'member' }, action,
        workspaceActive: true, runtimeGrant: true })).toBe(true);
    }
    expect(evaluateTenantPolicy({ ...base, action: 'scim.provision', workspaceActive: true, runtimeGrant: true })).toBe(false);
  });

  test('never grants from client group claims or cross-tenant/issuer/session substitution', () => {
    for (const changed of [
      { identity: { ...identity, organizationId: 'org-b' } },
      { identity: { ...identity, issuer: 'https://idp.example/tenant-b' } },
      { identity: { ...identity, sessionId: '' } },
      { member: { ...member, organizationId: 'org-b' } },
      { member: { ...member, subject: 'another' } },
      { member: { ...member, role: 'member' as const } },
      { member: { ...member, active: false } },
      { sessionActive: false },
      { issuer: 'https://idp.example/tenant-b' },
    ]) expect(evaluateTenantPolicy({ ...base, ...changed })).toBe(false);
    // Unknown actions do not gain authority by runtime casting or an IdP group.
    expect(evaluateTenantPolicy({ ...base, action: 'scim.groups.admin' as TenantAction })).toBe(false);
  });
});
