import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexService, type CodexClient } from '../../src/lib/codex/service';
import { agentTabManager } from '../agentTabManager';
import { installUnloadedThreadCarrier } from '../agentTaskService';
import {
  INTERPRETER_CALLER_TOKEN_ENV,
  INTERPRETER_CLI_PATH_ENV,
  INTERPRETER_CLI_SERVER_CONNECTION_ENV,
} from './interpreterCliRuntime';
import { listNativeCallerScopesForThread, persistNativeCallerBinding } from './persistedCallerBinding';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { ThreadNotFoundError } from '../../src/lib/codex/service';
import { inspectThread, readTurnsSince, startWakeThreadTurn } from './wakeSourcesRuntime';
import { readEndedTurn } from './outcomeReturnsRuntime';
import { THREAD_INPUT_SOURCE, WakeAdmissionFailure, WakeSources, wakeClientId, wakeInput,
  type WakeAdmission, type WakeEvent } from './wakeSources';

const boundTokens: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const token of boundTokens.splice(0)) agentTabManager.disposeBinding(token);
});

const GOAL_BLOCKED = { goalId: '00000000-0000-4000-8000-0000000000a1', status: 'blocked' as const,
  missionRevision: 2, lifecycleRevision: 3 };

function nativeService(threadId: string, status: 'notLoaded' | 'idle', options: {
  loadedThreadIds?: string[];
} = {}) {
  const resumeConfigs: Array<Record<string, unknown> | null | undefined> = [];
  let startedTurns = 0;
  const thread = { id: threadId, cwd: '/workspace/worker', status: { type: status }, turns: [] };
  const client = {
    subscribe: () => () => {},
    onDisconnect: () => () => {},
    threadRead: async () => ({ thread }),
    threadTurnsList: async () => ({ data: [], nextCursor: null }),
    threadQueueList: async () => ({ data: [], nextCursor: null }),
    threadLoadedList: async () => ({ data: options.loadedThreadIds ?? [], nextCursor: null }),
    threadList: async () => ({ data: [{ id: threadId }], nextCursor: null }),
    resumeThread: async (id: string, _provider: unknown, _model: unknown, _cwd: unknown,
      config?: Record<string, unknown> | null) => {
      resumeConfigs.push(config);
      return id;
    },
    startTurn: async () => {
      startedTurns++;
      return { id: 'native-turn', status: 'inProgress', items: [], error: null };
    },
    // A confirmed Goal resume by exact revision.
    threadGoalRevisionSet: async () => ({
      goal: { threadId, objective: 'Mission', status: 'active', tokenBudget: null, tokensUsed: 0,
        timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 },
      revision: { ...GOAL_BLOCKED, status: 'active', lifecycleRevision: GOAL_BLOCKED.lifecycleRevision + 1 },
    }),
  } as unknown as CodexClient;
  return { service: new CodexService(client), resumeConfigs, startedTurns: () => startedTurns };
}

