import { describe, expect, test } from 'bun:test';
import { RemoteSimpleClient, isTailnetAddress } from './remoteSimpleClient';

const projectId = 'e789617d-032e-4412-87cc-99fbcf0953cb';
const threadId = '8b998041-3299-43c3-8cc0-49486998e6aa';
const challengeId = '5e9a0d55-eed4-40fe-bd89-38775631af11';
const sessionId = '91addb76-f4d9-4671-8222-a24f57b29789';
const fingerprint = 'a'.repeat(64);
const endpoint = 'https://workstation.example.ts.net';
const offer = () => ({ version: 1 as const, endpoint, projectId, threadId,
  challengeId, fingerprint, expiresAt: Date.now() + 60_000 });
const code = 'AAAAAAAAAAAAAAAA';
const token = 'a'.repeat(43);
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

function harness(options: { addresses?: string[]; fingerprint?: string; connected?: () => void } = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new RemoteSimpleClient({
    addresses: async () => options.addresses ?? ['100.100.100.100'],
    connected: options.connected ?? (() => {}),
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/identity')) return json({ fingerprint: options.fingerprint ?? fingerprint });
      if (String(url).endsWith('/pair')) return json({ sessionId, projectId, threadId, token, expiresAt: Date.now() + 60_000 });
      if (String(url).endsWith('/disconnect')) return json({ disconnected: true });
      return json({ version: 1, projectId, threadId });
    }) as typeof fetch,
  });
  return { client, requests };
}

describe('private desktop remote client', () => {
  test('accepts only tailnet addresses', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true);
    expect(isTailnetAddress('100.127.255.254')).toBe(true);
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
    expect(isTailnetAddress('127.0.0.1')).toBe(false);
  });
  test('pins identity, scopes session and keeps credentials out of URLs and connection lists', async () => {
    const { client, requests } = harness();
    const connection = await client.connect({ offer: offer(), code });
    expect(connection.projectId).toBe(projectId);
    expect(JSON.stringify(client.list())).not.toContain(token);
    await client.forward(connection.id, 'capabilities');
    expect(requests.every(request => !request.url.includes(code) && !request.url.includes(token))).toBe(true);
    expect(requests[2].init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    expect(await client.disconnect(connection.id)).toBe(true);
    expect(client.list()).toHaveLength(0);
  });
  test('fails closed on public DNS, no device enrollment, altered fingerprint, expiry and URL credentials', async () => {
    const publicDns = harness({ addresses: ['100.100.100.100', '8.8.8.8'] });
    await expect(publicDns.client.connect({ offer: offer(), code })).rejects.toThrow('privately');
    expect(publicDns.requests).toHaveLength(0);
    const offline = harness({ connected: () => { throw new Error('Tailnet offline'); } });
    await expect(offline.client.connect({ offer: offer(), code })).rejects.toThrow('offline');
    const wrongIdentity = harness({ fingerprint: 'b'.repeat(64) });
    await expect(wrongIdentity.client.connect({ offer: offer(), code })).rejects.toThrow('identity');
    expect(wrongIdentity.requests).toHaveLength(1);
    await expect(harness().client.connect({ offer: { ...offer(), expiresAt: Date.now() - 1 }, code })).rejects.toThrow('expired');
    await expect(harness().client.connect({ offer: { ...offer(), endpoint: 'https://user:pass@workstation.example.ts.net' }, code })).rejects.toThrow('Private endpoint');
  });
});
