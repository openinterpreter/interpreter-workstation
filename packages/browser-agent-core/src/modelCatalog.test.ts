import { expect, spyOn, test } from 'bun:test';
import { BrowserLocalModelCatalog, DEFAULT_BROWSER_GGUF_MODEL, createBrowserModelDownload } from './modelCatalog';
import { MemoryPiTranscriptStore } from './piTranscript';
import type { Model } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { BrowserLocalProjectBackend } from './browserBackend';
import { BrowserPiAppServerSession } from './piSession';
import { CLIENT_METHOD } from '../../../src/lib/codex/protocol';

const origin = 'https://example.test';
test('the shared core registers a pinned default browser-local model without an app picker', () => {
  expect(Object.isFrozen(DEFAULT_BROWSER_GGUF_MODEL)).toBe(true);
  expect(Object.isFrozen(DEFAULT_BROWSER_GGUF_MODEL.assets)).toBe(true);
  expect(Object.isFrozen(DEFAULT_BROWSER_GGUF_MODEL.assets[0])).toBe(true);
  const [entry] = new BrowserLocalModelCatalog(undefined, origin).list();
  expect(entry?.revision).toBe('daeb8e2d528a760970442092f6bf1e55c3b659eb');
  expect(entry?.assets[0]?.bytes).toBe(1_282_439_264);
  expect(entry?.assets[0]?.sha256).toBe('d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5');
  expect(entry?.disableThinking).toBe(true);
});

test('a catalog configured for another origin cannot read this origin model selection', () => {
  const originalStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem(key: string, value: string) { values.set(key, value); },
    getItem(key: string) { return values.get(key) ?? null; },
  } });
  try {
    const here = new BrowserLocalModelCatalog(undefined, origin);
    const elsewhere = new BrowserLocalModelCatalog(undefined, 'https://elsewhere.test');
    here.select('project_origin', here.list()[0].id);
    expect(here.selected('project_origin').id).toBe(here.list()[0].id);
    expect(() => elsewhere.selected('project_origin')).toThrow('not registered');
  } finally { Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: originalStorage }); }
});
test('the public byte loader cannot allocate a giant model asset', async () => {
  const catalog = new BrowserLocalModelCatalog([{ id: 'large_gguf', name: 'Local',
    revision: 'a'.repeat(40), assets: [{ path: 'weights.gguf', url: '/weights.gguf',
      bytes: 1_282_439_264, sha256: 'a'.repeat(64) }] }], origin);
  await expect(catalog.asset('large_gguf', 'weights.gguf')).rejects.toThrow('streaming only');
  expect(() => new BrowserLocalModelCatalog([{ id: 'large_legacy', name: 'Legacy',
    assets: [{ path: 'weights.bin', url: '/weights.bin',
      bytes: 512 * 1024 * 1024, sha256: 'a'.repeat(64) }] }], origin))
    .toThrow('Invalid browser model asset');
});
const digest = '9372c470eeadd5ecd9c3c74c2b3cb633f8e2f2fad799250a0f70d652b6b825e4';
const descriptor = { id: 'model_one', name: 'Local model', assets: [{
  path: 'weights.bin', url: '/weights.bin', bytes: 5, sha256: digest,
}] };

test('manifest rejects unpinned assets, off-origin HTTP and duplicate model identity', () => {
  expect(() => new BrowserLocalModelCatalog([{ ...descriptor,
    assets: [{ ...descriptor.assets[0], sha256: 'wrong' }] }], origin)).toThrow();
  expect(() => new BrowserLocalModelCatalog([{ ...descriptor,
    assets: [{ ...descriptor.assets[0], url: 'http://remote.test/weights' }] }], origin)).toThrow();
  expect(() => new BrowserLocalModelCatalog([descriptor, descriptor], origin)).toThrow();
});

test('catalog refuses unsupported browser model context bounds', () => {
  for (const contextTokens of [0, 2047, 8193, 4096.5, Number.NaN]) {
    expect(() => new BrowserLocalModelCatalog([{ ...descriptor, contextTokens }], origin))
      .toThrow('Invalid browser model context');
  }
  expect(new BrowserLocalModelCatalog([{ ...descriptor, contextTokens: 4096 }], origin)
    .list()[0]?.contextTokens).toBe(4096);
});