describe('native wake browser-tool bridge', () => {
  test('reports the native phase without disclosing a rejection or retrying the user message', async () => {
    const threadId = `wake-bridge-${crypto.randomUUID()}`;
    let submissions = 0;
    const service = {
      readThreadShell: async () => ({ id: threadId, cwd: '/workspace/worker' }),
      startExistingThreadTurn: async (_id: string, _msg: string, _cwd: string, _config: unknown,
        _clientId: string, onPhase: (phase: 'resume' | 'start') => void) => {
        onPhase('resume');
        onPhase('start');
        submissions++;
        throw new Error('private native diagnostic');
      },
    } as unknown as CodexService;
    try {
      await startWakeThreadTurn(threadId, 'private instruction', service, 'stable-id');
      throw new Error('Expected native rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(WakeAdmissionFailure);
      expect((error as WakeAdmissionFailure).phase).toBe('start');
    }
    expect(submissions).toBe(1);
    expect(agentTabManager.getBindingForThread(threadId)).toBeUndefined();
  });
  test('resumes the SAME thread without replacing its native shell policy or minting a caller', async () => {
    const threadId = `wake-bridge-${crypto.randomUUID()}`;
    let received: unknown[] = [];
    const service = {
      readThreadShell: async () => ({ id: threadId, cwd: '/workspace/worker' }),
      startExistingThreadTurn: async (...args: unknown[]) => {
        received = args;
        return 'native-turn';
      },
    } as unknown as CodexService;

    expect(await startWakeThreadTurn(threadId, 'approved wake', service)).toBe('native-turn');
    expect(received.slice(0, 3)).toEqual([threadId, 'approved wake', '/workspace/worker']);
    expect(received[3]).toEqual({ mcp_servers: {} });
    expect(agentTabManager.getBindingForThread(threadId)).toBeUndefined();

    expect(await startWakeThreadTurn(threadId, 'next wake', service)).toBe('native-turn');
    expect(agentTabManager.getBindingForThread(threadId)).toBeUndefined();
    expect(await startWakeThreadTurn(threadId, 'identified wake', service, 'wake_fixture'))
      .toBe('native-turn');
    expect(received[4]).toBe('wake_fixture');
  });

  test('does not mint a caller or start a turn for another thread identity', async () => {
    const threadId = `wake-bridge-${crypto.randomUUID()}`;
    let started = false;
    const service = {
      readThreadShell: async () => ({ id: 'other-thread', cwd: '/workspace/worker' }),
      startExistingThreadTurn: async () => { started = true; return 'never'; },
    } as unknown as CodexService;
    await expect(startWakeThreadTurn(threadId, 'wake', service)).rejects.toThrow('Wake destination changed');
    expect(started).toBe(false);
    expect(agentTabManager.getBindingForThread(threadId)).toBeUndefined();
  });

  test('preserves an existing tool-scoped caller on wake', async () => {
    const threadId = `wake-bridge-${crypto.randomUUID()}`;
    const callerToken = `agtok_${crypto.randomUUID()}`;
    agentTabManager.bindThread({
      agentId: `existing-${crypto.randomUUID()}`,
      callerToken,
      threadId,
      workspacePath: '/workspace/worker',
      allowedToolNames: ['builtin-interpreter.interpreter_browser_page_inspect'],
    });
    boundTokens.push(callerToken);
    let config: any;
    const service = {
      readThreadShell: async () => ({ id: threadId, cwd: '/workspace/worker' }),
      startExistingThreadTurn: async (_id: string, _message: string, _cwd: string, next: unknown) => {
        config = next;
        return 'native-turn';
      },
    } as unknown as CodexService;
    await startWakeThreadTurn(threadId, 'wake', service);
    expect(config).toEqual({ mcp_servers: {} });
    expect(agentTabManager.getBindingForThread(threadId)?.allowedToolNames)
      .toEqual(['builtin-interpreter.interpreter_browser_page_inspect']);
  });
});

/** A native client with `count` saved turns, one per minute, the newest last.
 * Records every turn page request; never answers a full-history read. */
function pagedHistory(count: number) {
  const base = Date.parse('2026-11-01T00:00:00Z') / 1000;
  const turns = Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`, status: index === count - 1 ? 'inProgress' : 'completed', itemsView: 'full',
    startedAt: base + index * 60, completedAt: index === count - 1 ? null : base + index * 60 + 30, error: null,
    durationMs: null,
    items: [{ type: 'userMessage', id: `user-${index}`, clientId: `client-${index}`,
      content: [{ type: 'text', text: `input ${index}` }] },
    { type: 'agentMessage', id: `agent-${index}`, text: `answer ${index}` }],
  }));
  const pages: Array<string | null> = [];
  const reads: boolean[] = [];
  const client = {
    subscribe: () => () => {},
    onDisconnect: () => () => {},
    threadRead: async ({ threadId, includeTurns }: { threadId: string; includeTurns: boolean }) => {
      reads.push(includeTurns);
      if (includeTurns) throw new Error('full history read');
      return { thread: { id: threadId, cwd: '/workspace/worker', status: { type: 'active', activeFlags: [] },
        parentThreadId: null, ephemeral: false, turns: [] } };
    },
    threadTurnsList: async ({ cursor, limit }: { cursor?: string; limit: number }) => {
      pages.push(cursor ?? null);
      const start = cursor ? Number(cursor) : 0;
      const newestFirst = [...turns].reverse();
      const data = newestFirst.slice(start, start + limit);
      return { data, nextCursor: start + limit < turns.length ? String(start + limit) : null };
    },
  } as unknown as CodexClient;
  return { service: new CodexService(client), turns, pages, reads, base };
}

describe('bounded native history reads', () => {
  test('the thread shell never reads turns and tells a missing thread from an unreachable one', async () => {
    const history = pagedHistory(3);
    expect(await history.service.readThreadShell('thread-1')).toEqual({ id: 'thread-1', cwd: '/workspace/worker',
      status: 'active', parentThreadId: null, ephemeral: false });
    expect(history.reads).toEqual([false]);
    const failing = (error: unknown) => new CodexService({ subscribe: () => () => {}, onDisconnect: () => () => {},
      threadRead: async () => { throw error; } } as unknown as CodexClient);
    await expect(failing(new JSONRPCErrorException('thread not found: thread-1', -32600)).readThreadShell('thread-1'))
      .rejects.toBeInstanceOf(ThreadNotFoundError);
    const transportError = await failing(new Error('connection closed')).readThreadShell('thread-1')
      .catch(error => error);
    expect(transportError).toBeInstanceOf(Error);
    expect(transportError).not.toBeInstanceOf(ThreadNotFoundError);
    const silent = new CodexService({ subscribe: () => () => {}, onDisconnect: () => () => {},
      threadRead: () => new Promise(() => {}) } as unknown as CodexClient);
    const timedOut = await silent.readThreadShell('thread-1', 20).catch(error => error);
    expect(timedOut).toBeInstanceOf(Error);
    expect(timedOut).not.toBeInstanceOf(ThreadNotFoundError);
    const other = new CodexService({ subscribe: () => () => {}, onDisconnect: () => () => {},
      threadRead: async () => ({ thread: { id: 'thread-2', cwd: '/x', status: { type: 'idle' }, turns: [] } }),
    } as unknown as CodexClient);
    await expect(other.readThreadShell('thread-1')).rejects.toThrow('identity mismatch');
  });

  test('history is paged newest first and stops at the first turn that ended before the window', async () => {
    const history = pagedHistory(100);
    // The window starts inside turn 75: turns 75..99 are needed, turn 74 ended before it.
    const since = new Date((history.base + 75 * 60 + 10) * 1000).toISOString();
    const turns = await readTurnsSince('thread-1', since, history.service);
    expect(turns.map(turn => turn.id)).toEqual(Array.from({ length: 25 }, (_, i) => `turn-${75 + i}`));
    // Two pages of 20 were enough; the remaining sixty turns were never read.
    expect(history.pages).toEqual([null, '20']);
    expect(history.reads).toEqual([]);
    // Without a window every page is read, still one bounded page at a time.
    const all = pagedHistory(45);
    expect(await readTurnsSince('thread-1', undefined, all.service)).toHaveLength(45);
    expect(all.pages).toEqual([null, '20', '40']);
  });

  test('an outcome read pages back only as far as its turn', async () => {
    const history = pagedHistory(100);
    expect(await readEndedTurn('thread-1', 'turn-90', history.service))
      .toEqual({ outcome: 'completed', summary: 'answer 90' });
    expect(history.pages).toEqual([null]);
    expect(await readEndedTurn('thread-1', 'turn-99', history.service)).toBeNull(); // still running
    expect(history.reads).toEqual([]);
  });

  test('a turn without a recorded end is always read: one interrupted long after it started may hold a receipt', async () => {
    const history = pagedHistory(10);
    // turn-8 started long before the window and was interrupted by a crash, so it has no end time.
    Object.assign(history.turns[8]!, { status: 'interrupted', completedAt: null });
    // turn-9 ended inside the window.
    Object.assign(history.turns[9]!, { status: 'completed', startedAt: history.base + 1_100, completedAt: history.base + 1_200 });
    const since = new Date((history.base + 1_000) * 1000).toISOString();
    const turns = await readTurnsSince('thread-1', since, history.service);
    // turn-7 ended before the window and stops the scan; turn-8 is read although it started before it.
    expect(turns.map(turn => turn.id)).toEqual(['turn-8', 'turn-9']);
  });

  test('a history scan that reaches the page bound fails instead of reporting the rest as absent', async () => {
    let page = 0;
    // An endless history of turns without end times: nothing ever stops the scan.
    const client = {
      subscribe: () => () => {},
      onDisconnect: () => () => {},
      threadTurnsList: async ({ limit }: { limit: number }) => {
        page++;
        return { data: Array.from({ length: limit }, (_, i) => ({ id: `turn-${page}-${i}`, status: 'interrupted',
          itemsView: 'full', startedAt: 0, completedAt: null, error: null, durationMs: null, items: [] })),
          nextCursor: String(page) };
      },
    } as unknown as CodexClient;
    await expect(readTurnsSince('thread-1', new Date().toISOString(), new CodexService(client)))
      .rejects.toThrow('scan bound');
    expect(page).toBe(1_000);
  });
});

describe('the wake queue over bounded native history', () => {
  test('an input steered into a long-running turn that a crash interrupted is admitted from that turn, never offered again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-runtime-window-'));
    const now = Date.now();
    const base = Math.floor(now / 1000);
    const event = { threadId: 'thread-1', sourceId: THREAD_INPUT_SOURCE, eventId: 'steered_1', message: 'steered input',
      status: 'offered', createdAt: new Date(now - 120_000).toISOString(),
      offeredAt: new Date(now - 120_000).toISOString(), turnId: 'turn-long' };
    const clientId = wakeClientId(event);
    const turn = (id: string, status: string, startedAt: number, completedAt: number | null, client?: string) => ({
      id, status, itemsView: 'full', startedAt, completedAt, error: null, durationMs: null,
      items: client ? [{ type: 'userMessage', id: `user-${id}`, clientId: client,
        content: [{ type: 'text', text: 'steered input' }] }] : [] });
    // Newest first: a turn that ended inside the window, then the long turn (started an hour
    // before the input, interrupted, no end time) holding the receipt, then an old turn.
    const newestFirst = [turn('turn-after', 'completed', base - 100, base - 50),
      turn('turn-long', 'interrupted', base - 3_600, null, clientId),
      turn('turn-old', 'completed', base - 7_200, base - 7_100)];
    const client = {
      subscribe: () => () => {},
      onDisconnect: () => () => {},
      threadRead: async ({ threadId }: { threadId: string }) => ({ thread: { id: threadId, cwd: '/workspace/worker',
        status: { type: 'idle' }, parentThreadId: null, ephemeral: false, turns: [] } }),
      threadTurnsList: async () => ({ data: newestFirst, nextCursor: null }),
    } as unknown as CodexClient;
    const service = new CodexService(client);
    let offers = 0;
    await writeFile(path.join(root, 'wake-sources.json'), JSON.stringify({ sources: [], events: [event] }));
    const wake = new WakeSources({
      inspect: (threadId, since) => inspectThread(threadId, since, service),
      // Everything else would prove the input absent: the turn ended, nothing is queued, the thread is idle.
      custody: async () => ({ turnStatus: 'interrupted', queuedSubmissionCount: 0, lastTurnId: 'turn-after',
        threadStatus: 'idle' }),
      steer: async () => { offers++; return 'turn-new'; },
      start: async () => { offers++; return 'turn-new'; },
    }, root, 30_000, { intervalMs: 0, followUpMs: 0 });
    try {
      await wake.initialize();
      await wake.tick(now);
      await wake.tick(now + 16_000);
      expect(wake.find('thread-1', THREAD_INPUT_SOURCE, 'steered_1')).toMatchObject({ status: 'admitted',
        turnId: 'turn-long' });
      expect(offers).toBe(0);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('a receipt found only by its marker yields the turn holding it, so its outcome is watched', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wake-runtime-marker-'));
    const now = Date.now();
    const base = Math.floor(now / 1000);
    // An offer of unknown outcome (no turn saved) from a sender.
    const event: WakeEvent = { threadId: 'thread-1', sourceId: THREAD_INPUT_SOURCE, eventId: 'marker_1',
      message: 'marked input', status: 'offered', createdAt: new Date(now - 30_000).toISOString(),
      offeredAt: new Date(now - 30_000).toISOString(), sender: { computer: 'peer-host' } };
    // The persisted user message carries the marker but no client ID.
    const newestFirst = [{ id: 'turn-marked', status: 'completed', itemsView: 'full', startedAt: base - 20,
      completedAt: base - 10, error: null, durationMs: null,
      items: [{ type: 'userMessage', id: 'user-marked', content: [{ type: 'text', text: wakeInput(event) }] }] }];
    const client = {
      subscribe: () => () => {},
      onDisconnect: () => () => {},
      threadRead: async ({ threadId }: { threadId: string }) => ({ thread: { id: threadId, cwd: '/workspace/worker',
        status: { type: 'idle' }, parentThreadId: null, ephemeral: false, turns: [] } }),
      threadTurnsList: async () => ({ data: newestFirst, nextCursor: null }),
    } as unknown as CodexClient;
    const service = new CodexService(client);
    const admissions: WakeAdmission[] = [];
    await writeFile(path.join(root, 'wake-sources.json'), JSON.stringify({ sources: [], events: [event] }));
    const wake = new WakeSources({
      inspect: (threadId, since) => inspectThread(threadId, since, service),
      steer: async () => { throw new Error('unexpected steer'); },
      start: async () => { throw new Error('unexpected start'); },
      onAdmitted: async admission => { admissions.push(admission); return true; },
    }, root, 30_000, { intervalMs: 0, followUpMs: 0 });
    try {
      await wake.initialize();
      await wake.tick(now);
      const stored = wake.find('thread-1', THREAD_INPUT_SOURCE, 'marker_1');
      expect(stored).toMatchObject({ status: 'admitted', turnId: 'turn-marked' });
      expect(stored?.outcomeReturn).toBeUndefined();
      for (let i = 0; i < 300 && !admissions.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(admissions).toEqual([{ threadId: 'thread-1', sourceId: THREAD_INPUT_SOURCE, eventId: 'marker_1',
        turnId: 'turn-marked', sender: { computer: 'peer-host' } }]);
    } finally { await wake.stop(); await rm(root, { recursive: true, force: true }); }
  });
});

describe('native wake on a saved thread that is not loaded', () => {
  test('resumes with a fresh app CLI shell policy and registers its caller', async () => {
    restores.push(installUnloadedThreadCarrier());
    const threadId = crypto.randomUUID();
    const native = nativeService(threadId, 'notLoaded');

    expect(await startWakeThreadTurn(threadId, 'wake', native.service, 'wake_unloaded')).toBe('native-turn');
    const binding = agentTabManager.getBindingForThread(threadId);
    expect(binding?.workspacePath).toBe('/workspace/worker');
    if (binding) boundTokens.push(binding.callerToken);

    expect(native.resumeConfigs).toHaveLength(1);
    const policy = native.resumeConfigs[0]?.shell_environment_policy as { set: Record<string, string> };
    expect(native.resumeConfigs[0]?.mcp_servers).toEqual({});
    expect(policy.set[INTERPRETER_CLI_SERVER_CONNECTION_ENV]).toBeTruthy();
    expect(policy.set[INTERPRETER_CALLER_TOKEN_ENV]).toBe(binding?.callerToken);
    const launcherDir = path.dirname(policy.set[INTERPRETER_CLI_PATH_ENV]);
    const pathKey = Object.keys(policy.set).find(key => key.toUpperCase() === 'PATH')!;
    expect(policy.set[pathKey].split(path.delimiter)[0]).toBe(launcherDir);
    expect(native.startedTurns()).toBe(1);
  });

  test('replaces a narrower prior caller with a fresh caller of the same scope', async () => {
    restores.push(installUnloadedThreadCarrier());
    const threadId = crypto.randomUUID();
    const callerToken = `agtok_${crypto.randomUUID()}`;
    const allowedToolNames = ['builtin-interpreter.interpreter_browser_page_inspect'];
    agentTabManager.bindThread({ agentId: `existing-${crypto.randomUUID()}`, callerToken, threadId,
      workspacePath: '/workspace/worker', allowedToolNames, toolProfileId: 'profile-narrow' });
    boundTokens.push(callerToken);
    const native = nativeService(threadId, 'notLoaded');

    expect(await startWakeThreadTurn(threadId, 'wake', native.service)).toBe('native-turn');
    const binding = agentTabManager.getBindingForThread(threadId);
    if (binding) boundTokens.push(binding.callerToken);
    expect(binding?.callerToken).not.toBe(callerToken);
    expect(binding?.allowedToolNames).toEqual(allowedToolNames);
    expect(binding?.toolProfileId).toBe('profile-narrow');
    const policy = native.resumeConfigs[0]?.shell_environment_policy as { set: Record<string, string> };
    expect(policy.set[INTERPRETER_CALLER_TOKEN_ENV]).toBe(binding?.callerToken);
    expect(native.startedTurns()).toBe(1);
    expect(agentTabManager.getBindingForCallerToken(callerToken)).toBeUndefined();
  });

  test('a loaded thread keeps its shell scope and gains no caller', async () => {
    restores.push(installUnloadedThreadCarrier());
    const threadId = crypto.randomUUID();
    const native = nativeService(threadId, 'idle');
    expect(await startWakeThreadTurn(threadId, 'wake', native.service)).toBe('native-turn');
    expect(native.resumeConfigs).toEqual([{ mcp_servers: {} }]);
    expect(agentTabManager.getBindingForThread(threadId)).toBeUndefined();
  });

  test('replaces an open prior caller with the fresh caller it loads the thread with', async () => {
    restores.push(installUnloadedThreadCarrier());
    const threadId = crypto.randomUUID();
    const priorToken = `agtok_${crypto.randomUUID()}`;
    agentTabManager.bindThread({ agentId: `prior-${crypto.randomUUID()}`, callerToken: priorToken, threadId,
      workspacePath: '/workspace/worker' });
    boundTokens.push(priorToken);
    const native = nativeService(threadId, 'notLoaded');

    expect(await startWakeThreadTurn(threadId, 'wake', native.service)).toBe('native-turn');
    const binding = agentTabManager.getBindingForThread(threadId);
    if (binding) boundTokens.push(binding.callerToken);
    const policy = native.resumeConfigs[0]?.shell_environment_policy as { set: Record<string, string> };
    expect(policy.set[INTERPRETER_CALLER_TOKEN_ENV]).toBe(binding?.callerToken);
    expect(policy.set[INTERPRETER_CALLER_TOKEN_ENV]).not.toBe(priorToken);
    expect(agentTabManager.getBindingForCallerToken(priorToken)).toBeUndefined();
  });
});

describe('Goal resume by exact revision on a saved thread that is not loaded', () => {
  function captureWarnings() {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    restores.push(() => { console.warn = original; });
    return warnings;
  }

  test('loads the thread with a fresh app CLI caller when no caller is bound', async () => {
    restores.push(installUnloadedThreadCarrier());
    const threadId = crypto.randomUUID();
    const native = nativeService(threadId, 'notLoaded');

    const result = await native.service.resumeThreadGoalWithRevision(threadId, GOAL_BLOCKED);
    expect(result.continuation).toBe('loaded');
    const binding = agentTabManager.getBindingForThread(threadId);
    expect(binding?.workspacePath).toBe('/workspace/worker');
    if (binding) boundTokens.push(binding.callerToken);
    expect(native.resumeConfigs).toHaveLength(1);
    const policy = native.resumeConfigs[0]?.shell_environment_policy as { set: Record<string, string> };
    expect(policy.set[INTERPRETER_CLI_SERVER_CONNECTION_ENV]).toBeTruthy();
    expect(policy.set[INTERPRETER_CLI_PATH_ENV]).toBeTruthy();
    expect(policy.set[INTERPRETER_CALLER_TOKEN_ENV]).toBe(binding?.callerToken);
    // The runtime, not the app, starts the continuation turn.
    expect(native.startedTurns()).toBe(0);
  });

  test('replaces an open in-memory caller with the fresh caller', async () => {
    restores.push(installUnloadedThreadCarrier());
    const threadId = crypto.randomUUID();
    const priorToken = `agtok_${crypto.randomUUID()}`;
    agentTabManager.bindThread({ agentId: `prior-${crypto.randomUUID()}`, callerToken: priorToken, threadId,
      workspacePath: '/workspace/worker' });
    boundTokens.push(priorToken);
    const native = nativeService(threadId, 'notLoaded');

    expect((await native.service.resumeThreadGoalWithRevision(threadId, GOAL_BLOCKED)).continuation)
      .toBe('loaded');
    const binding = agentTabManager.getBindingForThread(threadId);
    if (binding) boundTokens.push(binding.callerToken);
    const policy = native.resumeConfigs[0]?.shell_environment_policy as { set: Record<string, string> };
    expect(policy.set[INTERPRETER_CALLER_TOKEN_ENV]).toBe(binding?.callerToken);
    expect(binding?.callerToken).not.toBe(priorToken);
    expect(agentTabManager.getBindingForCallerToken(priorToken)).toBeUndefined();
  });

  test('loads with a fresh caller that keeps a narrower prior tool profile', async () => {
    restores.push(installUnloadedThreadCarrier());
    const warnings = captureWarnings();
    const threadId = crypto.randomUUID();
    const callerToken = `agtok_${crypto.randomUUID()}`;
    agentTabManager.bindThread({ agentId: `existing-${crypto.randomUUID()}`, callerToken, threadId,
      workspacePath: '/workspace/worker', toolProfileId: 'profile-narrow' });
    boundTokens.push(callerToken);
    const native = nativeService(threadId, 'notLoaded');

    expect((await native.service.resumeThreadGoalWithRevision(threadId, GOAL_BLOCKED)).continuation)
      .toBe('loaded');
    const binding = agentTabManager.getBindingForThread(threadId);
    if (binding) boundTokens.push(binding.callerToken);
    expect(binding?.callerToken).not.toBe(callerToken);
    expect(binding?.toolProfileId).toBe('profile-narrow');
    expect(binding?.allowedToolNames).toBeUndefined();
    const policy = native.resumeConfigs[0]?.shell_environment_policy as { set: Record<string, string> };
    expect(policy.set[INTERPRETER_CALLER_TOKEN_ENV]).toBe(binding?.callerToken);
    expect(policy.set[INTERPRETER_CLI_SERVER_CONNECTION_ENV]).toBeTruthy();
    expect(warnings.some(line => line.startsWith('[Unloaded thread carrier]'))).toBe(false);
  });

  test('keeps a window-scoped prior caller, loads without a new caller and logs only the cause', async () => {
    restores.push(installUnloadedThreadCarrier());
    const warnings = captureWarnings();
    const threadId = crypto.randomUUID();
    const callerToken = `agtok_${crypto.randomUUID()}`;
    agentTabManager.bindThread({ agentId: `existing-${crypto.randomUUID()}`, callerToken, threadId,
      workspacePath: '/workspace/worker', windowSessionKey: 'window-a' });
    boundTokens.push(callerToken);
    const native = nativeService(threadId, 'notLoaded');

    expect((await native.service.resumeThreadGoalWithRevision(threadId, GOAL_BLOCKED)).continuation)
      .toBe('loaded');
    expect(native.resumeConfigs).toEqual([{ mcp_servers: {} }]);
    expect(agentTabManager.getBindingForThread(threadId)?.callerToken).toBe(callerToken);
    expect(warnings).toContain(`[Unloaded thread carrier] ${JSON.stringify({ threadId,
      carrier: 'not_given', cause: 'carrier_refused' })}`);
  });

  (process.platform === 'linux' ? test : test.skip)(
    'persisted prior callers that disagree on scope load without a new caller, revoke nothing and log the cause',
    async () => {
      restores.push(installUnloadedThreadCarrier());
      const warnings = captureWarnings();
      const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wake-carrier-scope-'));
      const priorDataDir = process.env.INTERPRETER_USER_DATA_DIR;
      process.env.INTERPRETER_USER_DATA_DIR = dataDir;
      restores.push(() => {
        if (priorDataDir === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
        else process.env.INTERPRETER_USER_DATA_DIR = priorDataDir;
      });
      try {
        const threadId = crypto.randomUUID();
        for (const toolProfileId of ['profile-a', 'profile-b']) {
          persistNativeCallerBinding({ agentId: `prior-${toolProfileId}`, callerToken: `agtok_${crypto.randomUUID()}`,
            threadId, workspacePath: '/workspace/worker', toolProfileId }, dataDir);
        }
        const native = nativeService(threadId, 'notLoaded');

        expect((await native.service.resumeThreadGoalWithRevision(threadId, GOAL_BLOCKED)).continuation)
          .toBe('loaded');
        expect(native.resumeConfigs).toEqual([{ mcp_servers: {} }]);
        expect(agentTabManager.getBindingForThread(threadId)).toBeUndefined();
        expect(listNativeCallerScopesForThread(threadId, dataDir)).toHaveLength(2);
        expect(warnings).toContain(`[Unloaded thread carrier] ${JSON.stringify({ threadId,
          carrier: 'not_given', cause: 'carrier_refused' })}`);
      } finally { await rm(dataDir, { recursive: true, force: true }); }
    },
  );

  (process.platform === 'linux' ? test : test.skip)(
    'a prior caller in another workspace with a different scope, or saved callers that disagree on model, refuse the carrier and log the cause',
    async () => {
      restores.push(installUnloadedThreadCarrier());
      const warnings = captureWarnings();
      const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wake-carrier-workspace-'));
      const priorDataDir = process.env.INTERPRETER_USER_DATA_DIR;
      process.env.INTERPRETER_USER_DATA_DIR = dataDir;
      restores.push(() => {
        if (priorDataDir === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
        else process.env.INTERPRETER_USER_DATA_DIR = priorDataDir;
      });
      const model = { provider: 'openai-oauth' as const, modelId: 'model-a' };
      try {
        for (const priors of [
          [{ toolProfileId: 'profile-a' }, { toolProfileId: 'profile-b', workspacePath: '/workspace' }],
          [{ toolProfileId: 'profile-a', modelConfig: model },
            { toolProfileId: 'profile-a', modelConfig: { ...model, modelId: 'model-b' } }],
        ]) {
          const threadId = crypto.randomUUID();
          for (const prior of priors) {
            persistNativeCallerBinding({ agentId: `prior-${crypto.randomUUID()}`, callerToken: `agtok_${crypto.randomUUID()}`,
              threadId, workspacePath: '/workspace/worker', ...prior }, dataDir);
          }
          const native = nativeService(threadId, 'notLoaded');

          expect((await native.service.resumeThreadGoalWithRevision(threadId, GOAL_BLOCKED)).continuation)
            .toBe('loaded');
          expect(native.resumeConfigs).toEqual([{ mcp_servers: {} }]);
          expect(agentTabManager.getBindingForThread(threadId)).toBeUndefined();
          expect(listNativeCallerScopesForThread(threadId, dataDir)).toHaveLength(2);
          expect(warnings).toContain(`[Unloaded thread carrier] ${JSON.stringify({ threadId,
            carrier: 'not_given', cause: 'carrier_refused' })}`);
        }
      } finally { await rm(dataDir, { recursive: true, force: true }); }
    },
  );

  test('a loaded thread is not resumed and gains no caller', async () => {
    restores.push(installUnloadedThreadCarrier());
    const threadId = crypto.randomUUID();
    const native = nativeService(threadId, 'idle');
    expect((await native.service.resumeThreadGoalWithRevision(threadId, GOAL_BLOCKED)).continuation)
      .toBe('already_loaded');
    expect(native.resumeConfigs).toEqual([]);
    expect(agentTabManager.getBindingForThread(threadId)).toBeUndefined();
  });
});
