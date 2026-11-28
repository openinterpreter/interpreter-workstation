import { Router, json, type Request, type Response } from 'express';
import { isIPv4, isIPv6 } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { OidcConfiguration, OidcIntegration } from './oidc';
import type { EnterpriseDirectory, VerifiedIdentity } from './controlPlane';
import { EnterpriseAccessDenied, verifiedDomainName, type ServerDirectory } from './serverDirectory';

type HttpOptions = Readonly<{
  config: OidcConfiguration;
  integration: OidcIntegration;
  /** Exact application origin and callback URI are installation-time pins, not request-derived. */
  applicationOrigin: string;
  successPath: string;
  /** Optional, separate, operator-pinned renewal UX path. This router is
   * itself unmounted by the desktop server; absence leaves recovery 404. */
  recoverySuccessPath?: string;
}>;

function exactOrigin(req: Request, origin: URL, loopback: boolean): boolean {
  // Do not trust X-Forwarded-* or a request body for the identity origin.
  // Absolute-form HTTP targets can carry an authority distinct from Host;
  // reject them before any binding, directory read or mutation. Inspect the
  // actual server socket, never forwarded headers. Bun's Node
  // HTTPS-compatible socket is encrypted but is not instanceof Node TLSSocket.
  const secure = (req.socket as TLSSocket).encrypted === true;
  try {
    return new URL(req.originalUrl, origin).origin === origin.origin &&
      req.get('host') === origin.host && (secure || (loopback && origin.protocol === 'http:'));
  } catch { return false; }
}

/** Login-start quota bucket from the accepted socket's peer address only;
 * X-Forwarded-For and other headers are never trusted. An IPv6 peer is
 * grouped by its /64, which one host normally controls in full. Behind a
 * proxy that does not preserve the peer address, every client shares one
 * bucket, which bounds them together but still never refuses a start. */
