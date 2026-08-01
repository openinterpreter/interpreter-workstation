import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import {
  buildProfileFromPreset,
  getCustomPreset,
  type Profile,
} from "@/lib/codex/profiles";
import {
  type AppServerNotification,
  SERVER_METHOD,
} from "@/lib/codex/protocol";
import {
  type CodexClient,
  CodexService,
  type StreamEvent,
  THREAD_LIST_DEFAULTS,
} from "@/lib/codex/service";
import type { v2 } from "@/schemas";
import type { JsonValue } from "@/schemas/serde_json/JsonValue";

function createTurn(id: string, status: v2.TurnStatus = "inProgress"): v2.Turn {
  return {
    id,
    status,
    items: [],
    error: null,
  };
}

function createFakeClient(overrides: {
  startTurn?: (params: Parameters<CodexClient["startTurn"]>[0]) => Promise<v2.Turn>;
  steerTurn?: (params: Parameters<CodexClient["steerTurn"]>[0]) => Promise<v2.TurnSteerResponse>;
  resumeThread?: (...args: Parameters<CodexClient["resumeThread"]>) => Promise<string>;
  threadRead?: (params: Parameters<CodexClient["threadRead"]>[0]) => Promise<v2.ThreadReadResponse>;
  configValueWrite?: (keyPath: string, value: JsonValue) => Promise<void>;
  configRead?: () => Promise<v2.ConfigReadResponse>;
} = {}) {
  let handler: ((notification: AppServerNotification) => void) | null = null;
  let disconnectHandler: ((reason: string) => void) | null = null;

  const calls = {
    startThread: 0,
    startThreadWithConfig: 0,
    resumeThread: 0,
    startTurn: 0,
    steerTurn: [] as Array<Parameters<CodexClient["steerTurn"]>[0]>,
    ensureConnected: 0,
    interruptTurn: [] as Array<{ threadId: string; turnId: string }>,
    cleanBackgroundTerminals: [] as string[],
    configValueWrite: [] as Array<{ keyPath: string; value: JsonValue }>,
    startThreadWithConfigConfig: [] as Array<Record<string, JsonValue> | null | undefined>,
    startThreadModelProvider: [] as Array<string | null | undefined>,
    startThreadCwd: [] as Array<string | null | undefined>,
    startThreadBaseInstructions: [] as Array<string | null | undefined>,
    startThreadDeveloperInstructions: [] as Array<string | null | undefined>,
    resumeThreadModelProvider: [] as Array<string | null | undefined>,
    resumeThreadModel: [] as Array<string | null | undefined>,
    resumeThreadCwd: [] as Array<string | null | undefined>,
    resumeThreadConfig: [] as Array<Record<string, JsonValue> | null | undefined>,
    resumeThreadBaseInstructions: [] as Array<string | null | undefined>,
    resumeThreadDeveloperInstructions: [] as Array<string | null | undefined>,
    startTurnCwd: [] as Array<string | null | undefined>,
    skillsListParams: [] as Array<v2.SkillsListParams>,
    threadListParams: [] as Array<v2.ThreadListParams>,
    threadReadParams: [] as Array<v2.ThreadReadParams>,
    threadSetNameParams: [] as Array<v2.ThreadSetNameParams>,
    threadArchiveParams: [] as Array<v2.ThreadArchiveParams>,
    threadUnarchiveParams: [] as Array<v2.ThreadUnarchiveParams>,
  };

  const client: CodexClient = {
    async ensureConnected() { calls.ensureConnected += 1; },
    subscribe(next) {
      handler = next;
      return () => {
        handler = null;
      };
    },
    onDisconnect(next) {
      disconnectHandler = next;
      return () => {
        disconnectHandler = null;
      };
    },
    async startThread(
      _model: string,
      modelProvider?: string | null,
      _baseInstructions?: string | null,
      cwd?: string | null,
      developerInstructions?: string | null,
    ) {
      calls.startThread += 1;
      calls.startThreadModelProvider.push(modelProvider);
      calls.startThreadCwd.push(cwd);
      calls.startThreadBaseInstructions.push(_baseInstructions);
      calls.startThreadDeveloperInstructions.push(developerInstructions);
      return "thr_new";
    },
    async startThreadWithConfig(
      model: string,
      modelProvider?: string | null,
      baseInstructions?: string | null,
      cwd?: string | null,
      config?: Record<string, JsonValue> | null,
      developerInstructions?: string | null,
    ) {
      calls.startThreadWithConfig += 1;
      calls.startThreadWithConfigConfig.push(config);
      return client.startThread(
        model,
        modelProvider,
        baseInstructions,
        cwd,
        developerInstructions,
      );
    },
    async startMcpToolThread() {
      return "thr_mcp";
    },
    async resumeThread(
      threadId: string,
      modelProvider?: string | null,
      model?: string | null,
      cwd?: string | null,
      config?: Record<string, JsonValue> | null,
      baseInstructions?: string | null,
      developerInstructions?: string | null,
    ) {
      calls.resumeThread += 1;
      calls.resumeThreadModelProvider.push(modelProvider);
      calls.resumeThreadModel.push(model);
      calls.resumeThreadCwd.push(cwd);
      calls.resumeThreadConfig.push(config);
      calls.resumeThreadBaseInstructions.push(baseInstructions);
      calls.resumeThreadDeveloperInstructions.push(developerInstructions);
      if (overrides.resumeThread) {
        return overrides.resumeThread(
          threadId,
          modelProvider,
          model,
          cwd,
          config,
          baseInstructions,
          developerInstructions,
        );
      }
      if (threadId === "missing") {
        throw new Error("missing thread");
      }
      return threadId;
    },
    async startTurn(params) {
      calls.startTurn += 1;
      calls.startTurnCwd.push(params.cwd);
      if (overrides.startTurn) {
        return overrides.startTurn(params);
      }
      return createTurn("turn_1");
    },
    async steerTurn(params) {
      calls.steerTurn.push(params);
      if (overrides.steerTurn) {
        return overrides.steerTurn(params);
      }
      return { turnId: params.turnId };
    },
    async interruptTurn(threadId: string, turnId: string) {
      calls.interruptTurn.push({ threadId, turnId });
    },
    async threadBackgroundTerminalsClean(threadId: string) {
      calls.cleanBackgroundTerminals.push(threadId);
      return {};
    },
    async configValueWrite(keyPath: string, value: JsonValue) {
      calls.configValueWrite.push({ keyPath, value });
      if (overrides.configValueWrite) {
        await overrides.configValueWrite(keyPath, value);
      }
    },
    async configRead() {
      if (overrides.configRead) {
        return overrides.configRead();
      }
      return { config: {} as never, origins: {}, layers: null };
    },
    async configBatchWrite() {
      return {
        status: "ok" as const,
        version: "1",
        filePath: "/tmp/config.toml",
        overriddenMetadata: null,
      };
    },
    async mcpServerReload() {
      return {};
    },
    async mcpServerStatusList() {
      return { data: [], nextCursor: null };
    },
    async mcpServerAuthStatusListViaCli() {
      return new Map();
    },
    async mcpServerOauthLogin() {
      return { authorizationUrl: "https://auth.example.com" };
    },
    async mcpServerToolCall() {
      return { content: [], structuredContent: null, isError: false };
    },
    async mcpResourceRead() {
      return { contents: [] };
    },
    async loginWithChatGPT() { return { loginId: 'test-login', authUrl: 'https://auth.openai.com/test' }; },
    async getAccount() { return { account: null, requiresOpenaiAuth: false }; },
    async cancelLogin() {},
    async logout() {},
    async skillsList(params) {
      calls.skillsListParams.push(params ?? {});
      return { data: [] };
    },
    async windowsSandboxSetupStart() {
      return { started: true };
    },
    async threadList(params) {
      calls.threadListParams.push(params ?? {});
      return { data: [], nextCursor: null };
    },
    async threadRead(params) {
      calls.threadReadParams.push(params);
      if (overrides.threadRead) {
        return overrides.threadRead(params);
      }
      return {
        thread: {
          id: 'thr_new',
          preview: '',
          modelProvider: 'openai',
          createdAt: 0,
          updatedAt: 0,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp',
          cliVersion: '0.0.0',
          source: 'appServer',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
      };
    },
    async threadSetName(params) {
      calls.threadSetNameParams.push(params);
      return {};
    },
    async threadArchive(params) {
      calls.threadArchiveParams.push(params);
      return {};
    },
    async threadUnarchive(params) {
      calls.threadUnarchiveParams.push(params);
      return {
        thread: {
          id: params.threadId,
          preview: '',
          modelProvider: 'openai',
          createdAt: 0,
          updatedAt: 0,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp',
          cliVersion: '0.0.0',
          source: 'appServer',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
      };
    },
  };

  return {
    client,
    calls,
    emit(notification: AppServerNotification) {
      if (!handler) {
        throw new Error("no subscriber attached");
      }

      handler(notification);
    },
    emitDisconnect(reason: string) {
      disconnectHandler?.(reason);
    },
  };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("condition not met");
}

async function flushUnhandledRejectionCheck(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createConfigReadResponseWithUserLayer(
  config: Record<string, unknown>,
): v2.ConfigReadResponse {
  return {
    config: {} as never,
    origins: {},
    layers: [
      {
        name: { type: "user", file: "/tmp/config.toml" },
        config,
        version: "1",
      } as any,
    ],
  };
}

describe("CodexService", () => {
  test("starts a turn and resolves on turn/completed", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);
    const observed: StreamEvent["kind"][] = [];

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      onEvent: (event) => observed.push(event.kind),
    });

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emit({
      method: SERVER_METHOD.itemStarted,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        item: { type: "userMessage", id: "item_1", content: [] },
      },
    });

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    const result = await run;
    assert.equal(result.threadId, "thr_new");
    assert.equal(result.turnId, "turn_1");
    assert.equal(result.status, "completed");
    assert.deepEqual(observed, [
      "thread",
      "turn",
      "notification",
      "notification",
    ]);
    assert.equal(fake.calls.startThread, 1);
    assert.deepEqual(fake.calls.startThreadWithConfigConfig[0], {
      shell_environment_policy: {
        set: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    });
  });

  test("absorbs same-task out-of-order blocking item completion after turn/completed", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);
    const observed: string[] = [];

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      onEvent: (event) => {
        if (event.kind === "notification") {
          observed.push(event.notification.method);
        }
      },
    });

    await waitFor(() => fake.calls.startTurn === 1);

    const commandItem = {
      type: "commandExecution" as const,
      id: "cmd_1",
      command: "interpreter-app tools builtin-media-ai run_media_model",
      cwd: "/tmp",
      processId: null,
      status: "inProgress" as const,
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };

    fake.emit({
      method: SERVER_METHOD.itemStarted,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        item: commandItem,
      },
    });

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    const completedCommandItem = {
      ...commandItem,
      status: "completed" as const,
      exitCode: 0,
      durationMs: 12,
      aggregatedOutput: "",
    };

    fake.emit({
      method: SERVER_METHOD.itemCompleted,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        item: completedCommandItem,
      },
    });

    const result = await run;
    assert.equal(result.threadId, "thr_new");
    assert.equal(result.turnId, "turn_1");
    assert.equal(result.status, "completed");
    assert.deepEqual(observed, [
      SERVER_METHOD.itemStarted,
      SERVER_METHOD.turnCompleted,
      SERVER_METHOD.itemCompleted,
    ]);
  });

  test("does not keep the thread blocked indefinitely after turn/completed when a blocking item never settles", async () => {
    let startTurnCount = 0;
    const fake = createFakeClient({
      async startTurn() {
        startTurnCount += 1;
        return createTurn(`turn_${startTurnCount}`);
      },
    });
    const service = new CodexService(fake.client);

    const firstRun = service.runTurn({
      threadId: "thr_existing",
      message: "first",
      model: "test-model",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emit({
      method: SERVER_METHOD.itemStarted,
      params: {
        threadId: "thr_existing",
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "interpreter-app tools builtin-media-ai run_media_model",
          cwd: "/tmp",
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    });

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    const firstResult = await firstRun;
    assert.equal(firstResult.status, "completed");
    assert.equal(firstResult.turnId, "turn_1");

    const secondRun = service.runTurn({
      threadId: "thr_existing",
      message: "second",
      model: "test-model",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 2);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_2", "completed"),
      },
    });

    const secondResult = await secondRun;
    assert.equal(secondResult.status, "completed");
    assert.equal(secondResult.turnId, "turn_2");
  });

  test("resolves with turn/completed if the runtime disconnects before a blocking command execution item settles", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emit({
      method: SERVER_METHOD.itemStarted,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "interpreter-app tools builtin-media-ai run_media_model",
          cwd: "/tmp",
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    });

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    fake.emitDisconnect("transport lost");

    const result = await run;
    assert.equal(result.threadId, "thr_new");
    assert.equal(result.turnId, "turn_1");
    assert.equal(result.status, "completed");
  });

  test("preserves a failed turn/completed status if the runtime disconnects before a blocking command execution item settles", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emit({
      method: SERVER_METHOD.itemStarted,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "interpreter-app tools builtin-media-ai run_media_model",
          cwd: "/tmp",
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    });

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "failed"),
      },
    });

    fake.emitDisconnect("transport lost");

    const result = await run;
    assert.equal(result.threadId, "thr_new");
    assert.equal(result.turnId, "turn_1");
    assert.equal(result.status, "failed");
  });

  test("allows turn/completed after a blocking command execution item completes", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);

    const commandItem = {
      type: "commandExecution" as const,
      id: "cmd_1",
      command: "interpreter-app tools builtin-media-ai run_media_model",
      cwd: "/tmp",
      processId: null,
      status: "inProgress" as const,
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };

    fake.emit({
      method: SERVER_METHOD.itemStarted,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        item: commandItem,
      },
    });

    fake.emit({
      method: SERVER_METHOD.itemCompleted,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        item: {
          ...commandItem,
          status: "completed",
          exitCode: 0,
          durationMs: 120,
        },
      },
    });

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    const result = await run;
    assert.equal(result.status, "completed");
  });

  test("forwards raw response item notifications for the active turn", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);
    const observed: string[] = [];

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      onEvent: (event) => {
        if (event.kind === "notification") {
          observed.push(event.notification.method);
        }
      },
    });

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emit({
      method: SERVER_METHOD.rawResponseItemCompleted,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        item: {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "js_repl",
          input: 'await page.goto("https://example.com");',
        },
      },
    });

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
    assert.deepEqual(observed, [
      SERVER_METHOD.rawResponseItemCompleted,
      SERVER_METHOD.turnCompleted,
    ]);
  });

  test("interrupts active turn on abort", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);
    const abortController = new AbortController();

    const runPromise = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      signal: abortController.signal,
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);

    abortController.abort();

    await waitFor(() => fake.calls.interruptTurn.length === 1);
    assert.deepEqual(fake.calls.interruptTurn, [
      { threadId: "thr_existing", turnId: "turn_1" },
    ]);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "interrupted"),
      },
    });

    const result = await runPromise;
    assert.equal(result.status, "interrupted");
  });

  test("rejects an overlapping turn on the same thread before starting another runtime turn", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const firstRun = service.runTurn({
      threadId: "thr_existing",
      message: "first",
      model: "test-model",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);

    await assert.rejects(
      service.runTurn({
        threadId: "thr_existing",
        message: "second",
        model: "test-model",
        idleTimeoutMs: 5,
        onEvent: () => {},
      }),
      /Interpreter is already responding in this thread\. Wait for turn turn_1 to finish before sending another message\./,
    );
    assert.equal(fake.calls.resumeThread, 1);
    assert.equal(fake.calls.startTurn, 1);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    const result = await firstRun;
    assert.equal(result.status, "completed");
  });

  test("rejects an overlapping turn while the first runtime turn is still starting", async () => {
    const pendingStart = deferred<v2.Turn>();
    const fake = createFakeClient({
      startTurn: () => pendingStart.promise,
    });
    const service = new CodexService(fake.client);
    const observed: StreamEvent["kind"][] = [];

    const firstRun = service.runTurn({
      threadId: "thr_existing",
      message: "first",
      model: "test-model",
      onEvent: (event) => observed.push(event.kind),
    });

    await waitFor(() => fake.calls.startTurn === 1);

    await assert.rejects(
      service.runTurn({
        threadId: "thr_existing",
        message: "second",
        model: "test-model",
        idleTimeoutMs: 5,
        onEvent: () => {},
      }),
      /Interpreter is already responding in this thread\. Wait for the current response to finish before sending another message\./,
    );
    assert.equal(fake.calls.startTurn, 1);

    pendingStart.resolve(createTurn("turn_1"));

    await waitFor(() => observed.includes("turn"));
    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    const result = await firstRun;
    assert.equal(result.status, "completed");
  });

  test("steers an active turn with the current turn id", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const turnId = await service.steer("thr_existing", {
      message: "follow up",
      turnId: "turn_1",
    });

    assert.equal(turnId, "turn_1");
    assert.deepEqual(fake.calls.steerTurn, [
      {
        threadId: "thr_existing",
        turnId: "turn_1",
        message: "follow up",
        attachments: undefined,
        skills: undefined,
      },
    ]);
  });

  test("retries steer once when the cached active turn id is stale", async () => {
    const fake = createFakeClient({
      async steerTurn(params) {
        if (params.turnId === "turn_old") {
          throw new JSONRPCErrorException(
            "expected active turn id `turn_old` but found `turn_new`",
            JSONRPCErrorCode.InvalidRequest,
          );
        }

        return { turnId: params.turnId };
      },
    });
    const service = new CodexService(fake.client);

    const turnId = await service.steer("thr_existing", {
      message: "follow up",
      turnId: "turn_old",
    });

    assert.equal(turnId, "turn_new");
    assert.equal(fake.calls.steerTurn.length, 2);
    assert.equal(fake.calls.steerTurn[0]?.turnId, "turn_old");
    assert.equal(fake.calls.steerTurn[1]?.turnId, "turn_new");
  });

  test("does not interrupt a settled turn when the abort signal fires later", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);
    const abortController = new AbortController();

    const runPromise = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      signal: abortController.signal,
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await runPromise;
    abortController.abort();
    await flushUnhandledRejectionCheck();

    assert.deepEqual(fake.calls.interruptTurn, []);
  });

  test("consumes abort interrupt failures instead of surfacing an unhandled rejection", async () => {
    const fake = createFakeClient();
    fake.client.interruptTurn = async (threadId: string, turnId: string) => {
      fake.calls.interruptTurn.push({ threadId, turnId });
      throw new Error("codex app-server exited (null): generic_exit");
    };

    const service = new CodexService(fake.client);
    const abortController = new AbortController();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const runPromise = service.runTurn({
        threadId: "thr_existing",
        message: "hello",
        model: "test-model",
        signal: abortController.signal,
        onEvent: () => {},
      });

      await waitFor(() => fake.calls.startTurn === 1);

      abortController.abort();

      await waitFor(() => fake.calls.interruptTurn.length === 1);
      await flushUnhandledRejectionCheck();

      assert.deepEqual(unhandledRejections, []);

      fake.emit({
        method: SERVER_METHOD.turnCompleted,
        params: {
          threadId: "thr_existing",
          turn: createTurn("turn_1", "interrupted"),
        },
      });

      const result = await runPromise;
      assert.equal(result.status, "interrupted");
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  test("rejects an active turn when the codex runtime disconnects", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const runPromise = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emitDisconnect("codex app-server exited (1073807364): provider overloaded");

    await assert.rejects(
      runPromise,
      /codex app-server exited \(1073807364\): provider overloaded/,
    );
  });

  test("does not treat a disconnect before turn start as a second failure path", async () => {
    let rejectStartTurn: ((error: Error) => void) | null = null;
    const fake = createFakeClient({
      startTurn: async () => {
        await new Promise<never>((_, reject) => {
          rejectStartTurn = (error) => reject(error);
        });
      },
    });
    const service = new CodexService(fake.client);

    const runPromise = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    fake.emitDisconnect("codex app-server exited (1): provider overloaded");
    rejectStartTurn?.(new Error("codex app-server exited (1): provider overloaded"));

    await assert.rejects(
      runPromise,
      /codex app-server exited \(1\): provider overloaded/,
    );
  });

  test("rejects and interrupts when an active turn goes idle without completion", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const runPromise = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      idleTimeoutMs: 50,
      onEvent: () => {},
    });

    const rejection = assert.rejects(
      runPromise,
      /Codex turn turn_1 went idle for 50ms after turn started without reaching turn\/completed\./,
    );

    await waitFor(() => fake.calls.startTurn === 1);
    await waitFor(() => fake.calls.interruptTurn.length === 1);
    await rejection;
    assert.deepEqual(fake.calls.interruptTurn, [
      { threadId: "thr_existing", turnId: "turn_1" },
    ]);
  });

  test("does not interrupt while a blocking MCP tool call is still in flight", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const runPromise = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      idleTimeoutMs: 5,
      onEvent: () => {},
    });
    const rejection = assert.rejects(
      runPromise,
      /Codex turn turn_1 went idle for 5ms after item\/completed:mcpToolCall without reaching turn\/completed\./,
    );

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emit({
      method: SERVER_METHOD.itemStarted,
      params: {
        threadId: "thr_existing",
        turnId: "turn_1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "builtin-media-ai",
          tool: "run_media_model",
          status: "inProgress",
          arguments: {},
          result: null,
          error: null,
          durationMs: null,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(fake.calls.interruptTurn, []);

    fake.emit({
      method: SERVER_METHOD.itemCompleted,
      params: {
        threadId: "thr_existing",
        turnId: "turn_1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "builtin-media-ai",
          tool: "run_media_model",
          status: "completed",
          arguments: {},
          result: null,
          error: null,
          durationMs: 20,
        },
      },
    });

    await waitFor(() => fake.calls.interruptTurn.length === 1);
    await rejection;
  });

  test("starts a fresh thread when resumeThread reports a stale thread", async () => {
    const fake = createFakeClient({
      async resumeThread() {
        throw new JSONRPCErrorException(
          "thread not found: 019d4faa-cc16-7c12-b5b2-97d3c7df8b8b",
          JSONRPCErrorCode.InvalidRequest,
        );
      },
    });
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.equal(fake.calls.resumeThread, 1);
    assert.equal(fake.calls.startThread, 1);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("rethrows non-stale resumeThread errors instead of starting a fresh thread", async () => {
    const fake = createFakeClient({
      async resumeThread() {
        throw new Error("codex app-server exited (1): generic_exit");
      },
    });
    const service = new CodexService(fake.client);

    await assert.rejects(
      service.runTurn({
        threadId: "thr_existing",
        message: "hello",
        model: "test-model",
        onEvent: () => {},
      }),
      /codex app-server exited \(1\): generic_exit/,
    );
    assert.equal(fake.calls.resumeThread, 1);
    assert.equal(fake.calls.startThread, 0);
    assert.equal(fake.calls.startTurn, 0);
  });

  test("passes modelProvider through to startThread", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      modelProvider: "interpreter",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.equal(fake.calls.startThreadModelProvider[0], "interpreter");

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("passes cwd through to startThread", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      cwd: "/workspace/demo",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.equal(fake.calls.startThreadCwd[0], "/workspace/demo");
    assert.equal(fake.calls.startTurnCwd[0], "/workspace/demo");

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("passes developerInstructions through to startThread", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      baseInstructions: "You are Interpreter.",
      developerInstructions: "Use interpreter-specific behavior.",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.equal(fake.calls.startThreadBaseInstructions[0], "You are Interpreter.");
    assert.equal(
      fake.calls.startThreadDeveloperInstructions[0],
      "Use interpreter-specific behavior.",
    );

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("passes modelProvider through to resumeThread", async () => {
    const fake = createFakeClient({
      async threadRead() {
        return {
          thread: {
            id: 'thr_existing',
            preview: '',
            modelProvider: 'custom',
            createdAt: 0,
            updatedAt: 0,
            status: { type: 'idle' },
            path: null,
            cwd: '/tmp',
            cliVersion: '0.0.0',
            source: 'appServer',
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
        };
      },
    });
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      modelProvider: "custom",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.equal(fake.calls.resumeThreadModelProvider[0], "custom");
    assert.equal(fake.calls.resumeThread, 1);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("passes model through to resumeThread for mid-thread provider switch", async () => {
    const fake = createFakeClient({
      async threadRead() {
        return {
          thread: {
            id: 'thr_existing',
            preview: '',
            modelProvider: 'interpreter',
            createdAt: 0,
            updatedAt: 0,
            status: { type: 'idle' },
            path: null,
            cwd: '/tmp',
            cliVersion: '0.0.0',
            source: 'appServer',
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
        };
      },
    });
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "interpreter-smart",
      modelProvider: "interpreter",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.equal(fake.calls.resumeThread, 1);
    assert.equal(fake.calls.resumeThreadModelProvider[0], "interpreter");
    assert.equal(fake.calls.resumeThreadModel[0], "interpreter-smart");

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("resumes the existing OIX thread when the runtime provider changes", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "interpreter-smart",
      modelProvider: "interpreter",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.equal(fake.calls.threadReadParams.length, 0);
    assert.equal(fake.calls.resumeThread, 1);
    assert.equal(fake.calls.resumeThreadModelProvider[0], "interpreter");
    assert.equal(fake.calls.resumeThreadModel[0], "interpreter-smart");
    assert.equal(fake.calls.startThread, 0);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("passes developerInstructions through to resumeThread", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      baseInstructions: "You are Interpreter.",
      developerInstructions: "Use interpreter-specific behavior.",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.equal(fake.calls.resumeThreadBaseInstructions[0], "You are Interpreter.");
    assert.equal(
      fake.calls.resumeThreadDeveloperInstructions[0],
      "Use interpreter-specific behavior.",
    );

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("passes config through to resumeThread", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      config: {
        shell_environment_policy: {
          inherit: "core",
          set: {
            INTERPRETER_CALLER_TOKEN: "agtok_test",
          },
        } as JsonValue,
      },
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.deepEqual(fake.calls.resumeThreadConfig[0], {
      shell_environment_policy: {
        inherit: "core",
        set: {
          ELECTRON_RUN_AS_NODE: "1",
          INTERPRETER_CALLER_TOKEN: "agtok_test",
        },
      },
    });

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("injects app-managed provider credentials into thread config without persisting them", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "gpt-5.4",
      modelProvider: "interpreter-app-openai-test",
      providerConfig: {
        base_url: "https://api.openai.com/v1",
        name: "OpenAI",
        requires_openai_auth: false,
        wire_api: "responses",
        experimental_bearer_token: "sk-test",
        http_headers: { Authorization: "Bearer sk-test" },
      },
      config: {
        mcp_servers: {},
      },
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.deepEqual(fake.calls.resumeThreadConfig[0], {
      mcp_servers: {},
      model_providers: {
        "interpreter-app-openai-test": {
          base_url: "https://api.openai.com/v1",
          name: "OpenAI",
          requires_openai_auth: false,
          wire_api: "responses",
          experimental_bearer_token: "sk-test",
          http_headers: { Authorization: "Bearer sk-test" },
        },
      },
      shell_environment_policy: {
        set: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    });
    assert.equal(fake.calls.configValueWrite.length, 0);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("passes cwd through to resumeThread", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const run = service.runTurn({
      threadId: "thr_existing",
      message: "hello",
      model: "test-model",
      cwd: "/workspace/next",
      onEvent: () => {},
    });

    await waitFor(() => fake.calls.startTurn === 1);
    assert.equal(fake.calls.resumeThreadCwd[0], "/workspace/next");
    assert.equal(fake.calls.startTurnCwd[0], "/workspace/next");

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_existing",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("fails fast when resumeThread fails instead of silently starting a new thread", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    await assert.rejects(
      service.runTurn({
        threadId: "missing",
        message: "hello",
        model: "test-model",
        onEvent: () => {},
      }),
      /missing thread/,
    );

    assert.equal(fake.calls.resumeThread, 1);
    assert.equal(fake.calls.startThread, 0);
    assert.equal(fake.calls.startThreadWithConfig, 0);
    assert.equal(fake.calls.startTurn, 0);
  });

  test("ensureProvider writes config on first call and skips on second", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const profile: Profile = {
      id: "interpreter",
      label: "Interpreter",
      modelProvider: "interpreter",
      providerConfig: {
        base_url: "https://example.com",
        name: "Interpreter",
        requires_openai_auth: false,
      },
    };

    await service.ensureProvider(profile);
    assert.equal(fake.calls.configValueWrite.length, 1);
    assert.equal(
      fake.calls.configValueWrite[0]?.keyPath,
      "model_providers.interpreter",
    );

    await service.ensureProvider(profile);
    assert.equal(fake.calls.configValueWrite.length, 1);
  });

  test("ensureProvider clears stale reserved local overrides before provisioning a local provider", async () => {
    const fake = createFakeClient({
      configRead: async () =>
        createConfigReadResponseWithUserLayer({
          model_providers: {
            ollama: { base_url: "http://localhost:11434/v1" },
            lmstudio: { base_url: "http://localhost:1234/v1" },
          },
        }),
    });
    const service = new CodexService(fake.client);

    const profile: Profile = {
      id: "ollama",
      label: "Ollama",
      modelProvider: "ollama-4f9d7d4a",
      providerConfig: {
        base_url: "http://localhost:11434/v1",
        name: "Ollama",
        requires_openai_auth: false,
        wire_api: "responses",
      },
    };

    await service.ensureProvider(profile, true);

    assert.deepEqual(fake.calls.configValueWrite, [
      {
        keyPath: "model_providers.ollama",
        value: null,
      },
      {
        keyPath: "model_providers.lmstudio",
        value: null,
      },
      {
        keyPath: "model_providers.ollama-4f9d7d4a",
        value: {
          base_url: "http://localhost:11434/v1",
          name: "Ollama",
          requires_openai_auth: false,
          wire_api: "responses",
        },
      },
    ]);
  });

  test("ensureProvider skips clearing missing reserved local overrides", async () => {
    const fake = createFakeClient({
      configRead: async () =>
        createConfigReadResponseWithUserLayer({
          model_providers: {
            "ollama-4f9d7d4a": {
              base_url: "http://localhost:11434/v1",
            },
          },
        }),
      configValueWrite: async (keyPath, value) => {
        if (
          value === null
          && (keyPath === "model_providers.ollama" || keyPath === "model_providers.lmstudio")
        ) {
          throw new Error("Path not found");
        }
      },
    });
    const service = new CodexService(fake.client);

    const profile: Profile = {
      id: "ollama",
      label: "Ollama",
      modelProvider: "ollama-4f9d7d4a",
      providerConfig: {
        base_url: "http://localhost:11434/v1",
        name: "Ollama",
        requires_openai_auth: false,
        wire_api: "responses",
      },
    };

    await service.ensureProvider(profile, true);

    assert.deepEqual(fake.calls.configValueWrite, [
      {
        keyPath: "model_providers.ollama-4f9d7d4a",
        value: {
          base_url: "http://localhost:11434/v1",
          name: "Ollama",
          requires_openai_auth: false,
          wire_api: "responses",
        },
      },
    ]);
  });

  test("ensureProvider skips clearing missing reserved local overrides for lmstudio", async () => {
    const fake = createFakeClient({
      configRead: async () =>
        createConfigReadResponseWithUserLayer({
          model_providers: {
            "lmstudio-2f7a8c1b": {
              base_url: "http://localhost:1234/v1",
            },
          },
        }),
      configValueWrite: async (keyPath, value) => {
        if (
          value === null
          && (keyPath === "model_providers.ollama" || keyPath === "model_providers.lmstudio")
        ) {
          throw new Error("Path not found");
        }
      },
    });
    const service = new CodexService(fake.client);

    const profile: Profile = {
      id: "lmstudio",
      label: "LM Studio",
      modelProvider: "lmstudio-2f7a8c1b",
      providerConfig: {
        base_url: "http://localhost:1234/v1",
        name: "LM Studio",
        requires_openai_auth: false,
        wire_api: "chat",
        experimental_bearer_token: "lm-studio",
        http_headers: { Authorization: "Bearer lm-studio" },
      },
    };

    await service.ensureProvider(profile, true);

    assert.deepEqual(fake.calls.configValueWrite, [
      {
        keyPath: "model_providers.lmstudio-2f7a8c1b",
        value: {
          base_url: "http://localhost:1234/v1",
          name: "LM Studio",
          requires_openai_auth: false,
          wire_api: "chat",
          experimental_bearer_token: "lm-studio",
          http_headers: { Authorization: "Bearer lm-studio" },
        },
      },
    ]);
  });

  test("ensureProvider rejects reserved built-in local provider IDs", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const profile: Profile = {
      id: "ollama",
      label: "Ollama",
      modelProvider: "ollama",
      providerConfig: {
        base_url: "http://localhost:11434/v1",
        name: "Ollama",
        requires_openai_auth: false,
        wire_api: "responses",
      },
    };

    await assert.rejects(
      service.ensureProvider(profile, true),
      /reserved built-in local provider id/i,
    );
    assert.equal(fake.calls.configValueWrite.length, 0);
  });

  test("ensureProvider writes default local profiles under non-reserved model_providers keys", async () => {
    const fake = createFakeClient({
      configRead: async () =>
        createConfigReadResponseWithUserLayer({
          model_providers: {
            ollama: { base_url: "http://localhost:11434/v1" },
            lmstudio: { base_url: "http://localhost:1234/v1" },
          },
        }),
    });
    const service = new CodexService(fake.client);
    const profiles: Profile[] = [];

    for (const presetId of ["ollama", "lmstudio"] as const) {
      const preset = getCustomPreset(presetId);
      assert.ok(preset, `${presetId} preset should exist`);

      const profile = buildProfileFromPreset(preset);
      assert.ok(profile.modelProvider);
      assert.notEqual(profile.modelProvider, presetId);
      profiles.push(profile);
      await service.ensureProvider(profile, true);
    }

    assert.equal(fake.calls.configValueWrite.length, 4);
    assert.equal(fake.calls.configValueWrite[0]?.keyPath, "model_providers.ollama");
    assert.equal(fake.calls.configValueWrite[1]?.keyPath, "model_providers.lmstudio");
    assert.equal(fake.calls.configValueWrite[2]?.keyPath, `model_providers.${profiles[0]?.modelProvider}`);
    assert.equal(fake.calls.configValueWrite[3]?.keyPath, `model_providers.${profiles[1]?.modelProvider}`);
  });

  test("forwards streamError notification to subscriber", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);
    const notifications: AppServerNotification[] = [];

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      onEvent: (event) => {
        if (event.kind === "notification") {
          notifications.push(event.notification);
        }
      },
    });

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emit({
      method: SERVER_METHOD.streamError,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        willRetry: true,
        error: {
          message: "transient failure",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    });

    await waitFor(() => notifications.length === 1);
    assert.equal(notifications[0]?.method, SERVER_METHOD.streamError);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("forwards tool delta notifications to subscriber", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);
    const methods: AppServerNotification["method"][] = [];

    const run = service.runTurn({
      message: "hello",
      model: "test-model",
      onEvent: (event) => {
        if (event.kind === "notification") {
          methods.push(event.notification.method);
        }
      },
    });

    await waitFor(() => fake.calls.startTurn === 1);

    fake.emit({
      method: SERVER_METHOD.commandExecutionOutputDelta,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        itemId: "cmd_1",
        delta: "stdout",
      },
    });

    fake.emit({
      method: SERVER_METHOD.fileChangeOutputDelta,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        itemId: "fc_1",
        delta: "applied",
      },
    });

    fake.emit({
      method: SERVER_METHOD.mcpToolCallProgress,
      params: {
        threadId: "thr_new",
        turnId: "turn_1",
        itemId: "mcp_1",
        message: "working",
      },
    });

    await waitFor(() => methods.length === 3);
    assert.deepEqual(methods, [
      SERVER_METHOD.commandExecutionOutputDelta,
      SERVER_METHOD.fileChangeOutputDelta,
      SERVER_METHOD.mcpToolCallProgress,
    ]);

    fake.emit({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_new",
        turn: createTurn("turn_1", "completed"),
      },
    });

    await run;
  });

  test("ensureProvider skips default profile with no provider config", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    const profile: Profile = {
      id: "default",
      label: "OpenAI",
      modelProvider: "openai",
    };

    await service.ensureProvider(profile);
    assert.equal(fake.calls.configValueWrite.length, 0);
  });

  test("THREAD_LIST_DEFAULTS has correct sourceKinds and modelProviders", () => {
    assert.deepEqual(THREAD_LIST_DEFAULTS.sourceKinds, ["vscode", "appServer"]);
    assert.deepEqual(THREAD_LIST_DEFAULTS.modelProviders, []);
    assert.equal(THREAD_LIST_DEFAULTS.sortKey, "updated_at");
    assert.equal(THREAD_LIST_DEFAULTS.archived, false);
  });

  test("should_pass_listThreads_params_to_client", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    await service.listThreads(THREAD_LIST_DEFAULTS);

    assert.equal(fake.calls.threadListParams.length, 1);
    assert.deepEqual(fake.calls.threadListParams[0]?.sourceKinds, ["vscode", "appServer"]);
    assert.deepEqual(fake.calls.threadListParams[0]?.modelProviders, []);
    assert.equal(fake.calls.threadListParams[0]?.sortKey, "updated_at");
    assert.equal(fake.calls.threadListParams[0]?.archived, false);
  });

  test("should_pass_readThread_params_to_client", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    await service.readThread("thr_123");

    assert.equal(fake.calls.threadReadParams.length, 1);
    assert.deepEqual(fake.calls.threadReadParams[0], { threadId: "thr_123", includeTurns: true });
  });

  test("should_pass_setThreadName_params_to_client", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    await service.setThreadName("thr_123", "Project Alpha");

    assert.deepEqual(fake.calls.threadSetNameParams, [
      { threadId: "thr_123", name: "Project Alpha" },
    ]);
  });

  test("should_pass_archiveThread_params_to_client", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    await service.archiveThread("thr_123");

    assert.deepEqual(fake.calls.threadArchiveParams, [
      { threadId: "thr_123" },
    ]);
  });

  test("should_pass_unarchiveThread_params_to_client", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    await service.unarchiveThread("thr_123");

    assert.deepEqual(fake.calls.threadUnarchiveParams, [
      { threadId: "thr_123" },
    ]);
  });

  test("does not preconnect before listThreads", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    await service.listThreads({});

    assert.equal(fake.calls.ensureConnected, 0);
  });

  test("does not preconnect before readThread", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    await service.readThread("thr_abc");

    assert.equal(fake.calls.ensureConnected, 0);
  });

  test("should_pass_listSkills_params_to_client", async () => {
    const fake = createFakeClient();
    const service = new CodexService(fake.client);

    await service.listSkills({ cwds: ["/tmp/project"], forceReload: true });

    assert.equal(fake.calls.skillsListParams.length, 1);
    assert.deepEqual(fake.calls.skillsListParams[0], {
      cwds: ["/tmp/project"],
      forceReload: true,
    });
  });
});
