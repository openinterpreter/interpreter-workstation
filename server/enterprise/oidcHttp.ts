import { Router, json, type Request, type Response } from 'express';
import type { TLSSocket } from 'node:tls';
import type { OidcConfiguration, OidcIntegration } from './oidc';
import type { EnterpriseDirectory, VerifiedIdentity } from './controlPlane';
import { EnterpriseAccessDenied, type ServerDirectory } from './serverDirectory';

type HttpOptions = Readonly<{
  config: OidcConfiguration;
  integration: OidcIntegration;
  /** Exact application origin and callback URI are installation-time pins, not request-derived. */
  applicationOrigin: string;
  successPath: string;
}>;

function exactOrigin(req: Request, origin: URL, loopback: boolean): boolean {
  // Do not trust X-Forwarded-* or a request body for the identity origin.
  // Inspect the actual server socket, never forwarded headers. Bun's Node
  // HTTPS-compatible socket is encrypted but is not instanceof Node TLSSocket.
  const secure = (req.socket as TLSSocket).encrypted === true;
  return req.get('host') === origin.host && (secure || (loopback && origin.protocol === 'http:'));
}

function cookie(req: Request, name: string): string | null {
  const matches = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** Not mounted by the desktop server. Requires a separately reviewed HTTPS deployment. */
export function createOidcHttpRouter({ config, integration, applicationOrigin, successPath }: HttpOptions): Router {
  const origin = new URL(applicationOrigin);
  const callback = new URL(config.redirectUri);
  const loopback = config.allowInsecureLoopbackForTests === true;
  if (loopback && process.env.NODE_ENV !== 'test') throw new Error('Insecure OIDC loopback requires an isolated test process');
  if (origin.origin !== callback.origin || origin.username || origin.password || callback.username || callback.password ||
      origin.pathname !== '/' || origin.search || origin.hash ||
      !successPath.startsWith('/') || successPath.startsWith('//') || successPath.includes('\\') ||
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
    try {
      const flow = await integration.begin();
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
    if (url.pathname !== callback.pathname || code.length !== 1 || state.length !== 1 ||
        !/^[A-Za-z0-9_-]{43}$/.test(state[0] ?? '') ||
        url.searchParams.size !== 2 || !binding) return void res.status(400).end();
    res.clearCookie(bindingName, cookieOptions);
    try {
      const result = await integration.complete({ code: code[0]!, state: state[0]!, browserBinding: binding });
      if (result.expiresAt <= Date.now()) return void res.status(401).end();
      res.cookie(sessionName, result.token, { ...cookieOptions, maxAge: Math.max(0, result.expiresAt - Date.now()) });
      return void res.redirect(303, successPath);
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

/** Separate, unmounted admin mutation seam. Must share the exact HTTPS origin
 * and server-owned session verifier with the read-only browser router. */
export function createEnterpriseAdminMutationRouter(options: Readonly<{
  applicationOrigin: string;
  allowInsecureLoopbackForTests?: boolean;
  verifySession: (token: string) => Promise<VerifiedIdentity | null>;
  directory: Pick<ServerDirectory, 'deactivateMember' | 'revokeMemberSessions' | 'revokeOrganizationSessions' | 'recordTenantDenial'>;
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
  async function mutate(req: Request, res: Response, action: 'deactivate' | 'revoke-sessions' | 'revoke-all-sessions'): Promise<void> {
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
  router.post('/organizations/:organizationId/members/:subject/revoke-sessions', json({ limit: '2kb', strict: true }),
    (req, res) => void mutate(req, res, 'revoke-sessions'));
  router.post('/organizations/:organizationId/sessions/revoke-all', json({ limit: '2kb', strict: true }),
    (req, res) => void mutate(req, res, 'revoke-all-sessions'));
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
