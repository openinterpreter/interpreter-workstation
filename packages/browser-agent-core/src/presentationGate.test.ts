import { afterAll, expect, test } from 'bun:test';
import * as publicTranscript from '@openinterpreter/browser-agent-core/transcript';
import { IDBDatabase, indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AppServerNotification } from '../../../src/lib/codex/protocol';
import { BrowserPiAppServerSession } from './piSession';
import { brandPersistentStoreForTests, IndexedDbPiTranscriptStore, MemoryPiTranscriptStore, type BrowserPiTranscript,
  type BrowserPiTranscriptStore } from './piTranscript';
import { BrowserPresentationError, presentationCandidate, validatePresentation,
  type PresentationCandidate } from './presentationGate';

const model = { id: 'local', name: 'Local', api: 'browser-local', provider: 'browser',
  baseUrl: '', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false, contextWindow: 4096, maxTokens: 512 } as Model<any>;
const streamFn: StreamFn = () => {
  const stream = createAssistantMessageEventStream();
  const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Verified answer' }],
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: 'stop' as const, usage: { input: 0, output: 0, cacheRead: 0,
      cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0,
        cacheWrite: 0, total: 0 } } };
  queueMicrotask(() => { stream.push({ type: 'start', partial: message });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Verified answer', partial: message });
    stream.push({ type: 'done', reason: 'stop', message }); });
  return stream;
};
const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const locks = new Set<string>();
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fakeIndexedDB });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  locks: { request: async <T>(name: string, _options: unknown,
    callback: (lock: object | null) => Promise<T>): Promise<T> => {
    if (locks.has(name)) return callback(null);
    locks.add(name);
    try { return await callback({ name }); }
    finally { locks.delete(name); }
  } },
} });
afterAll(() => {
  if (previousIndexedDB) Object.defineProperty(globalThis, 'indexedDB', previousIndexedDB);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
  if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});
class DurableTestStore extends IndexedDbPiTranscriptStore {
  readonly testName: string;
  constructor() {
    const name = `browser-presentation-test-${crypto.randomUUID()}`;
    super(name);
    this.testName = name;
    brandPersistentStoreForTests(this);
  }
}
test('a volatile subclass of the IndexedDB store cannot acquire presentation capability', async () => {
  const memory = new MemoryPiTranscriptStore();
  class VolatileSubclass extends IndexedDbPiTranscriptStore {
    constructor() { super(`browser-presentation-volatile-${crypto.randomUUID()}`); }
    override read(...args: Parameters<IndexedDbPiTranscriptStore['read']>) { return memory.read(...args); }
    override compareAndSwapTerminal(...args: Parameters<IndexedDbPiTranscriptStore['compareAndSwapTerminal']>) {
      return memory.compareAndSwapTerminal(...args);
    }
    override runExclusive<T>(projectId: string, threadId: string, action: () => Promise<T>) {
      return memory.runExclusive(projectId, threadId, action);
    }
  }
  let published = 0;
  const store = new VolatileSubclass();
  await expect(BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }), onEvent: () => { published++; } }, store))
    .rejects.toMatchObject({ code: 'capability' });
  expect(published).toBe(0);
});
test('public transcript subpath never exports test-only review helpers', () => {
  expect(Object.keys(publicTranscript)).not.toContain('brandPersistentStoreForTests');
  expect(Object.keys(publicTranscript)).not.toContain('isReviewedTestStore');
});
test('missing Web Locks rejects gated default open before opening IndexedDB', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalOpen = fakeIndexedDB.open;
  let opened = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  fakeIndexedDB.open = function (...args: Parameters<typeof originalOpen>) {
    opened++;
    return originalOpen.apply(this, args);
  } as typeof originalOpen;
  try {
    await expect(BrowserPiAppServerSession.open({ ...options,
      presentationValidator: () => ({ accept: true }) }))
      .rejects.toMatchObject({ code: 'capability' });
    expect(opened).toBe(0);
  } finally {
    fakeIndexedDB.open = originalOpen;
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
test('an exact IndexedDB instance ignores volatile own-method shadows', async () => {
  const memory = new MemoryPiTranscriptStore();
  const store = new IndexedDbPiTranscriptStore(`browser-presentation-shadow-${crypto.randomUUID()}`);
  store.read = (...args) => memory.read(...args);
  store.compareAndSwapTerminal = (...args) => memory.compareAndSwapTerminal(...args);
  store.runExclusive = (...args) => memory.runExclusive(...args);
  // An ordinary private TypeScript property is still writable at runtime.
  Object.defineProperty(store, 'db', { value: Promise.resolve(null), configurable: true });
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, store);
  await session.send(request);
  expect(await IndexedDbPiTranscriptStore.prototype.read.call(store,
    options.projectId, options.threadId)).not.toBeNull();
  session.dispose();
});
const options = { projectId: 'gate_project', threadId: 'gate_thread',
  model, systemPrompt: '', tools: [], streamFn };
const request = { workspacePath: 'browser-project:gate_project', message: 'Explain' };

test('candidate includes ordered assistant text before and after tool use', () => {
  const timestamp = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const transcript: BrowserPiTranscript = { version: 1, projectId: options.projectId,
    threadId: options.threadId, revision: 2, presentationRuns: { 'pi-turn-0': 'run-1' },
    presentationPriorRevisions: { 'pi-turn-0': 0 }, messages: [
      { role: 'user', content: 'Measure', timestamp },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier claim: 17. ' },
        { type: 'toolCall', id: 'c1', name: 'measure', arguments: { value: 17 } }],
      api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp, usage },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'measure',
        content: [{ type: 'text', text: '17' }], isError: false, timestamp },
      { role: 'assistant', content: [{ type: 'text', text: 'Final claim: 17.' }],
        api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp, usage },
    ] };
  const candidate = presentationCandidate(transcript, 0, transcript.messages.length, 'run-1', 0);
  expect(candidate.answer).toBe('Final claim: 17.');
  expect(candidate.answerParts).toEqual(['Earlier claim: 17. ', 'Final claim: 17.']);
  expect(candidate.tools).toHaveLength(1);
});

