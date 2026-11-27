import { expect, test } from 'bun:test';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { BrowserPiAppServerSession, DEFAULT_BROWSER_TURN_TIMEOUT_MS,
  MAX_BROWSER_TURN_TIMEOUT_MS } from './piSession';
import { MemoryPiTranscriptStore, validatePiTranscript } from './piTranscript';
import type { SseStreamEvent } from '../../../src/lib/codex/event-mapper';
import { projectPiHistory } from './piHistory';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

const model = {
  id: 'browser-local-test', name: 'browser-local-test', api: 'browser-local', provider: 'browser',
  baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false, contextWindow: 4096, maxTokens: 512,
} as Model<any>;

test('recorded failure wins over an interrupted marker in projected history', () => {
  const timestamp = Date.now();
  const thread = projectPiHistory('project_failure', 'thread_failure', 'browser', model.id,
    [{ role: 'user', content: 'Measure', timestamp }], ['pi-turn-0'],
    { 'pi-turn-0': 'truncated' });
  expect(thread.turns[0]).toMatchObject({ status: 'failed',
    error: { additionalDetails: 'browserModelTruncated' } });
});

test('reused completed tool-call IDs within a turn remain distinct after history restore', () => {
  const timestamp = Date.now();
  const toolUse = (value: number): AgentMessage => ({ role: 'assistant',
    content: [{ type: 'toolCall', id: 'call_0', name: 'measure', arguments: { value } }],
    api: model.api, provider: model.provider, model: model.id, timestamp, stopReason: 'toolUse',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const result = (value: number): AgentMessage => ({ role: 'toolResult',
    toolCallId: 'call_0', toolName: 'measure', isError: false, timestamp,
    content: [{ type: 'text', text: String(value * 2) }],
  });
  const messages: AgentMessage[] = [
    { role: 'user', content: 'Compare', timestamp },
    toolUse(2), result(2), toolUse(5), result(5),
  ];
  const thread = projectPiHistory('project_reused', 'thread_reused', 'browser', model.id, messages);
  const tools = thread.turns[0].items.filter(item => item.type === 'mcpToolCall');
  expect(tools.map(item => item.arguments)).toEqual([{ value: 2 }, { value: 5 }]);
  expect(tools.map(item => item.status)).toEqual(['completed', 'completed']);
  expect(new Set(tools.map(item => item.id)).size).toBe(2);
});

test('a tool-only final assistant is a failed turn with completed results journaled as failed', async () => {
  const storage = new MemoryPiTranscriptStore();
  const events: SseStreamEvent[] = [];
  const session = await BrowserPiAppServerSession.open({ projectId: 'project_tool_only',
    threadId: 'thread_tool_only', model, systemPrompt: '', storage,
    onEvent: event => events.push(event), tools: [{ name: 'measure', label: 'Measure',
      description: 'Measure', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text' as const, text: '7' }], details: null }) }],
    streamFn: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const second = context.messages.at(-1)?.role === 'toolResult';
      const message = { role: 'assistant' as const,
        content: second ? [] : [{ type: 'toolCall' as const, id: 'call_one',
          name: 'measure', arguments: {} }], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: second ? 'stop' as const : 'toolUse' as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    },
  }, storage);
  try {
    await session.send({ workspacePath: 'browser-project:project_tool_only', message: 'Measure' });
    expect(events.filter(event => event.event === 'completed').at(-1)?.payload.status).toBe('failed');
    expect(session.historyThread().turns[0]?.status).toBe('failed');
    expect((await storage.read('project_tool_only', 'thread_tool_only'))?.messages
      .some(message => message.role === 'toolResult')).toBe(true);
  } finally { session.dispose(); }
});

test('assistant pre-tool commentary cannot be mistaken for the final answer', async () => {
  const storage = new MemoryPiTranscriptStore();
  const events: SseStreamEvent[] = [];
  const session = new BrowserPiAppServerSession({ projectId: 'project_commentary',
    threadId: 'thread_commentary', model, systemPrompt: '', tools: [], storage,
    onEvent: event => events.push(event),
    streamFn: () => createAssistantMessageEventStream() });
  session.agent.prompt = async message => {
    const timestamp = Date.now();
    session.agent.state.messages.push({ role: 'user', content: message, timestamp },
      { role: 'assistant', content: [{ type: 'text', text: 'I will measure this.' },
        { type: 'toolCall', id: 'pending_tool', name: 'measure', arguments: { value: 1 } }],
      api: model.api, provider: model.provider, model: model.id, timestamp,
      stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0,
          cacheWrite: 0, total: 0 } } },
      { role: 'toolResult', toolCallId: 'pending_tool', toolName: 'measure',
        content: [{ type: 'text', text: '2' }], isError: false, timestamp });
  };
  try {
    await session.send({ workspacePath: 'browser-project:project_commentary', message: 'Measure' });
    expect(events.filter(event => event.event === 'completed').at(-1)?.payload.status).toBe('failed');
  } finally { session.dispose(); }
});

test('ungated agent property remains assignable for existing session integrations', () => {
  const session = new BrowserPiAppServerSession({ projectId: 'ungated_assignment',
    threadId: 'ungated_assignment', model, systemPrompt: '', tools: [],
    streamFn: () => createAssistantMessageEventStream() });
  const agent = session.agent;
  session.agent = agent;
  expect(session.agent).toBe(agent);
  session.dispose();
});

test('valid retained tool histories beyond old 256-message and 256-KB limits remain usable', async () => {
  const storage = new MemoryPiTranscriptStore();
  const timestamp = Date.now();
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < 31; turn++) {
    messages.push({ role: 'user', content: `Experiment ${turn}`, timestamp });
    for (let call = 0; call < 5; call++) {
      const id = `tool_${turn}_${call}`;
      messages.push({ role: 'assistant', content: [{ type: 'toolCall', id,
        name: 'measure', arguments: { value: call } }], api: model.api,
        provider: model.provider, model: model.id, timestamp, stopReason: 'toolUse',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      messages.push({ role: 'toolResult', toolCallId: id, toolName: 'measure',
        isError: false, timestamp, content: [{ type: 'text', text: 'x'.repeat(1200) }] });
    }
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Done' }],
      api: model.api, provider: model.provider, model: model.id, timestamp, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  expect(messages.length).toBeGreaterThan(256);
  expect(new TextEncoder().encode(JSON.stringify(messages)).byteLength).toBeGreaterThan(256 * 1024);
  await storage.compareAndSwap({ version: 1, projectId: 'project_large_history',
    threadId: 'thread_large_history', revision: 1, messages }, 0);
  const options = { projectId: 'project_large_history', threadId: 'thread_large_history',
    model, systemPrompt: '', tools: [], maxTurns: 64, streamFn: (() => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Usable' }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'stop' as const, usage: { input: 0, output: 0, cacheRead: 0,
          cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
            cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); });
      return stream;
    }) satisfies StreamFn };
  const session = await BrowserPiAppServerSession.open(options, storage);
  await session.send({ workspacePath: 'browser-project:project_large_history', message: 'Next' });
  expect(session.historyThread().turns).toHaveLength(32);
});

