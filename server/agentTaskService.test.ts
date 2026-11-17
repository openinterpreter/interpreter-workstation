import { afterEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { clearConfigCache, setConfigOverride } from './configStore';
import { forkAgentTaskThread, resumeAgentTaskThread, startAgentTask } from './agentTaskService';
import { agentTabManager } from './agentTabManager';
import { getCodexService } from '../src/lib/codex/service';
import {
  INTERPRETER_CALLER_TOKEN_ENV,
  INTERPRETER_CLI_PATH_ENV,
  INTERPRETER_CLI_SERVER_CONNECTION_ENV,
} from './utils/interpreterCliRuntime';

type CreateHeadedTask = NonNullable<Parameters<typeof startAgentTask>[0]['createHeadedTask']>;

afterEach(() => {
  setConfigOverride(null);
  clearConfigCache();
  agentTabManager.clearAll();
});

describe('resumeAgentTaskThread caller ownership', () => {
  const modelConfig = { provider: 'api' as const, modelId: 'test-model',
    apiFormat: 'openai' as const, baseURL: 'https://example.test/v1' };

  test('does not manufacture a binding for an existing native thread with no retained caller', async () => {
    await assert.rejects(resumeAgentTaskThread({ threadId: 'thr_unbound',
      workspace: '/tmp/owned-workspace', modelConfig }), /caller is unavailable/);
    assert.equal(agentTabManager.getBindingForThread('thr_unbound'), undefined);
  });

  test('preserves the original binding when workspace or model scope differs', async () => {
    agentTabManager.bindThread({ agentId: 'original-agent', callerToken: 'agtok_original',
      threadId: 'thr_bound', workspacePath: '/tmp/owned-workspace', modelConfig,
      allowedToolNames: ['builtin-interpreter.interpreter_goal_revision_get'] });
    const original = agentTabManager.getBindingForThread('thr_bound');
    await assert.rejects(resumeAgentTaskThread({ threadId: 'thr_bound',
      workspace: '/tmp/other-workspace', modelConfig }), /owner scope differs/);
    await assert.rejects(resumeAgentTaskThread({ threadId: 'thr_bound',
      workspace: '/tmp/owned-workspace', modelConfig: { ...modelConfig, modelId: 'other-model' } }),
    /owner scope differs/);
    assert.equal(agentTabManager.getBindingForThread('thr_bound'), original);
  });
});

describe('forkAgentTaskThread caller carrier', () => {
  const modelConfig = { provider: 'api' as const, modelId: 'test-model',
    apiFormat: 'openai' as const, baseURL: 'https://example.test/v1' };

  async function withStubbedFork<T>(run: (forks: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
    const service = getCodexService();
    const original = { ensureProvider: service.ensureProvider, forkThread: service.forkThread };
    const forks: Array<Record<string, unknown>> = [];
    service.ensureProvider = async () => {};
    service.forkThread = async (options) => {
      forks.push(options as unknown as Record<string, unknown>);
      return '00000000-0000-4000-8000-0000000000f2';
    };
    try { return await run(forks); }
    finally { Object.assign(service, original); }
  }

  test('gives the new forked thread a fresh app CLI shell policy and registers its caller', async () => {
    await withStubbedFork(async (forks) => {
      const result = await forkAgentTaskThread({ threadId: '00000000-0000-4000-8000-0000000000f1',
        lastTurnId: 'turn_source', workspace: '/tmp/owned-workspace', modelConfig });
      assert.equal(result.threadId, '00000000-0000-4000-8000-0000000000f2');
      const binding = agentTabManager.getBindingForThread(result.threadId);
      assert.ok(binding);
      try {
        assert.equal(binding.workspacePath, '/tmp/owned-workspace');
        const policy = (forks[0]?.config as { shell_environment_policy: { set: Record<string, string> } })
          .shell_environment_policy;
        assert.equal(policy.set[INTERPRETER_CALLER_TOKEN_ENV], binding.callerToken);
        assert.ok(policy.set[INTERPRETER_CLI_SERVER_CONNECTION_ENV]);
        const launcherDir = path.dirname(policy.set[INTERPRETER_CLI_PATH_ENV]);
        const pathKey = Object.keys(policy.set).find(key => key.toUpperCase() === 'PATH')!;
        assert.equal(policy.set[pathKey].split(path.delimiter)[0], launcherDir);
      } finally {
        agentTabManager.disposeBinding(binding.callerToken);
      }
    });
  });

  test('forks a source whose caller has a narrower tool scope without a new caller', async () => {
    const sourceThreadId = '00000000-0000-4000-8000-0000000000f3';
    const callerToken = 'agtok_restricted_source_caller';
    agentTabManager.bindThread({ agentId: 'restricted-agent', callerToken, threadId: sourceThreadId,
      workspacePath: '/tmp/owned-workspace', allowedToolNames: ['builtin-interpreter.interpreter_goal_revision_get'] });
    try {
      await withStubbedFork(async (forks) => {
        const forked = await forkAgentTaskThread({ threadId: sourceThreadId, lastTurnId: 'turn_source',
          workspace: '/tmp/owned-workspace', modelConfig });
        assert.equal(forks.length, 1);
        const config = (forks[0]?.config ?? {}) as Record<string, unknown>;
        assert.equal('shell_environment_policy' in config, false);
        assert.equal(agentTabManager.getBindingForThread(forked.threadId), undefined);
      });
    } finally {
      agentTabManager.disposeBinding(callerToken);
    }
  });
});

describe('startAgentTask', () => {
  test('forwards workspace to headed tasks and waits for renderer acknowledgement', async () => {
    let receivedArgs: unknown[] = [];
    const modelConfig = {
      provider: 'hosted',
      modelId: 'test-headed-model',
    } as const;
    const createHeadedTask = (async (...args) => {
      receivedArgs = args;
      return {
        agentId: 'agent-headed',
        callerToken: 'agtok-headed',
        requestId: 'req-headed',
        threadId: 'thr_resume',
        messages: [],
      };
    }) as CreateHeadedTask;

    const result = await startAgentTask({
      mode: 'headed',
      threadId: 'thr_resume',
      workspace: '/tmp/headed-workspace',
      modelConfig,
      createHeadedTask,
    });

    assert.deepEqual(receivedArgs, [{
      initialMessage: undefined,
      systemPrompt: undefined,
      timeout: undefined,
      threadId: 'thr_resume',
      workspacePath: '/tmp/headed-workspace',
      modelConfig,
      activate: undefined,
      completionDisposition: undefined,
    }]);
    assert.equal(result.mode, 'headed');
    assert.equal(result.completed, true);
    assert.equal(result.agentId, 'agent-headed');
    assert.equal(result.threadId, 'thr_resume');
    assert.equal(result.messageCount, 0);
    assert.deepEqual(result.messages, []);
  });

  test('surfaces headed task failures when the renderer never acknowledges the tab', async () => {
    const createHeadedTask = (async () => {
      throw new Error('Agent tab creation timed out after 1000ms');
    }) as CreateHeadedTask;

    const modelConfig = {
      provider: 'hosted',
      modelId: 'test-headed-model',
    } as const;

    await assert.rejects(
      () => startAgentTask({
        mode: 'headed',
        message: 'Open a headed task',
        timeoutMs: 1000,
        modelConfig,
        createHeadedTask,
      }),
      /Agent tab creation timed out after 1000ms/,
    );
  });

  test('preserves default-profile reasoning effort when deriving the model config', async () => {
    let receivedArgs: unknown[] = [];
    setConfigOverride({
      agents: {},
      profiles: [
        {
          id: 'profile-default',
          name: 'Programmatic Default',
          provider: 'api',
          modelId: 'gpt-5.4',
          apiFormat: 'openai',
          baseURL: 'https://api.openai.com/v1',
          isBuiltin: false,
          reasoningEffort: 'high',
        },
      ],
      defaultProfileId: 'profile-default',
    } as any);

    const createHeadedTask = (async (...args) => {
      receivedArgs = args;
      return {
        agentId: 'agent-reasoning',
        callerToken: 'agtok-reasoning',
        requestId: 'req-reasoning',
        threadId: 'thr_reasoning',
        messages: [],
      };
    }) as CreateHeadedTask;

    await startAgentTask({
      mode: 'headed',
      message: 'Use the default profile',
      workspace: '/tmp/programmatic-workspace',
      createHeadedTask,
    });

    assert.deepEqual(receivedArgs, [{
      initialMessage: 'Use the default profile',
      systemPrompt: undefined,
      timeout: undefined,
      threadId: undefined,
      workspacePath: '/tmp/programmatic-workspace',
      modelConfig: {
        profileId: 'profile-default',
        providerId: undefined,
        provider: 'api',
        modelId: 'gpt-5.4',
        harness: undefined,
        apiKey: undefined,
        baseURL: 'https://api.openai.com/v1',
        apiFormat: 'openai',
        codexProfileId: undefined,
        wireApi: 'responses',
        providerConfig: undefined,
        useResponsesApi: true,
        reasoningEffort: 'high',
        visionModel: undefined,
        fastModel: undefined,
      },
      activate: undefined,
      completionDisposition: undefined,
    }]);
  });
});
