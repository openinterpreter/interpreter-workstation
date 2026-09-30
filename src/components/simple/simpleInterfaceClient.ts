import { apiRequest, getApiUrl, isWorkstationReadOnly } from '@/ipc';
import type { SimpleActionEvent, SimpleInterfaceSnapshot } from '../../../shared/simpleInterface';

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