test('exceeding the finite transcript envelope reports capacity without corrupting an earlier revision', async () => {
  const storage = new MemoryPiTranscriptStore();
  const projectId = 'project_capacity';
  const threadId = 'thread_capacity';
  await storage.compareAndSwap({ version: 1, projectId, threadId, revision: 1,
    messages: [{ role: 'user', content: 'Retain this turn', timestamp: Date.now() }] }, 0);
  const before = await storage.read(projectId, threadId);
  await expect(storage.compareAndSwap({ ...before!, revision: 2,
    messages: Array.from({ length: 3073 }, (_, index) => ({ role: 'user' as const,
      content: `Turn ${index}`, timestamp: Date.now() })) }, 1))
    .rejects.toThrow('exceeds finite capacity; start a new thread');
  expect(await storage.read(projectId, threadId)).toEqual(before);
});

test('browser-local multi-pass inference has an extended but finite per-turn deadline', () => {
  const streamFn: StreamFn = () => createAssistantMessageEventStream();
  const options = { projectId: 'project_slow', threadId: 'thread_slow',
    model, streamFn, tools: [], systemPrompt: '' };
  const session = new BrowserPiAppServerSession(options);
  expect(DEFAULT_BROWSER_TURN_TIMEOUT_MS).toBe(600_000);
  expect(MAX_BROWSER_TURN_TIMEOUT_MS).toBe(5_400_000);
  expect((session as unknown as { timeoutMs: number }).timeoutMs)
    .toBe(DEFAULT_BROWSER_TURN_TIMEOUT_MS);
  expect(() => new BrowserPiAppServerSession({ ...options, timeoutMs: 1_800_000 }))
    .not.toThrow();
  expect(() => new BrowserPiAppServerSession({ ...options, timeoutMs: MAX_BROWSER_TURN_TIMEOUT_MS }))
    .not.toThrow();
  expect(() => new BrowserPiAppServerSession({ ...options,
    timeoutMs: MAX_BROWSER_TURN_TIMEOUT_MS + 1 })).toThrow('Invalid browser session bounds');
  expect(() => new BrowserPiAppServerSession({ ...options, timeoutMs: 0 }))
    .toThrow('Invalid browser session bounds');
});

test('a stalled browser-local stream is aborted by the configured finite deadline', async () => {
  const events: SseStreamEvent[] = [];
  let modelAborted = false;
  const streamFn: StreamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant' as const, content: [], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: 'aborted' as const, usage: { input: 0, output: 0, cacheRead: 0,
        cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'start', partial: message });
    options?.signal?.addEventListener('abort', () => {
      modelAborted = true;
      stream.push({ type: 'error', reason: 'aborted', error: message });
    }, { once: true });
    return stream;
  };
  const session = new BrowserPiAppServerSession({ projectId: 'project_timeout',
    threadId: 'thread_timeout', model, streamFn, systemPrompt: '', tools: [],
    timeoutMs: 100, onEvent: event => events.push(event) });
  await session.send({ threadId: 'thread_timeout',
    workspacePath: 'browser-project:project_timeout', message: 'Wait' });
  expect(modelAborted).toBe(true);
  expect(events.some(event => event.event === 'completed' &&
    event.payload.status === 'interrupted')).toBe(true);
});

test('a model that ignores abort cannot hold the HTTP turn open or execute a late tool', async () => {
  const events: SseStreamEvent[] = [];
  const storage = new MemoryPiTranscriptStore();
  let pending: ReturnType<typeof createAssistantMessageEventStream> | undefined;
  let toolExecutions = 0;
  const session = new BrowserPiAppServerSession({ projectId: 'project_unresponsive',
    threadId: 'thread_unresponsive', model, systemPrompt: '', timeoutMs: 100, storage,
    onEvent: event => events.push(event), streamFn: () => {
      pending = createAssistantMessageEventStream();
      // Intentionally ignore Pi's abort signal and never finish the model stream.
      return pending;
    }, tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async () => { toolExecutions++; return { content: [{ type: 'text', text: 'bad' }], details: null }; },
    }] });
  const request = { threadId: 'thread_unresponsive',
    workspacePath: 'browser-project:project_unresponsive', message: 'Measure' };
  const started = Date.now();
  await session.send(request);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(events.some(event => event.event === 'completed' &&
    event.payload.status === 'interrupted')).toBe(true);
  expect(session.historyThread().turns[0]?.status).toBe('interrupted');
  expect((await storage.read('project_unresponsive', 'thread_unresponsive'))?.messages
    .filter(message => message.role === 'user')).toHaveLength(1);
  expect(toolExecutions).toBe(0);
  const message = { role: 'assistant' as const,
    content: [{ type: 'toolCall' as const, id: 'late-tool', name: 'measure', arguments: { value: 5 } }],
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: 'toolUse' as const, usage: { input: 0, output: 0, cacheRead: 0,
      cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
        cacheRead: 0, cacheWrite: 0, total: 0 } } };
  pending?.push({ type: 'start', partial: message });
  pending?.push({ type: 'done', reason: 'toolUse', message });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(toolExecutions).toBe(0);
  expect(session.historyThread().turns[0]?.status).toBe('interrupted');
  await session.send(request);
  expect(session.historyThread().turns.map(turn => turn.status))
    .toEqual(['interrupted', 'interrupted']);
});