export function loginClientNetwork(address: string | undefined): string | null {
  if (!address) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return null;
  const halves = address.split('%')[0]!.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const rightGroups = right.reduce((count, part) => count + (part.includes('.') ? 2 : 1), 0);
  const groups = [...left, ...Array<string>(halves.length > 1 ? 8 - left.length - rightGroups : 0).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

function cookie(req: Request, name: string): string | null {
  const matches = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** Not mounted by the desktop server. Requires a separately reviewed HTTPS deployment. */
export function createOidcHttpRouter({ config, integration, applicationOrigin, successPath, recoverySuccessPath }: HttpOptions): Router {
  const origin = new URL(applicationOrigin);
  const callback = new URL(config.redirectUri);
  const successDestination = new URL(successPath, origin);
  const recoveryDestination = recoverySuccessPath === undefined ? null : new URL(recoverySuccessPath, origin);
  const loopback = config.allowInsecureLoopbackForTests === true;
  if (loopback && process.env.NODE_ENV !== 'test') throw new Error('Insecure OIDC loopback requires an isolated test process');
  if (!loopback &&
      (!config.accountDomain || verifiedDomainName(config.accountDomain) !== config.accountDomain)) {
    throw new Error('Production OIDC requires a pinned account domain');
  }
  if (origin.origin !== callback.origin || origin.username || origin.password || callback.username || callback.password ||
      origin.pathname !== '/' || origin.search || origin.hash ||
      !successPath.startsWith('/') || successPath.startsWith('//') || successPath.includes('\\') ||
      successDestination.origin !== origin.origin || successDestination.pathname !== successPath ||
      successDestination.search || successDestination.hash ||
      (recoverySuccessPath !== undefined && (!config.accountDomain || !recoverySuccessPath.startsWith('/') ||
        recoverySuccessPath.startsWith('//') || recoverySuccessPath.includes('\\') ||
        recoverySuccessPath === successPath || recoveryDestination?.origin !== origin.origin ||
        recoveryDestination.pathname !== recoverySuccessPath || recoveryDestination.search || recoveryDestination.hash)) ||
      !callback.pathname.startsWith('/enterprise/') || callback.search || callback.hash ||
      (loopback ? !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1') : origin.protocol !== 'https:')) {
    throw new Error('Invalid application origin or exact OIDC callback');
  }
  const bindingName = loopback ? 'interpreter-oidc-binding' : '__Host-interpreter-oidc-binding';
  const sessionName = loopback ? 'interpreter-enterprise-session' : '__Host-interpreter-enterprise-session';
  const router = Router();
  const cookieOptions = { httpOnly: true, secure: !loopback, sameSite: 'lax' as const, path: '/' };

  router.get('/organizations/:organizationId/login', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!exactOrigin(req, origin, loopback) || req.params.organizationId !== config.organizationId) {
      return void res.status(403).end();
    }
    const client = loginClientNetwork(req.socket.remoteAddress);
    if (!client) return void res.status(503).end();
    try {
      const flow = await integration.begin(client);
      res.cookie(bindingName, flow.browserBinding, { ...cookieOptions, maxAge: 5 * 60_000 });
      return void res.redirect(302, flow.authorizationUrl);
    } catch {
      return void res.status(503).end();
    }
  });

  if (recoverySuccessPath) router.get('/organizations/:organizationId/domain-recovery/login', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!exactOrigin(req, origin, loopback) || req.params.organizationId !== config.organizationId) {
      return void res.status(403).end();
    }
    const client = loginClientNetwork(req.socket.remoteAddress);
    if (!client) return void res.status(503).end();
    try {
      const flow = await integration.beginDomainRecovery(client);
      res.cookie(bindingName, flow.browserBinding, { ...cookieOptions, maxAge: 5 * 60_000 });
      return void res.redirect(302, flow.authorizationUrl);
    } catch {
      return void res.status(503).end();
    }
  });

  router.get(callback.pathname, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!exactOrigin(req, origin, loopback)) return void res.status(403).end();
    // Reject duplicated response parameters, errors, fragments and malformed values.
    const url = new URL(req.originalUrl, origin);
    const code = url.searchParams.getAll('code');
    const state = url.searchParams.getAll('state');
    const binding = cookie(req, bindingName);
    // HTTP absolute-form request targets can retain an attacker-selected
    // authority in originalUrl even when Host matches the pinned origin.
    if (url.origin !== origin.origin || url.pathname !== callback.pathname ||
        code.length !== 1 || state.length !== 1 ||
        !/^[A-Za-z0-9_-]{43}$/.test(state[0] ?? '') ||
        url.searchParams.size !== 2 || !binding) return void res.status(400).end();
    res.clearCookie(bindingName, cookieOptions);
    try {
      const result = await integration.complete({ code: code[0]!, state: state[0]!, browserBinding: binding },
        { allowDomainRecovery: Boolean(recoverySuccessPath) });
      if (result.expiresAt <= Date.now() || (result.recoveryOnly && !recoverySuccessPath)) return void res.status(401).end();
      res.cookie(sessionName, result.token, { ...cookieOptions, maxAge: Math.max(0, result.expiresAt - Date.now()) });
      return void res.redirect(303, result.recoveryOnly ? recoverySuccessPath! : successPath);
    } catch {
      // Do not expose an IdP error, verifier details or any token in URLs/logs.
      return void res.status(401).end();
    }
  });
  return router;
}

