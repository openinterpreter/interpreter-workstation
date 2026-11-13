import { describe, expect, test } from 'bun:test';
import { createTenantDiscovery, projectScimUser } from './identityBoundary';

const alpha = { organizationId: 'org-a', domain: 'alpha.example', issuer: 'https://idp.example/alpha',
  callbackUri: 'https://enterprise.example/enterprise/callback' };
const beta = { organizationId: 'org-b', domain: 'beta.example', issuer: 'https://idp.example/beta',
  callbackUri: 'https://enterprise.example/enterprise/callback' };

describe('unmounted discovery and provisioning projections', () => {
  test('exact configured domains give only discovery hints, never role or session authority', () => {
    const hint = createTenantDiscovery([alpha, beta], 'https://enterprise.example');
    expect(hint('Alice@ALPHA.EXAMPLE')).toEqual({ organizationId: 'org-a', issuer: alpha.issuer, callbackUri: alpha.callbackUri });
    expect(hint('alice@sub.alpha.example')).toBeNull();
    expect(hint('alice@notalpha.example')).toBeNull();
    expect(hint('alice@beta.example')).toMatchObject({ organizationId: 'org-b', issuer: beta.issuer });
    expect(hint('alice@@alpha.example')).toBeNull();
    expect(hint('alice@alpha.example ')).toBeNull();
    expect(JSON.stringify(hint('alice@alpha.example'))).not.toContain('role');
  });

  test('duplicate, wildcard, credentialed callback and unpinned origin fail at configuration time', () => {
    for (const bindings of [
      [alpha, { ...beta, domain: 'alpha.example' }],
      [{ ...alpha, domain: '*.example' }],
      [{ ...alpha, callbackUri: 'https://user:pass@enterprise.example/enterprise/callback' }],
      [{ ...alpha, callbackUri: 'https://another.example/enterprise/callback' }],
      [{ ...alpha, issuer: 'http://idp.example/alpha' }],
    ]) expect(() => createTenantDiscovery(bindings, 'https://enterprise.example')).toThrow();
    expect(() => createTenantDiscovery([alpha], 'http://enterprise.example')).toThrow();
  });

  test('SCIM-shaped input cannot cross tenant or promote upstream groups to admin', () => {
    const base = { organizationId: 'org-a', issuer: alpha.issuer, pinnedOrganizationId: 'org-a', pinnedIssuer: alpha.issuer,
      externalId: 'alice', displayName: 'Alice', active: true, groups: ['admins'] };
    expect(projectScimUser(base)).toEqual({ organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'member', active: true });
    expect(projectScimUser({ ...base, active: false })).toMatchObject({ active: false, role: 'member' });
    for (const changed of [{ organizationId: 'org-b' }, { issuer: beta.issuer }, { externalId: '__proto__' },
      { displayName: '' }, { active: 'true' as unknown as boolean }]) {
      expect(() => projectScimUser({ ...base, ...changed })).toThrow();
    }
  });
});