test('completed browser tool results survive timeout and reload without automatic replay', async () => {
  const store = new MemoryPiTranscriptStore();
  let modelCalls = 0;
  let toolCalls = 0;
  let lateStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
  const streamFn: StreamFn = (_model, context) => {
    modelCalls++;
    const stream = createAssistantMessageEventStream();
    if (modelCalls === 2) { lateStream = stream; return stream; }
    const tool = modelCalls === 1;
    const message = { role: 'assistant' as const,
      content: tool ? [{ type: 'toolCall' as const, id: 'experiment-1', name: 'measure',
        arguments: { value: 7 } }] : [{ type: 'text' as const, text: 'Prior result: 14' }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: tool ? 'toolUse' as const : 'stop' as const,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (modelCalls === 3) {
      expect(JSON.stringify(context.messages)).toContain('14');
    }
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message }); });
    return stream;
  };
  const options = { projectId: 'project_journal', threadId: 'thread_journal',
    model, systemPrompt: '', timeoutMs: 100, streamFn,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async (_id: string, args: { value: number }) => {
        toolCalls++;
        return { content: [{ type: 'text' as const, text: String(args.value * 2) }], details: null };
      } }] };
  const first = await BrowserPiAppServerSession.open(options, store);
  const stale = await BrowserPiAppServerSession.open(options, store);
  await first.send({ workspacePath: 'browser-project:project_journal', message: 'Experiment' });
  expect(toolCalls).toBe(1);
  expect(modelCalls).toBe(2);
  const persisted = await store.read('project_journal', 'thread_journal');
  expect(persisted?.messages.filter(message => message.role === 'toolResult')).toHaveLength(1);
  await expect(stale.send({ workspacePath: 'browser-project:project_journal', message: 'Stale' }))
    .rejects.toThrow('changed in another tab');
  expect(modelCalls).toBe(2);
  expect(() => validatePiTranscript({ ...persisted,
    interruptedTurnIds: ['pi-turn-999'] }, 'project_journal', 'thread_journal'))
    .toThrow('Invalid browser Pi interrupted turn journal');
  expect(() => validatePiTranscript({ ...persisted,
    failedTurns: { 'pi-turn-0': 'truncated' } }, 'project_journal', 'thread_journal'))
    .toThrow('Invalid browser Pi failed turn journal');
  const restored = await BrowserPiAppServerSession.open(options, store);
  expect(modelCalls).toBe(2);
  const interrupted = restored.historyThread().turns[0];
  expect(interrupted?.status).toBe('interrupted');
  expect(interrupted?.items.find(item => item.type === 'mcpToolCall'))
    .toMatchObject({ status: 'completed', arguments: { value: 7 } });
  const lateMessage = { role: 'assistant' as const,
    content: [{ type: 'toolCall' as const, id: 'late-call', name: 'measure', arguments: { value: 99 } }],
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: 'toolUse' as const, usage: { input: 0, output: 0, cacheRead: 0,
      cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
        cacheRead: 0, cacheWrite: 0, total: 0 } } };
  lateStream?.push({ type: 'start', partial: lateMessage });
  lateStream?.push({ type: 'done', reason: 'toolUse', message: lateMessage });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(toolCalls).toBe(1);
  await restored.send({ workspacePath: 'browser-project:project_journal', message: 'Compare' });
  expect(toolCalls).toBe(1);
  expect(restored.historyThread().turns.map(turn => turn.status))
    .toEqual(['interrupted', 'completed']);
});