test('validation retains exact text boundaries rather than manufacturing a number', () => {
  const timestamp = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages: BrowserPiTranscript['messages'] = [
    { role: 'user', content: 'Measure', timestamp },
    { role: 'assistant', content: [{ type: 'text', text: 'Measured 1' },
      { type: 'text', text: '7' }], api: model.api, provider: model.provider,
      model: model.id, stopReason: 'stop', timestamp, usage },
  ];
  const candidate = presentationCandidate({ version: 1, projectId: options.projectId,
    threadId: options.threadId, revision: 1, messages }, 0, messages.length, 'run-1');
  expect(candidate.answerParts).toEqual(['Measured 1', '7']);
  expect(candidate.answer).toBe('');
});

test('candidate omits empty assistant text parts that the history projection cannot present', () => {
  const timestamp = Date.now();
  const messages: BrowserPiTranscript['messages'] = [
    { role: 'user', content: 'Measure', timestamp },
    { role: 'assistant', content: [{ type: 'text', text: '' },
      { type: 'text', text: 'Answer' }], api: model.api, provider: model.provider,
      model: model.id, stopReason: 'stop', timestamp,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  ];
  const candidate = presentationCandidate({ version: 1, projectId: options.projectId,
    threadId: options.threadId, revision: 1, messages }, 0, messages.length, 'run-1');
  expect(candidate.answerParts).toEqual(['Answer']);
});

test('reload validation sees earlier assistant text before exposing any turn item', async () => {
  const timestamp = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const store = new DurableTestStore();
  await store.compareAndSwap({ version: 1, projectId: options.projectId, threadId: options.threadId,
    revision: 1, presentationRuns: { 'pi-turn-0': 'run-1' },
    presentationPriorRevisions: { 'pi-turn-0': 0 }, messages: [
      { role: 'user', content: 'Measure', timestamp },
      { role: 'assistant', content: [{ type: 'text', text: 'Unverified claim: 99. ' },
        { type: 'toolCall', id: 'c1', name: 'measure', arguments: { value: 17 } }],
        api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp, usage },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'measure',
        content: [{ type: 'text', text: '17' }], isError: false, timestamp },
      { role: 'assistant', content: [{ type: 'text', text: 'Final claim: 17.' }],
        api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp, usage },
    ] }, 0);
  const seen: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: candidate => {
      seen.push(candidate.answerParts.join(' | '));
      return candidate.answerParts.some(part => part.includes('Unverified claim: 99.'))
        ? { accept: false, reason: 'Earlier false claim' } : { accept: true };
    } }, store);
  expect(seen).toEqual(['Unverified claim: 99.  | Final claim: 17.']);
  expect(session.historyThread().turns[0].items.every(item => item.type === 'userMessage')).toBe(true);
  session.dispose();
});

test('default gated storage reports a typed capability failure when IndexedDB is absent', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try {
    await expect(BrowserPiAppServerSession.open({ ...options,
      presentationValidator: () => ({ accept: true }) }))
      .rejects.toMatchObject({ name: 'BrowserPresentationError', code: 'capability' });
    // The default-off path retains its existing storage failure behavior.
    await expect(BrowserPiAppServerSession.open(options))
      .rejects.toThrow('Browser Pi persistent storage unavailable');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});

test('volatile memory store cannot provide gated replies on first run or reload', async () => {
  expect(() => new BrowserPiAppServerSession({ ...options,
    presentationValidator: () => ({ accept: true }) })).toThrow(BrowserPresentationError);
  const store = new MemoryPiTranscriptStore();
  const open = () => BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, store);
  await expect(open()).rejects.toMatchObject({ code: 'capability' });
  class SpoofedMemoryStore extends MemoryPiTranscriptStore {
    readonly durability = 'persistent' as const;
    readonly crossTabLockCapability = true;
    async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number): Promise<void> {
      await this.compareAndSwap(value, revision);
    }
  }
  await expect(BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, new SpoofedMemoryStore()))
    .rejects.toMatchObject({ code: 'capability' });
  await store.compareAndSwap({ version: 1, projectId: options.projectId,
    threadId: options.threadId, revision: 1, messages: [] }, 0);
  await expect(open()).rejects.toMatchObject({ code: 'capability' });
  const noLock = new DurableTestStore();
  Object.defineProperty(noLock, 'crossTabLockCapability', { value: false });
  await expect(BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, noLock))
    .rejects.toMatchObject({ code: 'capability' });
});

