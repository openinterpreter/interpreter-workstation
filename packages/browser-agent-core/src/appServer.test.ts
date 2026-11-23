import { expect, test } from 'bun:test';
import { JSONRPCClient } from 'json-rpc-2.0';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { CLIENT_METHOD } from '../../../src/lib/codex/protocol';
import { BrowserProjectAppServer, BrowserModelCatalogAppServer } from './appServer';
import { BrowserPiAppServerSession } from './piSession';
import { MemoryPiTranscriptStore } from './piTranscript';
import { BrowserLocalModelCatalog } from './modelCatalog';
import { BrowserPresentationError } from './presentationGate';

function clientFixture() {
  const turn = { id: 'turn_one', items: [], status: 'completed' };
  const listeners = new Set<(value: unknown) => void>();
  const send = async (request: { message?: string; workspacePath?: string | null }) => {
    expect(request.workspacePath).toBe('browser-project:project_one');
    expect(request.message).toBe('Try another experiment');
    for (const listener of listeners) listener({ method: 'turn/started',
      params: { threadId: 'thread_one', turn } });
    return turn.id;
  };
  const session = { threadId: 'thread_one', projectId: 'project_one',
    agent: { state: { model: { id: 'local_model' } } },
    historyThread: () => ({ id: 'thread_one', turns: [turn] }), send,
    subscribeNotifications: (listener: (value: unknown) => void) => {
      listeners.add(listener); return () => listeners.delete(listener);
    },
    stop: () => undefined } as unknown as BrowserPiAppServerSession;
  const server = new BrowserProjectAppServer(session);
  let client: JSONRPCClient;
  client = new JSONRPCClient(async request => {
    const response = await server.handle(request);
    client.receive(response);
  });
  return { client, server };
}

test('unmodified JSON-RPC client reads the canonical thread and starts a model turn', async () => {
  const { client } = clientFixture();
  const read = await client.request(CLIENT_METHOD.threadRead,
    { threadId: 'thread_one', includeTurns: true });
  expect(read.thread.turns[0].id).toBe('turn_one');
  const started = await client.request(CLIENT_METHOD.turnStart, {
    threadId: 'thread_one', input: [{ type: 'text', text: 'Try another experiment', text_elements: [] }],
  });
  expect(started.turn.id).toBe('turn_one');
});

test('session app-server facade rejects overlapping turn starts through separate accessors', async () => {
  const model = { id: 'local_model', name: 'Local model', api: 'browser-local', provider: 'browser',
    baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 4096, maxTokens: 512 } as Model<any>;
  const session = new BrowserPiAppServerSession({ projectId: 'project_one', threadId: 'thread_one',
    model, tools: [], systemPrompt: '', streamFn: () => createAssistantMessageEventStream() });
  let release!: () => void;
  const pendingSend = new Promise<void>(resolve => { release = resolve; });
  session.send = async () => { await pendingSend; throw new Error('fixture send stopped'); };
  const params = { threadId: 'thread_one', input: [{ type: 'text' as const,
    text: 'Try another experiment', text_elements: [] }] };
  const first = session.appServer.request(CLIENT_METHOD.turnStart, params);
  const firstOutcome = first.catch(error => error);
  try {
    expect(session.appServer).toBe(session.appServer);
    await expect(session.appServer.request(CLIENT_METHOD.turnStart, params))
      .rejects.toThrow('Browser turn start already pending');
  } finally { release(); }
  expect((await firstOutcome).message).toBe('fixture send stopped');
});

test('canonical provider and model list methods enumerate registered browser-local models', async () => {
  const model = { id: 'model_one', name: 'First model', provider: 'browser', api: 'browser-local',
    baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 4096, maxTokens: 512 } as Model<any>;
  const catalog = new BrowserLocalModelCatalog([
    { id: 'model_one', name: 'First model', inputModalities: ['text'], assets: [{ path: 'one', url: '/one',
      bytes: 1, sha256: '0'.repeat(64) }] },
    { id: 'model_two', name: 'Second model', assets: [{ path: 'two', url: '/two',
      bytes: 1, sha256: '0'.repeat(64) }] },
  ], 'https://browser.test');
  const session = new BrowserPiAppServerSession({ projectId: 'project_one', threadId: 'thread_one',
    model, catalog, tools: [], systemPrompt: '',
    streamFn: () => createAssistantMessageEventStream() });
  const providers = await session.appServer.request(CLIENT_METHOD.interpreterProviderList,
    { includeUnconfigured: true });
  expect(providers.data).toEqual([{ id: 'browser', name: 'Browser-local models',
    description: 'Models registered for this browser',
    isCurrent: true, configured: true, isDefault: true }]);
  const models = await session.appServer.request(CLIENT_METHOD.interpreterModelList,
    { modelProvider: 'browser' });
  expect(models.data.map(item => [item.id, item.isDefault])).toEqual([
    ['model_one', true], ['model_two', false],
  ]);
  expect(models.data.map(item => item.inputModalities)).toEqual([['text'], ['text']]);
  expect(models.data.every(item => !item.description.includes('acquired'))).toBe(true);
  const beforeSession = new BrowserModelCatalogAppServer(catalog, 'browser');
  expect((await beforeSession.request(CLIENT_METHOD.interpreterModelList,
    { modelProvider: 'browser' })).data.map(item => item.id)).toEqual(['model_one', 'model_two']);
  const generic = await session.appServer.request(CLIENT_METHOD.modelList,
    { modelProvider: 'browser' });
  expect(generic.data.map(item => item.id)).toEqual(models.data.map(item => item.id));
  expect((await session.appServer.request(CLIENT_METHOD.interpreterModelList,
    { modelProvider: 'other' })).data).toEqual([]);
});

