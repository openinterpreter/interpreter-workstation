/** Unmounted connected-project boundary. A production host must supply verified identity and durable quota. */
export type VerifiedProjectSession = {
  tenantId: string;
  subjectId: string;
  projectId: string;
  csrf: string;
  allowedPaths: readonly string[];
  providerLabel: string;
};
export type ProjectIdentity = { tenantId: string; subjectId: string };
export type ModelProposalPort = (input: {
  message: string;
  selectedFile: { name: string; content: string; expectedRevision: string | null };
  providerLabel: string;
}) => Promise<{ reply: string; proposal: { name: string; content: string; expectedRevision: string | null } | null }>;
export type ConnectedBoundaryDeps = {
  /** Verify a signed, unexpired first-party cookie; never trust a client-supplied subject. */
  verifySession(request: Request): Promise<ProjectIdentity | null>;
  /** Resolve ownership for this identity on EVERY request. */
  ownProject(identity: ProjectIdentity, projectId: string): Promise<VerifiedProjectSession | null>;
  /** Atomically enforce per-user rate/cost quota and unique id BEFORE inference. */
  reserve(identity: ProjectIdentity, projectId: string, clientMessageId: string): Promise<boolean>;
  /** Inference-only port. No shell, filesystem, browser or host tool access. */
  model: ModelProposalPort;
};

const encoder = new TextEncoder();
const ids = /^[A-Za-z0-9_-]{1,64}$/;
const revision = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const filePath = (path: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(path) &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Injected identity/quota/model dependencies make this a contract, not an open route. */
export function connectedProjectBoundary(deps: ConnectedBoundaryDeps, origin: string) {
  const trusted = new URL(origin);
  if (trusted.origin !== origin || (trusted.protocol !== 'https:' &&
    !(trusted.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(trusted.hostname))))
    throw new Error('Connected project origin must be secure');
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== origin || (request.method !== 'GET' && request.headers.get('origin') !== origin) ||
        (request.method === 'GET' && request.headers.has('origin') &&
          request.headers.get('origin') !== origin) ||
        (request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin'))
      return json({ error: 'origin' }, 403);
    if (url.pathname !== '/api/browser-project/v1/session' &&
        url.pathname !== '/api/browser-project/v1/proposals') return json({ error: 'route' }, 404);
    const identity = await deps.verifySession(request);
    if (!identity || !ids.test(identity.subjectId) || !ids.test(identity.tenantId))
      return json({ error: 'unauthenticated' }, 401);
    if (url.pathname.endsWith('/session') && request.method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId || !ids.test(projectId)) return json({ error: 'project' }, 400);
      const owner = await deps.ownProject(identity, projectId);
      if (!owner || owner.subjectId !== identity.subjectId || owner.tenantId !== identity.tenantId ||
          owner.projectId !== projectId || !owner.allowedPaths.every(filePath))
        return json({ error: 'forbidden' }, 403);
      return json({ version: 1, authenticated: true, projectId, tenantId: identity.tenantId,
        subjectId: identity.subjectId, access: 'propose-only', csrf: owner.csrf,
        allowedPaths: owner.allowedPaths, providerLabel: owner.providerLabel });
    }
    if (!url.pathname.endsWith('/proposals') || request.method !== 'POST')
      return json({ error: 'method' }, 405);
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return json({ error: 'content-type' }, 415);
    const raw = await request.text();
    if (encoder.encode(raw).byteLength > 70 * 1024) return json({ error: 'size' }, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return json({ error: 'json' }, 400); }
    if (!record(body) || Object.keys(body).sort().join(',') !==
        'clientMessageId,consent,message,projectId,selectedFile,version' ||
        body.version !== 1 || body.consent !== true || typeof body.projectId !== 'string' ||
        !ids.test(body.projectId) || typeof body.clientMessageId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(body.clientMessageId) || typeof body.message !== 'string' ||
        !body.message.trim() || encoder.encode(body.message).byteLength > 1200 ||
        !record(body.selectedFile) || Object.keys(body.selectedFile).sort().join(',') !==
        'content,expectedRevision,name' || typeof body.selectedFile.name !== 'string' ||
        !filePath(body.selectedFile.name) || typeof body.selectedFile.content !== 'string' ||
        encoder.encode(body.selectedFile.content).byteLength > 64 * 1024 ||
        !revision(body.selectedFile.expectedRevision)) return json({ error: 'input' }, 400);
    const owner = await deps.ownProject(identity, body.projectId);
    if (!owner || owner.subjectId !== identity.subjectId || owner.tenantId !== identity.tenantId ||
        owner.projectId !== body.projectId ||
        !owner.allowedPaths.includes(body.selectedFile.name) ||
        request.headers.get('x-workstation-project-csrf') !== owner.csrf)
      return json({ error: 'forbidden' }, 403);
    if (!(await deps.reserve(identity, body.projectId, body.clientMessageId)))
      return json({ error: 'quota-or-duplicate' }, 429);
    const result = await deps.model({ message: body.message, selectedFile: {
      name: body.selectedFile.name, content: body.selectedFile.content,
      expectedRevision: body.selectedFile.expectedRevision,
    }, providerLabel: owner.providerLabel });
    const proposal = result.proposal;
    if (typeof result.reply !== 'string' || encoder.encode(result.reply).byteLength > 2048 ||
        (proposal !== null && (!record(proposal) ||
          Object.keys(proposal).sort().join(',') !== 'content,expectedRevision,name' ||
          proposal.name !== body.selectedFile.name ||
          proposal.expectedRevision !== body.selectedFile.expectedRevision ||
          typeof proposal.content !== 'string' ||
          encoder.encode(proposal.content).byteLength > 64 * 1024)))
      return json({ error: 'model-output' }, 502);
    return json({ version: 1, reply: result.reply, proposal });
  };
}
