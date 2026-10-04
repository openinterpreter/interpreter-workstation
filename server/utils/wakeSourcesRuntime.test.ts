import { afterEach, describe, expect, test } from 'bun:test';
import type { CodexService } from '../../src/lib/codex/service';
import { agentTabManager } from '../agentTabManager';
import { startWakeThreadTurn } from './wakeSourcesRuntime';

const boundTokens: string[] = [];
afterEach(() => {
  for (const token of boundTokens.splice(0)) agentTabManager.disposeBinding(token);
});

describe('native wake browser-tool bridge', () => {
  test('reapplies a scoped shell policy on the SAME thread, without changing its model', async () => {
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
    const binding = agentTabManager.getBindingForThread(threadId);
    expect(binding?.callerToken).toStartWith('agtok_');
    boundTokens.push(binding!.callerToken);
    expect(received.slice(0, 3)).toEqual([threadId, 'approved wake', '/workspace/worker']);
    const config = received[3] as {
      mcp_servers: Record<string, unknown>;
      shell_environment_policy: { set: Record<string, string> };
    };
    expect(config.mcp_servers).toEqual({});
    expect(config.shell_environment_policy.set.INTERPRETER_CALLER_TOKEN).toBe(binding?.callerToken);
    expect(config.shell_environment_policy.set.INTERPRETER_CLI_SERVER_CONNECTION).toBeTruthy();
    expect(config.shell_environment_policy.set.INTERPRETER_CLI_PATH).toEndWith('/interpreter-app');
    expect(config.shell_environment_policy.set.PATH).toContain('shell-safe-bin');
    expect(Object.keys(config)).toEqual(['mcp_servers', 'shell_environment_policy']);

    expect(await startWakeThreadTurn(threadId, 'next wake', service)).toBe('native-turn');
    expect(agentTabManager.getBindingForThread(threadId)?.callerToken).toBe(binding?.callerToken);
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
    expect(config.shell_environment_policy.set.INTERPRETER_CALLER_TOKEN).toBe(callerToken);
    expect(agentTabManager.getBindingForThread(threadId)?.allowedToolNames)
      .toEqual(['builtin-interpreter.interpreter_browser_page_inspect']);
  });
});
