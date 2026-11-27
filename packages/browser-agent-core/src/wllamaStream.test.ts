import { expect, test } from 'bun:test';
import type { Model } from '@earendil-works/pi-ai';
import { BrowserPiAppServerSession } from './piSession';
import { MemoryPiTranscriptStore } from './piTranscript';
import { createBrowserGgufStream, type BrowserChatEngine } from './wllamaStream';
import { mapNotificationToUiEvents } from '../../../src/lib/codex/event-mapper';
import { mapBrowserNotificationToUiEvents } from './protocolWire';
import { presentationCandidate } from './presentationGate';
import type { AppServerNotification } from '../../../src/lib/codex/protocol';

const model = { id: 'org/local-gguf', name: 'Local', api: 'browser-local-gguf',
  provider: 'browser', baseUrl: '/', input: ['text'], reasoning: false,
  contextWindow: 2048, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<any>;

test('generic Pi stream retains two different model-selected numeric calls, tool results and reply', async () => {
  const inputs: string[] = [];
  const engine: BrowserChatEngine = { async complete(messages, tools, _signal, onChunk) {
    inputs.push(JSON.stringify(messages));
    expect(tools.map(tool => tool.function.name)).toEqual(['measure']);
    const last = messages.at(-1);
    if (last?.role === 'user') {
      const value = messages.filter(message => message.role === 'user').length === 1 ? 2 : 5;
      onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_0',
        function: { name: 'measure', arguments: JSON.stringify({ value }) } }] }, finish_reason: 'tool_calls' }] });
    } else {
      onChunk({ choices: [{ delta: { content: 'Grounded in the completed local tool result.' }, finish_reason: 'stop' }] });
    }
  } };
  const storage = new MemoryPiTranscriptStore();
  const options = { projectId: 'project_gguf', threadId: 'thread_gguf', model,
    systemPrompt: 'Use measured results.', storage, streamFn: createBrowserGgufStream(engine),
    tools: [{ name: 'measure', label: 'Measure', description: 'Run a measurement',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async (_id: string, args: { value: number }) =>
        ({ content: [{ type: 'text' as const, text: String(args.value * 3) }], details: null }) }] };
  const session = await BrowserPiAppServerSession.open(options, storage);
  const notifications: AppServerNotification[] = [];
  session.subscribeNotifications(notification => notifications.push(notification));
  await session.send({ workspacePath: 'browser-project:project_gguf', message: 'First experiment' });
  await session.send({ workspacePath: 'browser-project:project_gguf', message: 'Different experiment' });
  const restored = await BrowserPiAppServerSession.open({ ...options,
    streamFn: createBrowserGgufStream(engine) }, storage);
  const turns = restored.historyThread().turns;
  expect(turns.map(turn => turn.status)).toEqual(['completed', 'completed']);
  expect(turns.map(turn => turn.items.filter(item => item.type === 'mcpToolCall')
    .map(item => item.arguments))).toEqual([[{ value: 2 }], [{ value: 5 }]]);
  expect(restored.agent.state.messages.filter(message => message.role === 'toolResult'))
    .toHaveLength(2);
  const transcript = await storage.read('project_gguf', 'thread_gguf');
  expect(transcript).not.toBeNull();
  const userIndices = transcript!.messages.flatMap((message, index) =>
    message.role === 'user' ? [index] : []);
  const first = presentationCandidate(transcript!, userIndices[0]!, userIndices[1]!, 'first');
  const second = presentationCandidate(transcript!, userIndices[1]!, transcript!.messages.length, 'second');
  expect(first.tools).toHaveLength(1);
  expect(second.tools).toHaveLength(1);
  expect(first.tools[0]!.id).not.toBe(second.tools[0]!.id);
  expect(second.priorTranscript.messages.some(message => message.role === 'toolResult' &&
    message.toolCallId === first.tools[0]!.id)).toBe(true);
  expect(inputs.at(-1)).toContain(second.tools[0]!.id);
  expect(inputs.at(-1)).toContain('15');
  for (const notification of notifications)
    expect(mapBrowserNotificationToUiEvents(notification))
      .toEqual(mapNotificationToUiEvents(notification));
  await restored.send({ workspacePath: 'browser-project:project_gguf', message: 'Experiment after reload' });
  const afterReload = await storage.read('project_gguf', 'thread_gguf');
  const thirdUser = afterReload!.messages.findIndex((message, index) =>
    index > userIndices[1]! && message.role === 'user');
  const third = presentationCandidate(afterReload!, thirdUser, afterReload!.messages.length, 'third');
  expect(third.tools).toHaveLength(1);
  expect(new Set([first.tools[0]!.id, second.tools[0]!.id, third.tools[0]!.id]).size).toBe(3);
  expect(restored.historyThread().turns.map(turn => turn.status))
    .toEqual(['completed', 'completed', 'completed']);
  session.dispose();
  restored.dispose();
});