test('provisional content cannot be read through agent, listeners or stream on rejection', async () => {
  const store = new DurableTestStore();
  let resolve!: (value: { accept: false; reason: string }) => void;
  const gate = new Promise<{ accept: false; reason: string }>(done => { resolve = done; });
  const notifications: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => gate,
    onEvent: event => notifications.push(JSON.stringify(event)) }, store);
  session.subscribeNotifications(notification => notifications.push(JSON.stringify(notification)));
  const pending = session.send(request);
  for (let i = 0; i < 100 && !(await store.read(options.projectId, options.threadId))?.messages
    .some(message => message.role === 'assistant'); i++) await new Promise(r => setTimeout(r, 1));
  expect(() => session.agent).toThrow(BrowserPresentationError);
  expect(() => session.historyThread()).toThrow();
  expect(notifications.join('')).not.toContain('Verified answer');
  resolve({ accept: false, reason: 'Not grounded' });
  await pending;
  expect(notifications.join('')).not.toContain('Verified answer');
  session.dispose();
  const restored = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, store);
  expect(restored.historyThread().turns.every(turn =>
    turn.items.every(item => item.type === 'userMessage'))).toBe(true);
  restored.dispose();
});

test('accepted answer is visible only after terminal write and digest-matched readback; reload revalidates', async () => {
  const store = new DurableTestStore();
  let validated: PresentationCandidate | undefined;
  const notifications: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: candidate => { validated = candidate; return { accept: true }; },
    onEvent: event => notifications.push(JSON.stringify(event)) }, store);
  await session.send(request);
  expect(validated?.answer).toBe('Verified answer');
  expect(Object.isFrozen(validated?.priorTranscript)).toBe(true);
  expect(notifications.join('')).toContain('Verified answer');
  expect(session.historyThread().turns[0].items.some(item => item.type === 'agentMessage')).toBe(true);
  session.dispose();
  const rejected = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: false, reason: 'Changed policy' }) }, store);
  expect(rejected.historyThread().turns[0].items.every(item => item.type === 'userMessage')).toBe(true);
  await expect(rejected.send(request)).rejects.toMatchObject({ code: 'incomplete' });
  rejected.dispose();
  let restoredCandidate: PresentationCandidate | undefined;
  const reopened = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: candidate => { restoredCandidate = candidate; return { accept: true }; } }, store);
  expect(reopened.historyThread().turns[0].items.some(item => item.type === 'agentMessage')).toBe(true);
  expect(restoredCandidate?.priorTranscript).toEqual(validated?.priorTranscript);
  expect(restoredCandidate?.runId).toBe(validated?.runId);
  reopened.dispose();
});

test('busy cross-tab lock fails typed before model inference', async () => {
  const store = new DurableTestStore();
  let calls = 0;
  store.runExclusive = async () => { throw new Error('Browser Pi thread is active in another tab'); };
  const session = await BrowserPiAppServerSession.open({ ...options,
    streamFn: (...args) => { calls++; return streamFn(...args); },
    presentationValidator: () => ({ accept: true }) }, store);
  await expect(session.send(request)).rejects.toMatchObject({ code: 'busy' });
  expect(calls).toBe(0);
  session.dispose();
});

test('a stalled durable re-read under the lease fails typed before model inference', async () => {
  class StalledReadStore extends DurableTestStore {
    reads = 0;
    override async read(projectId: string, threadId: string) {
      if (++this.reads > 1) return new Promise<BrowserPiTranscript | null>(() => {});
      return super.read(projectId, threadId);
    }
  }
  const store = new StalledReadStore();
  let calls = 0;
  const session = await BrowserPiAppServerSession.open({ ...options, timeoutMs: 100,
    streamFn: (...args) => { calls++; return streamFn(...args); },
    presentationValidator: () => ({ accept: true }) }, store);
  await expect(Promise.race([session.send(request), new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('durable re-read did not settle')), 450))]))
    .rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(calls).toBe(0);
  session.dispose();
});

test('normal Stop before any tool result leaves the gated session usable', async () => {
  const store = new DurableTestStore();
  let calls = 0;
  let started!: () => void;
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  const session = await BrowserPiAppServerSession.open({ ...options,
    streamFn: (...args) => {
      if (++calls === 1) { started(); return createAssistantMessageEventStream(); }
      return streamFn(...args);
    }, presentationValidator: () => ({ accept: true }) }, store);
  const first = session.send(request);
  await modelStarted;
  session.stop({ threadId: options.threadId });
  await first;
  await session.send(request);
  expect(calls).toBe(2);
  expect(session.historyThread().turns.at(-1)?.status).toBe('completed');
  session.dispose();
});

test('Stop during the initial journal transaction leaves the gated session usable', async () => {
  class StoppedInitialJournal extends DurableTestStore {
    first = true;
    entered!: () => void;
    writing = new Promise<void>(resolve => { this.entered = resolve; });
    override async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number,
      signal?: AbortSignal) {
      if (this.first) {
        this.first = false;
        this.entered();
        return new Promise<void>((_, reject) => {
          if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true });
        });
      }
      return super.compareAndSwapTerminal(value, revision, signal);
    }
  }
  const store = new StoppedInitialJournal();
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, store);
  const first = session.send(request);
  await store.writing;
  session.stop({ threadId: options.threadId });
  await first;
  await session.send(request);
  expect(session.historyThread().turns.at(-1)?.status).toBe('completed');
  session.dispose();
});

test('Stop during a tool-result journal transaction retains committed context and permits another send', async () => {
  class StoppedToolJournal extends DurableTestStore {
    entered!: () => void;
    writing = new Promise<void>(resolve => { this.entered = resolve; });
    override async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number,
      signal?: AbortSignal) {
      if (value.messages.some(message => message.role === 'toolResult')) {
        this.entered();
        return new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true });
        });
      }
      return super.compareAndSwapTerminal(value, revision, signal);
    }
  }
  const store = new StoppedToolJournal();
  let calls = 0;
  const toolStream: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const first = ++calls === 1;
    const message = { role: 'assistant' as const,
      content: first ? [{ type: 'toolCall' as const, id: 'call_0', name: 'measure', arguments: {} }]
        : [{ type: 'text' as const, text: 'Verified answer' }], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: first ? 'toolUse' as const : 'stop' as const,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message }); });
    return stream;
  };
  const session = await BrowserPiAppServerSession.open({ ...options, streamFn: toolStream,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text' as const, text: '7' }], details: null }) }],
    presentationValidator: () => ({ accept: true }) }, store);
  const first = session.send(request);
  await store.writing;
  session.stop({ threadId: options.threadId });
  await first;
  await session.send(request);
  expect(session.historyThread().turns.at(-1)?.status).toBe('completed');
  session.dispose();
});