test('completed tool results survive an over-limit model answer as failed durable history', async () => {
  const storage = new MemoryPiTranscriptStore();
  let calls = 0;
  const options = { projectId: 'project_limit_journal', threadId: 'thread_limit_journal',
    model, systemPrompt: '', storage, tools: [{ name: 'measure', label: 'Measure',
      description: 'Measure', parameters: { type: 'object', properties: {
        value: { type: 'number' } }, required: ['value'], additionalProperties: false },
      execute: async () => ({ content: [{ type: 'text' as const, text: '4' }], details: null }) }],
    streamFn: (() => {
      const stream = createAssistantMessageEventStream();
      const tool = ++calls === 1;
      const message = { role: 'assistant' as const,
        content: tool ? [{ type: 'toolCall' as const, id: 'call_0', name: 'measure',
          arguments: { value: 2 } }] : [{ type: 'text' as const, text: 'x'.repeat(33 * 1024) }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: tool ? 'toolUse' as const : 'stop' as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    }) satisfies StreamFn };
  const first = await BrowserPiAppServerSession.open(options, storage);
  await first.send({ workspacePath: 'browser-project:project_limit_journal', message: 'Measure' });
  const restored = await BrowserPiAppServerSession.open(options, storage);
  const turn = restored.historyThread().turns[0];
  expect(turn.status).toBe('failed');
  expect(turn.items.find(item => item.type === 'mcpToolCall'))
    .toMatchObject({ status: 'completed', arguments: { value: 2 } });
});

test('a hung final save respects the finite deadline and releases the active turn', async () => {
  const storage = new MemoryPiTranscriptStore();
  let writes = 0;
  const originalWrite = storage.compareAndSwap.bind(storage);
  storage.compareAndSwap = async (value, revision) => {
    if (++writes === 2) return new Promise<void>(() => {});
    return originalWrite(value, revision);
  };
  const session = new BrowserPiAppServerSession({ projectId: 'project_final_hang',
    threadId: 'thread_final_hang', model, systemPrompt: '', tools: [], storage, timeoutMs: 100,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Done' }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'stop' as const, usage: { input: 0, output: 0, cacheRead: 0,
          cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
            cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); });
      return stream;
    } });
  await Promise.race([session.send({ workspacePath: 'browser-project:project_final_hang',
    message: 'Run' }), new Promise((_, reject) => setTimeout(() => reject(new Error('hung turn')), 260))]);
  expect((session as unknown as { activeTurn: string | null }).activeTurn).toBeNull();
});

test('failed final save retains completed tools but requires reload before another turn', async () => {
  const storage = new MemoryPiTranscriptStore();
  const originalWrite = storage.compareAndSwap.bind(storage);
  let writes = 0;
  storage.compareAndSwap = async (next, revision) => {
    if (++writes === 4) throw new Error('ambiguous-final-write');
    return originalWrite(next, revision);
  };
  let modelCalls = 0;
  const options = { projectId: 'project_final_failure', threadId: 'thread_final_failure',
    model, systemPrompt: '', storage, tools: [{ name: 'measure', label: 'Measure',
      description: 'Measure', parameters: { type: 'object', properties: {
        value: { type: 'number' } }, required: ['value'], additionalProperties: false },
      execute: async () => ({ content: [{ type: 'text' as const, text: '4' }], details: null }) }],
    streamFn: (() => {
      const stream = createAssistantMessageEventStream();
      const tool = ++modelCalls === 1;
      const message = { role: 'assistant' as const,
        content: tool ? [{ type: 'toolCall' as const, id: 'call_0', name: 'measure',
          arguments: { value: 2 } }] : [{ type: 'text' as const, text: 'Done' }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: tool ? 'toolUse' as const : 'stop' as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    }) satisfies StreamFn };
  const first = await BrowserPiAppServerSession.open(options, storage);
  const request = { workspacePath: 'browser-project:project_final_failure', message: 'Measure' };
  await first.send(request);
  expect(() => first.historyThread()).toThrow('storage unavailable');
  await expect(first.send(request)).rejects.toThrow('storage unavailable');
  const restored = await BrowserPiAppServerSession.open(options, storage);
  const turn = restored.historyThread().turns[0];
  expect(turn?.status).toBe('failed');
  expect(turn?.error?.message).toBe('Browser model outcome not recorded; completed tools retained');
  expect(turn?.items.find(item => item.type === 'mcpToolCall'))
    .toMatchObject({ status: 'completed', arguments: { value: 2 } });
});

test('user Stop during a tool and after an earlier completed tool keeps a restorable interrupted journal', async () => {
  for (const stopAt of [1, 2]) {
    const storage = new MemoryPiTranscriptStore();
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const executing = new Promise<void>(resolve => { entered = resolve; });
    let modelCalls = 0;
    let toolCalls = 0;
    const projectId = `project_stop_${stopAt}`;
    const threadId = `thread_stop_${stopAt}`;
    const options = { projectId, threadId, model, systemPrompt: '', storage,
      tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
        parameters: { type: 'object', properties: { value: { type: 'number' } },
          required: ['value'], additionalProperties: false },
        execute: async () => {
          toolCalls++;
          if (toolCalls === stopAt) { entered(); await blocked; }
          return { content: [{ type: 'text' as const, text: String(toolCalls * 2) }], details: null };
        } }],
      streamFn: (() => {
        const stream = createAssistantMessageEventStream();
        const value = ++modelCalls;
        const message = { role: 'assistant' as const, content: value > 2 ?
          [{ type: 'text' as const, text: 'Done' }] : [{ type: 'toolCall' as const,
            id: 'call_0', name: 'measure', arguments: { value } }], api: model.api,
          provider: model.provider, model: model.id, timestamp: Date.now(),
          stopReason: value > 2 ? 'stop' as const : 'toolUse' as const,
          usage: { input: 0, output: 0, cacheRead: 0,
            cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
              cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { stream.push({ type: 'start', partial: message });
          stream.push({ type: 'done', reason: message.stopReason, message }); });
        return stream;
      }) satisfies StreamFn };
    const session = await BrowserPiAppServerSession.open(options, storage);
    const pending = session.send({ workspacePath: `browser-project:${projectId}`, message: 'Measure' });
    await executing;
    session.stop({ threadId });
    release();
    await pending;
    const restored = await BrowserPiAppServerSession.open(options, storage);
    const turn = restored.historyThread().turns[0];
    expect(turn?.status).toBe('interrupted');
    expect(turn?.items.filter(item => item.type === 'mcpToolCall' && item.status === 'completed'))
      .toHaveLength(stopAt - 1);
    expect(restored.agent.state.messages.filter(message => message.role === 'toolResult'))
      .toHaveLength(stopAt - 1);
  }
});

test('unresponsive browser storage cannot hold an expired turn open indefinitely', async () => {
  const store = new MemoryPiTranscriptStore();
  store.compareAndSwap = async () => new Promise<void>(() => {});
  let modelCalls = 0;
  const session = new BrowserPiAppServerSession({ projectId: 'project_storage_hang',
    threadId: 'thread_storage_hang', model, systemPrompt: '', tools: [],
    timeoutMs: 100, storage: store, streamFn: () => {
      modelCalls++;
      return createAssistantMessageEventStream();
    } });
  const request = { threadId: session.threadId,
    workspacePath: `browser-project:${session.projectId}`, message: 'Wait' };
  const started = Date.now();
  await session.send(request);
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(modelCalls).toBe(0);
  expect(() => session.historyThread()).toThrow('storage unavailable');
  await expect(session.send(request)).rejects.toThrow('storage unavailable');
});

test('a failed durable transcript CAS completes the canonical turn and forbids unsafe retry', async () => {
  const store = new MemoryPiTranscriptStore();
  store.compareAndSwap = async () => { throw new Error('sensitive-storage-internals'); };
  let modelCalls = 0;
  const streamFn: StreamFn = () => {
    modelCalls++;
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Result' }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: 'stop' as const, usage: { input: 0, output: 0, cacheRead: 0,
        cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message }); });
    return stream;
  };
  const session = new BrowserPiAppServerSession({ projectId: 'project_unsaved',
    threadId: 'thread_unsaved', model, systemPrompt: '', tools: [], storage: store, streamFn });
  const request = { threadId: 'thread_unsaved',
    workspacePath: 'browser-project:project_unsaved', message: 'Run' };
  const sse = await session.stream(request).text();
  expect(sse).toContain('event: completed');
  expect(sse).toContain('Browser conversation could not be saved');
  expect(sse).not.toContain('sensitive-storage-internals');
  expect(modelCalls).toBe(0);
  await expect(session.send(request)).rejects.toThrow('storage unavailable');
  expect(() => session.historyThread()).toThrow('storage unavailable');
  expect(modelCalls).toBe(0);
  expect(await store.read('project_unsaved', 'thread_unsaved')).toBeNull();
});

