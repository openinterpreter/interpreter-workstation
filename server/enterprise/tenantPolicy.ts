import type { OrganizationMember, VerifiedIdentity } from './controlPlane';

export type TenantAction = 'organization.read' | 'audit.read' | 'member.manage' | 'agent.execute' | 'tool.invoke' | 'scim.provision';

/** A server-owned default-deny boundary, not a Workstation-wide execution policy. */
export function evaluateTenantPolicy(input: Readonly<{
  identity: VerifiedIdentity;
  organizationId: string;
  issuer: string;
  member: OrganizationMember | null | undefined;
  sessionActive: boolean;
  action: TenantAction;
}>): boolean {
  const { identity, member } = input;
  if (!input.sessionActive || !identity.sessionId || identity.organizationId !== input.organizationId ||
      identity.issuer !== input.issuer || !member || member.organizationId !== input.organizationId ||
      member.subject !== identity.subject || !member.active || member.role !== 'admin') return false;
  // SCIM ingress, agent/tool execution and all unknown actions need separately
  // reviewed enforcement and may not inherit directory-admin privileges.
  return input.action === 'organization.read' || input.action === 'audit.read' || input.action === 'member.manage';
}
