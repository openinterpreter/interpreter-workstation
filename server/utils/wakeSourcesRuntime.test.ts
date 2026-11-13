import { afterEach, describe, expect, test } from 'bun:test';
import type { CodexService } from '../../src/lib/codex/service';
import { agentTabManager } from '../agentTabManager';
import { startWakeThreadTurn } from './wakeSourcesRuntime';
import { WakeAdmissionFailure } from './wakeSources';

const boundTokens: string[] = [];
afterEach(() => {
  for (const token of boundTokens.splice(0)) agentTabManager.disposeBinding(token);
});

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
