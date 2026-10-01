/** Tailnet-only display connection. Bearer credentials remain in host memory, never in URLs or renderer storage. */
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';
import { Agent } from 'undici';
import type { PairingOffer } from './remoteSimplePairing';

type Offer = PairingOffer['qr'];
type Connection = { id: string; endpoint: string; projectId: string; sessionId: string; threadId: string;
  token: string; expiresAt: number; fingerprint: string };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isTailnetAddress(address: string): boolean {
  if (/^fd7a:115c:a1e0:/i.test(address)) return true;
  const segments = address.split('.').map(Number);
  return segments.length === 4 && segments.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && segments[0] === 100 && segments[1] >= 64 && segments[1] <= 127;
}

function validateOffer(offer: Offer, now: number): URL {
  if (offer?.version !== 1 || !ID.test(offer.projectId) || !ID.test(offer.threadId) || !ID.test(offer.challengeId)
      || !Number.isSafeInteger(offer.expiresAt) || offer.expiresAt <= now || offer.expiresAt > now + 120_000
      || !/^[a-f0-9]{64}$/.test(offer.fingerprint)) throw new Error('Invalid or expired pairing offer');
  const url = new URL(offer.endpoint);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.hostname.split('.').length < 4
      || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.port && !['443', '8443'].includes(url.port))) throw new Error('Private endpoint required');
  return url;
}

export function assertTailnetConnected(): void {
  try {
    const output = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000,
      maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const state = JSON.parse(output) as { BackendState?: string; Self?: { Online?: boolean } };
    if (state.BackendState === 'Running' && state.Self?.Online === true) return;
  } catch { /* The connection must not fall back to ordinary internet. */ }
  throw new Error('This device is not connected to the private tailnet');
}

export class RemoteSimpleClient {
  private readonly connections = new Map<string, Connection>();
  private readonly privateDispatcher: Agent;
  constructor(private readonly dependencies: {
    fetcher: typeof fetch;
    addresses: (name: string) => Promise<string[]>;
    connected: () => void;
  } = {
    fetcher: fetch,
    addresses: async name => (await lookup(name, { all: true })).map(entry => entry.address),
    connected: assertTailnetConnected,
  }) {
    // Checking DNS before fetch is insufficient: another lookup during the
    // connection could rebind a private name to a public address. Pin every
    // actual TLS socket to a freshly checked tailnet result instead.
    this.privateDispatcher = new Agent({ connect: { lookup: (hostname, _options, callback) => {
      void this.dependencies.addresses(hostname).then(addresses => {
        if (!addresses.length || addresses.some(address => !isTailnetAddress(address))) {
          callback(new Error('Endpoint does not resolve privately'), '', 4);
          return;
        }
        callback(null, addresses[0], isIP(addresses[0]));
      }).catch(error => callback(error instanceof Error ? error : new Error('Private lookup failed'), '', 4));
    } } });
  }

  private async assertPrivate(endpoint: string): Promise<void> {
    // Some non-Node runtimes provide an incomplete Undici compatibility shim.
    // Never send a real request unless socket-level DNS pinning is available.
    if (this.dependencies.fetcher === fetch && typeof this.privateDispatcher.close !== 'function') {
      throw new Error('Private TLS transport is unavailable');
    }
    this.dependencies.connected();
    const addresses = await this.dependencies.addresses(new URL(endpoint).hostname);
    if (!addresses.length || addresses.some(address => !isTailnetAddress(address))) throw new Error('Endpoint does not resolve privately');
  }

  private async request(endpoint: string, path: string, init: RequestInit = {}): Promise<unknown> {
    await this.assertPrivate(endpoint);
    const response = await this.dependencies.fetcher(`${endpoint}/api/simple-remote/v1${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(10_000),
      dispatcher: this.privateDispatcher,
      headers: { 'X-Interpreter-Client': 'desktop', ...init.headers },
    } as unknown as RequestInit);
    if (!response.ok) throw new Error(`Remote project unavailable (${response.status})`);
    if (Number(response.headers.get('content-length')) > 5 * 1024 * 1024) throw new Error('Remote response exceeds limit');
    const data = await response.text();
    if (data.length > 5 * 1024 * 1024) throw new Error('Remote response exceeds limit');
    return JSON.parse(data) as unknown;
  }

  async connect(input: { offer: Offer; code: string }, now = Date.now()) {
    const offer = input.offer;
    const endpoint = validateOffer(offer, now).origin;
    if (!/^[A-Z2-7]{16}$/.test(input.code)) throw new Error('Invalid pairing code');
    const identity = await this.request(endpoint, '/identity') as { fingerprint?: string };
    if (identity.fingerprint !== offer.fingerprint) throw new Error('Remote identity does not match the pairing offer');
    const result = await this.request(endpoint, '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: offer.challengeId, projectId: offer.projectId, code: input.code }) }) as
      { sessionId: string; projectId: string; threadId: string; token: string; expiresAt: number };
    if (!ID.test(result.sessionId) || result.projectId !== offer.projectId || result.threadId !== offer.threadId
        || !TOKEN.test(result.token) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now) {
      throw new Error('Remote pairing response is invalid');
    }
    const id = randomUUID();
    this.connections.set(id, { id, endpoint, projectId: result.projectId, threadId: result.threadId,
      sessionId: result.sessionId, token: result.token, expiresAt: result.expiresAt, fingerprint: identity.fingerprint });
    return { id, projectId: result.projectId, threadId: result.threadId, status: 'connected' as const };
  }

  list() {
    return [...this.connections.values()].filter(item => item.expiresAt > Date.now())
      .map(({ id, projectId, threadId }) => ({ id, projectId, threadId, status: 'connected' as const }));
  }

  private connection(id: string): Connection {
    const item = this.connections.get(id);
    if (!item || item.expiresAt <= Date.now()) throw new Error('Remote session is unavailable');
    return item;
  }

  async forward(id: string, resource: 'capabilities' | 'interface' | 'conversation' | 'messages' | 'stop', body?: unknown): Promise<unknown> {
    const item = this.connection(id);
    const path = `/sessions/${item.sessionId}/projects/${item.projectId}/${resource}`;
    return this.request(item.endpoint, path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { Authorization: `Bearer ${item.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
  }

  async eventStream(id: string, signal: AbortSignal): Promise<Response> {
    const item = this.connection(id);
    await this.assertPrivate(item.endpoint);
    const response = await this.dependencies.fetcher(`${item.endpoint}/api/simple-remote/v1/sessions/${item.sessionId}/projects/${item.projectId}/events`, {
      headers: { Authorization: `Bearer ${item.token}`, 'X-Interpreter-Client': 'desktop', Accept: 'text/event-stream' },
      redirect: 'error', signal, dispatcher: this.privateDispatcher,
    } as unknown as RequestInit);
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      throw new Error('Remote event stream is unavailable');
    }
    return response;
  }

  async disconnect(id: string): Promise<boolean> {
    const item = this.connection(id);
    this.connections.delete(id);
    try {
      await this.request(item.endpoint, `/sessions/${item.sessionId}/projects/${item.projectId}/disconnect`, {
        method: 'POST', headers: { Authorization: `Bearer ${item.token}`, 'Content-Type': 'application/json' }, body: '{}' });
      return true;
    } catch { return false; }
  }
}

export const remoteSimpleClient = new RemoteSimpleClient();
