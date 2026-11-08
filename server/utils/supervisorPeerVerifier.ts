import type { Request } from 'express';
import { authorizeSupervisorPeer, type VerifiedSupervisorGrant,
  type SupervisorPeerTarget } from './supervisorPeerScope';

const ASSERTION_HEADER = 'x-interpreter-supervisor-assertion';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type SupervisorVerifierConfig = Readonly<{
  verifyUrl: string;
  audience: string;
  targetComputer: string;
}>;

/** This opt-in transport only accepts a grant validated by the enrolled remote
 * verifier using the target machine's own identity. An assertion is not a grant. */
export function createSupervisorPeerVerifier(config: SupervisorVerifierConfig,
  deps: Readonly<{ fetcher?: typeof fetch; identity?: (audience: string) => Promise<string> }> = {}) {
  const url = new URL(config.verifyUrl);
  const audience = new URL(config.audience);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      audience.protocol !== 'https:' || audience.username || audience.password ||
      config.audience !== url.origin ||
      !ID.test(config.targetComputer)) throw new Error('Supervisor verifier unavailable.');
  const fetcher = deps.fetcher ?? fetch;
  const identity = deps.identity ?? (async (scope: string) => {
    const endpoint = new URL('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity');
    endpoint.searchParams.set('audience', scope);
    endpoint.searchParams.set('format', 'full');
    const result = await fetcher(endpoint, { headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2_000), redirect: 'error' });
    if (!result.ok || Number(result.headers.get('content-length') ?? 0) > 8_192) throw new Error('Identity unavailable.');
    const token = (await result.text()).trim();
    if (token.length > 8_192 || !TOKEN.test(token)) throw new Error('Identity unavailable.');
    return token;
  });
  return async (request: Request): Promise<VerifiedSupervisorGrant | null> => {
    const assertion = request.get(ASSERTION_HEADER);
    if (!assertion || assertion.length > 4_096 || !/^[A-Za-z0-9._-]+$/.test(assertion)) return null;
    const threadId = request.params.threadId;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId)) return null;
    const capability: SupervisorPeerTarget['capability'] | undefined =
      request.path.endsWith('/goal/create') ? 'goal:create' :
      request.path.endsWith('/goal/resume') ? 'goal:resume' :
      request.path.endsWith('/goal') ? 'goal:read' :
      request.path.endsWith('/terminals/status') ? 'command:read' :
      request.path.endsWith('/turns/current') ? 'task:read' :
      request.path.includes('/submissions/') ? 'task:read' :
      request.path.includes('/artifacts/') ? 'artifact:read' : undefined;
    if (!capability) return null;
    try {
      const token = await identity(config.audience);
      if (token.length > 8_192 || !TOKEN.test(token)) return null;
      const response = await fetcher(url, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(4_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'verify', assertion, targetComputer: config.targetComputer,
          threadId, capability }) });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4_096) return null;
      const raw = await response.text();
      if (raw.length > 4_096) return null;
      const grant = JSON.parse(raw) as VerifiedSupervisorGrant;
      if (!grant || typeof grant.sourceComputer !== 'string' ||
          !Array.isArray(grant.capabilities)) return null;
      return authorizeSupervisorPeer(grant, { sourceComputer: grant.sourceComputer,
        targetComputer: config.targetComputer, threadId, capability }) === 'allowed' ? grant : null;
    } catch { return null; }
  };
}
