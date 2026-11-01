import type { Application } from 'express';
import type { EnterpriseDirectory, VerifiedIdentity } from './controlPlane';
import type { ServerDirectory } from './serverDirectory';
import { createEnterpriseAdminMutationRouter, createEnterpriseBrowserRouter } from './oidcHttp';

type ScopedAdminMount = Readonly<{
  enabled: true;
  applicationOrigin: string;
  organizationId: string;
  issuer: string;
  directory: EnterpriseDirectory & Pick<ServerDirectory, 'deactivateMember'>;
  verifySession: (token: string) => Promise<VerifiedIdentity | null>;
  /** Only an explicitly isolated test process may permit plaintext loopback. */
  allowInsecureLoopbackForTests?: boolean;
}>;

/** Explicit composition seam for a separately verified HTTPS server. Not invoked
 * by the desktop HTTP sidecar: forwarded proxy headers cannot establish TLS custody.
 * An absent flag, pinned tenant/issuer or server-owned verifier never mounts a route. */
export function mountEnterpriseAdminRoutes(app: Application, options?: ScopedAdminMount): boolean {
  if (!options) return false;
  if (options.enabled !== true || !options.organizationId || !options.issuer ||
      !options.directory || typeof options.verifySession !== 'function' ||
      (options.allowInsecureLoopbackForTests && process.env.NODE_ENV !== 'test')) {
    throw new Error('Enterprise admin mount requires a verified tenant, issuer, store and session verifier');
  }
  const verifySession = async (token: string) => {
    const identity = await options.verifySession(token);
    return identity?.organizationId === options.organizationId && identity.issuer === options.issuer ? identity : null;
  };
  const scoped = { applicationOrigin: options.applicationOrigin,
    allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests,
    verifySession, directory: options.directory };
  // Build both routers before mounting either; invalid origins cannot leave a partial API.
  const read = createEnterpriseBrowserRouter(scoped);
  const write = createEnterpriseAdminMutationRouter(scoped);
  app.use('/api/enterprise', read);
  app.use('/api/enterprise', write);
  return true;
}
