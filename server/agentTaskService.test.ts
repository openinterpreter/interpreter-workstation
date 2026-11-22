import { afterEach, beforeEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearConfigCache, setConfigOverride } from './configStore';
import {
  coldBindAgentTaskThread,
  forkAgentTaskThread,
  prepareUnloadedThreadCarrier,
  resumeAgentTaskThread,
  startAgentTask,
} from './agentTaskService';
import { listNativeCallerScopesForThread, persistNativeCallerBinding } from './utils/persistedCallerBinding';
import { agentTabManager } from './agentTabManager';
import { getCodexService, type CodexService } from '../src/lib/codex/service';
import { resolveAgentInterpreterCliTransport } from './utils/codexRuntime';
import {
  buildInterpreterCliServerConnection,
  INTERPRETER_CALLER_TOKEN_ENV,
  INTERPRETER_CLI_PATH_ENV,
  INTERPRETER_CLI_SERVER_CONNECTION_ENV,
} from './utils/interpreterCliRuntime';
import { setServerPort } from './utils/serverPort';

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

describe('resumeAgentTaskThread shell environment', () => {
  const modelConfig = { provider: 'api' as const, modelId: 'test-model',
    apiFormat: 'openai' as const, baseURL: 'https://example.test/v1' };
  const threadId = '00000000-0000-4000-8000-0000000000e1';
  const workspace = '/tmp/owned-workspace';

  async function withStubbedResume<T>(
    run: (resumes: Array<Parameters<CodexService['resumeThread']>[0]>) => Promise<T>,
  ): Promise<T> {
    const service = getCodexService();
    const original = { ensureProvider: service.ensureProvider, resumeThread: service.resumeThread };
    const resumes: Array<Parameters<CodexService['resumeThread']>[0]> = [];
    service.ensureProvider = async () => {};
    service.resumeThread = async (options) => {
      resumes.push(options);
      return options.threadId;
    };
    try { return await run(resumes); }
    finally { Object.assign(service, original); }
  }

  afterEach(() => setServerPort(0));

  test('carries the thread\'s existing caller and the current app CLI connection', async () => {
    setServerPort(43_211);
    agentTabManager.bindThread({ agentId: 'original-agent', callerToken: 'agtok_existing_caller',
      threadId, workspacePath: workspace, modelConfig });
    const original = agentTabManager.getBindingForThread(threadId);
    await withStubbedResume(async (resumes) => {
      assert.deepEqual(await resumeAgentTaskThread({ threadId, workspace, modelConfig }), { threadId });
      assert.equal(resumes.length, 1);
      assert.equal(resumes[0]?.callerBoundShellPolicy, true);
      assert.equal(resumes[0]?.coldShellPolicy, undefined);
      const config = resumes[0]?.config as {
        mcp_servers: unknown; shell_environment_policy: { set: Record<string, string> } };
      assert.deepEqual(config.mcp_servers, {});
      const set = config.shell_environment_policy.set;
      assert.equal(set[INTERPRETER_CALLER_TOKEN_ENV], 'agtok_existing_caller');
      assert.equal(set[INTERPRETER_CLI_SERVER_CONNECTION_ENV], buildInterpreterCliServerConnection(43_211, {
        transport: resolveAgentInterpreterCliTransport(process.platform),
      }));
      const launcherDir = path.dirname(set[INTERPRETER_CLI_PATH_ENV]);
      const pathKey = Object.keys(set).find(key => key.toUpperCase() === 'PATH')!;
      assert.equal(set[pathKey].split(path.delimiter)[0], launcherDir);
    });
    // The caller identity and binding are unchanged.
    assert.equal(agentTabManager.getBindingForThread(threadId), original);
    assert.equal(agentTabManager.getBindingForCallerToken('agtok_existing_caller')?.threadId, threadId);
  });

  test('keeps a delegated caller on its ordinary resume without a shell policy', async () => {
    agentTabManager.bindThread({ agentId: 'delegated-agent', callerToken: 'agtok_delegated_caller',
      threadId, workspacePath: workspace, modelConfig,
      parentOwner: { approvalOwnerKind: 'normal-agent', agentId: 'parent-agent', windowSessionKey: null,
        workspacePath: workspace } });
    await withStubbedResume(async (resumes) => {
      await resumeAgentTaskThread({ threadId, workspace, modelConfig });
      assert.equal(resumes.length, 1);
      assert.equal('callerBoundShellPolicy' in (resumes[0] ?? {}), false);
      assert.equal('shell_environment_policy' in (resumes[0]?.config ?? {}), false);
    });
  });

  test('does not resume when the binding cannot be verified', async () => {
    await withStubbedResume(async (resumes) => {
      await assert.rejects(resumeAgentTaskThread({ threadId, workspace, modelConfig }),
        /caller is unavailable/);
      agentTabManager.bindThread({ agentId: 'original-agent', callerToken: 'agtok_existing_caller',
        threadId, workspacePath: workspace, modelConfig });
      await assert.rejects(resumeAgentTaskThread({ threadId, workspace: '/tmp/other-workspace', modelConfig }),
        /owner scope differs/);
      await assert.rejects(resumeAgentTaskThread({ threadId, workspace,
        modelConfig: { ...modelConfig, modelId: 'other-model' } }), /owner scope differs/);
      assert.equal(resumes.length, 0);
    });
  });
});

