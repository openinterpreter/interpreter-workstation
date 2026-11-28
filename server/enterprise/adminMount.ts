import type { Application } from 'express';
import type { EnterpriseDirectory, VerifiedIdentity } from './controlPlane';
import type { OidcConfiguration } from './oidc';
import { getWorkstationHostPolicy } from '../workstationConnection';
import { verifiedDomainName, type ServerDirectory } from './serverDirectory';
import { createEnterpriseAdminMutationRouter, createEnterpriseAuditPageRouter, createEnterpriseBrowserRouter, createEnterpriseDomainProofRouter, createEnterpriseLogoutRouter, createEnterpriseWorkspaceRouter } from './oidcHttp';

type ScopedAdminMount = Readonly<{
  enabled: true;
  applicationOrigin: string;
  organizationId: string;
  issuer: string;
  /** Required outside isolated loopback fixtures; matches the persisted OIDC
   * session domain, not a browser claim or request-derived Host. */
  accountDomain?: string;
  /** The same operator-pinned identity mapping used by the OIDC callback.
   * A production admin surface cannot be composed from independent pins. */
  oidc?: Pick<OidcConfiguration, 'organizationId' | 'issuer' | 'accountDomain' | 'redirectUri'>;
  directory: EnterpriseDirectory & Pick<ServerDirectory, 'deactivateMember' | 'demoteAdministrator' | 'revokeMemberSessions' | 'revokeOrganizationSessions' | 'revokeSession' | 'verifyBoundSession' | 'verifyBoundSessionForDomainRenewal' | 'listAudit' | 'listAuditPage' | 'recordTenantDenial' | 'beginDomainProof' | 'confirmDomainProof' | 'domainProofStatus' | 'listWorkspaces' | 'createWorkspace' | 'deactivateWorkspace' | 'listWorkspaceGrants' | 'setRuntimeGrant'>;
  verifySession: (token: string) => Promise<VerifiedIdentity | null>;
  /** Separately opt in to setup; no login or SSO activation follows. */
  enableDomainSetup?: boolean;
  /** Administrative registry only. No workspace files or agent permissions. */
  enableWorkspaceAdministration?: boolean;
  /** Experimental RLS-v2 ledger only. Never silently expose partial history as a full export. */
  enablePagedAudit?: boolean;
  /** Only an explicitly isolated test process may permit plaintext loopback. */
  allowInsecureLoopbackForTests?: boolean;
}>;

/** Explicit composition seam for a separately verified HTTPS server. Not invoked
 * by the desktop HTTP sidecar: forwarded proxy headers cannot establish TLS custody.
 * An absent flag, pinned tenant/issuer or server-owned verifier never mounts a route. */