test('browser storage preflight failure never exposes raw storage internals or starts the model', async () => {
  const store = new MemoryPiTranscriptStore();
  store.read = async () => { throw new Error('sensitive-indexeddb-file-path'); };
  let modelCalls = 0;
  const options = { projectId: 'project_read_error', threadId: 'thread_read_error',
    model, systemPrompt: '', tools: [], streamFn: (() => {
      modelCalls++;
      return createAssistantMessageEventStream();
    }) as StreamFn };
  await expect(BrowserPiAppServerSession.open(options, store))
    .rejects.toThrow('Browser conversation storage unavailable; reload before sending');
  const session = new BrowserPiAppServerSession({ ...options, storage: store });
  await expect(session.stream({ threadId: options.threadId,
    workspacePath: `browser-project:${options.projectId}`, message: 'Run' }).text())
    .rejects.toThrow('Browser conversation storage unavailable; reload before sending');
  expect(modelCalls).toBe(0);

  store.read = async () => { throw new Error('different-sensitive-exception'); };
  await expect(session.send({ threadId: options.threadId,
    workspacePath: `browser-project:${options.projectId}`, message: 'Retry' }))
    .rejects.not.toThrow('different-sensitive-exception');
  expect(modelCalls).toBe(0);
});

test('a thrown browser tool error is sanitized before Pi model context, SSE and durable history', async () => {
  const store = new MemoryPiTranscriptStore();
  const modelContexts: string[] = [];
  const session = new BrowserPiAppServerSession({ projectId: 'project_tool_error',
    threadId: 'thread_tool_error', model, systemPrompt: '', storage: store,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async () => { throw new Error('sensitive-tool-provider-internals'); } }],
    streamFn: (_model, context) => {
      modelContexts.push(JSON.stringify(context.messages));
      const previousResult = context.messages.at(-1)?.role === 'toolResult';
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const,
        content: previousResult ? [{ type: 'text' as const, text: 'Measurement unavailable' }] :
          [{ type: 'toolCall' as const, id: 'error-call', name: 'measure', arguments: { value: 9 } }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: previousResult ? 'stop' as const : 'toolUse' as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    } });
  const sse = await session.stream({ threadId: session.threadId,
    workspacePath: `browser-project:${session.projectId}`, message: 'Measure nine' }).text();
  const transcript = await store.read(session.projectId, session.threadId);
  expect(sse).toContain('Browser tool failed');
  expect(sse).toContain('Measurement unavailable');
  expect(modelContexts).toHaveLength(2);
  expect(modelContexts[1]).toContain('Browser tool failed');
  expect([sse, ...modelContexts, JSON.stringify(transcript), JSON.stringify(session.historyThread())]
    .join('\n')).not.toContain('sensitive-tool-provider-internals');
});

test('structured tool output is bounded before model context, SSE and durable storage', async () => {
  const store = new MemoryPiTranscriptStore();
  const contexts: string[] = [];
  const session = new BrowserPiAppServerSession({ projectId: 'project_large_tool',
    threadId: 'thread_large_tool', model, systemPrompt: '', storage: store,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async () => ({ content: [{ type: 'text', text: 'small' }],
        structuredContent: { payload: 'sensitive-structured-prefix' + 'x'.repeat(8192) },
        details: { payload: 'sensitive-details-prefix' + 'x'.repeat(8192) } }) }],
    streamFn: (_model, context) => {
      contexts.push(JSON.stringify(context.messages));
      const previousResult = context.messages.at(-1)?.role === 'toolResult';
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const,
        content: previousResult ? [{ type: 'text' as const, text: 'Tool output unavailable' }] :
          [{ type: 'toolCall' as const, id: 'large-call', name: 'measure', arguments: { value: 2 } }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: previousResult ? 'stop' as const : 'toolUse' as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    } });
  const sse = await session.stream({ threadId: session.threadId,
    workspacePath: `browser-project:${session.projectId}`, message: 'Measure two' }).text();
  expect(sse).toContain('Browser tool result exceeds limit');
  expect(contexts[1]).toContain('Browser tool result exceeds limit');
  const visible = [sse, ...contexts, JSON.stringify(await store.read(session.projectId, session.threadId))]
    .join('\n');
  expect(visible).not.toContain('sensitive-structured-prefix');
  expect(visible).not.toContain('sensitive-details-prefix');
});

