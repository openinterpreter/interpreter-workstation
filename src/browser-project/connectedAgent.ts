import { applyApprovedEdit, MAX_PROJECT_FILE_BYTES, projectFileName, type ProjectFiles } from './project';

/** Proposal-only connected runtime. The OIX/native app-server is NOT a visitor API. */
export const CONNECTED_PROJECT_VERSION = 1;
export const CONNECTED_MAX_MESSAGE_BYTES = 1200;
export const CONNECTED_MAX_SHARED_FILE_BYTES = 64 * 1024;

export type ConnectedSession = {
  version: 1;
  authenticated: true;
  projectId: string;
  tenantId: string;
  subjectId: string;
  access: 'propose-only';
  csrf: string;
  allowedPaths: string[];
  providerLabel: string;
};
export type ConnectedProposal = {
  name: string;
  content: string;
  expectedRevision: string | null;
};
export type ConnectedReply = {
  version: 1;
  reply: string;
  proposal: ConnectedProposal | null;
};
type Fetcher = typeof fetch;

const encoder = new TextEncoder();
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function revision(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value));
}
function assertExactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(',') !== keys.sort().join(','))
    throw new Error('Unsupported connected project response');
}
function validateProjectId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error('Invalid connected project ID');
  return value;
}
function validateFile(value: unknown, session: ConnectedSession): ConnectedProposal {
  if (!record(value)) throw new Error('Invalid connected project file');
  assertExactKeys(value, ['name', 'content', 'expectedRevision']);
  if (typeof value.name !== 'string' || typeof value.content !== 'string' ||
      !revision(value.expectedRevision)) throw new Error('Invalid connected project file');
  const name = projectFileName(value.name);
  if (!session.allowedPaths.includes(name) ||
      encoder.encode(value.content).byteLength > CONNECTED_MAX_SHARED_FILE_BYTES ||
      encoder.encode(value.content).byteLength > MAX_PROJECT_FILE_BYTES)
    throw new Error('Connected project file is outside granted scope');
  return { name, content: value.content, expectedRevision: value.expectedRevision };
}

/** Only a same-origin TLS or loopback endpoint can receive a first-party session cookie. */
export function connectedEndpoint(base: string, pageUrl: string): URL {
  const page = new URL(pageUrl);
  const endpoint = new URL(base, page);
  if (endpoint.origin !== page.origin || endpoint.pathname !== '/' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash ||
      !(endpoint.protocol === 'https:' ||
        (endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))))
    throw new Error('Connected project backend must use this secure page origin');
  return new URL('api/browser-project/v1/', endpoint.href.endsWith('/') ? endpoint : `${endpoint.href}/`);
}

export class ConnectedProjectAgent {
  private session: ConnectedSession | null = null;
  private readonly endpoint: URL;
  constructor(base: string, pageUrl: string, private readonly transport: Fetcher = fetch) {
    this.endpoint = connectedEndpoint(base, pageUrl);
  }

  async connect(projectId: string): Promise<ConnectedSession> {
    this.session = null;
    projectId = validateProjectId(projectId);
    const url = new URL(`session?projectId=${encodeURIComponent(projectId)}`, this.endpoint);
    const response = await this.transport(url.href, { method: 'GET', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`Connected project session unavailable (${response.status})`);
    const value: unknown = await response.json();
    if (!record(value)) throw new Error('Invalid connected project session');
    assertExactKeys(value, ['version', 'authenticated', 'projectId', 'tenantId', 'subjectId',
      'access', 'csrf', 'allowedPaths', 'providerLabel']);
    if (value.version !== 1 || value.authenticated !== true || value.projectId !== projectId ||
        value.access !== 'propose-only' || typeof value.tenantId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(value.tenantId) ||
        typeof value.subjectId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.subjectId) ||
        typeof value.csrf !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.csrf) ||
        typeof value.providerLabel !== 'string' || value.providerLabel.length > 80 ||
        !Array.isArray(value.allowedPaths) || value.allowedPaths.length > 16 ||
        value.allowedPaths.some(path => typeof path !== 'string' || projectFileName(path) !== path))
      throw new Error('Invalid connected project session');
    this.session = value as ConnectedSession;
    return this.session;
  }

  async propose(input: { projectId: string; message: string; selectedFile: ConnectedProposal;
    clientMessageId: string; consent: boolean }): Promise<ConnectedReply> {
    const session = this.session;
    if (!session || session.projectId !== input.projectId) throw new Error('Connected project session required');
    if (input.consent !== true) throw new Error('Explicit provider/file-sharing consent required');
    if (!/^[0-9a-f]{32}$/.test(input.clientMessageId) || !input.message.trim() ||
        encoder.encode(input.message).byteLength > CONNECTED_MAX_MESSAGE_BYTES)
      throw new Error('Invalid connected project message');
    const selectedFile = validateFile(input.selectedFile, session);
    const response = await this.transport(new URL('proposals', this.endpoint).href, { method: 'POST',
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'X-Workstation-Project-Csrf': session.csrf },
      body: JSON.stringify({ version: 1, projectId: session.projectId, message: input.message,
        clientMessageId: input.clientMessageId, consent: true, selectedFile }),
    });
    if (!response.ok) throw new Error(`Connected project proposal unavailable (${response.status})`);
    const value: unknown = await response.json();
    if (!record(value)) throw new Error('Invalid connected project reply');
    assertExactKeys(value, ['version', 'reply', 'proposal']);
    if (value.version !== 1 || typeof value.reply !== 'string' ||
        encoder.encode(value.reply).byteLength > 2048)
      throw new Error('Invalid connected project reply');
    const proposal = value.proposal === null ? null : validateFile(value.proposal, session);
    if (proposal && (proposal.name !== selectedFile.name ||
        proposal.expectedRevision !== selectedFile.expectedRevision))
      throw new Error('Connected proposal changed the selected file or revision');
    return { version: 1, reply: value.reply, proposal };
  }
}

/** The model can propose but cannot write. UI must show the diff and collect approval. */
export async function applyConnectedProposal(files: ProjectFiles, proposal: ConnectedProposal,
  session: ConnectedSession, approved: boolean): Promise<string> {
  if (approved !== true) throw new Error('Explicit edit approval required');
  const edit = validateFile(proposal, session);
  return applyApprovedEdit(files, { ...edit, approved: true });
}
