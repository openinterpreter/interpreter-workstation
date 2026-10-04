import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import type {
  WorkstationAccess,
  WorkstationAuthentication,
  WorkstationConnectionDescriptor,
  WorkstationPairingPayload,
  WorkstationPairingSession,
} from '../shared/types/workstationConnection';
import { resolveInterpreterDataDir } from '../shared/interpreterConfigPaths';
import { getActiveSimpleProject } from './simpleProjects';
import { getServerPort } from './utils/serverPort';
import {
  disableTailscaleServe,
  enableTailscaleServe,
  inspectTailscaleRemote,
} from './tailscaleRemote';

const SESSION_COOKIE = 'interpreter_workstation_session';
const DEFAULT_SESSION_SECONDS = 60 * 60 * 24 * 14;
const DEFAULT_PAIRING_SECONDS = 5 * 60;

type RuntimePairingPolicy = {
  endpoint: string;
  allowedOrigins: string[];
  sessionSecret: string;
  persisted: boolean;
};

type PendingPairing = {
  digest: string;
  expiresAt: number;
  endpoint: string;
  hostName: string;
  projectId: string;
  projectName: string;
  projectPathHint: string;
};

let runtimePairingPolicy: RuntimePairingPolicy | null = null;
const pendingPairings = new Map<string, PendingPairing>();

function pairingPolicyPath(): string {
  return path.join(resolveInterpreterDataDir(), 'private-workstation.json');
}