test('validator rejection with a terminal rollback leaves a usable gated session', async () => {
  const store = new DurableTestStore();
  let decisions = 0;
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ++decisions === 1
      ? { accept: false, reason: 'not grounded' } : { accept: true } }, store);
  await session.send(request);
  const first = session.historyThread();
  expect(first.turns).toHaveLength(1);
  expect(first.turns[0]).toMatchObject({ status: 'failed',
    error: { additionalDetails: 'browserPresentation:rejected' } });
  expect(first.turns[0].items.every(item => item.type === 'userMessage')).toBe(true);
  await session.send(request);
  expect(session.historyThread().turns.at(-1)?.status).toBe('completed');
  session.dispose();
  const reloaded = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, store);
  expect(reloaded.historyThread().turns[0]).toMatchObject({ status: 'failed',
    error: { additionalDetails: 'browserPresentation:rejected' } });
  await reloaded.send(request);
  expect(reloaded.historyThread().turns.at(-1)?.status).toBe('completed');
  reloaded.dispose();
});

test('a second send on the same gated session fails typed busy without starting a turn', async () => {
  const store = new DurableTestStore();
  let release!: (value: { accept: true }) => void;
  let entered!: () => void;
  const validating = new Promise<void>(resolve => { entered = resolve; });
  const decision = new Promise<{ accept: true }>(resolve => { release = resolve; });
  let modelCalls = 0;
  const session = await BrowserPiAppServerSession.open({ ...options,
    streamFn: (...args) => { modelCalls++; return streamFn(...args); },
    presentationValidator: () => { entered(); return decision; } }, store);
  const first = session.send(request);
  await validating;
  await expect(session.send(request)).rejects.toMatchObject({ code: 'busy' });
  expect(modelCalls).toBe(1);
  release({ accept: true });
  await first;
  session.dispose();
});

