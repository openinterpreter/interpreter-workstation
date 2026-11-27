import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import { useChat } from '../../../src/hooks/use-chat';
import { BrowserPiAppServerSession, type BrowserPiSessionOptions } from './piSession';
import { MemoryPiTranscriptStore } from './piTranscript';
import { disableBrowserProjectNativeEvents } from '../../../src/ipc';

afterEach(cleanup);

test('actual useChat consumes Pi app-server SSE through its existing reducer over two model-directed tool turns', async () => {
  const model = { id: 'browser-test', name: 'browser-test', api: 'browser-local', provider: 'browser',
    baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 4096, maxTokens: 256 } as Model<any>;
  const argumentsSeen: number[] = [];
  const store = new MemoryPiTranscriptStore();
  const sessionOptions: BrowserPiSessionOptions = { projectId: 'project_UI', threadId: 'thread_UI', model,
    systemPrompt: 'Use the tool.', tools: [{ name: 'measure', label: 'Measure', description: 'Measure a value',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async (_id, args: { value: number }) => {
        argumentsSeen.push(args.value);
        return { content: [{ type: 'text', text: `measured=${args.value * 2}` }], details: null };
      } }], streamFn: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const distinct = JSON.stringify([...context.messages].reverse().find(m => m.role === 'user'))
        .toLowerCase().includes('different');
      const value = distinct ? 4 : 0;
      const result = context.messages[context.messages.length - 1]?.role === 'toolResult';
      const message = { role: 'assistant' as const,
        content: result ? [{ type: 'text' as const, text: `Grounded ${value * 2}` }] :
          [{ type: 'toolCall' as const, id: 'tool-reused-across-turns', name: 'measure', arguments: { value } }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: result ? 'stop' as const : 'toolUse' as const,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    } };
  const session = await BrowserPiAppServerSession.open(sessionOptions, store);
  disableBrowserProjectNativeEvents();
  const { result } = renderHook(() => useChat('browser', { agentId: 'simple-primary-agent',
    callerToken: 'browser-test', browserSession: session, initialThreadId: 'thread_UI',
    workspacePath: 'browser-project:project_UI' }));
  await waitFor(() => expect(result.current.historyLoaded).toBe(true));
  act(() => result.current.sendMessage('Baseline'));
  await waitFor(() => expect(result.current.messages.some(message =>
    message.role === 'assistant' && message.parts.some(part =>
      part.kind === 'text' && part.content.includes('Grounded 0')))).toBe(true));
  act(() => result.current.sendMessage('Different experiment'));
  await waitFor(() => expect(result.current.messages.some(message =>
    message.role === 'assistant' && message.parts.some(part =>
      part.kind === 'text' && part.content.includes('Grounded 8')))).toBe(true));
  expect(argumentsSeen).toEqual([0, 4]);
  expect(result.current.messages.flatMap(message => message.parts).filter(part =>
    part.kind === 'tool-call' && part.toolCall.state === 'complete')).toHaveLength(2);
  expect(result.current.messages.filter(message => message.role === 'assistant').length).toBeGreaterThanOrEqual(2);
  cleanup();
  const restored = await BrowserPiAppServerSession.open(sessionOptions, store);
  const remounted = renderHook(() => useChat('browser', { agentId: 'simple-primary-agent',
    callerToken: 'browser-remount', browserSession: restored, initialThreadId: 'thread_UI',
    workspacePath: 'browser-project:project_UI' }));
  await waitFor(() => expect(remounted.result.current.messages.filter(message =>
    message.role === 'user')).toHaveLength(2));
  expect(remounted.result.current.messages.flatMap(message => message.parts).filter(part =>
    part.kind === 'tool-call' && part.toolCall.state === 'complete')).toHaveLength(2);
  expect(remounted.result.current.messages.some(message => message.parts.some(part =>
    part.kind === 'text' && part.content.includes('Grounded 8')))).toBe(true);
  expect(argumentsSeen).toEqual([0, 4]);
});

test('actual useChat surfaces a sanitized browser Pi model failure from the canonical SSE reducer', async () => {
  const model = { id: 'browser-failure', name: 'browser-failure', api: 'browser-local', provider: 'browser',
    baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 4096, maxTokens: 256 } as Model<any>;
  const session = new BrowserPiAppServerSession({ projectId: 'project_failure', threadId: 'thread_failure',
    model, systemPrompt: '', tools: [], streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const, content: [], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: 'error' as const,
        errorMessage: 'sensitive-provider-internals', usage: { input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'error', reason: 'error', error: message }); });
      return stream;
    } });
  disableBrowserProjectNativeEvents();
  const { result } = renderHook(() => useChat('browser', { agentId: 'simple-primary-agent',
    callerToken: 'browser-failure-test', browserSession: session, initialThreadId: 'thread_failure',
    workspacePath: 'browser-project:project_failure' }));
  await waitFor(() => expect(result.current.historyLoaded).toBe(true));
  act(() => result.current.sendMessage('Try'));
  await waitFor(() => expect(result.current.isStreaming).toBe(false));
  expect(JSON.stringify(result.current)).not.toContain('sensitive-provider-internals');
  expect(result.current.error).toContain('Browser local model turn failed');
});

test('actual useChat never shows raw browser storage preflight errors', async () => {
  const model = { id: 'browser-storage', name: 'browser-storage', api: 'browser-local', provider: 'browser',
    baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 4096, maxTokens: 256 } as Model<any>;
  const store = new MemoryPiTranscriptStore();
  store.read = async () => { throw new Error('sensitive-indexeddb-file-path'); };
  let modelCalls = 0;
  const session = new BrowserPiAppServerSession({ projectId: 'project_storage',
    threadId: 'thread_storage', model, systemPrompt: '', tools: [], storage: store,
    streamFn: () => { modelCalls++; return createAssistantMessageEventStream(); } });
  disableBrowserProjectNativeEvents();
  const { result } = renderHook(() => useChat('browser', { agentId: 'simple-primary-agent',
    callerToken: 'browser-storage-test', browserSession: session, initialThreadId: 'thread_storage',
    workspacePath: 'browser-project:project_storage' }));
  await waitFor(() => expect(result.current.historyLoaded).toBe(true));
  act(() => result.current.sendMessage('Run'));
  await waitFor(() => expect(result.current.isStreaming).toBe(false));
  expect(result.current.error).toContain('Browser conversation storage unavailable');
  expect(JSON.stringify(result.current)).not.toContain('sensitive-indexeddb-file-path');
  expect(modelCalls).toBe(0);
});