test('catalog session forwards opt-in finite timeout and turn budget to Pi', async () => {
  const originalCaches = globalThis.caches;
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
    open: async () => ({ match: async () => new Response('model') }),
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => 'model_one',
    setItem: () => {},
  } });
  try {
    const catalog = new BrowserLocalModelCatalog([descriptor], origin);
    const options = { projectId: 'project_budget', threadId: 'thread_budget', tools: [],
      systemPrompt: '', timeoutMs: 1_800_000, maxTurns: 1,
      storage: new MemoryPiTranscriptStore(), load: async () => ({
        model: { id: 'model_one', name: 'Local', provider: 'browser', api: 'browser-local',
          input: ['text'] } as Model<any>, streamFn: () => createAssistantMessageEventStream(),
      }) };
    const session = await catalog.openSession(options);
    expect((session as unknown as { timeoutMs: number }).timeoutMs).toBe(1_800_000);
    expect((session as unknown as { maxTurns: number }).maxTurns).toBe(1);
    await expect(catalog.openSession({ ...options, timeoutMs: 5_400_001 }))
      .rejects.toThrow('Invalid browser session bounds');
  } finally {
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('a failed model-selection write disposes the newly opened agent session', async () => {
  const originalCaches = globalThis.caches;
  const originalStorage = globalThis.localStorage;
  const disposed = spyOn(BrowserPiAppServerSession.prototype, 'dispose');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
    open: async () => ({ match: async () => new Response('model') }),
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem: () => { throw new Error('Storage blocked'); },
  } });
  try {
    const catalog = new BrowserLocalModelCatalog([descriptor], origin);
    await expect(catalog.openSession({ projectId: 'project_storage', threadId: 'thread_storage',
      tools: [], systemPrompt: '', storage: new MemoryPiTranscriptStore(),
      load: async () => ({ model: { id: 'model_one', name: 'Local', provider: 'browser',
        api: 'browser-local', input: ['text'] } as Model<any>,
      streamFn: () => createAssistantMessageEventStream() }),
      modelId: 'model_one',
    })).rejects.toThrow('Storage blocked');
    expect(disposed).toHaveBeenCalledTimes(1);
  } finally {
    disposed.mockRestore();
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});

test('explicit acquisition verifies bytes, persists cache and binds selection per project', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalStorage = globalThis.localStorage;
  const responses = new Map<string, Response>();
  const choices = new Map<string, string>();
  let requests = 0;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
    open: async () => ({
      match: async (key: string) => responses.get(key)?.clone(),
      put: async (key: string, value: Response) => { responses.set(key, value.clone()); },
      delete: async (key: string) => responses.delete(key),
    }),
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => choices.get(key) ?? null,
    setItem: (key: string, value: string) => { choices.set(key, value); },
  } });
  globalThis.fetch = (async () => { requests++; return new Response('model'); }) as typeof fetch;
  try {
    const catalog = new BrowserLocalModelCatalog([descriptor], origin);
    expect(requests).toBe(0);
    await catalog.acquire('model_one');
    expect(requests).toBe(1);
    const download = createBrowserModelDownload(catalog, 'browser');
    const progress: Array<{ completed?: number; total?: number; done?: boolean }> = [];
    await download('browser', 'model_one', value => progress.push(value));
    expect(progress).toEqual([
      { completed: 5, total: 5 },
      { done: true },
    ]);
    expect(requests).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(download('browser', 'model_one', () => {}, controller.signal))
      .rejects.toThrow('aborted');
    expect(new TextDecoder().decode(await catalog.asset('model_one', 'weights.bin'))).toBe('model');
    await catalog.acquire('model_one');
    expect(requests).toBe(1);
    catalog.select('project_one', 'model_one');
    expect(catalog.selected('project_one').id).toBe('model_one');
    const backend = new BrowserLocalProjectBackend('project_one', 'browser', catalog, {
      threadId: 'thread_one', tools: [], systemPrompt: '', storage: new MemoryPiTranscriptStore(),
      load: async () => ({
        model: { id: 'model_one', name: 'Local model', provider: 'browser', api: 'browser-local',
          input: ['text'] } as Model<any>, streamFn: () => createAssistantMessageEventStream(),
      }),
    });
    expect((await backend.request(CLIENT_METHOD.interpreterModelList,
      { modelProvider: 'browser' })).data[0]?.id).toBe('model_one');
    expect((await backend.openSession('model_one')).model.id).toBe('model_one');
    const mismatchedBackend = new BrowserLocalProjectBackend('project_mismatch', 'other', catalog, {
      threadId: 'thread_mismatch', tools: [], systemPrompt: '',
      storage: new MemoryPiTranscriptStore(), load: async () => ({
        model: { id: 'model_one', name: 'Local model', provider: 'browser',
          api: 'browser-local', input: ['text'] } as Model<any>,
        streamFn: () => createAssistantMessageEventStream(),
      }),
    });
    await expect(mismatchedBackend.openSession('model_one'))
      .rejects.toThrow('provider identity mismatch');
    expect(() => catalog.selected('project_mismatch')).toThrow('not registered');
    await expect(backend.openSession('missing')).rejects.toThrow('not registered');
    expect(() => catalog.selected('project_two')).toThrow('not registered');
    await expect(catalog.openSession({ projectId: 'project_one', threadId: 'thread_one',
      tools: [], systemPrompt: 'Local only', load: async () => ({
        model: { id: 'unregistered' } as never, streamFn: (() => undefined) as never,
      }),
    })).rejects.toThrow('Browser model identity mismatch');
    responses.set(`${origin}/.workstation-browser-model/model_one/weights.bin`, new Response('other'));
    await expect(catalog.asset('model_one', 'weights.bin')).rejects.toThrow('acquire it first');
    await expect(catalog.openSession({ projectId: 'project_one', threadId: 'thread_one',
      tools: [], systemPrompt: 'Local only', load: async () => {
        throw new Error('unverified loader must not run');
      },
    })).rejects.toThrow('acquire it first');
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  }
});