test('overlapping model tool IDs retain completed journal results without replacing history', async () => {
  const store = new MemoryPiTranscriptStore();
  const session = new BrowserPiAppServerSession({ projectId: 'project_invalid_trace',
    threadId: 'thread_invalid_trace', model, systemPrompt: '', storage: store,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async () => ({ content: [{ type: 'text', text: 'value=1' }], details: null }) }],
    streamFn: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const previousResult = context.messages.at(-1)?.role === 'toolResult';
      const message = { role: 'assistant' as const,
        content: previousResult ? [{ type: 'text' as const, text: 'Done' }] : [
          { type: 'toolCall' as const, id: 'duplicate-call', name: 'measure', arguments: { value: 1 } },
          { type: 'toolCall' as const, id: 'duplicate-call', name: 'measure', arguments: { value: 2 } }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: previousResult ? 'stop' as const : 'toolUse' as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    } });
  const request = { threadId: session.threadId,
    workspacePath: `browser-project:${session.projectId}`, message: 'Measure' };
  const sse = await session.stream(request).text();
  expect(sse).toContain('Browser local model turn failed');
  expect(sse).not.toContain('duplicate tool call');
  expect((await store.read(session.projectId, session.threadId))?.messages
    .filter(message => message.role === 'toolResult')).toHaveLength(2);
  const restored = await BrowserPiAppServerSession.open({ projectId: session.projectId,
    threadId: session.threadId, model, systemPrompt: '', tools: [], streamFn: () =>
      createAssistantMessageEventStream() }, store);
  expect(restored.historyThread().turns[0]?.status).toBe('failed');
});

test('an oversized assistant answer cannot reach SSE or durable browser history', async () => {
  const store = new MemoryPiTranscriptStore();
  const session = new BrowserPiAppServerSession({ projectId: 'project_long_answer',
    threadId: 'thread_long_answer', model, systemPrompt: '', storage: store, tools: [],
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'sensitive-overlong-answer' + 'x'.repeat(33 * 1024) }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'stop' as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); });
      return stream;
    } });
  const request = { threadId: session.threadId,
    workspacePath: `browser-project:${session.projectId}`, message: 'Write' };
  const sse = await session.stream(request).text();
  expect(sse).toContain('event: completed');
  expect(sse).toContain('Browser local model turn failed');
  expect(sse).not.toContain('sensitive-overlong-answer');
  expect((await store.read(session.projectId, session.threadId))?.messages
    .filter(message => message.role === 'user')).toHaveLength(0);
  await expect(session.send(request)).rejects.toThrow('exceeded assistant output limit');
});

test('oversized model text deltas are denied before the canonical SSE event', async () => {
  const store = new MemoryPiTranscriptStore();
  const session = new BrowserPiAppServerSession({ projectId: 'project_large_delta',
    threadId: 'thread_large_delta', model, systemPrompt: '', storage: store, tools: [],
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const, content: [], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'stop' as const, usage: { input: 0, output: 0, cacheRead: 0,
          cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0,
            cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0,
          delta: 'sensitive-delta' + 'x'.repeat(33 * 1024), partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); });
      return stream;
    } });
  const sse = await session.stream({ threadId: session.threadId,
    workspacePath: `browser-project:${session.projectId}`, message: 'Write' }).text();
  expect(sse).toContain('Browser local model turn failed');
  expect(sse).not.toContain('sensitive-delta');
  expect((await store.read(session.projectId, session.threadId))?.messages
    .filter(message => message.role === 'user')).toHaveLength(0);
});

test('Pi tool-start events cannot leak oversized model arguments before tool validation', async () => {
  const store = new MemoryPiTranscriptStore();
  let executions = 0;
  const session = new BrowserPiAppServerSession({ projectId: 'project_big_args',
    threadId: 'thread_big_args', model, systemPrompt: '', storage: store,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'string' } },
        required: ['value'], additionalProperties: false },
      execute: async () => { executions++; return { content: [{ type: 'text', text: 'wrong' }], details: null }; } }],
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const,
        content: [{ type: 'toolCall' as const, id: 'oversized', name: 'measure',
          arguments: { value: 'sensitive-large-arguments' + 'x'.repeat(9 * 1024) } }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'toolUse' as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'toolUse', message }); });
      return stream;
    } });
  const request = { threadId: session.threadId,
    workspacePath: `browser-project:${session.projectId}`, message: 'Measure' };
  const sse = await session.stream(request).text();
  expect(sse).toContain('event: completed');
  expect(sse).toContain('Browser local model turn failed');
  expect(sse).not.toContain('sensitive-large-arguments');
  expect(executions).toBe(0);
  expect((await store.read(session.projectId, session.threadId))?.messages
    .filter(message => message.role === 'user')).toHaveLength(0);
  await expect(session.send(request)).rejects.toThrow('exceeded browser event limit');
});

