import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { CodexService, type CodexClient } from '../../src/lib/codex/service';
import { agentTabManager } from '../agentTabManager';
import { installUnloadedThreadCarrier } from '../agentTaskService';
import {
  INTERPRETER_CALLER_TOKEN_ENV,
  INTERPRETER_CLI_PATH_ENV,
  INTERPRETER_CLI_SERVER_CONNECTION_ENV,
} from './interpreterCliRuntime';
import { startWakeThreadTurn } from './wakeSourcesRuntime';
import { WakeAdmissionFailure } from './wakeSources';

const boundTokens: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const token of boundTokens.splice(0)) agentTabManager.disposeBinding(token);
});

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
  } as unknown as CodexClient;
  return { service: new CodexService(client), resumeConfigs, startedTurns: () => startedTurns };
}

describe('native wake browser-tool bridge', () => {
  test('reports the native phase without disclosing a rejection or retrying the user message', async () => {
    const threadId = `wake-bridge-${crypto.randomUUID()}`;
    let submissions = 0;
    const service = {
      readThread: async () => ({ id: threadId, cwd: '/workspace/worker', turns: [] }),
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
      readThread: async () => ({ id: threadId, cwd: '/workspace/worker', turns: [] }),
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
      readThread: async () => ({ id: 'other-thread', cwd: '/workspace/worker' }),
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
      readThread: async () => ({ id: threadId, cwd: '/workspace/worker' }),
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

  test('keeps a narrower prior caller and resumes without a new shell policy', async () => {
    restores.push(installUnloadedThreadCarrier());
    const threadId = crypto.randomUUID();
    const callerToken = `agtok_${crypto.randomUUID()}`;
    agentTabManager.bindThread({ agentId: `existing-${crypto.randomUUID()}`, callerToken, threadId,
      workspacePath: '/workspace/worker', allowedToolNames: ['builtin-interpreter.interpreter_browser_page_inspect'] });
    boundTokens.push(callerToken);
    const native = nativeService(threadId, 'notLoaded');

    // The wake still runs; the thread simply resumes as it did before.
    expect(await startWakeThreadTurn(threadId, 'wake', native.service)).toBe('native-turn');
    expect(native.resumeConfigs).toEqual([{ mcp_servers: {} }]);
    expect(native.startedTurns()).toBe(1);
    expect(agentTabManager.getBindingForThread(threadId)?.callerToken).toBe(callerToken);
  });

  test('a loaded thread keeps its shell scope and gains no caller', async () => {
    restores.push(installUnloadedThreadCarrier());
    const threadId = crypto.randomUUID();
    const native = nativeService(threadId, 'idle');
    expect(await startWakeThreadTurn(threadId, 'wake', native.service)).toBe('native-turn');
    expect(native.resumeConfigs).toEqual([{ mcp_servers: {} }]);
    expect(agentTabManager.getBindingForThread(threadId)).toBeUndefined();
  });
});
