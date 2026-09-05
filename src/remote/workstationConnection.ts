import type {
  WorkstationAccess,
  WorkstationAuthentication,
} from '../../shared/types/workstationConnection';

export type BrowserWorkstationConnection = {
  host: 'local' | 'remote';
  access: WorkstationAccess;
  authentication: WorkstationAuthentication;
  endpoint: string | null;
  publication: boolean;
};

function searchParams(): URLSearchParams {
  if (typeof window === 'undefined' || !window.location) return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

function explicitAccess(params: URLSearchParams): WorkstationAccess | null {
  const access = params.get('access');
  return access === 'read-only' || access === 'read-write' ? access : null;
}

function explicitAuthentication(params: URLSearchParams): WorkstationAuthentication | null {
  const authentication = params.get('auth');
  return authentication === 'none' || authentication === 'password' ? authentication : null;
}

/**
 * Resolve how this renderer reaches Workstation.
 *
 * `surface=workstation` is the general browser client. Its endpoint is the
 * remote Workstation origin and it uses the same HTTP/SSE bridge as local
 * browser development. Endpoint and access are independent of whether the
 * renderer runs in Electron or a browser. `surface=remote-workstation` remains
 * a backwards-compatible alias for older public embeds.
 */
export function getBrowserWorkstationConnection(): BrowserWorkstationConnection {
  const params = searchParams();
  const surface = params.get('surface');
  const legacyPublication = surface === 'remote-workstation';
  const remote = legacyPublication || surface === 'workstation';
  const endpointValue = params.get('endpoint')?.trim();
  const endpoint = endpointValue ? endpointValue.replace(/\/+$/, '') : null;
  const access = explicitAccess(params) ?? (legacyPublication ? 'read-only' : 'read-write');
  const authentication = explicitAuthentication(params)
    ?? (legacyPublication ? 'none' : remote ? 'password' : 'none');
  const publication = legacyPublication
    || (remote && access === 'read-only' && authentication === 'none');

  return {
    host: remote ? 'remote' : 'local',
    access,
    authentication,
    endpoint,
    publication,
  };
}

export function isRemoteWorkstationHost(): boolean {
  return getBrowserWorkstationConnection().host === 'remote';
}

export function isPublicWorkstationPublication(): boolean {
  return getBrowserWorkstationConnection().publication;
}

export function isWorkstationReadOnly(): boolean {
  return getBrowserWorkstationConnection().access === 'read-only';
}

/** Whether an OS file-manager action targets the same machine as this UI. */
export function canUseHostNativeFileManager(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.electron) return true;
  return !isRemoteWorkstationHost();
}

export function getWorkstationApiBaseUrl(): string {
  const connection = getBrowserWorkstationConnection();
  if (connection.host !== 'remote' || connection.publication) return '';
  return connection.endpoint ?? '';
}

export function resolveWorkstationApiUrl(path: string): string {
  const baseUrl = getWorkstationApiBaseUrl();
  if (!baseUrl) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return new URL(normalizedPath, `${baseUrl}/`).toString();
}

export function getBrowserWorkstationStorageKey(): string | null {
  const connection = getBrowserWorkstationConnection();
  if (connection.host !== 'remote' || connection.publication) return null;
  const target = connection.endpoint || (typeof window !== 'undefined' ? window.location.origin : 'remote');
  const identity = `${target}|${connection.access}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `workstation-remote-${(hash >>> 0).toString(36)}`;
}

export function workstationFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(resolveWorkstationApiUrl(input), {
    ...init,
    credentials: init.credentials ?? 'include',
  });
}
