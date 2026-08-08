import { afterEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { agentTabManager } from './agentTabManager';

afterEach(() => {
  agentTabManager.clearAll();
});

describe('agentTabManager', () => {
  test('registers headed task requests immediately without waiting for renderer ack', () => {
    const result = agentTabManager.requestAgentTask({
      initialMessage: 'Open immediately',
      timeout: 1_000,
      threadId: 'thr_existing',
      workspacePath: '/tmp/requested-workspace',
      agentId: 'agent-immediate',
      callerToken: 'agtok_immediate',
      completionDisposition: 'close_tab',
    });

    const [pendingRequest] = agentTabManager.getPendingRequests();
    assert.ok(pendingRequest);
    assert.deepEqual(result, {
      agentId: 'agent-immediate',
      callerToken: 'agtok_immediate',
      requestId: pendingRequest.requestId,
      startupId: pendingRequest.requestId,
      threadId: 'thr_existing',
      messages: [],
    });
  });

  test('resolves headed task requests when the tab is created', async () => {
    const taskPromise = agentTabManager.createAgentTask({
      initialMessage: 'Open the task UI',
      timeout: 1_000,
      threadId: 'thr_existing',
      workspacePath: '/tmp/requested-workspace',
      agentId: 'agent-123',
      callerToken: 'agtok_123',
      completionDisposition: 'close_tab',
    });

    const [pendingRequest] = agentTabManager.getPendingRequests();
    assert.ok(pendingRequest);
    assert.equal(pendingRequest.agentId, 'agent-123');
    assert.equal(pendingRequest.callerToken, 'agtok_123');
    assert.equal(pendingRequest.threadId, 'thr_existing');
    assert.equal(pendingRequest.workspacePath, '/tmp/requested-workspace');
    assert.equal(pendingRequest.completionDisposition, 'close_tab');

    agentTabManager.onTabCreated(pendingRequest.requestId, 'agent-123');

    const result = await taskPromise;
    assert.deepEqual(result, {
      agentId: 'agent-123',
      callerToken: 'agtok_123',
      requestId: pendingRequest.requestId,
      startupId: pendingRequest.requestId,
      threadId: 'thr_existing',
      messages: [],
    });
    assert.equal(agentTabManager.getPendingRequests().length, 0);
  });

  test('notifies listeners when a created headed startup run completes', async () => {
    const completions: any[] = [];
    const unsubscribe = agentTabManager.onCompletion((event) => {
      completions.push(event);
    });

    const taskPromise = agentTabManager.createAgentTask({
      initialMessage: 'Run and report completion',
      timeout: 1_000,
      agentId: 'agent-voice',
      callerToken: 'agtok_voice',
      completionDisposition: 'keep_open',
    });

    const [pendingRequest] = agentTabManager.getPendingRequests();
    assert.ok(pendingRequest);
    agentTabManager.onTabCreated(pendingRequest.requestId, 'agent-voice');
    await taskPromise;

    agentTabManager.onTabCompleted(
      pendingRequest.requestId,
      [{ role: 'assistant', content: 'Done.' }],
      undefined,
      'thr-voice',
    );

    assert.deepEqual(completions, [{
      agentId: 'agent-voice',
      callerToken: 'agtok_voice',
      requestId: pendingRequest.requestId,
      threadId: 'thr-voice',
      messages: [{ role: 'assistant', content: 'Done.' }],
    }]);
    unsubscribe();
  });

  test('consumes headed startup payloads exactly once', async () => {
    const taskPromise = agentTabManager.createAgentTask({
      initialMessage: 'Run once',
      agentId: 'agent-startup',
      callerToken: 'agtok_startup',
      completionDisposition: 'close_tab',
    });

    const [pendingRequest] = agentTabManager.getPendingRequests();
    assert.ok(pendingRequest);

    assert.deepEqual(agentTabManager.consumeStartup(pendingRequest.requestId, 'agent-startup'), {
      startupId: pendingRequest.requestId,
      initialMessage: 'Run once',
      completionDisposition: 'close_tab',
    });
    assert.equal(agentTabManager.consumeStartup(pendingRequest.requestId, 'agent-startup'), null);

    agentTabManager.onTabCreated(pendingRequest.requestId, 'agent-startup');
    await taskPromise;
  });

  test('stores and resolves thread bindings', () => {
    agentTabManager.bindThread({
      agentId: 'agent-123',
      threadId: 'thr-123',
      callerToken: 'agtok_123',
      workspacePath: '/tmp/workspace',
      allowedToolNames: ['builtin-docx__read_word'],
      modelConfig: {
        provider: 'api',
        modelId: 'gpt-5.4-mini',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
      },
      toolProfileId: 'profile-1',
    });

    assert.deepEqual(agentTabManager.getBindingForThread('thr-123'), {
      agentId: 'agent-123',
      callerToken: 'agtok_123',
      threadId: 'thr-123',
      workspacePath: '/tmp/workspace',
      allowedToolNames: ['builtin-docx__read_word'],
      modelConfig: {
        provider: 'api',
        modelId: 'gpt-5.4-mini',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
      },
      toolProfileId: 'profile-1',
    });
    assert.deepEqual(agentTabManager.getBindingForCallerToken('agtok_123'), {
      agentId: 'agent-123',
      callerToken: 'agtok_123',
      threadId: 'thr-123',
      workspacePath: '/tmp/workspace',
      allowedToolNames: ['builtin-docx__read_word'],
      modelConfig: {
        provider: 'api',
        modelId: 'gpt-5.4-mini',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
      },
      toolProfileId: 'profile-1',
    });
    assert.deepEqual(agentTabManager.getBindingForAgentId('agent-123'), {
      agentId: 'agent-123',
      callerToken: 'agtok_123',
      threadId: 'thr-123',
      workspacePath: '/tmp/workspace',
      allowedToolNames: ['builtin-docx__read_word'],
      modelConfig: {
        provider: 'api',
        modelId: 'gpt-5.4-mini',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
      },
      toolProfileId: 'profile-1',
    });
  });

  test('allows the same caller token and agent to move to a new workspace', () => {
    agentTabManager.registerAgentRuntime({
      agentId: 'agent-workspace',
      callerToken: 'agtok_workspace',
      workspacePath: '/tmp/workspace-a',
    });

    agentTabManager.bindThread({
      agentId: 'agent-workspace',
      callerToken: 'agtok_workspace',
      threadId: 'thread-workspace',
      workspacePath: '/tmp/workspace-b',
    });

    assert.equal(
      agentTabManager.getBindingForCallerToken('agtok_workspace')?.workspacePath,
      '/tmp/workspace-b',
    );
    assert.equal(
      agentTabManager.getBindingForThread('thread-workspace')?.workspacePath,
      '/tmp/workspace-b',
    );
  });

  test('rejects rebinding a caller token to a different agent', () => {
    agentTabManager.registerAgentRuntime({
      agentId: 'agent-a',
      callerToken: 'agtok_workspace',
      workspacePath: '/tmp/workspace-a',
    });

    assert.throws(
      () => agentTabManager.bindThread({
        agentId: 'agent-b',
        callerToken: 'agtok_workspace',
        threadId: 'thread-workspace',
        workspacePath: '/tmp/workspace-b',
      }),
      /Caller token is already bound to agent 'agent-a', not 'agent-b'/,
    );

    assert.equal(
      agentTabManager.getBindingForCallerToken('agtok_workspace')?.workspacePath,
      '/tmp/workspace-a',
    );
    assert.equal(agentTabManager.getBindingForThread('thread-workspace'), undefined);
  });

  test('preserves runtime binding fields when a thread is registered later', () => {
    agentTabManager.registerAgentRuntime({
      agentId: 'agent-merge',
      callerToken: 'agtok_merge',
      workspacePath: '/tmp/runtime-workspace',
      allowedToolNames: ['builtin-docx__read_word'],
      modelConfig: {
        provider: 'api',
        modelId: 'gpt-5.4-mini',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
      },
      toolProfileId: 'profile-merge',
    });

    agentTabManager.bindThread({
      agentId: 'agent-merge',
      threadId: 'thr-merge',
      callerToken: 'agtok_merge',
    });

    assert.deepEqual(agentTabManager.getBindingForThread('thr-merge'), {
      agentId: 'agent-merge',
      callerToken: 'agtok_merge',
      threadId: 'thr-merge',
      workspacePath: '/tmp/runtime-workspace',
      allowedToolNames: ['builtin-docx__read_word'],
      modelConfig: {
        provider: 'api',
        modelId: 'gpt-5.4-mini',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
      },
      toolProfileId: 'profile-merge',
    });
  });

  test('binds auxiliary threads without replacing the owner thread binding', () => {
    agentTabManager.bindThread({
      agentId: 'agent-123',
      threadId: 'thr-owner',
      callerToken: 'agtok_123',
      workspacePath: '/tmp/workspace',
      allowedToolNames: ['builtin-docx__read_word'],
      modelConfig: {
        provider: 'api',
        modelId: 'gpt-5.4-mini',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
      },
      toolProfileId: 'profile-1',
    });

    const auxiliary = agentTabManager.bindAuxiliaryThread({
      ownerThreadId: 'thr-owner',
      threadId: 'thr-mcp-tools',
    });

    assert.deepEqual(auxiliary, {
      agentId: 'agent-123',
      callerToken: 'agtok_123',
      threadId: 'thr-mcp-tools',
      workspacePath: '/tmp/workspace',
      allowedToolNames: ['builtin-docx__read_word'],
      modelConfig: {
        provider: 'api',
        modelId: 'gpt-5.4-mini',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
      },
      toolProfileId: 'profile-1',
    });
    assert.equal(agentTabManager.getBindingForThread('thr-owner')?.threadId, 'thr-owner');
    assert.equal(agentTabManager.getBindingForThread('thr-mcp-tools')?.agentId, 'agent-123');
    assert.equal(agentTabManager.getBindingForCallerToken('agtok_123')?.threadId, 'thr-owner');
  });

  test('disposes caller token bindings and associated threads', () => {
    agentTabManager.bindThread({
      agentId: 'agent-123',
      threadId: 'thr-123',
      callerToken: 'agtok_123',
    });

    agentTabManager.disposeBinding('agtok_123');

    assert.equal(agentTabManager.getBindingForCallerToken('agtok_123'), undefined);
    assert.equal(agentTabManager.getBindingForThread('thr-123'), undefined);
    assert.equal(agentTabManager.getBindingForAgentId('agent-123'), undefined);
  });
});