test('Pi cannot emit more than sixteen tool-start cards for one browser turn', async () => {
  const store = new MemoryPiTranscriptStore();
  let executions = 0;
  const session = new BrowserPiAppServerSession({ projectId: 'project_many_tools',
    threadId: 'thread_many_tools', model, systemPrompt: '', storage: store,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async () => { executions++; return { content: [{ type: 'text', text: '1' }], details: null }; } }],
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const,
        content: Array.from({ length: 17 }, (_, index) => ({ type: 'toolCall' as const,
          id: `many-call-${index}`, name: 'measure', arguments: { value: index } })),
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'toolUse' as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'toolUse', message }); });
      return stream;
    } });
  const sse = await session.stream({ threadId: session.threadId,
    workspacePath: `browser-project:${session.projectId}`, message: 'Measure many' }).text();
  expect(sse).toContain('Browser local model turn failed');
  expect(sse).not.toContain('many-call-16');
  expect(executions).toBeLessThanOrEqual(16);
  expect((await store.read(session.projectId, session.threadId))?.messages
    .filter(message => message.role === 'user')).toHaveLength(1);
  expect((await store.read(session.projectId, session.threadId))?.messages
    .filter(message => message.role === 'toolResult')).toHaveLength(executions);
});

test('Pi exact streamFn retains two turns, executes model-selected numeric args, and projects real app-server notifications', async () => {
  const toolArgs: number[] = [];
  const events: SseStreamEvent[] = [];
  const notifications: string[] = [];
  const modelContexts: string[][] = [];
  const streamFn: StreamFn = (_model, context) => {
    modelContexts.push(context.messages.map(message => message.role));
    const stream = createAssistantMessageEventStream();
    const prompted = [...context.messages].reverse().find(message => message.role === 'user');
    const delta = JSON.stringify(prompted).toLowerCase().includes('different') ? 3 : 0;
    const priorResult = context.messages.at(-1)?.role === 'toolResult';
    const content = priorResult ? [{ type: 'text' as const, text: `Measured ${delta * 2}` }] :
      [{ type: 'toolCall' as const, id: 'reused-across-turns', name: 'measure', arguments: { value: delta } }];
    const message = { role: 'assistant' as const, content, api: model.api, provider: model.provider,
      model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: priorResult ? 'stop' as const : 'toolUse' as const, timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message }); });
    return stream;
  };
  const session = new BrowserPiAppServerSession({ projectId: 'project_A', threadId: 'thread_A',
    model, streamFn, systemPrompt: 'Measure.', onEvent: (event, notification) => {
      events.push(event); if (notification) notifications.push(notification.method);
    }, tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async (_id, args: { value: number }) => {
        toolArgs.push(args.value);
        return { content: [{ type: 'text', text: JSON.stringify({ result: args.value * 2 }) }], details: null };
      } }] });
  await session.send({ threadId: 'thread_A', workspacePath: 'browser-project:project_A', message: 'Baseline' });
  await session.send({ threadId: 'thread_A', workspacePath: 'browser-project:project_A', message: 'Different experiment' });
  expect(toolArgs).toEqual([0, 3]);
  expect(modelContexts.at(-1)).toContain('toolResult');
  expect(session.agent.state.messages.filter(message => message.role === 'user')).toHaveLength(2);
  expect(events.filter(event => event.event === 'tool' && event.payload.phase === 'completed')).toHaveLength(2);
  expect(events.filter(event => event.event === 'final')).toHaveLength(2);
  expect(events.filter(event => event.event === 'completed')).toHaveLength(2);
  expect(notifications).toContain('item/started');
  expect(notifications).toContain('turn/completed');
  const history = session.historyThread();
  expect(history.projectId).toBe('project_A');
  expect(history.id).toBe('thread_A');
  expect(history.turns).toHaveLength(2);
  expect(history.turns.map(turn => turn.items.filter(item => item.type === 'mcpToolCall')
    .map(item => item.status))).toEqual([['completed'], ['completed']]);
  expect(history.turns.every(turn => turn.items.some(item => item.type === 'agentMessage'))).toBe(true);
  expect(() => session.stop({ threadId: 'thread_B' })).toThrow('Wrong browser thread');
  await expect(session.send({ threadId: 'thread_A', workspacePath: '/tmp/native', message: 'No' }))
    .rejects.toThrow('capability unavailable');
});

test('Pi session emits the existing HTTP-SSE frontend event framing, not a browser-only chat shape', async () => {
  const session = new BrowserPiAppServerSession({ projectId: 'project_B', threadId: 'thread_B',
    model, systemPrompt: '', tools: [], streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Grounded answer' }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'stop' as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
          totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); });
      return stream;
    },
  });
  const response = session.stream({ threadId: 'thread_B', workspacePath: 'browser-project:project_B',
    message: 'Answer' });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const sse = await response.text();
  expect(sse).toContain('event: thread\n');
  expect(sse).toContain('event: userMessage\n');
  expect(sse).toContain('event: final\n');
  expect(sse).toContain('event: completed\n');
  expect(sse).toContain('Grounded answer');
});

test('a local model failure emits a typed canonical turn error without leaking provider details', async () => {
  const observed: SseStreamEvent[] = [];
  const storage = new MemoryPiTranscriptStore();
  const session = new BrowserPiAppServerSession({ projectId: 'project_fail', threadId: 'thread_fail',
    model, systemPrompt: '', tools: [], storage, onEvent: event => observed.push(event),
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const, content: [], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'error' as const, errorMessage: 'sensitive-provider-internals',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0,
            cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'error', reason: 'error', error: message }); });
      return stream;
    } });
  const sse = await session.stream({ threadId: 'thread_fail',
    workspacePath: 'browser-project:project_fail', message: 'Run' }).text();
  const completed = observed.find(event => event.event === 'completed');
  expect(completed?.payload.status).toBe('failed');
  expect(completed?.payload.error).toMatchObject({ message: 'Browser local model turn failed' });
  expect(sse).toContain('event: completed');
  expect(sse).not.toContain('sensitive-provider-internals');
  const restored = session.historyThread();
  expect(restored.turns[0]?.status).toBe('failed');
  expect(restored.turns[0]?.error?.message).toBe('Browser local model turn failed');
  expect(JSON.stringify(restored)).not.toContain('sensitive-provider-internals');
  const persisted = await storage.read('project_fail', 'thread_fail');
  expect(JSON.stringify(persisted)).not.toContain('sensitive-provider-internals');
  expect(JSON.stringify(persisted)).toContain('Browser local model turn failed');
  expect(JSON.stringify(session.agent.state.messages)).not.toContain('sensitive-provider-internals');
  await session.send({ threadId: 'thread_fail', workspacePath: 'browser-project:project_fail',
    message: 'Try again' });
  expect(JSON.stringify(await storage.read('project_fail', 'thread_fail')))
    .not.toContain('sensitive-provider-internals');
});