test('two model calls with the same raw ID in one turn retain distinct paired identities after reload', async () => {
  const storage = new MemoryPiTranscriptStore();
  let passes = 0;
  const inputs: string[] = [];
  const options = { projectId: 'project_repeated_ids', threadId: 'thread_repeated_ids', model,
    systemPrompt: 'Measure twice.', storage,
    streamFn: createBrowserGgufStream({ async complete(messages, _tools, _signal, onChunk) {
      inputs.push(JSON.stringify(messages));
      passes++;
      if (passes === 3) onChunk({ choices: [{ delta: { content: 'Measured both results.' },
        finish_reason: 'stop' }] });
      else onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_0',
        function: { name: 'measure', arguments: JSON.stringify({ value: passes }) } }] },
      finish_reason: 'tool_calls' }] });
    } }),
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } } },
      execute: async (_id: string, args: { value: number }) =>
        ({ content: [{ type: 'text' as const, text: String(args.value * 3) }], details: null }) }] };
  const session = await BrowserPiAppServerSession.open(options, storage);
  try {
    await session.send({ workspacePath: 'browser-project:project_repeated_ids', message: 'Measure twice' });
    expect(passes).toBe(3);
    expect(session.historyThread().turns[0]?.status).toBe('completed');
    const transcript = await storage.read(options.projectId, options.threadId);
    const start = transcript!.messages.findIndex(message => message.role === 'user');
    const candidate = presentationCandidate(transcript!, start, transcript!.messages.length, 'verified');
    expect(candidate.tools).toHaveLength(2);
    const ids = candidate.tools.map(tool => tool.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id))).toBe(true);
    expect(candidate.tools.map(tool => tool.success)).toEqual([true, true]);
    expect(inputs[2]).toContain(ids[0]!);
    expect(inputs[2]).toContain(ids[1]!);
    const restored = await BrowserPiAppServerSession.open(options, storage);
    try {
      expect(restored.historyThread().turns[0]?.items.filter(item => item.type === 'mcpToolCall'))
        .toHaveLength(2);
    } finally { restored.dispose(); }
  } finally { session.dispose(); }
});

test('a model completion with no text or tool call fails instead of completing an empty turn', async () => {
  const storage = new MemoryPiTranscriptStore();
  const session = await BrowserPiAppServerSession.open({
    projectId: 'project_silent', threadId: 'thread_silent', model,
    systemPrompt: 'Answer the user.', storage,
    streamFn: createBrowserGgufStream({ async complete() {} }), tools: [],
  }, storage);
  try {
    await session.send({ workspacePath: 'browser-project:project_silent', message: 'Please answer' });
    expect(session.historyThread().turns.at(-1)?.status).toBe('failed');
    expect(session.historyThread().turns.at(-1)?.error?.message).toBe('Browser local model turn failed');
    expect(session.agent.state.messages.some(message => message.role === 'assistant' &&
      message.content.length === 0 && message.stopReason === 'stop')).toBe(false);
  } finally { session.dispose(); }
});

test('a length-truncated model reply never completes a successful turn', async () => {
  const storage = new MemoryPiTranscriptStore();
  const session = await BrowserPiAppServerSession.open({
    projectId: 'project_cutoff', threadId: 'thread_cutoff', model,
    systemPrompt: 'Answer the user.', storage,
    streamFn: createBrowserGgufStream({ async complete(_messages, _tools, _signal, onChunk) {
      onChunk({ choices: [{ delta: { content: 'Incomplete' }, finish_reason: 'length' }] });
    } }), tools: [],
  }, storage);
  try {
    await session.send({ workspacePath: 'browser-project:project_cutoff', message: 'Explain' });
    expect(session.historyThread().turns.at(-1)?.status).toBe('failed');
  } finally { session.dispose(); }
});