/** Read-only same-origin BFF seam. Never hands the cookie's bearer to renderer JS. Unmounted. */
export function createEnterpriseBrowserRouter(options: Readonly<{
  applicationOrigin: string;
  allowInsecureLoopbackForTests?: boolean;
  verifySession: (token: string) => Promise<VerifiedIdentity | null>;
  directory: EnterpriseDirectory & Pick<ServerDirectory, 'listAudit' | 'recordTenantDenial'>;
}>): Router {
  const origin = new URL(options.applicationOrigin);
  const loopback = options.allowInsecureLoopbackForTests === true;
  if (loopback && process.env.NODE_ENV !== 'test') throw new Error('Insecure enterprise browser API requires an isolated test process');
  if (origin.origin !== options.applicationOrigin ||
      (loopback ? !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1') : origin.protocol !== 'https:')) {
    throw new Error('Invalid browser API origin');
  }
  const sessionName = loopback ? 'interpreter-enterprise-session' : '__Host-interpreter-enterprise-session';
  const router = Router();
  async function read(req: Request, res: Response, view: 'members' | 'overview' | 'activity' | 'export'): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin, Sec-Fetch-Site');
    if (!exactOrigin(req, origin, loopback) ||
        (req.get('origin') && req.get('origin') !== origin.origin) ||
        (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site')!)) ||
        req.get('authorization')) return void res.status(403).end();
    const token = cookie(req, sessionName);
    if (!token) return void res.status(401).end();
    try {
      const identity = await options.verifySession(token);
      if (!identity || !identity.sessionId || !identity.issuer || !identity.subject) {
        return void res.status(403).end();
      }
      if (identity.organizationId !== req.params.organizationId) {
        await options.directory.recordTenantDenial(identity, req.params.organizationId, view);
        return void res.status(403).end();
      }
      const payload = view === 'activity' || view === 'export'
        ? { organizationId: identity.organizationId,
          events: view === 'export' ? await options.directory.listAudit(identity, 'export')
            : (await options.directory.listAudit(identity)).slice(-20) }
        : await options.directory.readAdmin(identity, view);
      if (payload === null) return void res.status(403).end();
      if (view === 'export') {
        res.setHeader('Content-Disposition', 'attachment; filename="organization-audit.json"');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      }
      return void res.json(payload);
    } catch (error) {
      return void res.status(error instanceof EnterpriseAccessDenied ? 403 : 503).end();
    }
  }
  router.get('/organizations/:organizationId/overview', (req, res) => read(req, res, 'overview'));
  router.get('/organizations/:organizationId/members', (req, res) => read(req, res, 'members'));
  router.get('/organizations/:organizationId/activity', (req, res) => read(req, res, 'activity'));
  router.get('/organizations/:organizationId/activity/export', (req, res) => read(req, res, 'export'));
  return router;
}

/** Separately constructed audit page route for the experimental v2 ledger.
 * It is NOT mounted by the desktop or the opt-in admin composition. The
 * legacy full-history endpoint deliberately fails closed for v2 stores. */
export function createEnterpriseAuditPageRouter(options: Readonly<{
  applicationOrigin: string;
  allowInsecureLoopbackForTests?: boolean;
  verifySession: (token: string) => Promise<VerifiedIdentity | null>;
  directory: Pick<ServerDirectory, 'listAuditPage' | 'recordTenantDenial'>;
}>): Router {
  const origin = new URL(options.applicationOrigin);
  const loopback = options.allowInsecureLoopbackForTests === true;
  if (loopback && process.env.NODE_ENV !== 'test') throw new Error('Insecure enterprise audit page requires an isolated test process');
  if (origin.origin !== options.applicationOrigin ||
      (loopback ? !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1') : origin.protocol !== 'https:')) {
    throw new Error('Invalid audit page origin');
  }
  const sessionName = loopback ? 'interpreter-enterprise-session' : '__Host-interpreter-enterprise-session';
  const router = Router();
  router.get('/organizations/:organizationId/activity/page', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin, Sec-Fetch-Site');
    if (!exactOrigin(req, origin, loopback) ||
        (req.get('origin') && req.get('origin') !== origin.origin) ||
        (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site')!)) ||
        req.get('authorization')) return void res.status(403).end();
    const url = new URL(req.originalUrl, origin);
    const keys = [...url.searchParams.keys()].sort();
    if (keys.some((key) => !['after', 'upper', 'limit', 'purpose'].includes(key)) ||
        new Set(keys).size !== keys.length) return void res.status(403).end();
    const integer = (key: string, fallback?: number) => {
      const value = url.searchParams.get(key);
      if (value === null) return fallback;
      if (!/^(?:0|[1-9]\d*)$/.test(value)) return NaN;
      return Number(value);
    };
    const after = integer('after', 0);
    const upper = integer('upper');
    const limit = integer('limit', 100);
    const purpose = url.searchParams.get('purpose') ?? 'view';
    if (!Number.isSafeInteger(after) || after! < 0 ||
        (upper !== undefined && (!Number.isSafeInteger(upper) || upper < after!)) ||
        !Number.isSafeInteger(limit) || limit! < 1 || limit! > 100 ||
        (purpose !== 'view' && purpose !== 'export')) return void res.status(403).end();
    const token = cookie(req, sessionName);
    if (!token) return void res.status(401).end();
    try {
      const identity = await options.verifySession(token);
      if (!identity?.sessionId || !identity.issuer || !identity.subject) return void res.status(403).end();
      if (identity.organizationId !== req.params.organizationId) {
        await options.directory.recordTenantDenial(identity, req.params.organizationId, 'activity');
        return void res.status(403).end();
      }
      const page = await options.directory.listAuditPage(identity, after!, upper, limit!, purpose);
      if (purpose === 'export') {
        res.setHeader('Content-Disposition', 'attachment; filename="organization-audit-page.json"');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      }
      return void res.json({ organizationId: identity.organizationId, ...page });
    } catch (error) {
      return void res.status(error instanceof EnterpriseAccessDenied ? 403 : 503).end();
    }
  });
  return router;
}

/** Separate, unmounted admin mutation seam. Must share the exact HTTPS origin
 * and server-owned session verifier with the read-only browser router. */
export function createEnterpriseAdminMutationRouter(options: Readonly<{
  applicationOrigin: string;
  allowInsecureLoopbackForTests?: boolean;
  verifySession: (token: string) => Promise<VerifiedIdentity | null>;
  directory: Pick<ServerDirectory, 'deactivateMember' | 'demoteAdministrator' | 'revokeMemberSessions' | 'revokeOrganizationSessions' | 'recordTenantDenial'>;
}>): Router {
  const origin = new URL(options.applicationOrigin);
  const loopback = options.allowInsecureLoopbackForTests === true;
  if (loopback && process.env.NODE_ENV !== 'test') throw new Error('Insecure enterprise admin API requires an isolated test process');
  if (origin.origin !== options.applicationOrigin ||
      (loopback ? !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1') : origin.protocol !== 'https:')) {
    throw new Error('Invalid admin API origin');
  }
  const sessionName = loopback ? 'interpreter-enterprise-session' : '__Host-interpreter-enterprise-session';
  const router = Router();
  async function mutate(req: Request, res: Response, action: 'deactivate' | 'demote' | 'revoke-sessions' | 'revoke-all-sessions'): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin, Sec-Fetch-Site');
    // Requiring both exact Origin and a non-simple header prevents a form POST
    // from riding a SameSite cookie even if an upstream proxy changes CORS.
    if (!exactOrigin(req, origin, loopback) || req.get('origin') !== origin.origin ||
        (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin') ||
        req.get('x-interpreter-csrf') !== '1' || !req.is('application/json') ||
        req.get('authorization') || !req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
      return void res.status(403).end();
    }
    const token = cookie(req, sessionName);
    if (!token) return void res.status(401).end();
    try {
      const identity = await options.verifySession(token);
      if (!identity?.sessionId || !identity.issuer || !identity.subject) {
        return void res.status(403).end();
      }
      if (identity.organizationId !== req.params.organizationId) {
        await options.directory.recordTenantDenial(identity, req.params.organizationId, action);
        return void res.status(403).end();
      }
      if (action === 'deactivate') await options.directory.deactivateMember(identity, req.params.subject);
      else if (action === 'demote') await options.directory.demoteAdministrator(identity, req.params.subject);
      else if (action === 'revoke-sessions') await options.directory.revokeMemberSessions(identity, req.params.subject);
      else {
        await options.directory.revokeOrganizationSessions(identity);
        res.clearCookie(sessionName, { httpOnly: true, secure: !loopback, sameSite: 'lax', path: '/' });
      }
      return void res.status(204).end();
    } catch (error) {
      return void res.status(error instanceof EnterpriseAccessDenied ? 403 : 503).end();
    }
  }
  router.post('/organizations/:organizationId/members/:subject/deactivate', json({ limit: '2kb', strict: true }),
    (req, res) => void mutate(req, res, 'deactivate'));
  router.post('/organizations/:organizationId/members/:subject/demote', json({ limit: '2kb', strict: true }),
    (req, res) => void mutate(req, res, 'demote'));
  router.post('/organizations/:organizationId/members/:subject/revoke-sessions', json({ limit: '2kb', strict: true }),
    (req, res) => void mutate(req, res, 'revoke-sessions'));
  router.post('/organizations/:organizationId/sessions/revoke-all', json({ limit: '2kb', strict: true }),
    (req, res) => void mutate(req, res, 'revoke-all-sessions'));
  return router;
}

/** Unmounted domain setup API. It records a limited DNS signal only; neither
 * endpoint activates SSO, provisions a tenant, or claims domain entitlement. */
export function createEnterpriseDomainProofRouter(options: Readonly<{
  applicationOrigin: string;
  allowInsecureLoopbackForTests?: boolean;
  verifySession: (token: string) => Promise<VerifiedIdentity | null>;
  directory: Pick<ServerDirectory, 'beginDomainProof' | 'confirmDomainProof' | 'domainProofStatus' | 'recordTenantDenial'>;
}>): Router {
  const origin = new URL(options.applicationOrigin);
  const loopback = options.allowInsecureLoopbackForTests === true;
  if (loopback && process.env.NODE_ENV !== 'test') throw new Error('Insecure enterprise domain API requires an isolated test process');
  if (origin.origin !== options.applicationOrigin ||
      (loopback ? !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1') : origin.protocol !== 'https:')) {
    throw new Error('Invalid domain API origin');
  }
  const sessionName = loopback ? 'interpreter-enterprise-session' : '__Host-interpreter-enterprise-session';
  const router = Router();
  async function act(req: Request, res: Response, action: 'challenge' | 'verify'): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin, Sec-Fetch-Site');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!exactOrigin(req, origin, loopback) || req.get('origin') !== origin.origin ||
        (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin') ||
        req.get('x-interpreter-csrf') !== '1' || !req.is('application/json') ||
        req.get('authorization') || !req.body || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 || typeof req.body.domain !== 'string') {
      return void res.status(403).end();
    }
    const token = cookie(req, sessionName);
    if (!token) return void res.status(401).end();
    try {
      const identity = await options.verifySession(token);
      if (!identity?.sessionId || !identity.issuer || !identity.subject) return void res.status(403).end();
      if (identity.organizationId !== req.params.organizationId) {
        await options.directory.recordTenantDenial(identity, req.params.organizationId, `domain.${action}`);
        return void res.status(403).end();
      }
      if (action === 'challenge') {
        const challenge = await options.directory.beginDomainProof(identity, req.body.domain);
        return void res.status(200).json(challenge);
      }
      await options.directory.confirmDomainProof(identity, req.body.domain);
      return void res.status(204).end();
    } catch (error) {
      return void res.status(error instanceof EnterpriseAccessDenied ? 403 : 503).end();
    }
  }
  router.post('/organizations/:organizationId/domains/challenge', json({ limit: '1kb', strict: true }),
    (req, res) => void act(req, res, 'challenge'));
  router.post('/organizations/:organizationId/domains/verify', json({ limit: '1kb', strict: true }),
    (req, res) => void act(req, res, 'verify'));
  router.get('/organizations/:organizationId/domains/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin, Sec-Fetch-Site');
    if (!exactOrigin(req, origin, loopback) || (req.get('origin') && req.get('origin') !== origin.origin) ||
        (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site')!)) ||
        req.get('authorization')) return void res.status(403).end();
    const url = new URL(req.originalUrl, origin);
    const domains = url.searchParams.getAll('domain');
    if (url.origin !== origin.origin || domains.length !== 1 || url.searchParams.size !== 1) return void res.status(403).end();
    const token = cookie(req, sessionName);
    if (!token) return void res.status(401).end();
    try {
      const identity = await options.verifySession(token);
      if (!identity?.sessionId || !identity.issuer || !identity.subject) return void res.status(403).end();
      if (identity.organizationId !== req.params.organizationId) {
        await options.directory.recordTenantDenial(identity, req.params.organizationId, 'domain.status');
        return void res.status(403).end();
      }
      return void res.json(await options.directory.domainProofStatus(identity, domains[0]!));
    } catch (error) {
      return void res.status(error instanceof EnterpriseAccessDenied ? 403 : 503).end();
    }
  });
  return router;
}

/** Optional administrative inventory, not a filesystem or execution-policy
 * boundary. It is not mounted by the desktop or by the default admin seam. */
export function createEnterpriseWorkspaceRouter(options: Readonly<{
  applicationOrigin: string;
  allowInsecureLoopbackForTests?: boolean;
  verifySession: (token: string) => Promise<VerifiedIdentity | null>;
  directory: Pick<ServerDirectory, 'listWorkspaces' | 'createWorkspace' | 'deactivateWorkspace' | 'listWorkspaceGrants' | 'setRuntimeGrant' | 'recordTenantDenial'>;
}>): Router {
  const origin = new URL(options.applicationOrigin);
  const loopback = options.allowInsecureLoopbackForTests === true;
  if (loopback && process.env.NODE_ENV !== 'test') throw new Error('Insecure enterprise workspace API requires an isolated test process');
  if (origin.origin !== options.applicationOrigin ||
      (loopback ? !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1') : origin.protocol !== 'https:')) {
    throw new Error('Invalid workspace API origin');
  }
  const sessionName = loopback ? 'interpreter-enterprise-session' : '__Host-interpreter-enterprise-session';
  const router = Router();
  async function act(req: Request, res: Response, action: 'read' | 'create' | 'deactivate' | 'read-grants' | 'change-grant'): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin, Sec-Fetch-Site');
    const mutation = action !== 'read' && action !== 'read-grants';
    if (!exactOrigin(req, origin, loopback) || req.get('authorization') ||
        (mutation ? req.get('origin') !== origin.origin || req.get('sec-fetch-site') !== 'same-origin' ||
          req.get('x-interpreter-csrf') !== '1' || !req.is('application/json') || !req.body || Array.isArray(req.body) ||
          (action === 'create' ? Object.keys(req.body).sort().join(',') !== 'id,name' ||
            typeof req.body.id !== 'string' || typeof req.body.name !== 'string' :
            action === 'change-grant' ? Object.keys(req.body).sort().join(',') !== 'action,granted,subject' ||
              typeof req.body.subject !== 'string' || typeof req.body.granted !== 'boolean' ||
              !['agent.execute', 'tool.invoke', 'simple.execute'].includes(req.body.action) : Object.keys(req.body).length !== 0)
          : (req.get('origin') && req.get('origin') !== origin.origin) ||
            (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site')!)))) {
      return void res.status(403).end();
    }
    const token = cookie(req, sessionName);
    if (!token) return void res.status(401).end();
    try {
      const identity = await options.verifySession(token);
      if (!identity?.sessionId || !identity.issuer || !identity.subject) return void res.status(403).end();
      if (identity.organizationId !== req.params.organizationId) {
        await options.directory.recordTenantDenial(identity, req.params.organizationId,
          action === 'read-grants' ? 'workspace.grants.read' : action === 'change-grant' ? 'workspace.grants.change' : `workspace.${action}`);
        return void res.status(403).end();
      }
      if (action === 'read') return void res.json({ organizationId: identity.organizationId,
        workspaces: await options.directory.listWorkspaces(identity) });
      if (action === 'read-grants') return void res.json({ organizationId: identity.organizationId,
        workspaceId: req.params.workspaceId, grants: await options.directory.listWorkspaceGrants(identity, req.params.workspaceId) });
      if (action === 'create') await options.directory.createWorkspace(identity, req.body.id, req.body.name);
      else if (action === 'deactivate') await options.directory.deactivateWorkspace(identity, req.params.workspaceId);
      else await options.directory.setRuntimeGrant(identity, req.params.workspaceId, req.body.subject, req.body.action, req.body.granted);
      return void res.status(204).end();
    } catch (error) {
      return void res.status(error instanceof EnterpriseAccessDenied ? 403 : 503).end();
    }
  }
  router.get('/organizations/:organizationId/workspaces', (req, res) => void act(req, res, 'read'));
  router.post('/organizations/:organizationId/workspaces', json({ limit: '1kb', strict: true }), (req, res) => void act(req, res, 'create'));
  router.post('/organizations/:organizationId/workspaces/:workspaceId/deactivate', json({ limit: '1kb', strict: true }),
    (req, res) => void act(req, res, 'deactivate'));
  router.get('/organizations/:organizationId/workspaces/:workspaceId/grants', (req, res) => void act(req, res, 'read-grants'));
  router.post('/organizations/:organizationId/workspaces/:workspaceId/grants', json({ limit: '1kb', strict: true }),
    (req, res) => void act(req, res, 'change-grant'));
  return router;
}

/** Explicit, unmounted self-revocation route. The server commits revocation and
 * audit before expiring the browser cookie; an outage cannot report success. */
export function createEnterpriseLogoutRouter(options: Readonly<{
  applicationOrigin: string;
  allowInsecureLoopbackForTests?: boolean;
  verifySession: (token: string) => Promise<VerifiedIdentity | null>;
  directory: Pick<ServerDirectory, 'revokeSession' | 'recordTenantDenial'>;
}>): Router {
  const origin = new URL(options.applicationOrigin);
  const loopback = options.allowInsecureLoopbackForTests === true;
  if (loopback && process.env.NODE_ENV !== 'test') throw new Error('Insecure enterprise logout requires an isolated test process');
  if (origin.origin !== options.applicationOrigin ||
      (loopback ? !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1') : origin.protocol !== 'https:')) {
    throw new Error('Invalid logout API origin');
  }
  const sessionName = loopback ? 'interpreter-enterprise-session' : '__Host-interpreter-enterprise-session';
  const router = Router();
  router.post('/organizations/:organizationId/session/logout', json({ limit: '2kb', strict: true }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin, Sec-Fetch-Site');
    if (!exactOrigin(req, origin, loopback) || req.get('origin') !== origin.origin ||
        (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin') ||
        req.get('x-interpreter-csrf') !== '1' || !req.is('application/json') ||
        req.get('authorization') || !req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
      return void res.status(403).end();
    }
    const token = cookie(req, sessionName);
    if (!token) return void res.status(401).end();
    try {
      const identity = await options.verifySession(token);
      if (!identity?.sessionId || !identity.issuer || !identity.subject) {
        return void res.status(403).end();
      }
      if (identity.organizationId !== req.params.organizationId) {
        await options.directory.recordTenantDenial(identity, req.params.organizationId, 'logout');
        return void res.status(403).end();
      }
      await options.directory.revokeSession(identity);
      res.clearCookie(sessionName, { httpOnly: true, secure: !loopback, sameSite: 'lax', path: '/' });
      return void res.status(204).end();
    } catch (error) {
      return void res.status(error instanceof EnterpriseAccessDenied ? 403 : 503).end();
    }
  });
  return router;
}