test('validated Pi transcript restores context in same project and rejects another tab revision', async () => {
  const store = new MemoryPiTranscriptStore();
  let modelCalls = 0;
  const streamFn: StreamFn = (_model, context) => {
    modelCalls++;
    const stream = createAssistantMessageEventStream();
    const answer = context.messages.filter(message => message.role === 'user').length.toString();
    const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: answer }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: 'stop' as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
        totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message }); });
    return stream;
  };
  const options = { projectId: 'project_P', threadId: 'thread_P', model,
    systemPrompt: '', tools: [], streamFn };
  const first = await BrowserPiAppServerSession.open(options, store);
  const stale = await BrowserPiAppServerSession.open(options, store);
  await first.send({ workspacePath: 'browser-project:project_P', message: 'First' });
  const restored = await BrowserPiAppServerSession.open(options, store);
  expect(restored.agent.state.messages.filter(message => message.role === 'user')).toHaveLength(1);
  await restored.send({ workspacePath: 'browser-project:project_P', message: 'Second' });
  expect(restored.agent.state.messages.filter(message => message.role === 'user')).toHaveLength(2);
  const callsBeforeStale = modelCalls;
  await expect(stale.send({ workspacePath: 'browser-project:project_P', message: 'Stale' }))
    .rejects.toThrow('changed in another tab');
  expect(modelCalls).toBe(callsBeforeStale);
  expect(stale.agent.state.messages).toHaveLength(0);
  const persisted = await store.read('project_P', 'thread_P');
  expect(() => validatePiTranscript(persisted, 'project_other', 'thread_P'))
    .toThrow('Invalid browser Pi transcript');
});

test('a persisted browser thread cannot reset its turn budget by reopening', async () => {
  const store = new MemoryPiTranscriptStore();
  let modelCalls = 0;
  const options = { projectId: 'project_turn_limit', threadId: 'thread_turn_limit',
    model, systemPrompt: '', tools: [], maxTurns: 1, streamFn: (() => {
      modelCalls++;
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Done' }], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'stop' as const, usage: { input: 1, output: 1, cacheRead: 0,
          cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0,
            cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); });
      return stream;
    }) satisfies StreamFn };
  const first = await BrowserPiAppServerSession.open(options, store);
  const request = { workspacePath: 'browser-project:project_turn_limit', message: 'First' };
  await first.send(request);
  const reopened = await BrowserPiAppServerSession.open(options, store);
  expect(reopened.agent.state.messages.filter(message => message.role === 'user')).toHaveLength(1);
  await expect(reopened.send({ ...request, message: 'Reopen to bypass limit' }))
    .rejects.toThrow('turn limit reached');
  expect(modelCalls).toBe(1);
});

test('a concurrent tab cannot invoke its model or tools during another browser Pi turn', async () => {
  const store = new MemoryPiTranscriptStore();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let modelCalls = 0;
  const streamFn: StreamFn = () => {
    modelCalls++;
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Done' }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: 'stop' as const, usage: { input: 0, output: 0, cacheRead: 0,
        cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message }); entered();
      void held.then(() => stream.push({ type: 'done', reason: 'stop', message })); });
    return stream;
  };
  const options = { projectId: 'project_lock', threadId: 'thread_lock',
    model, streamFn, systemPrompt: '', tools: [] };
  const first = await BrowserPiAppServerSession.open(options, store);
  const second = await BrowserPiAppServerSession.open(options, store);
  const request = { threadId: 'thread_lock', workspacePath: 'browser-project:project_lock', message: 'Run' };
  const inFlight = first.send(request);
  await started;
  try {
    await expect(second.send(request)).rejects.toThrow('active in another tab');
    expect(modelCalls).toBe(1);
    expect(second.agent.state.messages).toHaveLength(0);
  } finally { release(); }
  await inFlight;
});

test('a stopped HTTP stream never starts Pi model inference after a delayed persistent read', async () => {
  const store = new MemoryPiTranscriptStore();
  const originalRead = store.read.bind(store);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  store.read = async (projectId, threadId) => {
    entered();
    await held;
    return originalRead(projectId, threadId);
  };
  let modelCalls = 0;
  const session = new BrowserPiAppServerSession({ projectId: 'project_abort',
    threadId: 'thread_abort', model, systemPrompt: '', tools: [], storage: store,
    streamFn: () => { modelCalls++; return createAssistantMessageEventStream(); } });
  const abort = new AbortController();
  const response = session.stream({ threadId: 'thread_abort',
    workspacePath: 'browser-project:project_abort', message: 'Canceled' }, abort.signal);
  await reading;
  abort.abort();
  release();
  await expect(response.text()).rejects.toThrow('Browser turn aborted');
  expect(modelCalls).toBe(0);
  expect(session.agent.state.messages).toHaveLength(0);
  expect(await originalRead('project_abort', 'thread_abort')).toBeNull();
});