test('a later stop chunk cannot overwrite an earlier truncation signal', async () => {
  const storage = new MemoryPiTranscriptStore();
  const session = await BrowserPiAppServerSession.open({
    projectId: 'project_late_stop', threadId: 'thread_late_stop', model,
    systemPrompt: 'Answer the user.', storage,
    streamFn: createBrowserGgufStream({ async complete(_messages, _tools, _signal, onChunk) {
      onChunk({ choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] });
      onChunk({ choices: [{ delta: { content: ' suffix' }, finish_reason: 'stop' }] });
    } }), tools: [],
  }, storage);
  try {
    await session.send({ workspacePath: 'browser-project:project_late_stop', message: 'Explain' });
    expect(session.historyThread().turns.at(-1)?.status).toBe('failed');
  } finally { session.dispose(); }
});

for (const reason of ['length', 'content_filter', 'missing'] as const) {
  test(`${reason} terminal reason is a typed truncation in live and reloaded history`, async () => {
    const storage = new MemoryPiTranscriptStore();
    const projectId = `project_cut_${reason}`;
    const threadId = `thread_cut_${reason}`;
    const options = { projectId, threadId, model, systemPrompt: 'Answer.', storage, tools: [],
      streamFn: createBrowserGgufStream({ async complete(_messages, _tools, _signal, onChunk) {
        onChunk({ choices: [{ delta: { content: 'Partial answer at output cap' },
          ...(reason === 'missing' ? {} : { finish_reason: reason }) }],
          ...(reason === 'missing' ? { usage: { completion_tokens: model.maxTokens } } : {}) });
      } }) };
    const session = await BrowserPiAppServerSession.open(options, storage);
    await session.send({ workspacePath: `browser-project:${projectId}`, message: 'Answer' });
    expect(session.historyThread().turns[0]?.status).toBe('failed');
    expect(session.historyThread().turns[0]?.error?.additionalDetails).toBe('browserModelTruncated');
    session.dispose();
    const restored = await BrowserPiAppServerSession.open(options, storage);
    expect(restored.historyThread().turns[0]?.error?.additionalDetails).toBe('browserModelTruncated');
    restored.dispose();
  });
}

test('missing finish reason with measured under-cap tokens is not mislabeled truncation', async () => {
  const storage = new MemoryPiTranscriptStore();
  const options = { projectId: 'project_under_cap', threadId: 'thread_under_cap', model,
    systemPrompt: 'Answer.', storage, tools: [],
    streamFn: createBrowserGgufStream({ async complete(_messages, _tools, _signal, onChunk) {
      onChunk({ choices: [{ delta: { content: 'Complete answer' }, finish_reason: null }],
        usage: { completion_tokens: 12 } });
    } }) };
  const session = await BrowserPiAppServerSession.open(options, storage);
  await session.send({ workspacePath: 'browser-project:project_under_cap', message: 'Answer' });
  expect(session.historyThread().turns[0]?.status).toBe('completed');
  session.dispose();
});

test('missing finish reason and token count is uncertain, not a fabricated truncation', async () => {
  const storage = new MemoryPiTranscriptStore();
  const options = { projectId: 'project_unknown_cap', threadId: 'thread_unknown_cap', model,
    systemPrompt: 'Answer.', storage, tools: [],
    streamFn: createBrowserGgufStream({ async complete(_messages, _tools, _signal, onChunk) {
      onChunk({ choices: [{ delta: { content: 'Maybe incomplete' }, finish_reason: null }] });
    } }) };
  const session = await BrowserPiAppServerSession.open(options, storage);
  await session.send({ workspacePath: 'browser-project:project_unknown_cap', message: 'Answer' });
  expect(session.historyThread().turns[0]?.status).toBe('failed');
  expect(session.historyThread().turns[0]?.error?.additionalDetails).toBeNull();
  session.dispose();
});