describe('coldBindAgentTaskThread caller carrier', () => {
  for (const prior of [{}, { toolProfileId: 'profile-narrow' }]) test(
    `still binds a fresh caller through the guarded cold shell policy (${prior.toolProfileId ?? 'open'})`,
    async () => {
    const threadId = prior.toolProfileId
      ? '00000000-0000-4000-8000-0000000000e3' : '00000000-0000-4000-8000-0000000000e2';
    const workspace = '/tmp/owned-workspace';
    agentTabManager.bindThread({ agentId: 'original-agent', callerToken: 'agtok_prior_caller',
      threadId, workspacePath: workspace, ...prior });
    const service = getCodexService();
    const original = {
      readThread: service.readThread, readNativeCustody: service.readNativeCustody,
      readGlobalNativeCustody: service.readGlobalNativeCustody, resumeThread: service.resumeThread,
    };
    const resumes: Array<Parameters<CodexService['resumeThread']>[0]> = [];
    service.readThread = (async () => ({ id: threadId, cwd: workspace })) as never;
    service.readNativeCustody = (async () => ({ status: 'notLoaded', queuedSubmissionCount: 0 })) as never;
    service.readGlobalNativeCustody = (async () => ({ queuedSubmissionCount: 0, loadedThreadIds: [],
      threads: [{ threadId }] })) as never;
    service.resumeThread = async (options) => {
      resumes.push(options);
      return options.threadId;
    };
    try {
      await coldBindAgentTaskThread({ threadId, workspace });
    } finally {
      Object.assign(service, original);
    }
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]?.coldShellPolicy, true);
    assert.equal(resumes[0]?.callerBoundShellPolicy, undefined);
    const token = (resumes[0]?.config as { shell_environment_policy: { set: Record<string, string> } })
      .shell_environment_policy.set[INTERPRETER_CALLER_TOKEN_ENV];
    assert.notEqual(token, 'agtok_prior_caller');
    assert.equal(agentTabManager.getBindingForThread(threadId)?.callerToken, token);
    // The operator cold bind carries the prior caller's scope, never a wider one.
    assert.equal(agentTabManager.getBindingForThread(threadId)?.toolProfileId, prior.toolProfileId);
  });
});

