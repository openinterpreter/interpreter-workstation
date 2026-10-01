import { apiRequest } from '@/ipc';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';

export type SimpleProjectSnapshot = { projectPath: string; revision: string; bundle: string; diagnostic: string | null };
export type SimpleProject = { id: string; path: string; name: string };

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
  projects: (windowId: string) => request<{ projects: SimpleProject[]; active: SimpleProject | null }>('GET', `/projects?windowId=${encodeURIComponent(windowId)}`),
  createProject: (windowId: string, parentPath: string, name: string) => request<SimpleProject>('POST', '/projects/new', { windowId, parentPath, name }),
  openProject: (windowId: string, projectPath: string) => request<SimpleProject>('POST', '/projects/open', { windowId, projectPath }),
  closeProject: (windowId: string) => request<{ closed: true }>('POST', '/projects/close', { windowId }),
  projectRefresh: (windowId: string, projectId: string) => isWorkstationReadOnly()
    ? request<SimpleProjectSnapshot>('GET', `/project?windowId=${encodeURIComponent(windowId)}&projectId=${encodeURIComponent(projectId)}`)
    : request<SimpleProjectSnapshot>('POST', '/project/promote', { windowId, projectId }),
  projectAction: (action: { windowId: string; projectId: string; revision: string; message: string }) =>
    request<{ id: string; message: string }>('POST', '/project/action', action),
  projectDelivery: (delivery: { windowId: string; projectId: string; id: string; status: 'dispatched' | 'failed' }) =>
    request<{ success: true }>('POST', '/project/delivery', delivery),
};