test('a model repeatedly calling tools reaches a failed pass budget, not a user Stop', async () => {
  let passes = 0;
  const events: Array<{ event: string; payload: { status?: string } }> = [];
  const storage = new MemoryPiTranscriptStore();
  const session = await BrowserPiAppServerSession.open({
    projectId: 'project_passes', threadId: 'thread_passes', model,
    systemPrompt: 'Answer the user.', storage,
    onEvent: event => events.push(event as typeof events[number]),
    streamFn: createBrowserGgufStream({ async complete(_messages, _tools, _signal, onChunk) {
      passes++;
      onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${passes}`,
        function: { name: 'measure', arguments: '{"value":1}' } }] },
      finish_reason: 'tool_calls' }] });
    } }), tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } } },
      execute: async () => ({ content: [{ type: 'text' as const, text: '1' }], details: null }) }],
  }, storage);
  try {
    await session.send({ workspacePath: 'browser-project:project_passes', message: 'Measure and answer' });
    expect(passes).toBeGreaterThanOrEqual(8);
    expect(events.filter(event => event.event === 'completed').at(-1)?.payload.status).toBe('failed');
    expect(session.historyThread().turns.at(-1)?.status).toBe('failed');
    const restored = await BrowserPiAppServerSession.open({ projectId: 'project_passes', threadId: 'thread_passes', model,
      systemPrompt: 'Answer the user.', storage, streamFn: createBrowserGgufStream({ async complete() {} }), tools: [] }, storage);
    expect(restored.historyThread().turns.at(-1)?.status).toBe('failed');
    restored.dispose();
  } finally { session.dispose(); }
});

test('a model error after a completed tool preserves a failed journal, not user interruption', async () => {
  const storage = new MemoryPiTranscriptStore();
  const session = await BrowserPiAppServerSession.open({
    projectId: 'project_tool_error', threadId: 'thread_tool_error', model,
    systemPrompt: 'Use the measurement.', storage,
    streamFn: createBrowserGgufStream({ async complete(messages, _tools, _signal, onChunk) {
      if (messages.at(-1)?.role === 'user')
        onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1',
          function: { name: 'measure', arguments: '{"value":2}' } }] }, finish_reason: 'tool_calls' }] });
      else throw new Error('Engine failed after measurement');
    } }), tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } } },
      execute: async () => ({ content: [{ type: 'text' as const, text: '6' }], details: null }) }],
  }, storage);
  try {
    await session.send({ workspacePath: 'browser-project:project_tool_error', message: 'Measure' });
    expect(session.historyThread().turns[0]?.status).toBe('failed');
    const restored = await BrowserPiAppServerSession.open({ projectId: 'project_tool_error', threadId: 'thread_tool_error',
      model, systemPrompt: 'Use the measurement.', storage,
      streamFn: createBrowserGgufStream({ async complete() {} }), tools: [] }, storage);
    expect(restored.historyThread().turns[0]?.status).toBe('failed');
    restored.dispose();
    expect((await storage.read('project_tool_error', 'thread_tool_error'))?.messages
      .some(message => message.role === 'toolResult')).toBe(true);
  } finally { session.dispose(); }
});

test('a library length stop after a completed tool remains typed truncated on reload', async () => {
  const storage = new MemoryPiTranscriptStore();
  const options = { projectId: 'project_tool_cut', threadId: 'thread_tool_cut', model,
    systemPrompt: 'Use the tool.', storage,
    streamFn: createBrowserGgufStream({ async complete(messages, _tools, _signal, onChunk) {
      if (messages.at(-1)?.role === 'user')
        onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1',
          function: { name: 'measure', arguments: '{"value":3}' } }] }, finish_reason: 'tool_calls' }] });
      else onChunk({ choices: [{ delta: { content: 'Unfinished answer' }, finish_reason: 'length' }] });
    } }), tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } } },
      execute: async () => ({ content: [{ type: 'text' as const, text: '9' }], details: null }) }] };
  const session = await BrowserPiAppServerSession.open(options, storage);
  await session.send({ workspacePath: 'browser-project:project_tool_cut', message: 'Measure' });
  const restored = await BrowserPiAppServerSession.open(options, storage);
  expect(restored.historyThread().turns[0]).toMatchObject({ status: 'failed',
    error: { codexErrorInfo: 'other', additionalDetails: 'browserModelTruncated' } });
  expect(restored.historyThread().turns[0]?.items.find(item => item.type === 'mcpToolCall'))
    .toMatchObject({ status: 'completed', arguments: { value: 3 } });
  session.dispose(); restored.dispose();
});
