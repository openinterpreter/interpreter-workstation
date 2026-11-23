import { expect, test } from 'bun:test';
import type { Wllama } from '@wllama/wllama';
import { browserChatTemplateOptions, createWllamaRuntime } from './wllamaEngine';
import { BrowserPiAppServerSession } from './piSession';
import { MemoryPiTranscriptStore } from './piTranscript';

test('template options are declared by the model, not inferred from its name', () => {
  expect(browserChatTemplateOptions({ id: 'Qwen3-lookalike', name: 'Local',
    assets: [], disableThinking: false })).toEqual({});
  expect(browserChatTemplateOptions({ id: 'other-model', name: 'Local',
    assets: [], disableThinking: true })).toEqual({ chat_template_kwargs: {
      enable_thinking: false,
    } });
});

test('lazy wllama runtime loads a Blob, streams an answer and disposes its worker', async () => {
  const weights = new Blob(['small fake model']);
  let loaded: { files: Blob[]; threads: number; context: number } | undefined;
  let requests = 0;
  let exits = 0;
  const fake = {
    async loadModel(files: Blob[], options: { n_threads: number; n_ctx: number }) {
      loaded = { files, threads: options.n_threads, context: options.n_ctx };
    },
    async createChatCompletion(options: { onData: (chunk: unknown) => void;
      max_tokens: number; messages: unknown[] }) {
      requests++;
      expect(options.max_tokens).toBe(384);
      expect(options.messages.at(-1)).toMatchObject({ role: 'user', content: 'Answer' });
      options.onData({ choices: [{ delta: { content: 'Grounded response' }, finish_reason: 'stop' }] });
    },
    async exit() { exits++; },
  } as unknown as Wllama;
  const descriptor = { id: 'real-format-local', name: 'Local',
    assets: [{ path: 'weights.gguf', url: '/weights.gguf', bytes: weights.size,
      sha256: 'a'.repeat(64) }] };
  const runtime = await createWllamaRuntime(descriptor, weights, 'browser-local', undefined, () => fake);
  expect(loaded).toEqual({ files: [weights], threads: 2, context: 2048 });
  const storage = new MemoryPiTranscriptStore();
  const session = await BrowserPiAppServerSession.open({ projectId: 'project_engine',
    threadId: 'thread_engine', model: runtime.model, streamFn: runtime.streamFn,
    tools: [], systemPrompt: '', storage }, storage);
  try {
    await session.send({ workspacePath: 'browser-project:project_engine', message: 'Answer' });
    expect(session.historyThread().turns[0]?.status).toBe('completed');
    expect(requests).toBe(1);
  } finally { session.dispose(); runtime.dispose?.(); }
  expect(exits).toBe(1);
});

test('the library length finish reason never becomes a successful answer', async () => {
  const weights = new Blob(['mock weights']);
  const runtime = await createWllamaRuntime({ id: 'local-cutoff', name: 'Local',
    assets: [{ path: 'weights.gguf', url: '/weights.gguf', bytes: weights.size,
      sha256: 'a'.repeat(64) }] }, weights, 'browser-local', undefined,
  () => ({ async loadModel() {}, async createChatCompletion(options: {
    onData: (chunk: unknown) => void }) {
    options.onData({ choices: [{ delta: { content: 'Incomplete response' }, finish_reason: 'length' }] });
  }, async exit() {} }) as unknown as Wllama);
  const storage = new MemoryPiTranscriptStore();
  const session = await BrowserPiAppServerSession.open({ projectId: 'project_lib_length',
    threadId: 'thread_lib_length', model: runtime.model, streamFn: runtime.streamFn,
    tools: [], systemPrompt: '', storage }, storage);
  try {
    await session.send({ workspacePath: 'browser-project:project_lib_length', message: 'Answer' });
    expect(session.historyThread().turns[0]).toMatchObject({ status: 'failed',
      error: { additionalDetails: 'browserModelTruncated' } });
  } finally { session.dispose(); runtime.dispose?.(); }
});