function persistRuntimePairingPolicy(policy: RuntimePairingPolicy | null): void {
  const filePath = pairingPolicyPath();
  if (!policy) {
    try { unlinkSync(filePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return;
  }
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const persistedPolicy = {
    endpoint: policy.endpoint,
    allowedOrigins: policy.allowedOrigins,
    sessionSecret: policy.sessionSecret,
  };
  writeFileSync(temporaryPath, `${JSON.stringify(persistedPolicy)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, filePath);
}

function restoreRuntimePairingPolicy(): RuntimePairingPolicy | null {
  if (process.env.NODE_ENV === 'test') return null;
  try {
    const value = JSON.parse(readFileSync(pairingPolicyPath(), 'utf8')) as Partial<RuntimePairingPolicy>;
    if (typeof value.endpoint !== 'string'
      || !Array.isArray(value.allowedOrigins)
      || !value.allowedOrigins.every((origin) => typeof origin === 'string')
      || typeof value.sessionSecret !== 'string'
      || value.sessionSecret.length < 32) return null;
    const endpoint = new URL(value.endpoint);
    if (endpoint.protocol !== 'https:') return null;
    return {
      endpoint: endpoint.toString().replace(/\/$/, ''),
      allowedOrigins: value.allowedOrigins,
      sessionSecret: value.sessionSecret,
      persisted: true,
    };
  } catch {
    return null;
  }
}

runtimePairingPolicy = restoreRuntimePairingPolicy();

export type WorkstationHostPolicy = {
  remote: boolean;
  access: WorkstationAccess;
  authentication: WorkstationAuthentication;
  password: string | null;
  sessionSecret: string | null;
  sessionSeconds: number;
  allowedOrigins: string[];
  secureCookie: boolean;
};

function normalizedOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function getWorkstationHostPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): WorkstationHostPolicy {
  if (runtimePairingPolicy) {
    return {
      remote: true,
      access: 'read-write',
      authentication: 'pairing',
      password: null,
      sessionSecret: runtimePairingPolicy.sessionSecret,
      sessionSeconds: DEFAULT_SESSION_SECONDS,
      allowedOrigins: runtimePairingPolicy.allowedOrigins,
      secureCookie: true,
    };
  }
  const configuredAccess = environment.INTERPRETER_WORKSTATION_ACCESS?.trim();
  const remote = configuredAccess === 'read-only' || configuredAccess === 'read-write';
  const access: WorkstationAccess = configuredAccess === 'read-only' ? 'read-only' : 'read-write';
  const configuredAuthentication = environment.INTERPRETER_WORKSTATION_AUTH?.trim();
  const authentication: WorkstationAuthentication = configuredAuthentication === 'password'
    ? 'password'
    : configuredAuthentication === 'pairing'
      ? 'pairing'
      : 'none';
  const password = environment.INTERPRETER_WORKSTATION_PASSWORD?.trim() || null;
  const sessionSecret = environment.INTERPRETER_WORKSTATION_SESSION_SECRET?.trim()
    || password;
  const configuredSessionSeconds = Number(environment.INTERPRETER_WORKSTATION_SESSION_SECONDS);

  return {
    remote,
    access,
    authentication,
    password,
    sessionSecret,
    sessionSeconds: Number.isInteger(configuredSessionSeconds) && configuredSessionSeconds > 0
      ? configuredSessionSeconds
      : DEFAULT_SESSION_SECONDS,
    allowedOrigins: normalizedOrigins(environment.INTERPRETER_WORKSTATION_ALLOWED_ORIGINS),
    secureCookie: environment.INTERPRETER_WORKSTATION_SECURE_COOKIE === '1',
  };
}

export function enableRuntimeWorkstationPairing(input: {
  endpoint: string;
  allowedOrigins?: string[];
  persist?: boolean;
}): void {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'https:') throw new Error('Remote Workstation requires a private HTTPS endpoint.');
  endpoint.pathname = '';
  endpoint.search = '';
  endpoint.hash = '';
  const normalizedEndpoint = endpoint.toString().replace(/\/$/, '');
  runtimePairingPolicy = {
    endpoint: normalizedEndpoint,
    allowedOrigins: input.allowedOrigins?.length ? input.allowedOrigins : [normalizedEndpoint],
    sessionSecret: randomBytes(32).toString('base64url'),
    persisted: input.persist === true,
  };
  if (input.persist) persistRuntimePairingPolicy(runtimePairingPolicy);
  pendingPairings.clear();
}

export function disableRuntimeWorkstationPairing(persist = false): void {
  runtimePairingPolicy = null;
  if (persist) persistRuntimePairingPolicy(null);
  pendingPairings.clear();
}

export function getRuntimeWorkstationPairingEndpoint(): string | null {
  return runtimePairingPolicy?.endpoint ?? null;
}

export function validateWorkstationHostPolicy(policy: WorkstationHostPolicy): void {
  if (!policy.remote) return;
  if (policy.authentication === 'password' && (!policy.password || !policy.sessionSecret)) {
    throw new Error(
      'Remote Workstation password authentication requires INTERPRETER_WORKSTATION_PASSWORD.',
    );
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function signature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function createSessionValue(policy: WorkstationHostPolicy, now = Date.now()): string {
  if (!policy.sessionSecret) throw new Error('Workstation session signing is not configured.');
  const expiresAt = Math.floor(now / 1000) + policy.sessionSeconds;
  const payload = `v1.${expiresAt}`;
  return `${payload}.${signature(payload, policy.sessionSecret)}`;
}

function sessionCookie(value: string, policy: WorkstationHostPolicy, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    secure ? 'Secure' : '',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${policy.sessionSeconds}`,
  ].filter(Boolean).join('; ');
}

function bearerValue(request: Request): string | null {
  const header = request.header('authorization');
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1]?.trim() || null;
}

function validSessionValue(session: string | null, policy: WorkstationHostPolicy, now = Date.now()): boolean {
  if (!session || !policy.sessionSecret) return false;
  const match = /^v1\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(session);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  const payload = `v1.${expiresAt}`;
  return safeEqual(match[2], signature(payload, policy.sessionSecret));
}

function cookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.header('cookie');
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return null;
}

export function isWorkstationSessionAuthenticated(
  request: Request,
  policy: WorkstationHostPolicy,
  now = Date.now(),
): boolean {
  if (!policy.remote || policy.authentication === 'none') return true;
  return validSessionValue(bearerValue(request), policy, now)
    || validSessionValue(cookieValue(request, SESSION_COOKIE), policy, now);
}

