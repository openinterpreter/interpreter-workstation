import { afterEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { clearConfigCache, setConfigOverride } from './configStore';
import { startAgentTask } from './agentTaskService';

type CreateHeadedTask = NonNullable<Parameters<typeof startAgentTask>[0]['createHeadedTask']>;

afterEach(() => {
  setConfigOverride(null);
  clearConfigCache();
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
