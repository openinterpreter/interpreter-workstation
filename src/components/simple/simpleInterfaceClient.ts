import { apiRequest, getApiUrl } from '@/ipc';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';
export type SimpleAppStatus = {
  revision: string;
  sourceRevision: string;
  diagnostic: string | null;
  ready: boolean;
};
export type SimpleProject = {
  path: string;
  metadata: { version: 1; id: string; name: string; createdAt: string };
  legacy: boolean;
};
export type SimplePresentation = {
  id: string;
  kind: 'text' | 'image' | 'progress' | 'result';
  title: string;
  text: string | null;
  asset: string | null;
  createdAt: string;
};
export type SimpleResolvedPath = { path: string; name: string; directory: boolean };

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await apiRequest({ method, path: `/api/simple-interface${path}`, body });
  if (!response.ok) {
    const error = response.data && typeof response.data === 'object' && 'error' in response.data
      ? String((response.data as { error: unknown }).error)
      : `Interface request failed (${response.status})`;
    throw new Error(error);
  }
  return response.data as T;
}

export const simpleInterfaceClient = {
  read: () => request<SimpleAppStatus>('GET', ''),
  refresh: () => isWorkstationReadOnly()
    ? request<SimpleAppStatus>('GET', '')
    : request<SimpleAppStatus>('POST', '/promote'),
  appState: () => request<Record<string, unknown>>('GET', '/app/state'),
  setAppState: (value: Record<string, unknown>) => request<{ success: true }>('POST', '/app/state', value),
  updateAppState: (key: string, value: unknown) => request<{ success: true }>('POST', '/app/state/update', { key, value }),
  appUiState: () => request<Record<string, unknown>>('GET', '/app/ui-state'),
  setAppUiState: (value: Record<string, unknown>) => request<{ success: true }>('POST', '/app/ui-state', value),
  resolvePath: (path: string) => request<SimpleResolvedPath>('POST', '/app/resolve-path', { path }),
  runtimeError: (message: string) => request<{ success: true }>('POST', '/app/runtime-error', { message }),
  projects: () => request<{ active: SimpleProject; recent: SimpleProject[] }>('GET', '/projects'),
  createProject: (path: string, options?: { activate?: boolean }) => request<SimpleProject>('POST', '/projects/new', { path, ...options }),
  openProject: (path: string, options?: { activate?: boolean }) => request<SimpleProject>('POST', '/projects/open', { path, ...options }),
  presentation: () => request<SimplePresentation | null>('GET', '/presentation'),
  clearPresentation: () => request<{ success: true }>('POST', '/presentation/clear'),
  appUrl: (revision: string) => getApiUrl(`/api/simple-interface/app/index.html?revision=${encodeURIComponent(revision)}`),
  assetUrl: (asset: string) => getApiUrl(`/api/simple-interface/assets/${encodeURIComponent(asset)}`),
};