test('a same-revision cross-tab byte change requires reload and revalidation before another turn', async () => {
  const store = new DurableTestStore();
  let modelCalls = 0;
  const validator = (candidate: PresentationCandidate) => candidate.answer === 'Verified answer'
    ? { accept: true as const } : { accept: false as const, reason: 'Changed answer' };
  const session = await BrowserPiAppServerSession.open({ ...options,
    streamFn: (...args) => { modelCalls++; return streamFn(...args); },
    presentationValidator: validator }, store);
  await session.send(request);
  const recorded = await store.read(options.projectId, options.threadId);
  expect(recorded).not.toBeNull();
  const changed = structuredClone(recorded!);
  const final = changed.messages.findLast(message => message.role === 'assistant');
  if (final?.role !== 'assistant' || final.content[0]?.type !== 'text')
    throw new Error('Expected a completed assistant turn');
  final.content[0].text = 'Unverified answer';
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = fakeIndexedDB.open(store.testName);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('threads', 'readwrite');
    transaction.objectStore('threads').put(changed, `${options.projectId}:${options.threadId}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  await expect(session.send(request)).rejects.toMatchObject({ code: 'incomplete' });
  expect(modelCalls).toBe(1);
  session.dispose();
  const reopened = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: validator }, store);
  expect(reopened.historyThread().turns[0].items.every(item => item.type === 'userMessage')).toBe(true);
  reopened.dispose();
});

test('failed final readback does not publish buffered assistant items or cache success', async () => {
  class MismatchedReadStore extends DurableTestStore {
    override async read(projectId: string, threadId: string) {
      const value = await super.read(projectId, threadId);
      return value?.presentationRuns ? { ...value, revision: value.revision + 1 } : value;
    }
  }
  const store = new MismatchedReadStore();
  const events: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }),
    onEvent: event => events.push(JSON.stringify(event)) }, store);
  await session.send(request);
  expect(events.join('')).not.toContain('Verified answer');
  expect(events.join('')).toContain('browserPresentation:storage-unavailable');
  expect(() => session.historyThread()).toThrow(BrowserPresentationError);
  try { session.historyThread(); } catch (error) {
    expect(error).toMatchObject({ code: 'storage-unavailable' });
  }
  await expect(session.send(request)).rejects.toMatchObject({ code: 'storage-unavailable' });
  session.dispose();
});

test('late final commit after deadline stays hidden live and is revalidated on reload', async () => {
  class LateCommitStore extends DurableTestStore {
    override async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number,
      signal?: AbortSignal) {
      if (value.presentationRuns && Object.keys(value.presentationRuns).length)
        await new Promise(resolve => setTimeout(resolve, 150));
      // Deliberately ignores the signal, simulating an acknowledged late commit.
      await this.compareAndSwap(value, revision);
      void signal;
    }
  }
  const store = new LateCommitStore();
  const events: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options, timeoutMs: 100,
    presentationValidator: () => ({ accept: true }),
    onEvent: event => events.push(JSON.stringify(event)) }, store);
  await session.send(request);
  expect(events.join('')).not.toContain('Verified answer');
  expect(events.join('')).toContain('browserPresentation:storage-unavailable');
  session.dispose();
  const reopened = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, store);
  expect(reopened.historyThread().turns[0].items.some(item =>
    item.type === 'agentMessage' && item.text === 'Verified answer')).toBe(true);
  reopened.dispose();
});

test('the exclusive lock covers model tools, validator, durable write and publication', async () => {
  class ObservedStore extends DurableTestStore {
    held = false;
    finalWriteHeld = false;
    override async runExclusive<T>(project: string, thread: string, action: () => Promise<T>) {
      return super.runExclusive(project, thread, async () => {
        this.held = true;
        try { return await action(); } finally { this.held = false; }
      });
    }
    override async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number,
      signal?: AbortSignal) {
      if (Object.keys(value.presentationRuns ?? {}).length) this.finalWriteHeld = this.held;
      return super.compareAndSwapTerminal(value, revision, signal);
    }
  }
  const store = new ObservedStore();
  const seen: string[] = [];
  const published: Array<Extract<AppServerNotification, { method: 'item/completed' }>['params']['item']> = [];
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const toolStream: StreamFn = (_model, context) => {
    const stream = createAssistantMessageEventStream();
    const second = context.messages.at(-1)?.role === 'toolResult';
    const message = { role: 'assistant' as const, content: second ?
      [{ type: 'text' as const, text: 'Measured value 7' }] :
      [{ type: 'toolCall' as const, id: 'call_0', name: 'measure', arguments: { value: 7 } }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: second ? 'stop' as const : 'toolUse' as const,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message }); });
    return stream;
  };
  const gated = { ...options, streamFn: toolStream,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } } },
      execute: async () => ({ content: [{ type: 'text' as const, text: '7' }], details: null }) }],
    presentationValidator: async (candidate: PresentationCandidate) => {
      expect(store.held).toBe(true);
      expect(candidate.tools).toMatchObject([{ id: 'call_0', name: 'measure',
        arguments: { value: 7 }, success: true }]);
      enter(); await hold; return { accept: true as const };
    },
  };
  const session = await BrowserPiAppServerSession.open({ ...gated,
    onEvent: event => { if (JSON.stringify(event).includes('Measured value')) {
      expect(store.held).toBe(true); seen.push('answer');
    } } }, store);
  session.subscribeNotifications(notification => {
    if (notification.method === 'item/completed' && notification.params.item.type !== 'userMessage')
      published.push(notification.params.item);
  });
  const second = await BrowserPiAppServerSession.open(gated, store);
  const pending = session.send(request);
  await entered;
  expect(seen).toEqual([]);
  await expect(second.send(request)).rejects.toMatchObject({ code: 'busy' });
  release(); await pending;
  expect(store.finalWriteHeld).toBe(true);
  expect(seen).toEqual(['answer']);
  const reopened = await BrowserPiAppServerSession.open({ ...gated,
    presentationValidator: () => ({ accept: true }) }, store);
  expect(published).toEqual(reopened.historyThread().turns[0].items
    .filter(item => item.type !== 'userMessage'));
  reopened.dispose();
  session.dispose(); second.dispose();
});

test('strict IndexedDB transaction reaches its terminal event before answer publication and lock release', async () => {
  const store = new DurableTestStore();
  const original = IDBDatabase.prototype.transaction;
  let strict = false;
  let terminal = false;
  let released = false;
  const observations: Array<{ strict: boolean; terminal: boolean; released: boolean }> = [];
  IDBDatabase.prototype.transaction = (function (this: IDBDatabase, names: string | string[], mode?: IDBTransactionMode,
    options?: IDBTransactionOptions) {
    const transaction = original.call(this, names, mode, options);
    if (mode === 'readwrite' && options?.durability === 'strict') {
      strict = true;
      transaction.addEventListener('complete', () => { terminal = true; });
    }
    return transaction;
  }) as typeof IDBDatabase.prototype.transaction;
  const exclusive = store.runExclusive.bind(store);
  store.runExclusive = async (project, thread, action) => exclusive(project, thread, async () => {
    try { return await action(); }
    finally { released = true; }
  });
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }),
    onEvent: event => {
      if (event.event === 'final') {
        observations.push({ strict, terminal, released });
      }
    } }, store);
  try { await session.send(request); }
  finally { IDBDatabase.prototype.transaction = original; }
  expect(observations).toEqual([{ strict: true, terminal: true, released: false }]);
  expect(terminal).toBe(true);
  expect(released).toBe(true);
  session.dispose();
});

test('terminal CAS compares revision and puts inside one atomic IndexedDB transaction', async () => {
  const name = `browser-presentation-atomic-${crypto.randomUUID()}`;
  const first = new IndexedDbPiTranscriptStore(name);
  const second = new IndexedDbPiTranscriptStore(name);
  const messages: BrowserPiTranscript['messages'] = [
    { role: 'user', content: 'One', timestamp: Date.now() }];
  const base = { version: 1 as const, projectId: options.projectId,
    threadId: options.threadId, revision: 1 };
  const outcomes = await Promise.allSettled([
    first.compareAndSwapTerminal({ ...base, messages }, 0),
    second.compareAndSwapTerminal({ ...base, messages: [
      { role: 'user', content: 'Two', timestamp: Date.now() }] }, 0),
  ]);
  expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect((await first.read(options.projectId, options.threadId))?.revision).toBe(1);
});

test('a throwing presentation observer cannot turn an already durable answer into a failure', async () => {
  const store = new DurableTestStore();
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, store);
  session.subscribeNotifications(() => { throw new Error('observer failed'); });
  const received: string[] = [];
  session.subscribeNotifications(notification => received.push(notification.method));
  await session.send(request);
  expect(received).toContain('turn/completed');
  expect(session.historyThread().turns[0].status).toBe('completed');
  session.dispose();
});

test('an incomplete completed-tool journal is hidden on reload, not approved by a stored marker', async () => {
  const store = new DurableTestStore();
  const timestamp = Date.now();
  await store.compareAndSwap({ version: 1, projectId: options.projectId,
    threadId: options.threadId, revision: 1, interruptedTurnIds: ['pi-turn-0'],
    presentationRuns: { 'pi-turn-0': 'untrusted-stored-success' },
    presentationPriorRevisions: { 'pi-turn-0': 0 }, messages: [
      // A persisted marker has no authority without a complete paired turn.
      { role: 'user', content: 'Measure', timestamp },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'measure',
        arguments: { value: 12 } }], api: model.api, provider: model.provider, model: model.id,
        stopReason: 'toolUse', timestamp, usage: { input: 0, output: 0, cacheRead: 0,
          cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
            cacheRead: 0, cacheWrite: 0, total: 0 } } },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'measure',
        content: [{ type: 'text', text: 'SECRET RESULT' }], isError: false, timestamp },
    ] }, 0);
  let calls = 0;
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => { calls++; return { accept: true }; } }, store);
  const turn = session.historyThread().turns[0];
  expect(calls).toBe(0);
  expect(turn.items).toHaveLength(1);
  expect(turn.status).toBe('failed');
  expect(JSON.stringify(turn)).not.toContain('SECRET RESULT');
  session.dispose();
});

test('the ordinary event stream does not bypass a rejecting validator', async () => {
  const store = new DurableTestStore();
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: false, reason: 'Rejected' }) }, store);
  const response = session.stream(request);
  const body = await response.text();
  expect(body).not.toContain('Verified answer');
  expect(body).toContain('browserPresentation:rejected');
  session.dispose();
});

test('caller options mutation cannot disable the gate after the session opens', async () => {
  const store = new DurableTestStore();
  const supplied = { ...options,
    presentationValidator: () => ({ accept: false as const, reason: 'Rejected' }) };
  const events: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...supplied,
    onEvent: event => events.push(JSON.stringify(event)) }, store);
  supplied.presentationValidator = undefined as unknown as typeof supplied.presentationValidator;
  await session.send(request);
  expect(events.join('')).not.toContain('Verified answer');
  expect(events.join('')).toContain('browserPresentation:rejected');
  expect(() => session.agent).toThrow(BrowserPresentationError);
  session.dispose();
});

test('caller mutation during asynchronous open cannot turn a gated session into an ungated one', async () => {
  let release!: () => void;
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const pendingRead = new Promise<void>(resolve => { release = resolve; });
  class SlowReadStore extends DurableTestStore {
    override async read(projectId: string, threadId: string) {
      entered(); await pendingRead;
      return super.read(projectId, threadId);
    }
  }
  const store = new SlowReadStore();
  const supplied = { ...options,
    presentationValidator: () => ({ accept: false as const, reason: 'Rejected' }) };
  const opening = BrowserPiAppServerSession.open(supplied, store);
  await reading;
  supplied.presentationValidator = undefined as unknown as typeof supplied.presentationValidator;
  release();
  const session = await opening;
  expect(() => session.agent).toThrow(BrowserPresentationError);
  session.dispose();
});

test('gated model exposes only read-only metadata even if the model is not cloneable', async () => {
  const store = new DurableTestStore();
  const custom = { ...model, internalSecret: 'hidden-provider-detail',
    localFactory: () => 'non-cloneable' };
  const session = await BrowserPiAppServerSession.open({ ...options, model: custom,
    presentationValidator: () => ({ accept: true }) }, store);
  expect(session.model.id).toBe(model.id);
  expect(JSON.stringify(session.model)).not.toContain('hidden-provider-detail');
  expect(Object.isFrozen(session.model)).toBe(true);
  expect(Object.isFrozen(session.model.input)).toBe(true);
  session.dispose();
});

test('assistant and tool start/completion items stay withheld before a rejection', async () => {
  const store = new DurableTestStore();
  let release!: (value: { accept: false; reason: string }) => void;
  let entered!: () => void;
  const validating = new Promise<void>(resolve => { entered = resolve; });
  const decision = new Promise<{ accept: false; reason: string }>(resolve => { release = resolve; });
  const notifications: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => { entered(); return decision; } }, store);
  session.subscribeNotifications(notification => notifications.push(JSON.stringify(notification)));
  const pending = session.send(request);
  await validating;
  const notify = (session as unknown as { notification: (event: AppServerNotification) => void }).notification
    .bind(session);
  const item: Extract<AppServerNotification, { method: 'item/completed' }>['params']['item'] = {
    type: 'agentMessage', id: 'secret', text: 'Hidden provisional item', phase: 'final_answer',
    memoryCitation: null, delivery: null, questions: null };
  notify({ method: 'item/started', params: { threadId: options.threadId,
    turnId: 'pi-turn-0', startedAtMs: Date.now(), item } });
  notify({ method: 'item/completed', params: { threadId: options.threadId,
    turnId: 'pi-turn-0', completedAtMs: Date.now(), item } });
  expect(notifications.join('')).not.toContain('Hidden provisional item');
  expect(notifications.join('')).not.toContain('"id":"secret"');
  release({ accept: false, reason: 'Rejected' });
  await pending;
  expect(notifications.join('')).not.toContain('Hidden provisional item');
  session.dispose();
});

test('actual Pi tool start and completion remain withheld across validator rejection', async () => {
  const store = new DurableTestStore();
  let release!: () => void;
  let entered!: () => void;
  const validating = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const items: string[] = [];
  const toolStream: StreamFn = (_model, context) => {
    const stream = createAssistantMessageEventStream();
    const second = context.messages.at(-1)?.role === 'toolResult';
    const message = { role: 'assistant' as const,
      content: second ? [{ type: 'text' as const, text: 'Claim 7' }] :
        [{ type: 'toolCall' as const, id: 'call_0', name: 'measure', arguments: { value: 7 } }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: second ? 'stop' as const : 'toolUse' as const,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message }); });
    return stream;
  };
  const session = await BrowserPiAppServerSession.open({ ...options, streamFn: toolStream,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { value: { type: 'number' } } },
      execute: async () => ({ content: [{ type: 'text' as const, text: '7' }], details: null }) }],
    presentationValidator: async () => {
      entered(); await held; return { accept: false, reason: 'Rejected' };
    } }, store);
  session.subscribeNotifications(notification => {
    if ((notification.method === 'item/started' || notification.method === 'item/completed') &&
        notification.params.item.type !== 'userMessage') items.push(notification.method);
  });
  const pending = session.send(request);
  await validating;
  expect(items).toEqual([]);
  release(); await pending;
  expect(items).toEqual([]);
  session.dispose();
});

test('assistant output beyond the finite pending budget is never published', async () => {
  const store = new DurableTestStore();
  const events: string[] = [];
  const large: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'X'.repeat(40_000) }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: 'stop' as const, usage: { input: 0, output: 0, cacheRead: 0,
        cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'X'.repeat(40_000), partial: message });
      stream.push({ type: 'done', reason: 'stop', message }); });
    return stream;
  };
  const session = await BrowserPiAppServerSession.open({ ...options, streamFn: large,
    presentationValidator: () => ({ accept: true }),
    onEvent: event => events.push(JSON.stringify(event)) }, store);
  await session.send(request);
  expect(events.join('')).not.toContain('XXXXXXXXXX');
  expect(events.join('')).not.toContain('"status":"completed"');
  session.dispose();
});

test('pending item buffer overflow fails typed even when model delta budget is untouched', async () => {
  const store = new DurableTestStore();
  let release!: (value: { accept: true }) => void;
  let entered!: () => void;
  const validating = new Promise<void>(resolve => { entered = resolve; });
  const decision = new Promise<{ accept: true }>(resolve => { release = resolve; });
  const events: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => { entered(); return decision; },
    onEvent: event => events.push(JSON.stringify(event)) }, store);
  const pending = session.send(request);
  await validating;
  const notify = (session as unknown as { notification: (event: AppServerNotification) => void }).notification
    .bind(session);
  let overflow: unknown;
  for (let i = 0; i < 22; i++) {
    try {
      notify({ method: 'item/completed', params: { threadId: options.threadId,
        turnId: 'pi-turn-0', completedAtMs: Date.now(), item: { type: 'agentMessage',
          id: `large-${i}`, text: 'X'.repeat(8_000), phase: 'final_answer',
          memoryCitation: null, delivery: null, questions: null } } });
    } catch (error) { overflow = error; break; }
  }
  expect(overflow).toMatchObject({ code: 'buffer' });
  release({ accept: true });
  await pending;
  expect(events.join('')).not.toContain('XXXXXXXXXX');
  expect(events.join('')).toContain('browserPresentation:buffer');
  expect(events.join('')).not.toContain('"status":"completed"');
  await expect(session.send(request)).rejects.toMatchObject({ code: 'buffer' });
  session.dispose();
});

test('real Pi tool events overflowing the pending budget fail typed before final-answer checks', async () => {
  const store = new DurableTestStore();
  const events: string[] = [];
  let validations = 0;
  const toolStream: StreamFn = (_model, context) => {
    const stream = createAssistantMessageEventStream();
    const second = context.messages.at(-1)?.role === 'toolResult';
    const message = { role: 'assistant' as const, content: second ?
      [{ type: 'text' as const, text: 'Should not be published' }] :
      Array.from({ length: 16 }, (_, index) => ({ type: 'toolCall' as const,
        id: `call_${index}`, name: 'measure', arguments: { payload: 'A'.repeat(7_000) } })),
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: second ? 'stop' as const : 'toolUse' as const,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message }); });
    return stream;
  };
  const session = await BrowserPiAppServerSession.open({ ...options, streamFn: toolStream,
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure',
      parameters: { type: 'object', properties: { payload: { type: 'string' } } },
      execute: async () => ({ content: [{ type: 'text' as const, text: 'R'.repeat(7_000) }],
        details: null }) }],
    presentationValidator: () => { validations++; return { accept: true }; },
    onEvent: event => events.push(JSON.stringify(event)) }, store);
  await session.send(request);
  expect(validations).toBe(0);
  expect(events.join('')).toContain('browserPresentation:buffer');
  expect(events.join('')).not.toContain('Should not be published');
  session.dispose();
});

test('an aborted terminal transaction leaves only an incomplete journal, never a completed answer', async () => {
  class AbortingStore extends DurableTestStore {
    held = false;
    released = false;
    terminal = false;
    override async runExclusive<T>(project: string, thread: string, action: () => Promise<T>) {
      return super.runExclusive(project, thread, async () => {
        this.held = true;
        try { return await action(); }
        finally { this.held = false; this.released = true; }
      });
    }
    override async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number,
      signal?: AbortSignal) {
      if (Object.keys(value.presentationRuns ?? {}).length) {
        await new Promise<void>(resolve => setTimeout(resolve, 150));
        if (signal?.aborted) {
          expect(this.held).toBe(true);
          expect(this.released).toBe(false);
          this.terminal = true;
          throw new DOMException('Transaction aborted', 'AbortError');
        }
      }
      return super.compareAndSwapTerminal(value, revision, signal);
    }
  }
  const store = new AbortingStore();
  const events: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options, timeoutMs: 100,
    presentationValidator: () => ({ accept: true }),
    onEvent: event => events.push(JSON.stringify(event)) }, store);
  await session.send(request);
  expect(store.terminal).toBe(true);
  expect(store.released).toBe(true);
  const durable = await store.read(options.projectId, options.threadId);
  expect(durable?.messages.some(message => message.role === 'assistant')).toBe(false);
  expect(events.join('')).not.toContain('Verified answer');
  session.dispose();
  const reopened = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, store);
  expect(reopened.historyThread().turns[0]).toMatchObject({ status: 'failed',
    error: { additionalDetails: 'browserPresentation:incomplete' } });
  reopened.dispose();
});

test('missing terminal event has a bounded abort grace and never publishes or caches an answer', async () => {
  class NoTerminalStore extends DurableTestStore {
    override async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number,
      signal?: AbortSignal): Promise<void> {
      if (Object.keys(value.presentationRuns ?? {}).length) return new Promise(() => {});
      return super.compareAndSwapTerminal(value, revision, signal);
    }
  }
  const store = new NoTerminalStore();
  const events: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options, timeoutMs: 100,
    presentationValidator: () => ({ accept: true }),
    onEvent: event => events.push(JSON.stringify(event)) }, store);
  const result = await Promise.race([session.send(request), new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('terminal grace did not settle')), 3_500))]);
  expect(result).toMatch(/^pi-turn-/);
  expect(events.join('')).toContain('browserPresentation:storage-unavailable');
  expect(events.join('')).not.toContain('Verified answer');
  expect(locks.size).toBe(0);
  try { session.historyThread(); } catch (error) {
    expect(error).toMatchObject({ code: 'storage-unavailable' });
  }
  await expect(session.send(request)).rejects.toMatchObject({ code: 'storage-unavailable' });
  session.dispose();
});

test('a late ambiguous commit is detected by a stale tab before it can infer another turn', async () => {
  class LateTerminalStore extends DurableTestStore {
    override async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number,
      signal?: AbortSignal): Promise<void> {
      if (!Object.keys(value.presentationRuns ?? {}).length)
        return super.compareAndSwapTerminal(value, revision, signal);
      await new Promise(resolve => setTimeout(resolve, 2_500));
      // A broken adapter commits after our bounded terminal grace. Atomic CAS
      // and the next tab's digest preflight must still fail closed.
      await this.compareAndSwap(value, revision);
    }
  }
  const store = new LateTerminalStore();
  let calls = 0;
  const gated = { ...options, streamFn: ((...args: Parameters<StreamFn>) => {
    calls++; return streamFn(...args);
  }) as StreamFn, presentationValidator: () => ({ accept: true as const }) };
  const stale = await BrowserPiAppServerSession.open(gated, store);
  const events: string[] = [];
  const first = await BrowserPiAppServerSession.open({ ...gated, timeoutMs: 100,
    onEvent: event => events.push(JSON.stringify(event)) }, store);
  await first.send(request);
  expect(events.join('')).not.toContain('Verified answer');
  await new Promise(resolve => setTimeout(resolve, 500));
  const durable = await store.read(options.projectId, options.threadId);
  expect(durable?.presentationRuns?.['pi-turn-0']).toBeTruthy();
  await expect(stale.send(request)).rejects.toMatchObject({ code: 'incomplete' });
  expect(calls).toBe(1);
  first.dispose(); stale.dispose();
});

test('validator exceptions and finite validation timeout reject without leaking output', async () => {
  const thrown = new DurableTestStore();
  const events: string[] = [];
  const session = await BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => { throw new Error('SECRET validator internals'); },
    onEvent: event => events.push(JSON.stringify(event)) }, thrown);
  await session.send(request);
  expect(events.join('')).not.toContain('Verified answer');
  expect(events.join('')).not.toContain('SECRET validator internals');
  session.dispose();
  const timed = new DurableTestStore();
  const pending = await BrowserPiAppServerSession.open({ ...options, timeoutMs: 100,
    presentationValidator: () => new Promise(() => {}) }, timed);
  const result = await Promise.race([pending.send(request), new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('validation did not time out')), 500))]);
  expect(result).toMatch(/^pi-turn-/);
  expect((await timed.read(options.projectId, options.threadId))?.presentationRuns ?? {}).toEqual({});
  pending.dispose();
});

test('validator has its own ten-second bound independent of the model turn deadline', async () => {
  const candidate: PresentationCandidate = { projectId: options.projectId,
    threadId: options.threadId, turnId: 'pi-turn-0', runId: 'run-1', tools: [],
    answerParts: ['Answer'], answer: 'Answer', priorTranscript: { version: 1, projectId: options.projectId,
      threadId: options.threadId, revision: 0, messages: [] } };
  const started = Date.now();
  await expect(validatePresentation(() => new Promise(() => {}), candidate))
    .rejects.toMatchObject({ code: 'timeout' });
  expect(Date.now() - started).toBeGreaterThanOrEqual(9_900);
}, 15_000);
