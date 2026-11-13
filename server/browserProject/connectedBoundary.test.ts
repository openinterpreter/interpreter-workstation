import { expect, test } from 'bun:test';
import { connectedProjectBoundary, type ConnectedBoundaryDeps } from './connectedBoundary';
import { ConnectedProjectAgent, applyConnectedProposal } from '../../src/browser-project/connectedAgent';
import { MemoryProjectFiles } from '../../src/browser-project/project';

const origin = 'https://projects.example';
const owner = { tenantId: 'tenant_one', subjectId: 'alice' };
const selectedFile = { name: 'scene.json', content: '{"tint":"teal"}', expectedRevision: null };
const body = { version: 1, projectId: 'project_one', clientMessageId: 'a'.repeat(32),
  message: 'Change the color', consent: true, selectedFile };

test('unmounted boundary enforces tenant, owner, origin, CSRF, consent, quota and no tool inputs', async () => {
  let identity = owner;
  let modelCalls = 0;
  let reservations = 0;
  const reserved = new Set<string>();
  const deps: ConnectedBoundaryDeps = {
    verifySession: async () => identity,
    ownProject: async (user, projectId) => projectId === 'project_one' &&
      user.tenantId === owner.tenantId && user.subjectId === owner.subjectId
      ? { ...owner, projectId, csrf: '0123456789abcdef', allowedPaths: ['scene.json'],
        providerLabel: 'Selected model' } : null,
    reserve: async (user, projectId, id) => {
      reservations++;
      const key = `${user.tenantId}:${user.subjectId}:${projectId}:${id}`;
      if (reserved.has(key)) return false;
      reserved.add(key);
      return true;
    },
    model: async input => {
      modelCalls++;
      expect(Object.keys(input).sort()).toEqual(['message', 'providerLabel', 'selectedFile']);
      return { reply: 'Review the diff.', proposal: { ...input.selectedFile, content: '{"tint":"amber"}' } };
    },
  };
  const handle = connectedProjectBoundary(deps, origin);
  const post = (value: unknown, headers: Record<string, string> = {}) =>
    handle(new Request(`${origin}/api/browser-project/v1/proposals`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json',
        'X-Workstation-Project-Csrf': '0123456789abcdef', ...headers }, body: JSON.stringify(value) }));
  const get = () => handle(new Request(`${origin}/api/browser-project/v1/session?projectId=project_one`));
  expect((await get()).status).toBe(200); // Ordinary same-origin GET does not send Origin.
  identity = { tenantId: 'tenant_two', subjectId: 'alice' };
  expect((await get()).status).toBe(403);
  expect((await post(body)).status).toBe(403);
  identity = { tenantId: 'tenant_one', subjectId: 'mallory' };
  expect((await get()).status).toBe(403);
  identity = owner;
  expect((await post(body, { Origin: 'https://evil.example' })).status).toBe(403);
  expect((await post(body, { 'X-Workstation-Project-Csrf': 'incorrect' })).status).toBe(403);
  expect((await post({ ...body, consent: false })).status).toBe(400);
  expect((await post({ ...body, tools: ['shell'] })).status).toBe(400);
  expect((await post({ ...body, selectedFile: { ...selectedFile, name: 'secret.txt' } })).status).toBe(403);
  expect(modelCalls).toBe(0);
  expect(reservations).toBe(0);
  const accepted = await post(body);
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).proposal.content).toBe('{"tint":"amber"}');
  expect((await post(body)).status).toBe(429);
  expect(modelCalls).toBe(1);
  expect(reservations).toBe(2);
});

test('model output cannot smuggle a second file or redirect the revision', async () => {
  const handle = connectedProjectBoundary({
    verifySession: async () => owner,
    ownProject: async () => ({ ...owner, projectId: 'project_one', csrf: '0123456789abcdef',
      allowedPaths: ['scene.json'], providerLabel: 'Fixture' }),
    reserve: async () => true,
    model: async () => ({ reply: 'No', proposal: { name: 'other.json', content: '{}', expectedRevision: null } }),
  }, origin);
  const response = await handle(new Request(`${origin}/api/browser-project/v1/proposals`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
      'X-Workstation-Project-Csrf': '0123456789abcdef' }, body: JSON.stringify(body),
  }));
  expect(response.status).toBe(502);
});

test('browser client and scoped HTTP contract agree without executing or writing before approval', async () => {
  const handler = connectedProjectBoundary({
    verifySession: async () => owner,
    ownProject: async (identity, projectId) => identity.tenantId === owner.tenantId &&
      identity.subjectId === owner.subjectId && projectId === 'project_one'
      ? { ...owner, projectId, csrf: '0123456789abcdef', allowedPaths: ['scene.json'],
        providerLabel: 'Fixture only' } : null,
    reserve: async () => true,
    model: async ({ selectedFile }) => ({ reply: 'Proposed one edit.',
      proposal: { ...selectedFile, content: '{"tint":"amber"}' } }),
  }, origin);
  const transport: typeof fetch = (url, init) => handler(new Request(String(url), {
    ...init, headers: { ...init?.headers, Origin: origin },
  }));
  const agent = new ConnectedProjectAgent('/', `${origin}/`, transport);
  const connected = await agent.connect('project_one');
  const proposal = await agent.propose(body);
  const files = new MemoryProjectFiles();
  expect(await files.read('scene.json')).toBeNull();
  await expect(applyConnectedProposal(files, proposal.proposal!, connected, false)).rejects.toThrow();
  await applyConnectedProposal(files, proposal.proposal!, connected, true);
  expect((await files.read('scene.json'))?.content).toBe('{"tint":"amber"}');
});
