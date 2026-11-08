/** A verified grant is produced by the enrolled identity verifier, never from HTTP input. */
export type VerifiedSupervisorGrant = Readonly<{
  issuer: string;
  subject: string;
  sourceComputer: string;
  targetComputer: string;
  threadId: string;
  capabilities: readonly ('goal:read' | 'goal:create' | 'goal:resume' | 'task:read' | 'command:read' | 'artifact:read')[];
  expiresAt: number;
}>;

export type SupervisorPeerTarget = Readonly<{
  sourceComputer: string;
  targetComputer: string;
  threadId: string;
  capability: VerifiedSupervisorGrant['capabilities'][number];
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Fail closed if an enrolled verifier or exact scoped identity is unavailable. */
export function authorizeSupervisorPeer(
  grant: VerifiedSupervisorGrant | null,
  target: SupervisorPeerTarget,
  now = Date.now(),
): 'allowed' | 'identity_unavailable' | 'scope_denied' {
  if (!grant) return 'identity_unavailable';
  if (!ID.test(grant.issuer) || !ID.test(grant.subject) ||
      !ID.test(grant.sourceComputer) || !ID.test(grant.targetComputer) ||
      !THREAD.test(grant.threadId) || !THREAD.test(target.threadId) ||
      !ID.test(target.sourceComputer) || !ID.test(target.targetComputer) ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now ||
      !grant.capabilities.includes(target.capability) ||
      grant.sourceComputer !== target.sourceComputer ||
      grant.targetComputer !== target.targetComputer || grant.threadId !== target.threadId) {
    return 'scope_denied';
  }
  return 'allowed';
}
