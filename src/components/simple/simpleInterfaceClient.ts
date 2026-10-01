import { apiRequest, getApiUrl } from '@/ipc';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';
import type { SimpleActionEvent, SimpleInterfaceSnapshot } from '../../../shared/simpleInterface';

export type SimpleProjectSnapshot = { projectPath: string; revision: string; bundle: string; diagnostic: string | null };

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
  projectRefresh: () => isWorkstationReadOnly()
    ? request<SimpleProjectSnapshot>('GET', '/project')
    : request<SimpleProjectSnapshot>('POST', '/project/promote'),
  projectSelect: (projectPath: string) => request<{ projectPath: string }>('POST', '/project/select', { projectPath }),
  projectAction: (action: { revision: string; message: string }) =>
    request<{ id: string; message: string }>('POST', '/project/action', action),
  projectDelivery: (delivery: { id: string; status: 'dispatched' | 'failed' }) =>
    request<{ success: true }>('POST', '/project/delivery', delivery),
  read: () => request<SimpleInterfaceSnapshot>('GET', ''),
  refresh: () => isWorkstationReadOnly()
    ? request<SimpleInterfaceSnapshot>('GET', '')
    : request<SimpleInterfaceSnapshot>('POST', '/promote'),
  action: (requestData: { actionId: string; revision: string; value?: string }) =>
    request<SimpleActionEvent>('POST', '/action', requestData),
  input: (requestData: { id: string; revision: string; value: string }) =>
    request<{ success: true }>('POST', '/input', requestData),
  delivery: (requestData: { id: string; status: 'dispatched' | 'failed'; error?: string }) =>
    request<{ success: true }>('POST', '/delivery', requestData),
  assetUrl: (asset: string) => getApiUrl(`/api/simple-interface/assets/${encodeURIComponent(asset)}`),
};
