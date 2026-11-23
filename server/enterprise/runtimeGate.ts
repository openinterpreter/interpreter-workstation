import type { RequestHandler } from 'express';
import type { TLSSocket } from 'node:tls';
import { getWorkstationHostPolicy } from '../workstationConnection';
import { EnterpriseAccessDenied, verifiedDomainName, type ServerDirectory } from './serverDirectory';

type RuntimeAction = 'agent.execute' | 'tool.invoke' | 'simple.execute';

function requestAuthorityMatches(req: Parameters<RequestHandler>[0], origin: URL): boolean {
  // Absolute-form request targets can name a different authority even when
  // Host, Origin and the route path appear to match the application origin.
  try { return new URL(req.originalUrl, origin).origin === origin.origin; }
  catch { return false; }
}

/** Only a separately mounted execution route may call this; it is not wired
 * into the desktop or browser product. A true decision must never be treated
 * as a long-lived tool lease or as authority for native IPC. */
export function createEnterpriseRuntimeGate(options: Readonly<{
  applicationOrigin: string;
  organizationId: string;
  issuer: string;
  accountDomain?: string;
  workspaceId: string;
  action: RuntimeAction;
  /** Exact relative route below this middleware's mount, not a namespace-wide
   * authority. A grant for one IPC method must not unlock settings or files. */
  routePath: string;
  directory: Pick<ServerDirectory, 'verifySession' | 'verifyBoundSession' | 'authorizeRuntime'>;
  allowInsecureLoopbackForTests?: boolean;
}>): RequestHandler {
  const origin = new URL(options.applicationOrigin);
  const loopback = options.allowInsecureLoopbackForTests === true && process.env.NODE_ENV === 'test';
  let validIssuer = false;
  try {
    const issuer = new URL(options.issuer);
    validIssuer = (issuer.protocol === 'https:' || (loopback && issuer.protocol === 'http:' && issuer.hostname === '127.0.0.1')) &&
      !issuer.username && !issuer.password && !issuer.search && !issuer.hash;
  } catch { /* Invalid issuer must not produce a mounted execution gate. */ }
  if (origin.origin !== options.applicationOrigin || origin.username || origin.password || origin.search || origin.hash ||
      (loopback ? !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1') : origin.protocol !== 'https:') ||
      !/^[A-Za-z0-9._@:-]{1,160}$/.test(options.organizationId) ||
      !/^[A-Za-z0-9._@:-]{1,160}$/.test(options.workspaceId) || !validIssuer ||
      !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/.test(options.routePath) ||
      !['agent.execute', 'tool.invoke', 'simple.execute'].includes(options.action) ||
      (!loopback && (!options.accountDomain || verifiedDomainName(options.accountDomain) !== options.accountDomain))) {
    throw new Error('Enterprise runtime requires a pinned origin, tenant, workspace and account domain');
  }
  if (getWorkstationHostPolicy().remote) throw new Error('Enterprise runtime cannot share a remote Workstation host session');
  const { organizationId, issuer, accountDomain, workspaceId, action, routePath, directory } = options;
  const cookieName = loopback ? 'interpreter-enterprise-session' : '__Host-interpreter-enterprise-session';
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin, Sec-Fetch-Site');
    if (getWorkstationHostPolicy().remote) return void res.status(503).end();
    if (req.method !== 'POST' || req.path !== routePath || !requestAuthorityMatches(req, origin) ||
        req.get('host') !== origin.host ||
        (!(req.socket as TLSSocket).encrypted && !loopback) || req.get('origin') !== origin.origin ||
        req.get('sec-fetch-site') !== 'same-origin' || req.get('x-interpreter-csrf') !== '1' ||
        req.get('authorization')) return void res.status(403).end();
    const values = (req.headers.cookie ?? '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`));
    if (values.length !== 1) return void res.status(401).end();
    const token = values[0]!.slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return void res.status(401).end();
    try {
      const identity = loopback ? await directory.verifySession(token)
        : await directory.verifyBoundSession(token, accountDomain!);
      if (!identity) return void res.status(403).end();
      // Pin tenant and issuer before asking the directory to authorize or
      // append an audit event. A foreign but valid session must not create a
      // runtime event in its own tenant for this tenant's execution route.
      if (identity.organizationId !== organizationId || identity.issuer !== issuer) {
        return void res.status(403).end();
      }
      const allowed = await directory.authorizeRuntime(identity, action, workspaceId);
      if (!allowed) return void res.status(403).end();
      next();
    } catch (error) {
      return void res.status(error instanceof EnterpriseAccessDenied ? 403 : 503).end();
    }
  };
}
