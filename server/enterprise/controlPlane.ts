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
  /** Permission, session, tenant snapshot and audit commit form one durable operation. */
  readAdmin(identity: VerifiedIdentity, view: 'members' | 'overview'): Promise<unknown | null>;
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
  async function authorized(req: Request, res: Response, view: 'members' | 'overview'): Promise<void> {
    const token = /^Bearer ([^\s]+)$/.exec(req.header('authorization') ?? '')?.[1];
    if (!token) return void res.status(401).json({ error: 'Authentication required' });

    try {
      const identity = await deps.verifyBearer(token);
      if (!identity || !identity.issuer || !identity.subject || !identity.sessionId ||
          identity.organizationId !== req.params.organizationId) {
        return void res.status(403).json({ error: 'Access denied' });
      }
      const payload = await deps.directory.readAdmin(identity, view);
      if (payload === null) return void res.status(403).json({ error: 'Access denied' });
      res.setHeader('Cache-Control', 'no-store');
      return void res.json(payload);
    } catch {
      // A verifier, revocation, audit, or directory outage is never permission.
      return void res.status(503).json({ error: 'Organization directory unavailable' });
    }
  }
  router.get('/organizations/:organizationId/members', (req, res) => authorized(req, res, 'members'));
  router.get('/organizations/:organizationId/overview', (req, res) => authorized(req, res, 'overview'));
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