export function mountEnterpriseAdminRoutes(app: Application, options?: ScopedAdminMount): boolean {
  if (!options) return false;
  // The remote Workstation password cookie is not a tenant session. Its
  // authenticated browser still reaches ordinary IPC/agent APIs after an
  // organization kill. Refuse this mixed deployment before any route mounts;
  // a dedicated tenant-enforced runtime needs separate end-to-end review.
  if (getWorkstationHostPolicy().remote) {
    throw new Error('Enterprise admin cannot share a remote Workstation host session');
  }
  let pinnedIssuer = false;
  try {
    const issuer = new URL(options.issuer);
    const isolatedLoopback = options.allowInsecureLoopbackForTests === true && process.env.NODE_ENV === 'test' &&
      issuer.protocol === 'http:' && issuer.hostname === '127.0.0.1';
    pinnedIssuer = (issuer.protocol === 'https:' || isolatedLoopback) && !issuer.username && !issuer.password &&
      !issuer.search && !issuer.hash;
  } catch { /* Invalid issuer must not partially mount an admin router. */ }
  let pinnedCallback = false;
  if (!options.allowInsecureLoopbackForTests && options.oidc) {
    try {
      const origin = new URL(options.applicationOrigin);
      const callback = new URL(options.oidc.redirectUri);
      pinnedCallback = origin.origin === options.applicationOrigin && callback.origin === origin.origin &&
        !callback.username && !callback.password && callback.pathname.startsWith('/enterprise/') &&
        !callback.search && !callback.hash;
    } catch { /* Invalid configuration must not partially mount any router. */ }
  }
  if (options.enabled !== true || !options.organizationId || !pinnedIssuer ||
      !options.directory || typeof options.verifySession !== 'function' ||
      (options.enableDomainSetup !== undefined && typeof options.enableDomainSetup !== 'boolean') ||
      (options.enableWorkspaceAdministration !== undefined && typeof options.enableWorkspaceAdministration !== 'boolean') ||
      (options.enablePagedAudit !== undefined && typeof options.enablePagedAudit !== 'boolean') ||
      (options.enablePagedAudit === true && typeof options.directory.listAuditPage !== 'function') ||
      (options.enableDomainSetup === true && (typeof options.directory.beginDomainProof !== 'function' ||
        typeof options.directory.confirmDomainProof !== 'function' || typeof options.directory.domainProofStatus !== 'function')) ||
      (options.enableWorkspaceAdministration === true && (typeof options.directory.listWorkspaces !== 'function' ||
        typeof options.directory.createWorkspace !== 'function' || typeof options.directory.deactivateWorkspace !== 'function' ||
        typeof options.directory.listWorkspaceGrants !== 'function' || typeof options.directory.setRuntimeGrant !== 'function')) ||
      typeof options.directory.demoteAdministrator !== 'function' ||
      (!options.allowInsecureLoopbackForTests && (!options.accountDomain ||
        verifiedDomainName(options.accountDomain) !== options.accountDomain ||
        typeof options.directory.verifyBoundSession !== 'function' || !pinnedCallback ||
        (options.enableDomainSetup === true && typeof options.directory.verifyBoundSessionForDomainRenewal !== 'function') ||
        options.oidc?.organizationId !== options.organizationId || options.oidc.issuer !== options.issuer ||
        options.oidc.accountDomain !== options.accountDomain)) ||
      (options.allowInsecureLoopbackForTests && process.env.NODE_ENV !== 'test')) {
    throw new Error('Enterprise admin mount requires a verified tenant, issuer, store and session verifier');
  }
  // Caller-owned configuration objects are mutable in JavaScript. Snapshot
  // every authority pin before registering handlers, as the OIDC client does.
  const { organizationId, issuer, accountDomain, allowInsecureLoopbackForTests, directory,
    verifySession: suppliedVerifier } = options;
  const verifySession = async (token: string) => {
    const identity = allowInsecureLoopbackForTests
      ? await suppliedVerifier(token)
      : await directory.verifyBoundSession(token, accountDomain!);
    return identity?.organizationId === organizationId && identity.issuer === issuer ? identity : null;
  };
  // Domain-proof routes renew the lease that ordinary bound sessions require;
  // their verifier must not itself require that lease to be current. The
  // directory limits that waiver to challenge, verify and status for the
  // session's own bound domain.
  const verifyRenewalSession = async (token: string) => {
    const identity = allowInsecureLoopbackForTests
      ? await suppliedVerifier(token)
      : await directory.verifyBoundSessionForDomainRenewal(token, accountDomain!);
    return identity?.organizationId === organizationId && identity.issuer === issuer ? identity : null;
  };
  const scoped = { applicationOrigin: options.applicationOrigin,
    allowInsecureLoopbackForTests, verifySession, directory };
  // Build every router before mounting; invalid origins cannot leave a partial API.
  const read = createEnterpriseBrowserRouter(scoped);
  const write = createEnterpriseAdminMutationRouter(scoped);
  const logout = createEnterpriseLogoutRouter(scoped);
  const domains = options.enableDomainSetup === true
    ? createEnterpriseDomainProofRouter({ ...scoped, verifySession: verifyRenewalSession }) : null;
  const workspaces = options.enableWorkspaceAdministration === true ? createEnterpriseWorkspaceRouter(scoped) : null;
  const pagedAudit = options.enablePagedAudit === true ? createEnterpriseAuditPageRouter(scoped) : null;
  // The host access mode is currently read from the environment on every
  // request. A later switch to remote must not bypass the startup refusal.
  // Keep this gate ahead of all enterprise routes, including read endpoints.
  app.use('/api/enterprise', (_req, res, next) => {
    if (getWorkstationHostPolicy().remote) return void res.status(503).end();
    next();
  });
  app.use('/api/enterprise', read);
  app.use('/api/enterprise', write);
  app.use('/api/enterprise', logout);
  if (domains) app.use('/api/enterprise', domains);
  if (workspaces) app.use('/api/enterprise', workspaces);
  if (pagedAudit) app.use('/api/enterprise', pagedAudit);
  return true;
}
