import { expect, test } from 'bun:test';
import { ConnectedProjectAgent, applyConnectedProposal, connectedEndpoint } from './connectedAgent';
import { MemoryProjectFiles } from './project';

const page = 'https://projects.example/app/';
const session = { version: 1, authenticated: true, projectId: 'p_one', tenantId: 't_one',
  subjectId: 'u_one', access: 'propose-only', csrf: '0123456789abcdef',
  allowedPaths: ['scene.json', 'view.html'], providerLabel: 'User-selected model' };
const selectedFile = { name: 'scene.json', content: '{"tint":"teal"}', expectedRevision: null };
const message = { projectId: 'p_one', clientMessageId: 'a'.repeat(32),
  message: 'Suggest a warmer palette', selectedFile, consent: true };

test('same-origin endpoint cannot redirect a session or file content to another origin', () => {
  expect(connectedEndpoint('/', page).href).toBe('https://projects.example/api/browser-project/v1/');
  for (const endpoint of ['https://other.example/', 'http://projects.example/',
    'https://evil@projects.example/', '//other.example/', 'https://projects.example/?token=secret'])
    expect(() => connectedEndpoint(endpoint, page)).toThrow();
  expect(() => connectedEndpoint('/', 'http://projects.example/')).toThrow();
});

test('fixture: owner-scoped session, per-send consent/quota and proposal-only model port', async () => {
  let user = 'u_one';
  const owner = new Map([['p_one', 'u_one'], ['p_two', 'u_two']]);
  let modelCalls = 0;
  let budget = 1;
  const fetcher: typeof fetch = async (url, options) => {
    const request = new URL(String(url));
    expect(request.origin).toBe('https://projects.example');
    expect(options?.credentials).toBe('same-origin');
    expect(options?.redirect).toBe('error');
    const projectId = options?.method === 'POST'
      ? JSON.parse(String(options.body)).projectId : request.searchParams.get('projectId');
    if (owner.get(projectId) !== user) return new Response('{}', { status: 403 });
    if (options?.method === 'POST') {
      const headers = options.headers as Record<string, string>;
      const body = JSON.parse(String(options.body));
      expect(headers['X-Workstation-Project-Csrf']).toBe(session.csrf);
      expect(body.consent).toBe(true);
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('apiKey');
      if (budget-- <= 0) return new Response('{}', { status: 429 });
      modelCalls++;
      return Response.json({ version: 1, reply: 'Review this source diff.', proposal: {
        name: body.selectedFile.name, content: '{"tint":"amber"}',
        expectedRevision: body.selectedFile.expectedRevision,
      } });
    }
    return Response.json({ ...session, projectId });
  };
  const adapter = new ConnectedProjectAgent('/', page, fetcher);
  await expect(adapter.propose(message)).rejects.toThrow('session required');
  await adapter.connect('p_one');
  await expect(adapter.propose({ ...message, consent: false })).rejects.toThrow('consent required');
  expect(modelCalls).toBe(0);
  const reply = await adapter.propose(message);
  expect(reply.proposal).toEqual({ name: 'scene.json', content: '{"tint":"amber"}', expectedRevision: null });
  const files = new MemoryProjectFiles();
  expect(await files.read('scene.json')).toBeNull();
  await expect(applyConnectedProposal(files, reply.proposal!, session, false)).rejects.toThrow();
  const revision = await applyConnectedProposal(files, reply.proposal!, session, true);
  expect(revision).toMatch(/^[0-9a-f]{64}$/);
  await expect(applyConnectedProposal(files, reply.proposal!, session, true)).rejects.toThrow('changed');
  await expect(adapter.propose(message)).rejects.toThrow('429');
  user = 'u_two';
  await expect(adapter.connect('p_one')).rejects.toThrow('403');
  await expect(adapter.propose(message)).rejects.toThrow('session required');
  expect(modelCalls).toBe(1);
});

test('rejects cross-file, ungranted, malformed and oversized model proposals', async () => {
  for (const proposal of [
    { name: 'view.html', content: 'bad', expectedRevision: null },
    { name: '../secret', content: 'bad', expectedRevision: null },
    { name: 'scene.json', content: 'x'.repeat(65537), expectedRevision: null },
    { name: 'scene.json', content: '{}', expectedRevision: 'a'.repeat(64) },
    { name: 'scene.json', content: '{}', expectedRevision: null, command: 'shell' },
  ]) {
    const adapter = new ConnectedProjectAgent('/', page, async (_url, options) =>
      Response.json(options?.method === 'POST'
        ? { version: 1, reply: 'Untrusted', proposal }
        : session));
    await adapter.connect('p_one');
    await expect(adapter.propose(message)).rejects.toThrow();
  }
});
