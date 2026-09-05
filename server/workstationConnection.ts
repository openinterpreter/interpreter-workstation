import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type {
  WorkstationAccess,
  WorkstationAuthentication,
  WorkstationConnectionDescriptor,
} from '../shared/types/workstationConnection';

const SESSION_COOKIE = 'interpreter_workstation_session';
const DEFAULT_SESSION_SECONDS = 60 * 60 * 24 * 14;

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
  const configuredAccess = environment.INTERPRETER_WORKSTATION_ACCESS?.trim();
  const remote = configuredAccess === 'read-only' || configuredAccess === 'read-write';
  const access: WorkstationAccess = configuredAccess === 'read-only' ? 'read-only' : 'read-write';
  const configuredAuthentication = environment.INTERPRETER_WORKSTATION_AUTH?.trim();
  const authentication: WorkstationAuthentication = configuredAuthentication === 'password'
    ? 'password'
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
  if (!policy.sessionSecret) return false;
  const session = cookieValue(request, SESSION_COOKIE);
  if (!session) return false;
  const match = /^v1\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(session);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  const payload = `v1.${expiresAt}`;
  return safeEqual(match[2], signature(payload, policy.sessionSecret));
}

function requestOrigin(request: Request): string | null {
  const origin = request.header('origin')?.replace(/\/+$/, '');
  return origin || null;
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

  if (!policy.remote) {
    response.header('Access-Control-Allow-Origin', '*');
  } else if (origin && isAllowedOrigin(request, policy)) {
    response.header('Access-Control-Allow-Origin', origin);
    response.header('Access-Control-Allow-Credentials', 'true');
    response.header('Vary', 'Origin');
  }
  response.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  response.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') {
    if (policy.remote && origin && !isAllowedOrigin(request, policy)) {
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
    const attributes = [
      `${SESSION_COOKIE}=${encodeURIComponent(createSessionValue(policy))}`,
      'Path=/',
      'HttpOnly',
      secure ? 'Secure' : '',
      'SameSite=Lax',
      `Max-Age=${policy.sessionSeconds}`,
    ].filter(Boolean);
    response.setHeader('Set-Cookie', attributes.join('; '));
    response.json({ success: true });
  });

  router.delete('/session', (request, response) => {
    const policy = getWorkstationHostPolicy();
    if (!isAllowedOrigin(request, policy)) {
      response.status(403).json({ error: 'Request origin is not allowed.' });
      return;
    }
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    response.json({ success: true });
  });

  return router;
}
