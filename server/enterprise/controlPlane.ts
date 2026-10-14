import { Router, type Request, type Response } from 'express';

/** Identity must come from a server-side token verifier, never from request JSON or decoded JWT claims. */
export type VerifiedIdentity = Readonly<{
  issuer: string;
  subject: string;
  organizationId: string;
  sessionId: string;
}>;

export type OrganizationMember = Readonly<{
  organizationId: string;
  subject: string;
  displayName: string;
  role: 'admin' | 'member';
  active: boolean;
}>;

export interface EnterpriseDirectory {
  getMember(organizationId: string, subject: string): Promise<OrganizationMember | null>;
  listMembers(organizationId: string): Promise<readonly OrganizationMember[]>;
  sessionIsActive(identity: VerifiedIdentity): Promise<boolean>;
  recordAudit(event: Readonly<{ organizationId: string; subject: string; action: string; outcome: 'allowed' | 'denied' }>): Promise<void>;
}

export type EnterpriseDependencies = Readonly<{
  verifyBearer: (token: string) => Promise<VerifiedIdentity | null>;
  directory: EnterpriseDirectory;
}>;

/**
 * A deliberately read-only control-plane seam. A desktop-local JWT cache and
 * local filesystem workspace are NOT an enterprise identity or tenant boundary.
 * The host must supply a verified issuer/audience/signature and a server-owned
 * directory with revocation before mounting this router.
 */
export function createEnterpriseControlPlane(deps: EnterpriseDependencies): Router {
  const router = Router();
  router.get('/organizations/:organizationId/members', async (req: Request, res: Response) => {
    const token = /^Bearer ([^\s]+)$/.exec(req.header('authorization') ?? '')?.[1];
    if (!token) return void res.status(401).json({ error: 'Authentication required' });

    try {
      const identity = await deps.verifyBearer(token);
      if (!identity || !identity.issuer || !identity.subject || !identity.sessionId ||
          identity.organizationId !== req.params.organizationId) {
        return void res.status(403).json({ error: 'Access denied' });
      }
      const member = await deps.directory.getMember(identity.organizationId, identity.subject);
      const allowed = Boolean(member?.organizationId === identity.organizationId && member.active && member.role === 'admin' &&
        await deps.directory.sessionIsActive(identity));
      const members = allowed ? await deps.directory.listMembers(identity.organizationId) : [];
      // A faulty backend must not make an adjacent tenant visible in this API.
      if (members.some((entry) => entry.organizationId !== identity.organizationId)) {
        throw new Error('Tenant directory returned cross-organization records');
      }
      await deps.directory.recordAudit({
        organizationId: identity.organizationId,
        subject: identity.subject,
        action: 'organization.members.read',
        outcome: allowed ? 'allowed' : 'denied',
      });
      if (!allowed) return void res.status(403).json({ error: 'Access denied' });
      res.setHeader('Cache-Control', 'no-store');
      return void res.json({ organizationId: identity.organizationId, members: members.map(({ subject, displayName, role, active }) => ({ subject, displayName, role, active })) });
    } catch {
      // A verifier, revocation, audit, or directory outage is never permission.
      return void res.status(503).json({ error: 'Organization directory unavailable' });
    }
  });
  return router;
}

export const ENTERPRISE_READINESS = Object.freeze({
  available: false,
  identity: 'not configured',
  organizationAdministration: 'not available',
  policyEnforcement: 'not available',
  auditExport: 'not available',
  provisioning: 'not available',
  detail: 'This desktop build does not connect to a verified enterprise control plane. Local account sign-in is not organization SSO.',
});
