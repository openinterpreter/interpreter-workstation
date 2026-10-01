import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Agent } from 'undici';
import { RemoteSimpleClient } from '../server/remoteSimpleClient';

test('private desktop TLS socket rejects DNS rebinding after pairing preflight', async () => {
  const endpoint = 'https://workstation.example.ts.net';
  const projectId = 'e789617d-032e-4412-87cc-99fbcf0953cb';
  const threadId = '8b998041-3299-43c3-8cc0-49486998e6aa';
  let lookups = 0;
  const requests: RequestInit[] = [];
  const client = new RemoteSimpleClient({
    addresses: async () => ++lookups < 3 ? ['100.100.100.100'] : ['8.8.8.8'],
    connected: () => {},
    fetcher: (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      const body = requests.length === 1 ? { fingerprint: 'a'.repeat(64) }
        : { sessionId: '91addb76-f4d9-4671-8222-a24f57b29789', projectId, threadId,
          token: 'a'.repeat(43), expiresAt: Date.now() + 60_000 };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  await client.connect({ offer: {
    version: 1, endpoint, projectId, threadId, challengeId: '5e9a0d55-eed4-40fe-bd89-38775631af11',
    fingerprint: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
  }, code: 'AAAAAAAAAAAAAAAA' });
  const dispatcher = (requests[0] as RequestInit & { dispatcher: Agent }).dispatcher;
  try {
    await assert.rejects(dispatcher.request({ origin: endpoint, path: '/identity', method: 'GET' }), /privately/);
    assert.ok(lookups >= 3);
  } finally { await dispatcher.close(); }
});
