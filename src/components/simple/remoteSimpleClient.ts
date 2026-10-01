import { apiRequest, getApiUrl } from '@/ipc';

export type RemoteConnection = { id: string; projectId: string; threadId: string; status: 'connected' };
export type RemoteOffer = { version: 1; endpoint: string; projectId: string; threadId: string;
  challengeId: string; expiresAt: number; fingerprint: string };

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await apiRequest({ method, path: `/api/simple-remote-client${path}`, body });
  if (!response.ok) throw new Error(response.data && typeof response.data === 'object' && 'error' in response.data
    ? String(response.data.error) : `Remote connection unavailable (${response.status})`);
  return response.data as T;
}

export const remoteSimpleClient = {
  list: () => request<RemoteConnection[]>('GET', '/connections'),
  connect: (offer: RemoteOffer, code: string) => request<RemoteConnection>('POST', '/connections', { offer, code }),
  disconnect: (id: string) => request<{ revoked: boolean }>('POST', `/connections/${id}/disconnect`),
  capabilities: (id: string) => request<{ projectId: string; threadId: string; host: 'remote'; version: 1 }>('GET', `/connections/${id}/capabilities`),
  readInterface: (id: string) => request<{ version: 1; projectId: string; revision: string; bundle: string; diagnostic: string | null }>('GET', `/connections/${id}/interface`),
  conversation: (id: string) => request<{ messages: Array<{ role: 'agent' | 'user'; text: string }> }>('GET', `/connections/${id}/conversation`),
  send: (id: string, windowId: string, message: string, source: 'composer' | 'interface' | 'voice' = 'composer') =>
    request<{ eventId: string; status: string }>('POST', `/connections/${id}/messages`,
      { version: 1, windowId, eventId: crypto.randomUUID(), message, source }),
  stop: (id: string) => request<{ stopped: boolean }>('POST', `/connections/${id}/stop`, {}),
  eventsUrl: (id: string) => getApiUrl(`/api/simple-remote-client/connections/${id}/events`),
};
