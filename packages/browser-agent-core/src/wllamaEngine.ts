import { Wllama, LoggerWithoutDebug } from '@wllama/wllama';
import type { ChatCompletionMessage, ChatCompletionTool } from '@wllama/wllama';
import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import type { Model } from '@earendil-works/pi-ai';
import { browserModelContextTokens, type BrowserModelDescriptor,
  type BrowserModelRuntime } from './modelCatalog';
import { createBrowserGgufStream, type BrowserChatEngine } from './wllamaStream';

export function browserChatTemplateOptions(descriptor: BrowserModelDescriptor):
  { chat_template_kwargs?: { enable_thinking: false } } {
  return descriptor.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {};
}

/** One lazy CPU/WASM engine per open session; weights remain a verified OPFS-backed Blob. */
export async function createWllamaRuntime(descriptor: BrowserModelDescriptor, weights: Blob,
  providerId: string, openingSignal?: AbortSignal,
  createEngine: () => Wllama = () => new Wllama({ default: wasmUrl },
    { logger: LoggerWithoutDebug })): Promise<BrowserModelRuntime> {
  if (descriptor.assets.length !== 1 || !descriptor.assets[0].path.toLowerCase().endsWith('.gguf'))
    throw new Error('Browser GGUF engine requires one verified model asset');
  const contextTokens = browserModelContextTokens(descriptor);
  let active: Wllama | null = null;
  let loading: Promise<Wllama> | null = null;
  let disposed = false;
  const start = async (signal?: AbortSignal): Promise<Wllama> => {
    if (disposed) throw new Error('Browser model session disposed');
    if (signal?.aborted) throw new DOMException('Browser model load aborted', 'AbortError');
    if (active) return active;
    if (!loading) loading = (async () => {
      const instance = createEngine();
      const stopLoad = () => { void instance.exit().catch(() => {}); };
      signal?.addEventListener('abort', stopLoad, { once: true });
      try {
        await instance.loadModel([weights], { n_gpu_layers: 0, n_threads: 2, n_ctx: contextTokens });
        if (signal?.aborted) throw new DOMException('Browser model load aborted', 'AbortError');
        if (disposed) throw new Error('Browser model session disposed');
        active = instance;
        return instance;
      } catch (error) { await instance.exit().catch(() => {}); throw error; }
      finally { signal?.removeEventListener('abort', stopLoad); }
    })().finally(() => { loading = null; });
    return loading;
  };
  await start(openingSignal);
  const engine: BrowserChatEngine = { async complete(messages, tools, signal, onChunk) {
    if (signal.aborted) throw new DOMException('Browser model turn aborted', 'AbortError');
    const instance = await start(signal);
    let exited = false;
    const abort = () => {
      if (exited) return;
      exited = true;
      if (active === instance) active = null;
      // Abort must terminate the CPU worker rather than merely ending SSE output.
      queueMicrotask(() => { void instance.exit().catch(() => {}); });
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw new DOMException('Browser model turn aborted', 'AbortError');
      await instance.createChatCompletion({ messages: messages as ChatCompletionMessage[],
        stream: true, abortSignal: signal, onData: onChunk,
        max_tokens: 384, temperature: 0, top_k: 1, cache_prompt: true,
        ...browserChatTemplateOptions(descriptor),
        ...(tools.length ? { tools: tools as unknown as ChatCompletionTool[],
          tool_choice: 'auto' as const } : {}),
      });
      if (signal.aborted) throw new DOMException('Browser model turn aborted', 'AbortError');
    } finally {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
  } };
  const model = { id: descriptor.id, name: descriptor.name, provider: providerId,
    api: 'browser-local-gguf', baseUrl: '/', input: descriptor.inputModalities ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false,
    contextWindow: contextTokens, maxTokens: 384 } as Model<any>;
  return { model, streamFn: createBrowserGgufStream(engine), dispose: () => {
    if (disposed) return;
    disposed = true;
    const instance = active;
    active = null;
    if (instance) void instance.exit().catch(() => {});
  } };
}