function isLoopbackRequest(request: Request): boolean {
  const address = request.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isDirectLoopbackRequest(request: Request): boolean {
  if (!isLoopbackRequest(request)) return false;
  const host = request.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function purgeExpiredPairings(now = Date.now()): void {
  for (const [key, pairing] of pendingPairings) {
    if (pairing.expiresAt <= now) pendingPairings.delete(key);
  }
}

function issuePairing(input: Omit<PendingPairing, 'digest' | 'expiresAt' | 'endpoint'>): WorkstationPairingPayload {
  if (!runtimePairingPolicy) throw new Error('Private remote access is not enabled.');
  purgeExpiredPairings();
  const pairingToken = randomBytes(24).toString('base64url');
  const digest = createHash('sha256').update(pairingToken).digest('hex');
  const expiresAt = Date.now() + DEFAULT_PAIRING_SECONDS * 1000;
  pendingPairings.set(digest, {
    ...input,
    digest,
    expiresAt,
    endpoint: runtimePairingPolicy.endpoint,
  });
  return {
    schemaVersion: 1,
    endpoint: runtimePairingPolicy.endpoint,
    pairingToken,
    expiresAt: new Date(expiresAt).toISOString(),
    hostName: input.hostName,
    projectId: input.projectId,
    projectName: input.projectName,
    projectPathHint: input.projectPathHint,
  };
}

function redeemPairing(token: string): WorkstationPairingSession | null {
  if (!runtimePairingPolicy) return null;
  purgeExpiredPairings();
  const digest = createHash('sha256').update(token).digest('hex');
  const pairing = pendingPairings.get(digest);
  if (!pairing || pairing.expiresAt <= Date.now()) return null;
  pendingPairings.delete(digest);
  const policy = getWorkstationHostPolicy();
  const accessToken = createSessionValue(policy);
  const expiresAtSeconds = Number(/^v1\.(\d+)\./.exec(accessToken)?.[1] ?? 0);
  return {
    schemaVersion: 1,
    endpoint: pairing.endpoint,
    accessToken,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    access: policy.access,
  };
}

function requestOrigin(request: Request): string | null {
  const origin = request.header('origin')?.replace(/\/+$/, '');
  return origin || null;
}

function authorizePairingOrigin(origin: string | null): void {
  if (!runtimePairingPolicy || !origin) return;
  // Packaged Electron renderers have an opaque `file://` origin, serialized by
  // browsers as the literal `null`. It is safe only after possession of the
  // single-use pairing secret, and the resulting bearer remains mandatory.
  if (origin === 'null') {
    if (!runtimePairingPolicy.allowedOrigins.includes(origin)) {
      runtimePairingPolicy = {
        ...runtimePairingPolicy,
        allowedOrigins: [...runtimePairingPolicy.allowedOrigins, origin],
      };
      if (runtimePairingPolicy.persisted) persistRuntimePairingPolicy(runtimePairingPolicy);
    }
    return;
  }
  const parsed = new URL(origin);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new Error('The connecting app origin is invalid.');
  }
  const normalized = parsed.origin;
  if (runtimePairingPolicy.allowedOrigins.includes(normalized)) return;
  runtimePairingPolicy = {
    ...runtimePairingPolicy,
    allowedOrigins: [...runtimePairingPolicy.allowedOrigins, normalized],
  };
  if (runtimePairingPolicy.persisted) persistRuntimePairingPolicy(runtimePairingPolicy);
}

function ownOrigin(request: Request): string {
  const forwardedProto = request.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto || request.protocol;
  return `${protocol}://${request.get('host')}`.replace(/\/+$/, '');
}

function isAllowedOrigin(request: Request, policy: WorkstationHostPolicy): boolean {
  const origin = requestOrigin(request);
  if (!origin) return false;
  const allowed = policy.allowedOrigins.length > 0
    ? policy.allowedOrigins
    : [ownOrigin(request)];
  return allowed.includes(origin);
}

function isPublicPublicationPath(path: string): boolean {
  return path === '/api/public-thread'
    || path.startsWith('/api/public-thread/')
    || path === '/api/public-workspace'
    || path.startsWith('/api/public-workspace/');
}

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

// This is a security boundary. Keep it explicit: a newly added handler must be
// reviewed before a read-only host can call it. Method-name conventions are not
// authority because a query-shaped name can still mutate state.
const READ_ONLY_IPC_OPERATIONS = new Set([
  'approvals.get', 'agentTabs.getPending', 'workspace.get',
  'vault.getSnapshot', 'vault.getNoteContext', 'vault.getTags', 'vault.searchNotes',
  'settings.get', 'settings.getBackgroundOpacity', 'profiles.list', 'profiles.get',
  'userName.get', 'userEmail.get', 'onboardingPersona.get', 'onboardingState.get',
  'onboardingPermissions.get', 'locale.get', 'whatsNew.getDismissed',
  'topNotices.list', 'interviewInvite.getStatus', 'telemetry.get',
  'providers.list', 'providers.get', 'providers.getOAuthStatus',
  'providers.listOpenAIOAuthModels', 'providers.listOpenRouterModels',
  'providers.listDeepSeekModels', 'providers.listInterpreterProviders',
  'providers.listInterpreterModels', 'providers.listInterpreterHarnesses',
  'providers.getOllamaStatus', 'providers.getLmStudioStatus',
  'providers.getEnvApiKeys', 'providers.getEnvApiKey', 'providers.getClaudeCodeStatus',
  'providers.getCodexStatus', 'providers.getGitHubCliAuth',
  'providers.probeResponsesApiSupport', 'providers.getAllProfileStatuses',
  'toolServers.getSnapshot', 'servers.list', 'servers.get', 'checkpoint.get',
  'checkpoint.getSettings', 'conversations.list', 'conversations.listWithPreviews',
  'files.read', 'files.isDirectory', 'files.listDirectory', 'files.getThumbnails',
  'files.getStats', 'officeExtension.checkInstalled', 'tts.getSettings',
  'tts.listModels', 'tts.getVoices', 'stt.getSettings', 'browser.getState',
  'browser.getPersistedTabs', 'browserControl.getStatus', 'browserControl.getPolicy',
  'backgroundOpacity.get', 'zoomFactor.get', 'theme.get', 'primaryColor.get',
  'agentSettings.getMaxSteps', 'agentSettings.getMaxSubagentDepth',
  'agentSettings.getAutoContinuationLimit', 'overlaySettings.get',
  'overlaySettings.getPermissionStatus', 'computerUseSetup.ready',
  'mcpSettings.getAllowAgentAddTools', 'mcpSettings.getAllowLocalMcpServers',
  'globalTools.list', 'globalTools.get', 'nativeTools.getNetworkAccess',
  'nativeTools.getSandboxNetworkAccess', 'nativeTools.getApprovalPolicy',
  'nativeTools.getSandboxMode', 'nativeTools.getReadAccessMode',
  'nativeTools.getMacosTempAccess', 'nativeTools.getMacosScreenshotAccess',
  'nativeTools.getCuaAccessPolicy', 'nativeTools.getApprovalAutoApproveForTests',
  'skills.list', 'skillSettings.getFolders', 'skillSettings.getAllowModelSkillEditing',
  'skillSettings.getGlobalFolder',
]);

export function isReadOnlyWorkstationRequest(request: Pick<Request, 'method' | 'path'>): boolean {
  if (isSafeMethod(request.method)) return true;
  if (request.method !== 'POST') return false;
  const match = /^\/api\/ipc\/([^/]+)\/([^/]+)$/.exec(request.path);
  if (!match) return false;
  return READ_ONLY_IPC_OPERATIONS.has(`${match[1]}.${match[2]}`);
}

export function workstationCorsMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const policy = getWorkstationHostPolicy();
  const origin = requestOrigin(request);
  const isPairingRedemption = request.path === '/api/workstation-connection/pairings/redeem';

  if (!policy.remote) {
    response.header('Access-Control-Allow-Origin', '*');
  } else if (isPairingRedemption && origin) {
    response.header('Access-Control-Allow-Origin', origin);
    response.header('Vary', 'Origin');
  } else if (isDirectLoopbackRequest(request) && origin) {
    response.header('Access-Control-Allow-Origin', origin);
    response.header('Access-Control-Allow-Credentials', 'true');
    response.header('Vary', 'Origin');
  } else if (origin && isAllowedOrigin(request, policy)) {
    response.header('Access-Control-Allow-Origin', origin);
    response.header('Access-Control-Allow-Credentials', 'true');
    response.header('Vary', 'Origin');
  }
  response.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  response.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') {
    if (policy.remote
      && origin
      && !isPairingRedemption
      && !isDirectLoopbackRequest(request)
      && !isAllowedOrigin(request, policy)) {
      response.status(403).json({ error: 'Origin is not allowed.' });
      return;
    }
    response.status(204).end();
    return;
  }

  next();
}

