import type { OrganizationMember, VerifiedIdentity } from './controlPlane';

export type RuntimeAction = 'agent.execute' | 'tool.invoke' | 'simple.execute';
export type TenantAction = 'organization.read' | 'audit.read' | 'member.manage' | RuntimeAction | 'scim.provision';

/** A server-owned default-deny boundary, not a Workstation-wide execution policy. */
export function evaluateTenantPolicy(input: Readonly<{
  identity: VerifiedIdentity;
  organizationId: string;
  issuer: string;
  member: OrganizationMember | null | undefined;
  sessionActive: boolean;
  action: TenantAction;
  /** Server-owned, transactionally read workspace grant; never a JWT claim. */
  runtimeGrant?: boolean;
  workspaceActive?: boolean;
}>): boolean {
  const { identity, member } = input;
  if (!input.sessionActive || !identity.sessionId || identity.organizationId !== input.organizationId ||
      identity.issuer !== input.issuer || !member || member.organizationId !== input.organizationId ||
      member.subject !== identity.subject || !member.active) return false;
  if (input.action === 'agent.execute' || input.action === 'tool.invoke' || input.action === 'simple.execute') {
    return input.workspaceActive === true && input.runtimeGrant === true;
  }
  // Administrative rights never imply execution; SCIM and unknown actions
  // remain denied even when the caller has an explicit runtime grant.
  return member.role === 'admin' &&
    (input.action === 'organization.read' || input.action === 'audit.read' || input.action === 'member.manage');
}
