import { expect, test } from 'bun:test';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { BrowserPiAppServerSession } from './piSession';
import { MemoryPiTranscriptStore, type BrowserPiTranscript,
  type BrowserPiTranscriptStore } from './piTranscript';
import { BrowserPresentationError, type PresentationCandidate } from './presentationGate';

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
class DurableTestStore extends MemoryPiTranscriptStore implements BrowserPiTranscriptStore {
  readonly durability = 'persistent' as const;
  readonly crossTabLockCapability = true;
  async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number,
    signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('aborted');
    await this.compareAndSwap(value, revision);
  }
}
const options = { projectId: 'gate_project', threadId: 'gate_thread',
  model, systemPrompt: '', tools: [], streamFn };
const request = { workspacePath: 'browser-project:gate_project', message: 'Explain' };

test('volatile memory store cannot provide gated replies on first run or reload', async () => {
  expect(() => new BrowserPiAppServerSession({ ...options,
    presentationValidator: () => ({ accept: true }) })).toThrow(BrowserPresentationError);
  const store = new MemoryPiTranscriptStore();
  const open = () => BrowserPiAppServerSession.open({ ...options,
    presentationValidator: () => ({ accept: true }) }, store);
  await expect(open()).rejects.toMatchObject({ code: 'capability' });
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
  expect(() => session.historyThread()).toThrow();
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
  const second = await BrowserPiAppServerSession.open(gated, store);
  const pending = session.send(request);
  await entered;
  expect(seen).toEqual([]);
  await expect(second.send(request)).rejects.toMatchObject({ code: 'busy' });
  release(); await pending;
  expect(store.finalWriteHeld).toBe(true);
  expect(seen).toEqual(['answer']);
  session.dispose(); second.dispose();
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

test('an aborted terminal transaction leaves only an incomplete journal, never a completed answer', async () => {
  class AbortingStore extends DurableTestStore {
    override async compareAndSwapTerminal(value: BrowserPiTranscript, revision: number,
      signal?: AbortSignal) {
      if (Object.keys(value.presentationRuns ?? {}).length) {
        await new Promise<void>(resolve => setTimeout(resolve, 150));
        if (signal?.aborted) throw new DOMException('Transaction aborted', 'AbortError');
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