describe('unloaded thread carrier keeps the prior caller scope', () => {
  // Persisted caller scopes exist on Linux hosts only.
  const linuxTest = process.platform === 'linux' ? test : test.skip;
  const workspace = '/tmp/carrier-workspace/project';
  const olderWorkspace = '/tmp/carrier-workspace';
  const modelConfig = { provider: 'api' as const, modelId: 'test-model',
    apiFormat: 'openai' as const, baseURL: 'https://example.test/v1' };
  const narrowTools = ['builtin-interpreter__interpreter_goal_revision_get'];
  let dataDir = '';
  let priorDataDir: string | undefined;
  let sequence = 0;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'carrier-scope-'));
    priorDataDir = process.env.INTERPRETER_USER_DATA_DIR;
    process.env.INTERPRETER_USER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    agentTabManager.clearAll();
    if (priorDataDir === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
    else process.env.INTERPRETER_USER_DATA_DIR = priorDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const newThreadId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

  function persistPrior(threadId: string, scope: {
    workspacePath?: string; allowedToolNames?: string[]; toolProfileId?: string;
    modelConfig?: typeof modelConfig;
  } = {}): string {
    const callerToken = `agtok_prior_${++sequence}_abcdefgh`;
    persistNativeCallerBinding({ agentId: `prior-${sequence}`, callerToken, threadId,
      workspacePath: scope.workspacePath ?? workspace,
      ...(scope.allowedToolNames ? { allowedToolNames: scope.allowedToolNames } : {}),
      ...(scope.toolProfileId ? { toolProfileId: scope.toolProfileId } : {}),
      ...(scope.modelConfig ? { modelConfig: scope.modelConfig } : {}) }, dataDir);
    return callerToken;
  }

  const prepare = (threadId: string) =>
    prepareUnloadedThreadCarrier({ service: {} as CodexService, threadId, cwd: workspace });

  function policyToken(carrier: { shellPolicy: unknown }): string {
    const policy = carrier.shellPolicy as { set: Record<string, string> };
    assert.ok(policy.set[INTERPRETER_CLI_SERVER_CONNECTION_ENV]);
    assert.ok(policy.set[INTERPRETER_CLI_PATH_ENV]);
    return policy.set[INTERPRETER_CALLER_TOKEN_ENV];
  }

  test('a restricted live caller is replaced by a fresh caller with the same scope', async () => {
    const threadId = newThreadId();
    agentTabManager.bindThread({ agentId: 'prior-live', callerToken: 'agtok_prior_live_caller', threadId,
      workspacePath: workspace, toolProfileId: 'profile-narrow', modelConfig });
    const carrier = await prepare(threadId);
    const token = policyToken(carrier);
    assert.notEqual(token, 'agtok_prior_live_caller');
    const binding = agentTabManager.getBindingForThread(threadId);
    assert.equal(binding?.callerToken, token);
    assert.equal(binding?.toolProfileId, 'profile-narrow');
    assert.equal(binding?.allowedToolNames, undefined);
    assert.deepEqual(binding?.modelConfig, modelConfig);
    carrier.commit();
    assert.equal(agentTabManager.getBindingForCallerToken('agtok_prior_live_caller'), undefined);
    assert.equal(agentTabManager.getBindingForCallerToken(token)?.toolProfileId, 'profile-narrow');
  });

  test('rollback restores the restricted live caller', async () => {
    const threadId = newThreadId();
    agentTabManager.bindThread({ agentId: 'prior-live', callerToken: 'agtok_prior_live_caller', threadId,
      workspacePath: workspace, allowedToolNames: narrowTools });
    const carrier = await prepare(threadId);
    const token = policyToken(carrier);
    carrier.rollback();
    assert.equal(agentTabManager.getBindingForThread(threadId)?.callerToken, 'agtok_prior_live_caller');
    assert.deepEqual(agentTabManager.getBindingForThread(threadId)?.allowedToolNames, narrowTools);
    assert.equal(agentTabManager.getBindingForCallerToken(token), undefined);
  });

  linuxTest('persisted callers with one scope give a fresh caller of that scope and leave one record', async () => {
    const threadId = newThreadId();
    for (let i = 0; i < 3; i++) persistPrior(threadId, { toolProfileId: 'profile-narrow', modelConfig });
    const carrier = await prepare(threadId);
    const token = policyToken(carrier);
    const binding = agentTabManager.getBindingForThread(threadId);
    assert.equal(binding?.callerToken, token);
    assert.equal(binding?.toolProfileId, 'profile-narrow');
    assert.equal(binding?.allowedToolNames, undefined);
    assert.deepEqual(binding?.modelConfig, { provider: modelConfig.provider, modelId: modelConfig.modelId });
    carrier.commit();
    assert.deepEqual(listNativeCallerScopesForThread(threadId, dataDir), [{ workspacePath: workspace,
      toolProfileId: 'profile-narrow', model: { provider: modelConfig.provider, modelId: modelConfig.modelId } }]);
  });

  linuxTest('older same-scope callers in a parent workspace do not block the fresh caller', async () => {
    const threadId = newThreadId();
    for (let i = 0; i < 15; i++) persistPrior(threadId, { toolProfileId: 'profile-narrow' });
    for (let i = 0; i < 9; i++) persistPrior(threadId, { toolProfileId: 'profile-narrow', workspacePath: olderWorkspace });
    const carrier = await prepare(threadId);
    policyToken(carrier);
    assert.equal(agentTabManager.getBindingForThread(threadId)?.toolProfileId, 'profile-narrow');
    carrier.commit();
    assert.deepEqual(listNativeCallerScopesForThread(threadId, dataDir), [{ workspacePath: workspace,
      toolProfileId: 'profile-narrow' }]);
  });

  linuxTest('persisted callers of one scope but different models give no model', async () => {
    const threadId = newThreadId();
    persistPrior(threadId, { allowedToolNames: narrowTools, modelConfig });
    persistPrior(threadId, { allowedToolNames: narrowTools, modelConfig: { ...modelConfig, modelId: 'other-model' } });
    const carrier = await prepare(threadId);
    const binding = agentTabManager.getBindingForThread(threadId);
    assert.deepEqual(binding?.allowedToolNames, narrowTools);
    assert.equal(binding?.modelConfig, undefined);
    carrier.rollback();
  });

  linuxTest('persisted callers that disagree on scope are refused and nothing is revoked', async () => {
    for (const scopes of [
      [{ toolProfileId: 'profile-a' }, { toolProfileId: 'profile-b' }],
      [{}, { toolProfileId: 'profile-a' }],
      [{ allowedToolNames: narrowTools }, {}],
    ]) {
      const threadId = newThreadId();
      for (const scope of scopes) persistPrior(threadId, scope);
      await assert.rejects(prepare(threadId), /scope differs/);
      assert.equal(agentTabManager.getBindingForThread(threadId), undefined);
      assert.equal(listNativeCallerScopesForThread(threadId, dataDir).length, 2);
    }
  });

  linuxTest('an older caller in another workspace with a different scope is refused', async () => {
    const consistent = newThreadId();
    persistPrior(consistent, { toolProfileId: 'profile-a' });
    persistPrior(consistent, { toolProfileId: 'profile-b', workspacePath: olderWorkspace });
    await assert.rejects(prepare(consistent), /different tool scope/);
    // With no caller in this workspace the chosen scope is open, which a
    // restricted older caller must not be widened to.
    const onlyOlder = newThreadId();
    persistPrior(onlyOlder, { toolProfileId: 'profile-a', workspacePath: olderWorkspace });
    await assert.rejects(prepare(onlyOlder), /different tool scope/);
    for (const threadId of [consistent, onlyOlder]) {
      assert.equal(agentTabManager.getBindingForThread(threadId), undefined);
    }
    assert.equal(listNativeCallerScopesForThread(consistent, dataDir).length, 2);
    assert.equal(listNativeCallerScopesForThread(onlyOlder, dataDir).length, 1);
  });

  test('a thread with no prior caller still gets an open fresh caller', async () => {
    const threadId = newThreadId();
    const carrier = await prepare(threadId);
    const binding = agentTabManager.getBindingForThread(threadId);
    assert.equal(binding?.callerToken, policyToken(carrier));
    assert.equal(binding?.allowedToolNames, undefined);
    assert.equal(binding?.toolProfileId, undefined);
    assert.equal(binding?.modelConfig, undefined);
    carrier.commit();
  });

  test('a delegated, window-scoped or other-workspace live caller is still refused', async () => {
    const parentOwner = { approvalOwnerKind: 'normal-agent' as const, agentId: 'parent-agent',
      windowSessionKey: null, workspacePath: workspace };
    for (const extra of [{ parentOwner }, { windowSessionKey: 'window-a' }, { workspacePath: olderWorkspace }]) {
      const threadId = newThreadId();
      agentTabManager.bindThread({ agentId: `prior-${threadId}`, callerToken: `agtok_live_${sequence}_abcdefgh`,
        threadId, workspacePath: workspace, ...extra });
      const original = agentTabManager.getBindingForThread(threadId);
      await assert.rejects(prepare(threadId), /owner or tool scope differs/);
      assert.equal(agentTabManager.getBindingForThread(threadId), original);
    }
  });

  linuxTest('a restricted prior caller never yields an open or different fresh caller', async () => {
    const priors = [
      { toolProfileId: 'profile-narrow' },
      { allowedToolNames: narrowTools },
      { allowedToolNames: [...narrowTools, 'builtin-interpreter__interpreter_browser_page_inspect'].reverse(),
        toolProfileId: 'profile-narrow' },
    ];
    for (const prior of priors) {
      for (const live of [true, false]) {
        const threadId = newThreadId();
        if (live) {
          agentTabManager.bindThread({ agentId: `prior-${threadId}`, callerToken: `agtok_live_${sequence}_abcdefgh`,
            threadId, workspacePath: workspace, ...prior });
        } else {
          persistPrior(threadId, prior);
          persistPrior(threadId, prior);
        }
        const carrier = await prepare(threadId);
        const binding = agentTabManager.getBindingForThread(threadId);
        assert.equal(binding?.callerToken, policyToken(carrier));
        assert.ok(binding?.toolProfileId || binding?.allowedToolNames?.length, 'fresh caller must not be open');
        assert.equal(binding?.toolProfileId, prior.toolProfileId);
        assert.deepEqual([...(binding?.allowedToolNames ?? [])].sort(), [...(prior.allowedToolNames ?? [])].sort());
        carrier.commit();
        const remaining = listNativeCallerScopesForThread(threadId, dataDir);
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0]?.toolProfileId, prior.toolProfileId);
      }
    }
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
