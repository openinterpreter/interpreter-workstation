import { Router, type Request, type Response } from 'express';
import { TLSSocket } from 'node:tls';
import type { OidcConfiguration, OidcIntegration } from './oidc';

type HttpOptions = Readonly<{
  config: OidcConfiguration;
  integration: OidcIntegration;
  /** Exact application origin and callback URI are installation-time pins, not request-derived. */
  applicationOrigin: string;
  successPath: string;
}>;

function exactOrigin(req: Request, origin: URL, loopback: boolean): boolean {
  // Do not trust X-Forwarded-* or a request body for the identity origin.
  const secure = req.socket instanceof TLSSocket && req.socket.encrypted;
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
  if (origin.origin !== callback.origin || origin.pathname !== '/' || origin.search || origin.hash ||
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
