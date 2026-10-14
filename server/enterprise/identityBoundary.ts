import type { OrganizationMember } from './controlPlane';

type Binding = Readonly<{ organizationId: string; domain: string; issuer: string; callbackUri: string }>;
const dns = (value: string): boolean => value.length <= 253 && value.includes('.') &&
  value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));

/** Discovery hints only; an email domain or IdP claim never grants a tenant role. */
export function createTenantDiscovery(bindings: readonly Binding[], applicationOrigin: string) {
  const origin = new URL(applicationOrigin);
  if (origin.origin !== applicationOrigin || origin.protocol !== 'https:') throw new Error('Invalid application origin');
  const domains = new Map<string, Binding>();
  for (const binding of bindings) {
    const domain = binding.domain.toLowerCase();
    const callback = new URL(binding.callbackUri);
    const issuer = new URL(binding.issuer);
    if (!dns(domain) || domain !== binding.domain || domains.has(domain) ||
        !/^[a-zA-Z0-9._:-]{1,160}$/.test(binding.organizationId) ||
        ['__proto__', 'constructor', 'prototype'].includes(binding.organizationId) ||
        callback.origin !== origin.origin || callback.username || callback.password ||
        !callback.pathname.startsWith('/enterprise/') || callback.search || callback.hash ||
        issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) {
      throw new Error('Invalid or ambiguous tenant discovery configuration');
    }
    domains.set(domain, binding);
  }
  return (email: string): Pick<Binding, 'organizationId' | 'issuer' | 'callbackUri'> | null => {
    if (email.length > 320 || email.trim() !== email || email.split('@').length !== 2) return null;
    const [local, domain] = email.split('@');
    if (!local || !domain || !/^[a-zA-Z0-9._%+-]+$/.test(local) || !dns(domain.toLowerCase())) return null;
    const binding = domains.get(domain.toLowerCase());
    return binding ? { organizationId: binding.organizationId, issuer: binding.issuer, callbackUri: binding.callbackUri } : null;
  };
}

/** Projection only: no SCIM ingress, credentials, group-sync, or mutation route exists. */
export function projectScimUser(input: Readonly<{
  organizationId: string; issuer: string; pinnedOrganizationId: string; pinnedIssuer: string;
  externalId: string; displayName: string; active: boolean; groups?: readonly string[];
}>): OrganizationMember {
  if (input.organizationId !== input.pinnedOrganizationId || input.issuer !== input.pinnedIssuer ||
      !/^[a-zA-Z0-9._@:-]{1,160}$/.test(input.externalId) ||
      ['__proto__', 'constructor', 'prototype'].includes(input.externalId) ||
      !input.displayName.trim() || input.displayName.length > 200 || typeof input.active !== 'boolean' ||
      (input.groups && (!Array.isArray(input.groups) || input.groups.some((group) => typeof group !== 'string')))) {
    throw new Error('Invalid tenant-bound provisioning projection');
  }
  // Groups supplied by an upstream directory cannot mint an administrator.
  return { organizationId: input.pinnedOrganizationId, subject: input.externalId,
    displayName: input.displayName.trim(), role: 'member', active: input.active };
}