test('unsupported native methods and forged project paths fail closed through JSON-RPC', async () => {
  const { client } = clientFixture();
  await expect(client.request('thread/start', {})).rejects.toThrow('Browser app-server capability unavailable');
  await expect(client.request(CLIENT_METHOD.turnStart, { threadId: 'thread_one',
    cwd: '/host/private', input: [{ type: 'text', text: 'Try another experiment', text_elements: [] }],
  })).rejects.toThrow('Browser turn capability unavailable');
  await expect(client.request(CLIENT_METHOD.threadRead,
    { threadId: 'other', includeTurns: true })).rejects.toThrow('Browser thread identity mismatch');
});

test('gated JSON-RPC errors expose a fixed typed code without provider details', async () => {
  const { server } = clientFixture();
  Object.defineProperty(server.session, 'presentationGated', { value: true });
  server.session.historyThread = () => { throw new BrowserPresentationError('storage-unavailable'); };
  const response = await server.handle({ jsonrpc: '2.0', id: 8,
    method: CLIENT_METHOD.threadRead, params: { threadId: 'thread_one', includeTurns: true } });
  expect(response.error?.data?.code).toBe('storage-unavailable');
  expect(response.error?.message).toBe('Browser presentation storage-unavailable');
  expect(JSON.stringify(response)).not.toContain('provider');
  server.session.historyThread = () => { throw new Error('sensitive-provider-internals'); };
  const unknown = await server.handle({ jsonrpc: '2.0', id: 10,
    method: CLIENT_METHOD.threadRead, params: { threadId: 'thread_one', includeTurns: true } });
  expect(unknown.error).toEqual({ code: -32000, message: 'Browser presentation rejected',
    data: { code: 'rejected' } });
  expect((await server.handle({ jsonrpc: 'broken', id: 9 })).error?.data?.code)
    .toBe('rejected');
});

test('canonical JSON-RPC turn executes the real Pi engine and projects the same thread history', async () => {
  const model = { id: 'local_model', name: 'Local model', api: 'browser-local', provider: 'browser',
    baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 4096, maxTokens: 512 } as Model<any>;
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant' as const, content: [{ type: 'text' as const,
      text: 'Verified result' }], api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: 'stop' as const, usage: { input: 0, output: 0,
        cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message }); });
    return stream;
  };
  const events: string[] = [];
  const session = await BrowserPiAppServerSession.open({ projectId: 'project_one',
    threadId: 'thread_one', model, streamFn, tools: [], systemPrompt: 'Local only' },
  new MemoryPiTranscriptStore());
  const server = new BrowserProjectAppServer(session);
  let client: JSONRPCClient;
  client = new JSONRPCClient(async request => {
    client.receive(await server.handle(request));
  });
  const unsubscribe = server.subscribeJsonRpc(notification => {
    expect(notification.jsonrpc).toBe('2.0');
    events.push(notification.method);
  });
  const completed = new Promise<void>(resolve => {
    const off = server.subscribe(notification => {
      if (notification.method === 'turn/completed') { off(); resolve(); }
    });
  });
  const catalog = await client.request(CLIENT_METHOD.modelList, { modelProvider: 'browser' });
  expect(catalog.data.map(item => item.id)).toEqual(['local_model']);
  const started = await client.request(CLIENT_METHOD.turnStart, { threadId: 'thread_one',
    input: [{ type: 'text', text: 'Try another experiment', text_elements: [] }] });
  expect(started.turn.status).toBe('inProgress');
  await completed;
  const history = await client.request(CLIENT_METHOD.threadRead,
    { threadId: 'thread_one', includeTurns: true });
  expect(JSON.stringify(history.thread.turns)).toContain('Verified result');
  expect(events).toContain('turn/started');
  expect(events).toContain('turn/completed');
  unsubscribe();
});