export function workstationAccessMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const policy = getWorkstationHostPolicy();
  const isApplicationApi = request.path === '/api'
    || request.path.startsWith('/api/')
    || request.path === '/mcp'
    || request.path.startsWith('/mcp/');
  if (!policy.remote || !isApplicationApi || isPublicPublicationPath(request.path)) {
    next();
    return;
  }


  // Tailscale Serve reaches this process over loopback too, so the socket
  // address alone is not authority. Only an explicitly loopback Host is the
  // local desktop/browser bridge; tailnet hostnames still require a session.
  if (isDirectLoopbackRequest(request)) {
    next();
    return;
  }

  if (!isWorkstationSessionAuthenticated(request, policy)) {
    response.status(401).json({ error: 'Authentication required.' });
    return;
  }

  if (!isSafeMethod(request.method) && !isAllowedOrigin(request, policy)) {
    response.status(403).json({ error: 'Request origin is not allowed.' });
    return;
  }

  if (policy.access === 'read-only' && !isReadOnlyWorkstationRequest(request)) {
    response.status(403).json({ error: 'This Workstation connection is read-only.' });
    return;
  }

  next();
}

export function createWorkstationConnectionRouter(): Router {
  const router = Router();

  router.get('/', (request, response) => {
    const policy = getWorkstationHostPolicy();
    const authenticated = isWorkstationSessionAuthenticated(request, policy);
    const descriptor: WorkstationConnectionDescriptor = {
      schemaVersion: 1,
      host: policy.remote ? 'remote' : 'local',
      access: policy.access,
      authentication: {
        method: policy.authentication,
        required: policy.remote && policy.authentication !== 'none',
        authenticated,
      },
    };
    response.setHeader('Cache-Control', 'no-store');
    response.json(descriptor);
  });

  router.get('/tailscale', async (request, response) => {
    if (!isDirectLoopbackRequest(request)) {
      response.status(403).json({ error: 'Tailscale host status is only available on this computer.' });
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      ...(await inspectTailscaleRemote()),
      enabled: getRuntimeWorkstationPairingEndpoint() !== null,
    });
  });

  router.post('/tailscale/enable', async (request, response) => {
    if (!isDirectLoopbackRequest(request)) {
      response.status(403).json({ error: 'Private access can only be enabled on this computer.' });
      return;
    }
    try {
      const status = await enableTailscaleServe(getServerPort());
      if (!status.endpoint) throw new Error('Tailscale did not provide a private HTTPS name.');
      const localOrigin = requestOrigin(request);
      enableRuntimeWorkstationPairing({
        endpoint: status.endpoint,
        allowedOrigins: [status.endpoint, ...(localOrigin ? [localOrigin] : [])],
        persist: true,
      });
      const hostPolicy = getWorkstationHostPolicy();
      response.setHeader('Set-Cookie', sessionCookie(
        createSessionValue(hostPolicy),
        hostPolicy,
        request.secure || request.header('x-forwarded-proto') === 'https',
      ));
      const project = await getActiveSimpleProject();
      const pairing = issuePairing({
        hostName: status.hostName || 'Workstation',
        projectId: project.metadata.id,
        projectName: project.metadata.name,
        projectPathHint: project.metadata.name,
      });
      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(pairing), { width: 320, margin: 1 });
      response.setHeader('Cache-Control', 'no-store');
      response.json({ status: { ...status, enabled: true }, pairing, qrDataUrl });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/tailscale/pairing', async (request, response) => {
    if (!isDirectLoopbackRequest(request)) {
      response.status(403).json({ error: 'Pairing codes can only be created on this computer.' });
      return;
    }
    try {
      const status = await inspectTailscaleRemote();
      if (!status.endpoint || getRuntimeWorkstationPairingEndpoint() !== status.endpoint) {
        throw new Error('Enable private access before creating another pairing code.');
      }
      const project = await getActiveSimpleProject();
      const pairing = issuePairing({
        hostName: status.hostName || 'Workstation',
        projectId: project.metadata.id,
        projectName: project.metadata.name,
        projectPathHint: project.metadata.name,
      });
      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(pairing), { width: 320, margin: 1 });
      response.setHeader('Cache-Control', 'no-store');
      response.json({ pairing, qrDataUrl });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/tailscale', async (request, response) => {
    if (!isDirectLoopbackRequest(request)) {
      response.status(403).json({ error: 'Private access can only be disabled on this computer.' });
      return;
    }
    try {
      await disableTailscaleServe();
      disableRuntimeWorkstationPairing(true);
      response.json({ success: true });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/session', (request, response) => {
    const policy = getWorkstationHostPolicy();
    if (!policy.remote || policy.authentication !== 'password' || !policy.password) {
      response.status(404).json({ error: 'Password authentication is not configured.' });
      return;
    }
    if (!isAllowedOrigin(request, policy)) {
      response.status(403).json({ error: 'Request origin is not allowed.' });
      return;
    }
    const suppliedPassword = typeof request.body?.password === 'string'
      ? request.body.password
      : '';
    if (!safeEqual(suppliedPassword, policy.password)) {
      response.status(401).json({ error: 'Incorrect password.' });
      return;
    }

    const secure = policy.secureCookie || request.secure || request.header('x-forwarded-proto') === 'https';
    response.setHeader('Set-Cookie', sessionCookie(createSessionValue(policy), policy, secure));
    response.json({ success: true });
  });

  router.post('/pairings', (request, response) => {
    if (!isDirectLoopbackRequest(request)) {
      response.status(403).json({ error: 'Pairing codes can only be created on the host computer.' });
      return;
    }
    try {
      const value = issuePairing({
        hostName: typeof request.body?.hostName === 'string' ? request.body.hostName : 'Workstation',
        projectId: typeof request.body?.projectId === 'string' ? request.body.projectId : '',
        projectName: typeof request.body?.projectName === 'string' ? request.body.projectName : 'Interface',
        projectPathHint: typeof request.body?.projectPathHint === 'string' ? request.body.projectPathHint : '',
      });
      response.setHeader('Cache-Control', 'no-store');
      response.json(value);
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/pairings/redeem', (request, response) => {
    const token = typeof request.body?.pairingToken === 'string' ? request.body.pairingToken : '';
    const session = token ? redeemPairing(token) : null;
    if (!session) {
      response.status(401).json({ error: 'This pairing code is invalid, expired, or already used.' });
      return;
    }
    try {
      authorizePairingOrigin(requestOrigin(request));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const policy = getWorkstationHostPolicy();
    const secure = policy.secureCookie || request.secure || request.header('x-forwarded-proto') === 'https';
    response.setHeader('Set-Cookie', sessionCookie(session.accessToken, policy, secure));
    response.setHeader('Cache-Control', 'no-store');
    response.json(session);
  });

  router.delete('/session', (request, response) => {
    const policy = getWorkstationHostPolicy();
    if (!isAllowedOrigin(request, policy)) {
      response.status(403).json({ error: 'Request origin is not allowed.' });
      return;
    }
    const secure = policy.secureCookie || request.secure || request.header('x-forwarded-proto') === 'https';
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; ${secure ? 'Secure; SameSite=None' : 'SameSite=Lax'}; Max-Age=0`,
    );
    response.json({ success: true });
  });

  return router;
}
