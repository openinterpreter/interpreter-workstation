import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  assessCloseStderr,
  buildCodexSpawnEnv,
  CodexAppServerClient,
  CodexRuntimeDisconnectedError,
  ensureIsolatedCodexRuntimeCacheAccess,
  loadHydratedToolServersForBroadcast,
  mergeStartupStatusIntoToolServers,
  StdioJsonRpcTransport,
  type JsonRpcTransport,
  resolveDefaultCodexHome,
  getInterpreterCliSandboxReadableRoots,
  getInterpreterCliSandboxWritableRoots,
} from "@/lib/codex/app-server-client";
import type { AppServerNotification, ServerRequest } from "@/lib/codex/protocol";
import {
  CLIENT_METHOD,
  CLIENT_NOTIFICATION_METHOD,
  type RequestMap,
  SERVER_METHOD,
  SERVER_REQUEST_METHOD,
} from "@/lib/codex/protocol";
import type { InitializeResponse, v2 } from "@/schemas";
import {
  clearConfigCache,
  getMcpServer,
  setConfigOverride,
} from "../../../server/configStore";
import { setToolManager } from "../../../server/tools/toolManagerAccessor";

type SentRequest<M extends keyof RequestMap = keyof RequestMap> = {
  id: number;
  method: M;
  params: RequestMap[M]["params"];
};

type SentNotification = {
  method: typeof CLIENT_NOTIFICATION_METHOD.initialized;
};

type SentMessage = SentRequest | SentNotification;

type ServerResponse = {
  id: number;
  result: RequestMap[keyof RequestMap]["result"];
};

afterEach(() => {
  clearConfigCache();
});

beforeEach(() => {
  setConfigOverride({
    agents: {},
    mcpServers: {},
    globalDisabledTools: [],
  } as any);
  setToolManager({
    async listDisplayToolServers() {
      return [];
    },
  } as any);
});

type StreamErrorNotification = Extract<
  AppServerNotification,
  { method: typeof SERVER_METHOD.streamError }
>;

function makeThread(id: string): v2.Thread {
  return {
    id,
    preview: "",
    modelProvider: "openai",
    createdAt: 0,
    updatedAt: 0,
    path: null,
    cwd: "/tmp",
    cliVersion: "0.0.0",
    source: "appServer",
    gitInfo: null,
    turns: [],
  };
}

function makeThreadStartResponse(threadId: string): v2.ThreadStartResponse {
  return {
    thread: makeThread(threadId),
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    cwd: "/tmp",
    approvalPolicy: "never",
    sandbox: { type: "dangerFullAccess" },
    reasoningEffort: null,
  };
}

function makeThreadResumeResponse(threadId: string): v2.ThreadResumeResponse {
  return {
    thread: makeThread(threadId),
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp",
    approvalPolicy: "never",
    sandbox: { type: "dangerFullAccess" },
    reasoningEffort: null,
  };
}

function makeThreadForkResponse(threadId: string): v2.ThreadForkResponse {
  return {
    thread: makeThread(threadId),
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    reasoningEffort: null,
  };
}

function makeTurn(id: string, status: v2.TurnStatus = "inProgress"): v2.Turn {
  return { id, items: [], status, error: null };
}

function makeTurnStartResponse(turnId: string): v2.TurnStartResponse {
  return { turn: makeTurn(turnId) };
}

function workspaceWriteSandboxPolicy(
  networkAccess = false,
  allowTempAccess = true,
): v2.SandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess,
    excludeTmpdirEnvVar: !allowTempAccess,
    excludeSlashTmp: !allowTempAccess,
  };
}

function makeStreamErrorNotification(
  message: string,
  {
    additionalDetails = null,
    codexErrorInfo = null,
  }: {
    additionalDetails?: string | null;
    codexErrorInfo?: v2.CodexErrorInfo | null;
  } = {},
): StreamErrorNotification {
  return {
    method: SERVER_METHOD.streamError,
    params: {
      error: {
        message,
        codexErrorInfo,
        additionalDetails,
      },
      willRetry: false,
      threadId: "thr_1",
      turnId: "turn_1",
    },
  };
}

class FakeTransport implements JsonRpcTransport {
  private messageHandler: ((message: string) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;
  private started = false;
  private nextSendError: Error | null = null;
  private nextCliResult: { stdout: string; stderr?: string } = { stdout: "[]" };

  sent: SentMessage[] = [];
  cliRuns: string[][] = [];
  stderrSnapshot = "";

  async start() {
    this.started = true;
  }

  send(message: string) {
    if (!this.started) {
      throw new Error("transport not started");
    }
    if (this.nextSendError) {
      const error = this.nextSendError;
      this.nextSendError = null;
      throw error;
    }

    this.sent.push(JSON.parse(message) as SentMessage);
  }

  onMessage(handler: (message: string) => void) {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void) {
    this.closeHandler = handler;
  }

  stop() {}

  getStderrSnapshot() {
    return this.stderrSnapshot;
  }

  respond<M extends keyof RequestMap>(
    msg: SentRequest<M>,
    result: RequestMap[M]["result"],
  ) {
    this.emitRaw({ id: msg.id, result });
  }

  emitNotification(notification: AppServerNotification) {
    this.emitRaw(notification);
  }

  emitServerRequest(payload: {
    id: number | string;
    method: string;
    params: unknown;
  }) {
    this.emitRaw(payload);
  }

  emitRaw(payload: unknown) {
    if (!this.messageHandler) {
      throw new Error("message handler missing");
    }

    this.messageHandler(JSON.stringify(payload));
  }

  close(error?: Error) {
    this.closeHandler?.(error);
  }

  failNextSend(error: Error) {
    this.nextSendError = error;
  }

  setNextCliResult(result: { stdout: string; stderr?: string }) {
    this.nextCliResult = result;
  }

  async runCodexCli(args: string[]) {
    this.cliRuns.push(args);
    return {
      stdout: this.nextCliResult.stdout,
      stderr: this.nextCliResult.stderr ?? "",
    };
  }
}

function assertSentRequest<M extends keyof RequestMap>(
  transport: FakeTransport,
  index: number,
  method: M,
): SentRequest<M> {
  const msg = transport.sent[index];
  assert.ok(msg, `No message at index ${index}`);
  assert.ok("id" in msg, `Message at index ${index} is not a request`);
  assert.equal(msg.method, method);
  return msg as SentRequest<M>;
}

function assertSentNotification(
  transport: FakeTransport,
  index: number,
  method: typeof CLIENT_NOTIFICATION_METHOD.initialized,
) {
  const msg = transport.sent[index];
  assert.ok(msg, `No message at index ${index}`);
  assert.ok(!("id" in msg), `Message at index ${index} is not a notification`);
  assert.equal(msg.method, method);
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

async function waitForAsync(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("condition not met");
}

function completeInitHandshake(transport: FakeTransport) {
  const initReq = assertSentRequest(transport, 0, CLIENT_METHOD.initialize);
  const response: InitializeResponse = { userAgent: "codex-test" };
  transport.respond(initReq, response);
}

describe("CodexAppServerClient", () => {
  test("uses stdio transport handshake and typed methods", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      codexApprovalPolicy: "never",
      codexSandboxMode: "workspace-write",
      codexNetworkAccess: false,
    });

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const notifications: AppServerNotification["method"][] = [];

    client.subscribe((notification) => {
      notifications.push(notification.method);
    });

    const threadPromise = client.startThread("gpt-5.3-codex");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 2);
    assertSentNotification(
      transport,
      1,
      CLIENT_NOTIFICATION_METHOD.initialized,
    );

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadStart,
    );
    assert.equal(threadReq.params.sandbox, "workspace-write");
    transport.respond(threadReq, makeThreadStartResponse("thr_1"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_1");

    const turnPromise = client.startTurn({
      threadId,
      message: "hello",
      skills: [
        {
          id: "project:skill-creator:/workspace/current/.agents/skills/skill-creator/SKILL.md",
          label: "Skill Creator",
          name: "skill-creator",
          path: "/workspace/current/.agents/skills/skill-creator/SKILL.md",
        },
      ],
      cwd: "/workspace/current",
    });

    await waitFor(() => transport.sent.length >= 4);
    const turnReq = assertSentRequest(transport, 3, CLIENT_METHOD.turnStart);
    assert.equal(turnReq.params.cwd, "/workspace/current");
    assert.deepEqual(turnReq.params.sandboxPolicy, workspaceWriteSandboxPolicy());
    assert.deepEqual(turnReq.params.input, [
      {
        type: "text",
        text: "hello",
        text_elements: [],
      },
      {
        type: "skill",
        name: "skill-creator",
        path: "/workspace/current/.agents/skills/skill-creator/SKILL.md",
      },
    ]);
    transport.respond(turnReq, makeTurnStartResponse("turn_1"));
    transport.emitNotification({
      method: SERVER_METHOD.agentMessageDelta,
      params: {
        threadId,
        turnId: "turn_1",
        itemId: "item_1",
        delta: "a",
      },
    });

    const turn = await turnPromise;
    assert.equal(turn.id, "turn_1");
    assert.equal(notifications.includes(SERVER_METHOD.agentMessageDelta), true);
  });

  test("starts hidden MCP tool threads without clearing MCP servers", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      codexApprovalPolicy: "never",
      codexSandboxMode: "workspace-write",
      codexNetworkAccess: true,
    });

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startMcpToolThread({
      model: "interpreter-smart",
      modelProvider: "interpreter",
      cwd: "/workspace/current",
    });

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await waitFor(() => transport.sent.length >= 3);

    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadStart,
    );
    assert.equal(threadReq.params.model, "interpreter-smart");
    assert.equal(threadReq.params.modelProvider, "interpreter");
    assert.equal(threadReq.params.cwd, "/workspace/current");
    assert.equal(threadReq.params.ephemeral, true);
    assert.equal("experimentalRawEvents" in threadReq.params, false);
    assert.equal("persistExtendedHistory" in threadReq.params, false);
    assert.deepEqual(threadReq.params.config, {
      include_apply_patch_tool: false,
      include_permissions_instructions: false,
      mcp_servers: {},
    });

    transport.respond(threadReq, makeThreadStartResponse("thr_mcp"));
    assert.equal(await threadPromise, "thr_mcp");
  });

  test("uses danger-full-access per turn when app config requests it", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      codexApprovalPolicy: "never",
      codexSandboxMode: "danger-full-access",
      codexNetworkAccess: true,
    });

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThread("gpt-5.4-mini");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await waitFor(() => transport.sent.length >= 3);

    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadStart,
    );
    transport.respond(threadReq, makeThreadStartResponse("thr_danger"));
    const threadId = await threadPromise;

    const turnPromise = client.startTurn({
      threadId,
      message: "hello",
      cwd: "/workspace/current",
    });

    await waitFor(() => transport.sent.length >= 4);
    const turnReq = assertSentRequest(transport, 3, CLIENT_METHOD.turnStart);
    assert.deepEqual(turnReq.params.sandboxPolicy, { type: "dangerFullAccess" });

    transport.respond(turnReq, makeTurnStartResponse("turn_danger"));
    const turn = await turnPromise;
    assert.equal(turn.id, "turn_danger");
  });

  test("updates workspace-write cwd on later turns", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      codexApprovalPolicy: "never",
      codexSandboxMode: "workspace-write",
      codexNetworkAccess: false,
    });

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThread("gpt-5.4-mini", null, null, "/workspace/first");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await waitFor(() => transport.sent.length >= 3);

    const threadReq = assertSentRequest(transport, 2, CLIENT_METHOD.threadStart);
    assert.equal(threadReq.params.cwd, "/workspace/first");
    transport.respond(threadReq, makeThreadStartResponse("thr_workspace"));
    const threadId = await threadPromise;

    const firstTurnPromise = client.startTurn({
      threadId,
      message: "first",
      cwd: "/workspace/first",
    });

    await waitFor(() => transport.sent.length >= 4);
    const firstTurnReq = assertSentRequest(transport, 3, CLIENT_METHOD.turnStart);
    assert.equal(firstTurnReq.params.cwd, "/workspace/first");
    assert.deepEqual(firstTurnReq.params.sandboxPolicy, workspaceWriteSandboxPolicy());
    transport.respond(firstTurnReq, makeTurnStartResponse("turn_workspace_1"));
    await firstTurnPromise;

    const secondTurnPromise = client.startTurn({
      threadId,
      message: "second",
      cwd: "/workspace/second",
    });

    await waitFor(() => transport.sent.length >= 5);
    const secondTurnReq = assertSentRequest(transport, 4, CLIENT_METHOD.turnStart);
    assert.equal(secondTurnReq.params.cwd, "/workspace/second");
    assert.deepEqual(secondTurnReq.params.sandboxPolicy, workspaceWriteSandboxPolicy());
    transport.respond(secondTurnReq, makeTurnStartResponse("turn_workspace_2"));

    const secondTurn = await secondTurnPromise;
    assert.equal(secondTurn.id, "turn_workspace_2");
  });

  test("enforces workspace-only reads through an OIX permission profile", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      codexApprovalPolicy: "never",
      codexSandboxMode: "workspace-write",
      codexReadAccessMode: "workspace-only",
      codexNetworkAccess: false,
    });

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThread("gpt-5.4-mini", null, null, "/workspace/current");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await waitFor(() => transport.sent.length >= 3);

    const threadReq = assertSentRequest(transport, 2, CLIENT_METHOD.threadStart);
    const scopedThreadParams = threadReq.params as typeof threadReq.params & {
      permissions?: string;
      runtimeWorkspaceRoots?: string[];
    };
    assert.equal(scopedThreadParams.sandbox, undefined);
    assert.equal(scopedThreadParams.permissions, "interpreter-workspace-scope");
    assert.deepEqual(scopedThreadParams.runtimeWorkspaceRoots, ["/workspace/current"]);
    assert.deepEqual(scopedThreadParams.config?.permissions, {
      "interpreter-workspace-scope": {
        filesystem: {
          ":minimal": "read",
          ":workspace_roots": {
            ".": "write",
          },
          ":tmpdir": "write",
          [getInterpreterCliSandboxReadableRoots()[0]!]: "read",
          [getInterpreterCliSandboxWritableRoots()[0]!]: "write",
        },
        network: {
          enabled: false,
        },
      },
    });
    transport.respond(threadReq, makeThreadStartResponse("thr_scoped"));
    const threadId = await threadPromise;

    const turnPromise = client.startTurn({
      threadId,
      message: "hello",
      cwd: "/workspace/current",
    });

    await waitFor(() => transport.sent.length >= 4);
    const turnReq = assertSentRequest(transport, 3, CLIENT_METHOD.turnStart);
    const scopedTurnParams = turnReq.params as typeof turnReq.params & {
      permissions?: string;
      runtimeWorkspaceRoots?: string[];
    };
    assert.equal(scopedTurnParams.sandboxPolicy, undefined);
    assert.equal(scopedTurnParams.permissions, undefined);
    assert.deepEqual(scopedTurnParams.runtimeWorkspaceRoots, ["/workspace/current"]);

    transport.respond(turnReq, makeTurnStartResponse("turn_scoped"));
    const turn = await turnPromise;
    assert.equal(turn.id, "turn_scoped");
  });

  test("applies the macOS-only temp restriction while keeping screenshot scope workspace-bounded", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      codexApprovalPolicy: "never",
      codexSandboxMode: "workspace-write",
      codexReadAccessMode: "workspace-only",
      codexNetworkAccess: false,
      codexMacosTempAccess: false,
      codexMacosScreenshotAccess: true,
    });

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThread("gpt-5.4-mini", null, null, "/workspace/current");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await waitFor(() => transport.sent.length >= 3);

    const threadReq = assertSentRequest(transport, 2, CLIENT_METHOD.threadStart);
    const scopedThreadParams = threadReq.params as typeof threadReq.params & {
      permissions?: string;
      runtimeWorkspaceRoots?: string[];
    };
    assert.equal(scopedThreadParams.permissions, "interpreter-workspace-scope");
    const expectedFilesystem = {
      ":minimal": "read",
      ":workspace_roots": {
        ".": "write",
      },
      // codexMacosTempAccess is intentionally a macOS-only setting. Linux and
      // Windows retain the runtime's normal temporary-directory access.
      ...(process.platform === "darwin" ? {} : { ":tmpdir": "write" }),
      [getInterpreterCliSandboxReadableRoots()[0]!]: "read",
      [getInterpreterCliSandboxWritableRoots()[0]!]: "write",
    };
    assert.deepEqual(scopedThreadParams.config?.permissions, {
      "interpreter-workspace-scope": {
        filesystem: expectedFilesystem,
        network: {
          enabled: false,
        },
      },
    });
    transport.respond(threadReq, makeThreadStartResponse("thr_screenshot_only"));
    const threadId = await threadPromise;

    const turnPromise = client.startTurn({
      threadId,
      message: "hello",
      cwd: "/workspace/current",
    });

    await waitFor(() => transport.sent.length >= 4);
    const turnReq = assertSentRequest(transport, 3, CLIENT_METHOD.turnStart);
    const scopedTurnParams = turnReq.params as typeof turnReq.params & {
      permissions?: string;
      runtimeWorkspaceRoots?: string[];
    };
    assert.equal(scopedTurnParams.sandboxPolicy, undefined);
    assert.equal(scopedTurnParams.permissions, undefined);
    assert.deepEqual(scopedTurnParams.runtimeWorkspaceRoots, ["/workspace/current"]);

    transport.respond(turnReq, makeTurnStartResponse("turn_screenshot_only"));
    const turn = await turnPromise;
    assert.equal(turn.id, "turn_screenshot_only");
  });

  test("uses an explicit per-turn sandbox policy override when provided", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      codexApprovalPolicy: "never",
      codexSandboxMode: "danger-full-access",
      codexReadAccessMode: "full-system",
      codexNetworkAccess: true,
    });

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const sandboxPolicyOverride: v2.SandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: ["/workspace/docx.docx.ooxml"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };

    const threadPromise = client.startThread("gpt-5.4-mini", null, null, "/workspace/docx.docx.ooxml");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await waitFor(() => transport.sent.length >= 3);

    const threadReq = assertSentRequest(transport, 2, CLIENT_METHOD.threadStart);
    transport.respond(threadReq, makeThreadStartResponse("thr_override"));
    const threadId = await threadPromise;

    const turnPromise = client.startTurn({
      threadId,
      message: "edit the xml",
      cwd: "/workspace/docx.docx.ooxml",
      sandboxPolicy: sandboxPolicyOverride,
    });

    await waitFor(() => transport.sent.length >= 4);
    const turnReq = assertSentRequest(transport, 3, CLIENT_METHOD.turnStart);
    assert.deepEqual(turnReq.params.sandboxPolicy, sandboxPolicyOverride);

    transport.respond(turnReq, makeTurnStartResponse("turn_override"));
    const turn = await turnPromise;
    assert.equal(turn.id, "turn_override");
  });

  test("reloads runtime access snapshot for later turns", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      codexApprovalPolicy: "on-request",
      codexSandboxMode: "workspace-write",
      codexReadAccessMode: "workspace-only",
      codexNetworkAccess: false,
    });

    let runtimeAccess = {
      sandboxMode: "workspace-write" as const,
      readAccessMode: "workspace-only" as const,
      networkAccess: false,
      macosTempAccess: false,
      macosScreenshotAccess: false,
    };

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null, async () => runtimeAccess);

    const threadPromise = client.startThread("gpt-5.4-mini", null, null, "/workspace/current");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await waitFor(() => transport.sent.length >= 3);

    const threadReq = assertSentRequest(transport, 2, CLIENT_METHOD.threadStart);
    const scopedThreadParams = threadReq.params as typeof threadReq.params & {
      permissions?: string;
      runtimeWorkspaceRoots?: string[];
    };
    assert.equal(scopedThreadParams.sandbox, undefined);
    assert.equal(scopedThreadParams.permissions, "interpreter-workspace-scope");
    assert.deepEqual(scopedThreadParams.runtimeWorkspaceRoots, ["/workspace/current"]);
    transport.respond(threadReq, makeThreadStartResponse("thr_runtime_reload"));
    const threadId = await threadPromise;

    runtimeAccess = {
      sandboxMode: "read-only",
      readAccessMode: "full-system",
      networkAccess: true,
      macosTempAccess: true,
      macosScreenshotAccess: true,
    };

    const turnPromise = client.startTurn({
      threadId,
      message: "hello",
      cwd: "/workspace/current",
    });

    await waitFor(() => transport.sent.length >= 4);
    const turnReq = assertSentRequest(transport, 3, CLIENT_METHOD.turnStart);
    assert.deepEqual(turnReq.params.sandboxPolicy, {
      type: "readOnly",
      networkAccess: true,
    });

    transport.respond(turnReq, makeTurnStartResponse("turn_runtime_reload"));
    const turn = await turnPromise;
    assert.equal(turn.id, "turn_runtime_reload");
  });

  test("adds oo-editors converter path for Windows app-server process", () => {
    const env = buildCodexSpawnEnv({
      baseEnv: {
        Path: "C:\\Windows\\System32",
        USERPROFILE: "C:\\Users\\Alice",
        HOMEDRIVE: "C:",
        HOMEPATH: "\\Users\\Alice",
      },
      codeHome: "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home",
      codexBinary: "C:\\Program Files\\Interpreter\\resources\\codex.exe",
      platform: "win32",
      pathExists: (candidatePath) => candidatePath.includes("converter"),
    });

    assert.equal(env.CODEX_HOME, "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home");
    assert.equal(env.INTERPRETER_HOME, "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home");
    assert.equal(env.OPEN_INTERPRETER_HOME, "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home");
    assert.equal(env.INTERPRETER_DISABLE_SYSTEM_IMPORT, "1");
    assert.equal(env.HOME, "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home\\home");
    assert.equal(env.USERPROFILE, "C:\\Users\\Alice");
    assert.equal(env.HOMEDRIVE, "C:");
    assert.equal(env.HOMEPATH, "\\Users\\Alice");
    assert.equal(
      env.Path,
      "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\oo-editors\\converter;C:\\Windows\\System32",
    );
  });

  test("backfills Windows profile env from isolated home when missing", () => {
    const env = buildCodexSpawnEnv({
      baseEnv: { Path: "C:\\Windows\\System32" },
      codeHome: "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home",
      codexBinary: "C:\\Program Files\\Interpreter\\resources\\codex.exe",
      platform: "win32",
      pathExists: () => false,
    });

    assert.equal(env.USERPROFILE, "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home\\home");
    assert.equal(env.HOMEDRIVE, "C:");
    assert.equal(env.HOMEPATH, "\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home\\home");
  });

  test("normalizes duplicate Windows path keys before spawning app-server", () => {
    const env = buildCodexSpawnEnv({
      baseEnv: {
        Path: "C:\\Users\\Alice\\bin",
        PATH: "C:\\Windows\\System32",
      },
      codeHome: "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home",
      codexBinary: "C:\\Program Files\\Interpreter\\resources\\codex.exe",
      platform: "win32",
      pathExists: (candidatePath) => candidatePath.includes("converter")
        || candidatePath.includes("Program Files\\Interpreter\\resources"),
    });

    assert.equal(env.PATH, undefined);
    assert.equal(
      env.Path,
      "C:\\Program Files\\Interpreter\\resources;C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\oo-editors\\converter;C:\\Users\\Alice\\bin;C:\\Windows\\System32",
    );
  });

  test("canonicalizes Windows path key casing before spawning app-server", () => {
    const env = buildCodexSpawnEnv({
      baseEnv: {
        PATH: "C:\\Windows\\System32",
      },
      codeHome: "C:\\Users\\Alice\\AppData\\Roaming\\interpreter\\codex-home",
      codexBinary: "C:\\Program Files\\Interpreter\\resources\\codex.exe",
      platform: "win32",
      pathExists: () => false,
    });

    assert.equal(env.PATH, undefined);
    assert.equal(env.Path, "C:\\Windows\\System32");
  });

  test("does not mutate PATH for non-Windows app-server process", () => {
    const env = buildCodexSpawnEnv({
      baseEnv: { PATH: "/usr/bin:/bin", NODE_V8_COVERAGE: "/tmp/cov" },
      codeHome: "/Users/alice/Library/Application Support/interpreter/codex-home",
      codexBinary: "/Applications/Interpreter.app/Contents/Resources/codex",
      platform: "darwin",
      pathExists: () => true,
    });

    assert.equal(
      env.CODEX_HOME,
      "/Users/alice/Library/Application Support/interpreter/codex-home",
    );
    assert.equal(
      env.INTERPRETER_HOME,
      "/Users/alice/Library/Application Support/interpreter/codex-home",
    );
    assert.equal(
      env.OPEN_INTERPRETER_HOME,
      "/Users/alice/Library/Application Support/interpreter/codex-home",
    );
    assert.equal(env.INTERPRETER_DISABLE_SYSTEM_IMPORT, "1");
    assert.equal(
      env.HOME,
      "/Users/alice/Library/Application Support/interpreter/codex-home/home",
    );
    assert.equal(env.PATH, "/usr/bin:/bin");
    assert.equal(env.NODE_V8_COVERAGE, undefined);
  });

  test("lists MCP auth status through interpreter CLI JSON output", async () => {
    const transport = new FakeTransport();
    transport.setNextCliResult({
      stdout: `noise before json
[
  { "name": "docs", "enabled": true, "auth_status": "oauth" },
  { "name": "legacy", "enabled": true, "auth_status": "o_auth" },
  { "name": "disabled", "enabled": false, "auth_status": "bearer_token" },
  { "name": "unknown", "enabled": true, "auth_status": "future_status" }
]`,
    });
    const client = new CodexAppServerClient(transport, null);

    const authStatuses = await client.mcpServerAuthStatusListViaCli();

    assert.deepEqual(transport.cliRuns, [["mcp", "list", "--json"]]);
    assert.deepEqual(Array.from(authStatuses.entries()), [
      ["docs", "oAuth"],
      ["legacy", "oAuth"],
    ]);
  });

  test("logs out MCP servers through interpreter CLI", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    await client.mcpServerLogoutViaCli("docs");

    assert.deepEqual(transport.cliRuns, [["mcp", "logout", "docs"]]);
  });

  test("links the isolated codex home to the host codex runtime cache when present", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-cache-link-"));
    const hostHome = path.join(tempRoot, "host-home");
    const isolatedHome = path.join(tempRoot, "isolated-home");
    const hostRuntimeCacheRoot = path.join(hostHome, ".cache", "codex-runtimes");
    await mkdir(path.join(hostRuntimeCacheRoot, "codex-primary-runtime"), { recursive: true });
    await writeFile(path.join(hostRuntimeCacheRoot, "codex-primary-runtime", "sentinel.txt"), "ok");

    ensureIsolatedCodexRuntimeCacheAccess(isolatedHome, {
      hostHome,
      platform: "darwin",
    });

    const linkedRuntimeCacheRoot = path.join(isolatedHome, ".cache", "codex-runtimes");
    assert.equal(lstatSync(linkedRuntimeCacheRoot).isSymbolicLink(), true);
    assert.equal(
      path.resolve(path.dirname(linkedRuntimeCacheRoot), readlinkSync(linkedRuntimeCacheRoot)),
      hostRuntimeCacheRoot,
    );
  });

  test("resolves the shared Open Interpreter home on macOS", () => {
    assert.equal(
      resolveDefaultCodexHome("darwin", {}, "/Users/alice"),
      "/Users/alice/.openinterpreter",
    );
  });

  test("resolves the shared home from INTERPRETER_HOME and ignores CODEX_HOME", () => {
    assert.equal(
      resolveDefaultCodexHome("darwin", {
        CODEX_HOME: "/tmp/legacy-codex-home",
        INTERPRETER_HOME: "/tmp/explicit-interpreter-home",
      }, "/Users/alice"),
      "/tmp/explicit-interpreter-home",
    );
    assert.equal(
      resolveDefaultCodexHome("darwin", { CODEX_HOME: "/tmp/legacy-codex-home" }, "/Users/alice"),
      "/Users/alice/.openinterpreter",
    );
  });

  test("resolves the shared Open Interpreter home on Windows", () => {
    assert.equal(
      resolveDefaultCodexHome("win32", {
        USERPROFILE: "C:\\Users\\Alice",
      }, "C:\\Users\\Alice"),
      "C:\\Users\\Alice\\.openinterpreter",
    );
  });

  test("resolves the shared Open Interpreter home on Linux", () => {
    assert.equal(
      resolveDefaultCodexHome("linux", {
        XDG_CONFIG_HOME: "/home/alice/.config",
      }, "/home/alice"),
      "/home/alice/.openinterpreter",
    );
  });

  test("copies missing legacy app runtime state into the shared home without deleting the source", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "interpreter-home-migration-"));
    const userDataDir = path.join(tempRoot, "app-data");
    const interpreterHome = path.join(tempRoot, ".openinterpreter");
    const legacyHome = path.join(userDataDir, "codex-home");
    const originalInterpreterHome = process.env.INTERPRETER_HOME;
    const originalUserDataDir = process.env.INTERPRETER_USER_DATA_DIR;

    try {
      process.env.INTERPRETER_HOME = interpreterHome;
      process.env.INTERPRETER_USER_DATA_DIR = userDataDir;
      await mkdir(legacyHome, { recursive: true });
      await writeFile(path.join(legacyHome, "legacy-state.txt"), "preserved legacy state", "utf8");

      const transport = new StdioJsonRpcTransport(() => {
        throw new Error("spawn is not expected while resolving the runtime home");
      });
      assert.equal(await (transport as any).resolveCodexHome(), interpreterHome);
      assert.equal(
        await readFile(path.join(interpreterHome, "legacy-state.txt"), "utf8"),
        "preserved legacy state",
      );
      assert.equal(await readFile(path.join(legacyHome, "legacy-state.txt"), "utf8"), "preserved legacy state");
      assert.equal(existsSync(path.join(interpreterHome, ".workstation-runtime-home-migrated-v1")), true);
    } finally {
      if (originalInterpreterHome === undefined) delete process.env.INTERPRETER_HOME;
      else process.env.INTERPRETER_HOME = originalInterpreterHome;
      if (originalUserDataDir === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
      else process.env.INTERPRETER_USER_DATA_DIR = originalUserDataDir;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects pending requests when process closes", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const promise = client.startThread("gpt-5.3-codex");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    assertSentRequest(transport, 2, CLIENT_METHOD.threadStart);

    transport.close(new Error("stdio closed"));

    await assert.rejects(promise, /stdio closed/);
  });

  test("logs in with api key when configured", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, "sk-test");

    const threadPromise = client.startThread("gpt-5.3-codex");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 2);
    await waitFor(() => transport.sent.length >= 3);
    const loginReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.accountLoginStart,
    );
    const loginResponse: v2.LoginAccountResponse = { type: "apiKey" };
    transport.respond(loginReq, loginResponse);

    await waitFor(() => transport.sent.length >= 4);
    const threadReq = assertSentRequest(
      transport,
      3,
      CLIENT_METHOD.threadStart,
    );
    transport.respond(threadReq, makeThreadStartResponse("thr_1"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_1");
  });

  test("does not infer api key auth from process env by default", async () => {
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    const originalOpenAiKey = process.env.OPENAI_KEY;
    process.env.OPENAI_API_KEY = "sk-env-test";
    process.env.OPENAI_KEY = "sk-env-legacy-test";

    try {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(transport);

      const threadPromise = client.startThread("gpt-5.3-codex");

      await waitFor(() => transport.sent.length >= 1);
      completeInitHandshake(transport);

      await waitFor(() => transport.sent.length >= 3);
      const threadReq = assertSentRequest(
        transport,
        2,
        CLIENT_METHOD.threadStart,
      );
      transport.respond(threadReq, makeThreadStartResponse("thr_1"));

      const threadId = await threadPromise;
      assert.equal(threadId, "thr_1");
      assert.equal(
        transport.sent.some(
          (message) =>
            "id" in message && message.method === CLIENT_METHOD.accountLoginStart,
        ),
        false,
      );
    } finally {
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      }

      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_KEY;
      } else {
        process.env.OPENAI_KEY = originalOpenAiKey;
      }
    }
  });

  test("loginWithChatGPT sends chatgpt type and returns loginId and authUrl", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const loginPromise = client.loginWithChatGPT();

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const loginReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.accountLoginStart,
    );
    assert.deepEqual(loginReq.params, { type: "chatgpt" });

    const loginResponse: v2.LoginAccountResponse = {
      type: "chatgpt",
      loginId: "lid_1",
      authUrl: "https://auth.openai.com/authorize?foo=bar",
    };
    transport.respond(loginReq, loginResponse);

    const result = await loginPromise;
    assert.equal(result.loginId, "lid_1");
    assert.equal(result.authUrl, "https://auth.openai.com/authorize?foo=bar");
  });

  test("startThread passes modelProvider to thread/start params", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThread("gpt-5.3-codex", "interpreter");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadStart,
    );
    assert.equal(threadReq.params.modelProvider, "interpreter");

    transport.respond(threadReq, makeThreadStartResponse("thr_1"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_1");
  });

  test("startThread passes baseInstructions to thread/start params", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThread(
      "gpt-5.3-codex",
      "openai",
      "You are a helpful assistant.",
    );

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadStart,
    );
    assert.equal(threadReq.params.baseInstructions, "You are a helpful assistant.");

    transport.respond(threadReq, makeThreadStartResponse("thr_1"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_1");
  });

  test("startThread passes developerInstructions to thread/start params", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThread(
      "gpt-5.3-codex",
      "openai",
      undefined,
      undefined,
      "Use interpreter-specific behavior.",
    );

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadStart,
    );
    assert.equal(
      threadReq.params.developerInstructions,
      "Use interpreter-specific behavior.",
    );

    transport.respond(threadReq, makeThreadStartResponse("thr_1"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_1");
  });

  test("startThread passes cwd to thread/start params", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThread(
      "gpt-5.3-codex",
      "openai",
      "You are a helpful assistant.",
      "/workspace/project",
    );

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadStart,
    );
    assert.equal(threadReq.params.cwd, "/workspace/project");

    transport.respond(threadReq, makeThreadStartResponse("thr_1"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_1");
  });

  test("startThread omits baseInstructions when not provided", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThread("gpt-5.3-codex");

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadStart,
    );
    assert.equal(threadReq.params.baseInstructions, undefined);
    assert.deepEqual(threadReq.params.config, {
      include_apply_patch_tool: true,
      include_permissions_instructions: false,
      mcp_servers: {},
    });

    transport.respond(threadReq, makeThreadStartResponse("thr_1"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_1");
  });

  test("startThreadWithConfig strips eager MCP tool metadata from thread config", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.startThreadWithConfig(
      "gpt-5.3-codex",
      null,
      null,
      "/workspace/project",
      {
        mcp_servers: {
          installedDocsServer: {
            url: "https://tools.example.com/mcp",
            tools: [
              {
                name: "issue_942_huge_doc_tool",
                description: "ISSUE_942_THREAD_CONFIG_TOOL_DESCRIPTION_SHOULD_NOT_REACH_MODEL",
              },
            ],
          },
        },
        shell_environment_policy: {
          inherit: "core",
          set: {
            INTERPRETER_CALLER_TOKEN: "agtok_thread_config",
          },
        },
      },
    );

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadStart,
    );
    const serializedConfig = JSON.stringify(threadReq.params.config);

    assert.deepEqual(threadReq.params.config, {
      include_apply_patch_tool: true,
      include_permissions_instructions: false,
      shell_environment_policy: {
        inherit: "core",
        set: {
          INTERPRETER_CALLER_TOKEN: "agtok_thread_config",
        },
      },
      mcp_servers: {},
    });
    assert.equal(serializedConfig.includes("issue_942_huge_doc_tool"), false);
    assert.equal(
      serializedConfig.includes("ISSUE_942_THREAD_CONFIG_TOOL_DESCRIPTION_SHOULD_NOT_REACH_MODEL"),
      false,
    );

    transport.respond(threadReq, makeThreadStartResponse("thr_1"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_1");
  });

  test("resumeThread passes developerInstructions to thread/resume params", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.resumeThread(
      "thr_existing",
      "openai",
      "gpt-5.3-codex",
      "/workspace/project",
      null,
      null,
      "Use interpreter-specific behavior.",
    );

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadResume,
    );
    assert.equal(
      threadReq.params.developerInstructions,
      "Use interpreter-specific behavior.",
    );
    assert.equal(threadReq.params.cwd, "/workspace/project");

    transport.respond(threadReq, makeThreadResumeResponse("thr_existing"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_existing");
  });

  test("forkThread preserves history through one completed turn", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.forkThread(
      "thr_source",
      "turn_clean",
      "openai",
      "gpt-5.3-codex",
      "/workspace/project",
      null,
    );

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(transport, 2, CLIENT_METHOD.threadFork);
    assert.equal(threadReq.params.threadId, "thr_source");
    assert.equal(threadReq.params.lastTurnId, "turn_clean");
    assert.equal(threadReq.params.cwd, "/workspace/project");

    transport.respond(threadReq, makeThreadForkResponse("thr_fork"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_fork");
  });

  test("resumeThread passes baseInstructions to thread/resume params", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.resumeThread(
      "thr_existing",
      "openai",
      "gpt-5.3-codex",
      "/workspace/project",
      null,
      "You are Interpreter.",
      null,
    );

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadResume,
    );
    assert.equal(threadReq.params.baseInstructions, "You are Interpreter.");

    transport.respond(threadReq, makeThreadResumeResponse("thr_existing"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_existing");
  });

  test("resumeThread passes config to thread/resume params", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const threadPromise = client.resumeThread(
      "thr_existing",
      "openai",
      "gpt-5.3-codex",
      "/workspace/project",
      {
        shell_environment_policy: {
          inherit: "core",
          set: {
            INTERPRETER_CALLER_TOKEN: "agtok_test",
          },
        },
      },
      null,
      "Use interpreter-specific behavior.",
    );

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const threadReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.threadResume,
    );
    assert.deepEqual(threadReq.params.config, {
      include_apply_patch_tool: true,
      include_permissions_instructions: false,
      shell_environment_policy: {
        inherit: "core",
        set: {
          INTERPRETER_CALLER_TOKEN: "agtok_test",
        },
      },
      mcp_servers: {},
    });

    transport.respond(threadReq, makeThreadResumeResponse("thr_existing"));

    const threadId = await threadPromise;
    assert.equal(threadId, "thr_existing");
  });

  test("configValueWrite sends config/value/write RPC", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-config-write-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, "[mcp_servers.test]\nname = \"Test\"\n", "utf-8");

    const writePromise = client.configValueWrite(
      "model_providers.interpreter",
      { base_url: "https://example.com", name: "Test" },
    );

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const writeReq = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.configValueWrite,
    );
    assert.equal(writeReq.params.keyPath, "model_providers.interpreter");
    assert.equal(writeReq.params.mergeStrategy, "upsert");

    const writeResponse: v2.ConfigWriteResponse = {
      status: "ok",
      version: "1",
      filePath: configPath,
      overriddenMetadata: null,
    };
    transport.respond(writeReq, writeResponse);

    await writePromise;

    const contents = await readFile(configPath, "utf-8");
    assert.ok(contents.startsWith("# Interpreter user configuration\n# Hosted model IDs must be \"interpreter-smart\", \"interpreter-fast\", or <provider>/<model_id>.\n# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.\n# API model IDs are supplied by OIX and preserved even when they are newer than Workstation's fallback catalog.\n# For API profiles, set base_url to the API root.\n# Responses is the default API wire format. API profiles use wire_api = \"chat\" only when Chat Completions is explicitly enabled in Settings.\n\n"));
  });

  test("drops invalid lifecycle notification with console.warn", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const notifications: AppServerNotification[] = [];
    const warns: unknown[][] = [];
    const origWarn = console.warn;

    client.subscribe((n) => notifications.push(n));

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    console.warn = (...args: unknown[]) => warns.push(args);
    transport.emitNotification({
      method: "turn/completed",
      params: { invalid: true },
    } as unknown as AppServerNotification);
    console.warn = origWarn;

    assert.equal(notifications.length, 0);
    assert.ok(warns.length > 0);
  });

  test("passes through non-lifecycle notification without validation", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const notifications: AppServerNotification[] = [];

    client.subscribe((n) => notifications.push(n));

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.emitNotification({
      method: SERVER_METHOD.agentMessageDelta,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "item_1",
        delta: "hello",
      },
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.method, SERVER_METHOD.agentMessageDelta);
  });

  test("passes through valid lifecycle notification", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const notifications: AppServerNotification[] = [];

    client.subscribe((n) => notifications.push(n));

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.emitNotification({
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_1",
        turn: { id: "turn_1", items: [], status: "completed", error: null },
      },
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.method, SERVER_METHOD.turnCompleted);
  });

  test("configRead sends config/read RPC", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const readPromise = client.configRead({ includeLayers: true });

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const readReq = assertSentRequest(transport, 2, CLIENT_METHOD.configRead);
    assert.equal(readReq.params.includeLayers, true);

    const response: v2.ConfigReadResponse = {
      config: { model: null, review_model: null, model_context_window: null, model_auto_compact_token_limit: null, model_provider: null, approval_policy: null, sandbox_mode: null, sandbox_workspace_write: null, forced_chatgpt_workspace_id: null, forced_login_method: null, web_search: null, tools: null, profile: null, profiles: {}, instructions: null, developer_instructions: null, compact_prompt: null, model_reasoning_effort: null, model_reasoning_summary: null, model_verbosity: null, analytics: null },
      origins: {},
      layers: null,
    };
    transport.respond(readReq, response);

    const result = await readPromise;
    assert.equal(result.layers, null);
  });

  test("configRead ensures the header comment block on the user config", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-config-read-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, "web_search = \"disabled\"\n", "utf-8");

    const readPromise = client.configRead({ includeLayers: true });

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const readReq = assertSentRequest(transport, 2, CLIENT_METHOD.configRead);

    const response: v2.ConfigReadResponse = {
      config: { model: null, review_model: null, model_context_window: null, model_auto_compact_token_limit: null, model_provider: null, approval_policy: null, sandbox_mode: null, sandbox_workspace_write: null, forced_chatgpt_workspace_id: null, forced_login_method: null, web_search: "disabled", tools: null, profile: null, profiles: {}, instructions: null, developer_instructions: null, compact_prompt: null, model_reasoning_effort: null, model_reasoning_summary: null, model_verbosity: null, analytics: null },
      origins: {},
      layers: [
        {
          name: { type: "user", file: configPath },
          version: "1",
          config: { web_search: "disabled" },
          disabledReason: null,
        },
      ],
    };
    transport.respond(readReq, response);

    const result = await readPromise;
    assert.equal(result.layers?.[0]?.name.type, "user");

    const contents = await readFile(configPath, "utf-8");
    assert.ok(contents.startsWith("# Interpreter user configuration\n# Hosted model IDs must be \"interpreter-smart\", \"interpreter-fast\", or <provider>/<model_id>.\n# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.\n# API model IDs are supplied by OIX and preserved even when they are newer than Workstation's fallback catalog.\n# For API profiles, set base_url to the API root.\n# Responses is the default API wire format. API profiles use wire_api = \"chat\" only when Chat Completions is explicitly enabled in Settings.\n\n"));
  });

  test("configRead creates the header comment block when the user config file is missing", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-config-read-missing-"));
    const configPath = path.join(tempDir, "config.toml");

    const readPromise = client.configRead({ includeLayers: true });

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const readReq = assertSentRequest(transport, 2, CLIENT_METHOD.configRead);

    const response: v2.ConfigReadResponse = {
      config: { model: null, review_model: null, model_context_window: null, model_auto_compact_token_limit: null, model_provider: null, approval_policy: null, sandbox_mode: null, sandbox_workspace_write: null, forced_chatgpt_workspace_id: null, forced_login_method: null, web_search: null, tools: null, profile: null, profiles: {}, instructions: null, developer_instructions: null, compact_prompt: null, model_reasoning_effort: null, model_reasoning_summary: null, model_verbosity: null, analytics: null },
      origins: {},
      layers: [
        {
          name: { type: "user", file: configPath },
          version: "1",
          config: {},
          disabledReason: null,
        },
      ],
    };
    transport.respond(readReq, response);

    const result = await readPromise;
    assert.equal(result.layers?.[0]?.name.type, "user");

    const contents = await readFile(configPath, "utf-8");
    assert.ok(contents.startsWith("# Interpreter user configuration\n# Hosted model IDs must be \"interpreter-smart\", \"interpreter-fast\", or <provider>/<model_id>.\n# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.\n# API model IDs are supplied by OIX and preserved even when they are newer than Workstation's fallback catalog.\n# For API profiles, set base_url to the API root.\n# Responses is the default API wire format. API profiles use wire_api = \"chat\" only when Chat Completions is explicitly enabled in Settings.\n"));
  });

  test("configBatchWrite sends config/batchWrite RPC", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-config-batch-"));
    const configPath = path.join(tempDir, "config.toml");
    const header = "# Interpreter user configuration\n# Hosted model IDs must be \"interpreter-smart\", \"interpreter-fast\", or <provider>/<model_id>.\n# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.\n# API model IDs are supplied by OIX and preserved even when they are newer than Workstation's fallback catalog.\n# For API profiles, set base_url to the API root.\n# Responses is the default API wire format. API profiles use wire_api = \"chat\" only when Chat Completions is explicitly enabled in Settings.\n\n";
    await writeFile(configPath, `${header}web_search = \"disabled\"\n`, "utf-8");

    const writePromise = client.configBatchWrite({
      edits: [
        { keyPath: "mcp_servers.test", value: { command: "echo" }, mergeStrategy: "upsert" },
      ],
    });

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const writeReq = assertSentRequest(transport, 2, CLIENT_METHOD.configBatchWrite);
    assert.equal(writeReq.params.edits.length, 1);
    assert.equal(writeReq.params.edits[0]?.keyPath, "mcp_servers.test");

    const response: v2.ConfigWriteResponse = {
      status: "ok",
      version: "2",
      filePath: configPath,
      overriddenMetadata: null,
    };
    transport.respond(writeReq, response);

    const result = await writePromise;
    assert.equal(result.version, "2");

    const contents = await readFile(configPath, "utf-8");
    assert.equal(contents, `${header}web_search = \"disabled\"\n`);
  });

  test("configBatchWrite does not retry after a codex runtime disconnect", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const writePromise = client.configBatchWrite({
      edits: [
        { keyPath: "mcp_servers.test", value: { command: "echo" }, mergeStrategy: "upsert" },
      ],
    });

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    assertSentRequest(transport, 2, CLIENT_METHOD.configBatchWrite);
    transport.close(new Error("codex app-server exited (1): provider overloaded"));

    await assert.rejects(
      writePromise,
      /codex app-server exited \(1\): provider overloaded/,
    );
    assert.equal(transport.sent.length, 3);
  });

  test("mcpServerReload sends config/mcpServer/reload RPC with no params", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const reloadPromise = client.mcpServerReload();

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const reloadReq = assertSentRequest(transport, 2, CLIENT_METHOD.mcpServerReload);
    assert.equal(reloadReq.params, undefined);

    const response: v2.McpServerRefreshResponse = {};
    transport.respond(reloadReq, response);

    await reloadPromise;
  });

  test("mcpServerStatusList sends mcpServerStatus/list RPC", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const listPromise = client.mcpServerStatusList({ limit: 10 });

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.some((message) => "id" in message && message.method === CLIENT_METHOD.mcpServerStatusList));
    const listReq = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.mcpServerStatusList> =>
        "id" in message && message.method === CLIENT_METHOD.mcpServerStatusList,
    );
    assert.ok(listReq);
    assert.equal(listReq.params.limit, 10);

    const response: v2.ListMcpServerStatusResponse = {
      data: [{ name: "test-server", tools: {}, resources: [], resourceTemplates: [], authStatus: "unsupported" }],
      nextCursor: null,
    };
    transport.respond(listReq, response);

    const result = await listPromise;
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.name, "test-server");
  });

  test("mcpServerOauthLogin sends mcpServer/oauth/login RPC", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const loginPromise = client.mcpServerOauthLogin({
      name: "remote-mcp",
      scopes: ["read", "write"],
    });

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.length >= 3);
    const loginReq = assertSentRequest(transport, 2, CLIENT_METHOD.mcpServerOauthLogin);
    assert.equal(loginReq.params.name, "remote-mcp");
    assert.deepEqual(loginReq.params.scopes, ["read", "write"]);

    const response: v2.McpServerOauthLoginResponse = {
      authorizationUrl: "https://auth.example.com/oauth",
    };
    transport.respond(loginReq, response);

    const result = await loginPromise;
    assert.equal(result.authorizationUrl, "https://auth.example.com/oauth");
  });

  test("successful OAuth completion broadcasts fresh status without reloading MCP servers", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const reloadCalls: undefined[] = [];
    const broadcastCalls: Array<v2.McpServerStatusUpdatedNotification | undefined> = [];

    (client as any).mcpServerReload = async () => {
      reloadCalls.push(undefined);
      return {};
    };
    (client as any).broadcastMcpServerStatusChange = async (
      startupStatus?: v2.McpServerStatusUpdatedNotification,
    ) => {
      broadcastCalls.push(startupStatus);
    };

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.emitNotification({
      method: SERVER_METHOD.mcpServerOauthLoginCompleted,
      params: {
        name: "sentry",
        success: true,
        error: null,
      },
    });

    await waitFor(() => broadcastCalls.length === 1);

    assert.equal(reloadCalls.length, 0);
    assert.deepEqual(broadcastCalls, [undefined]);
  });

  test("does not duplicate MCP notification handlers across reconnects", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const broadcastCalls: Array<v2.McpServerStatusUpdatedNotification | undefined> = [];

    (client as any).broadcastMcpServerStatusChange = async (
      startupStatus?: v2.McpServerStatusUpdatedNotification,
    ) => {
      broadcastCalls.push(startupStatus);
    };

    const firstConnect = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await firstConnect;

    transport.close(new Error("stdio closed"));

    const secondConnect = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 3);
    const secondInit = assertSentRequest(transport, 2, CLIENT_METHOD.initialize);
    transport.respond(secondInit, { userAgent: "codex-test" });
    await secondConnect;

    transport.emitNotification({
      method: SERVER_METHOD.mcpServerStartupStatusUpdated,
      params: {
        name: "sentry",
        status: "starting",
        error: null,
      },
    });

    await waitFor(() => broadcastCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(broadcastCalls.length, 1);
    assert.deepEqual(broadcastCalls[0], {
      name: "sentry",
      status: "starting",
      error: null,
    });
  });

  test("failed OAuth completion broadcasts fresh status without reloading MCP servers", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const reloadCalls: undefined[] = [];
    const broadcastCalls: Array<v2.McpServerStatusUpdatedNotification | undefined> = [];

    (client as any).mcpServerReload = async () => {
      reloadCalls.push(undefined);
      return {};
    };
    (client as any).broadcastMcpServerStatusChange = async (
      startupStatus?: v2.McpServerStatusUpdatedNotification,
    ) => {
      broadcastCalls.push(startupStatus);
    };

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.emitNotification({
      method: SERVER_METHOD.mcpServerOauthLoginCompleted,
      params: {
        name: "sentry",
        success: false,
        error: "Access denied",
      },
    });

    await waitFor(() => broadcastCalls.length === 1);

    assert.equal(reloadCalls.length, 0);
    assert.deepEqual(broadcastCalls, [undefined]);
  });

  test("startup auth failures persist MCP reauth state for later snapshots", async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        sentry: {
          id: "sentry",
          name: "Sentry",
          transport: "http",
          url: "https://mcp.sentry.dev/mcp",
          enabled: true,
          createdAt: 1,
        },
      },
      globalDisabledTools: [],
    } as any);

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.emitNotification({
      method: SERVER_METHOD.mcpServerStartupStatusUpdated,
      params: {
        name: "sentry",
        status: "failed",
        error: "MCP client for `sentry` failed to start: invalid_token",
      },
    });

    await waitForAsync(async () => {
      const server = await getMcpServer("sentry");
      return server?.lastConnectionFailure?.needsAuth === true;
    });

    const server = await getMcpServer("sentry");
    assert.deepEqual(server?.lastConnectionFailure, {
      error: "MCP client for `sentry` failed to start: invalid_token",
      needsAuth: true,
      updatedAt: server?.lastConnectionFailure?.updatedAt,
    });
    assert.equal(typeof server?.lastConnectionFailure?.updatedAt, "number");
  });

  test("successful OAuth completion clears persisted MCP reauth state", async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        sentry: {
          id: "sentry",
          name: "Sentry",
          transport: "http",
          url: "https://mcp.sentry.dev/mcp",
          enabled: true,
          createdAt: 1,
          lastConnectionFailure: {
            error: "OAuth login required",
            needsAuth: true,
            updatedAt: 2,
          },
        },
      },
      globalDisabledTools: [],
    } as any);

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.emitNotification({
      method: SERVER_METHOD.mcpServerOauthLoginCompleted,
      params: {
        name: "sentry",
        success: true,
        error: null,
      },
    });

    await waitForAsync(async () => {
      const server = await getMcpServer("sentry");
      return server?.lastConnectionFailure === undefined;
    });

    const server = await getMcpServer("sentry");
    assert.equal(server?.lastConnectionFailure, undefined);
  });

  test("mcpServerStatusList persists auth-required stderr for Supabase on fresh status reads", async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        supabase: {
          id: "supabase",
          name: "Supabase",
          transport: "http",
          url: "https://mcp.supabase.com/mcp",
          enabled: true,
          createdAt: 1,
        },
      },
      globalDisabledTools: [],
    } as any);

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const listPromise = client.mcpServerStatusList({ detail: "toolsAndAuthOnly" });

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() => transport.sent.some((message) => "id" in message && message.method === CLIENT_METHOD.mcpServerStatusList));
    const listReq = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.mcpServerStatusList> =>
        "id" in message && message.method === CLIENT_METHOD.mcpServerStatusList,
    );
    assert.ok(listReq);
    transport.stderrSnapshot = [
      "2026-04-22T18:22:15.391492Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError {",
      "www_authenticate_header: \"Bearer [REDACTED]=\\\"invalid_request\\\"\",",
      "error_description=\\\"No access token was provided in this request\\\",",
      "resource_metadata=\\\"https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp\\\"",
      "})",
    ].join(" ");

    const response: v2.ListMcpServerStatusResponse = {
      data: [{ name: "supabase", tools: {}, resources: [], resourceTemplates: [], authStatus: "unsupported" }],
      nextCursor: null,
    };
    transport.respond(listReq, response);

    await listPromise;

    await waitForAsync(async () => {
      const server = await getMcpServer("supabase");
      return server?.lastConnectionFailure?.needsAuth === true;
    });

    const server = await getMcpServer("supabase");
    assert.deepEqual(server?.lastConnectionFailure, {
      error: "No access token was provided in this request",
      needsAuth: true,
      updatedAt: server?.lastConnectionFailure?.updatedAt,
    });
    assert.equal(typeof server?.lastConnectionFailure?.updatedAt, "number");
  });

  test("default chat runtime does not mirror app MCP config into Codex config on connect", async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        supabase: {
          id: "supabase",
          name: "Supabase",
          transport: "http",
          url: "https://mcp.supabase.com/mcp",
          oauthResource: "https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp",
          enabled: true,
          createdAt: 1,
        },
      },
      globalDisabledTools: [],
    } as any);

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.configValueWrite,
      ),
      false,
    );
    assert.equal(
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.mcpServerReload,
      ),
      false,
    );
  });

  test("MCP runtime sync preserves oauth_resource when mirroring app config into Codex config", async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        supabase: {
          id: "supabase",
          name: "Supabase",
          transport: "http",
          url: "https://mcp.supabase.com/mcp",
          oauthResource: "https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp",
          enabled: true,
          createdAt: 1,
        },
      },
      globalDisabledTools: [],
    } as any);

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null, undefined, {
      syncMcpServersFromConfigStore: true,
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() =>
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.configValueWrite,
      ),
    );

    const writeReq = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.configValueWrite> =>
        "id" in message && message.method === CLIENT_METHOD.configValueWrite,
    );
    assert.ok(writeReq);
    assert.equal(writeReq.params.keyPath, "mcp_servers.supabase");
    assert.deepEqual(writeReq.params.value, {
      url: "https://mcp.supabase.com/mcp",
      oauth_resource: "https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp",
      tool_timeout_sec: 3600,
      default_tools_approval_mode: "prompt",
    });

    transport.respond(writeReq, {
      status: "ok",
      version: "1",
      filePath: "/tmp/config.toml",
      overriddenMetadata: null,
    });

    await waitFor(() =>
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.mcpServerReload,
      ),
    );

    const reloadReq = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.mcpServerReload> =>
        "id" in message && message.method === CLIENT_METHOD.mcpServerReload,
    );
    assert.ok(reloadReq);
    transport.respond(reloadReq, {});
    await connectPromise;
  });

  test("MCP runtime sync mirrors auth-required servers so they stay recoverable via OAuth", async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        linear: {
          id: "linear",
          name: "Linear",
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          enabled: true,
          createdAt: 1,
          lastConnectionFailure: {
            error: "Missing or invalid access token",
            needsAuth: true,
            updatedAt: 2,
          },
        },
        docs: {
          id: "docs",
          name: "Docs",
          transport: "http",
          url: "https://docs.example.com/mcp",
          enabled: true,
          createdAt: 3,
        },
      },
      globalDisabledTools: [],
    } as any);

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null, undefined, {
      syncMcpServersFromConfigStore: true,
    });

    const ok = {
      status: "ok" as const,
      version: "1",
      filePath: "/tmp/config.toml",
      overriddenMetadata: null,
    };

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    // The auth-required server (linear) must be mirrored, not skipped: the mirror
    // needs it in config to report "needs auth" and to run mcpServer/oauth/login.
    // Writes are sequential, so respond to each so the next is issued.
    await waitFor(() =>
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.configValueWrite,
      ),
    );
    const firstWrite = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.configValueWrite> =>
        "id" in message && message.method === CLIENT_METHOD.configValueWrite,
    );
    assert.ok(firstWrite);
    assert.equal(firstWrite.params.keyPath, "mcp_servers.linear");
    transport.respond(firstWrite, ok);

    await waitFor(
      () =>
        transport.sent.filter(
          (message) => "id" in message && message.method === CLIENT_METHOD.configValueWrite,
        ).length >= 2,
    );
    const writeReqs = transport.sent.filter(
      (message): message is SentRequest<typeof CLIENT_METHOD.configValueWrite> =>
        "id" in message && message.method === CLIENT_METHOD.configValueWrite,
    );
    assert.deepEqual(
      writeReqs.map((request) => request.params.keyPath),
      ["mcp_servers.linear", "mcp_servers.docs"],
    );
    transport.respond(writeReqs[1]!, ok);

    await waitFor(() =>
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.mcpServerReload,
      ),
    );

    const reloadReq = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.mcpServerReload> =>
        "id" in message && message.method === CLIENT_METHOD.mcpServerReload,
    );
    assert.ok(reloadReq);
    transport.respond(reloadReq, {});
  });

  test("MCP runtime sync preserves configured timeout fields when mirroring app config", async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        slow: {
          id: "slow",
          name: "Slow",
          transport: "http",
          url: "https://example.com/mcp",
          startupTimeoutSec: 45,
          toolTimeoutSec: 90,
          enabled: true,
          createdAt: 1,
        },
      },
      globalDisabledTools: [],
    } as any);

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null, undefined, {
      syncMcpServersFromConfigStore: true,
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() =>
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.configValueWrite,
      ),
    );

    const writeReq = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.configValueWrite> =>
        "id" in message && message.method === CLIENT_METHOD.configValueWrite,
    );
    assert.ok(writeReq);
    assert.equal(writeReq.params.keyPath, "mcp_servers.slow");
    assert.deepEqual(writeReq.params.value, {
      url: "https://example.com/mcp",
      startup_timeout_sec: 45,
      tool_timeout_sec: 90,
      default_tools_approval_mode: "prompt",
    });

    transport.respond(writeReq, {
      status: "ok",
      version: "1",
      filePath: "/tmp/config.toml",
      overriddenMetadata: null,
    });

    await waitFor(() =>
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.mcpServerReload,
      ),
    );

    const reloadReq = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.mcpServerReload> =>
        "id" in message && message.method === CLIENT_METHOD.mcpServerReload,
    );
    assert.ok(reloadReq);
    transport.respond(reloadReq, {});
    await connectPromise;
  });

  test("MCP runtime sync mirrors websocket config as a URL-based runtime entry", async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        realtime: {
          id: "realtime",
          name: "Realtime",
          transport: "websocket",
          wsUrl: "wss://example.com/mcp",
          enabled: true,
          createdAt: 1,
        },
      },
      globalDisabledTools: [],
    } as any);

    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null, undefined, {
      syncMcpServersFromConfigStore: true,
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);

    await waitFor(() =>
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.configValueWrite,
      ),
    );

    const writeReq = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.configValueWrite> =>
        "id" in message && message.method === CLIENT_METHOD.configValueWrite,
    );
    assert.ok(writeReq);
    assert.equal(writeReq.params.keyPath, "mcp_servers.realtime");
    assert.deepEqual(writeReq.params.value, {
      url: "wss://example.com/mcp",
      tool_timeout_sec: 3600,
      default_tools_approval_mode: "prompt",
    });

    transport.respond(writeReq, {
      status: "ok",
      version: "1",
      filePath: "/tmp/config.toml",
      overriddenMetadata: null,
    });

    await waitFor(() =>
      transport.sent.some(
        (message) => "id" in message && message.method === CLIENT_METHOD.mcpServerReload,
      ),
    );

    const reloadReq = transport.sent.find(
      (message): message is SentRequest<typeof CLIENT_METHOD.mcpServerReload> =>
        "id" in message && message.method === CLIENT_METHOD.mcpServerReload,
    );
    assert.ok(reloadReq);
    transport.respond(reloadReq, {});
    await connectPromise;
  });

  test("mcpServerAuthStatusListViaCli maps CLI auth status variants", async () => {
    const transport = new FakeTransport();
    transport.setNextCliResult({
      stdout: `WARNING: proceeding, even though we could not update PATH: Operation not permitted (os error 1)
[
  {
    "name": "supabase",
    "enabled": true,
    "disabled_reason": null,
    "transport": {
      "type": "streamable_http",
      "url": "https://mcp.supabase.com/mcp"
    },
    "auth_status": "not_logged_in"
  },
  {
    "name": "github",
    "enabled": true,
    "disabled_reason": null,
    "transport": {
      "type": "streamable_http",
      "url": "https://api.githubcopilot.com/mcp"
    },
    "auth_status": "o_auth"
  },
  {
    "name": "disabled-server",
    "enabled": false,
    "disabled_reason": "disabled",
    "transport": {
      "type": "stdio",
      "command": "uv",
      "args": []
    },
    "auth_status": "bearer_token"
  }
]`,
    });
    const client = new CodexAppServerClient(transport, null);

    const result = await client.mcpServerAuthStatusListViaCli();

    assert.deepEqual(transport.cliRuns, [["mcp", "list", "--json"]]);
    assert.deepEqual(
      Array.from(result.entries()),
      [
        ["supabase", "notLoggedIn"],
        ["github", "oAuth"],
      ],
    );
  });

  test("mcpServerAuthStatusListViaCli ignores unknown auth statuses", async () => {
    const transport = new FakeTransport();
    transport.setNextCliResult({
      stdout: `[
  {
    "name": "supabase",
    "enabled": true,
    "disabled_reason": null,
    "transport": {
      "type": "streamable_http",
      "url": "https://mcp.supabase.com/mcp"
    },
    "auth_status": "not_logged_in"
  },
  {
    "name": "future-server",
    "enabled": true,
    "disabled_reason": null,
    "transport": {
      "type": "streamable_http",
      "url": "https://mcp.example.com"
    },
    "auth_status": "device_code"
  }
]`,
    });
    const client = new CodexAppServerClient(transport, null);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const result = await client.mcpServerAuthStatusListViaCli();

      assert.deepEqual(Array.from(result.entries()), [["supabase", "notLoggedIn"]]);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /future-server/);
      assert.match(warnings[0] ?? "", /device_code/);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("loadHydratedToolServersForBroadcast asks ToolManager for hydrated servers", async () => {
    const hydratedServers = [
      {
        id: "custom-mcp",
        name: "Configured MCP",
        description: "Persisted description",
        config: { id: "custom-mcp", transport: "http", url: "https://mcp.example.com" },
        state: {
          status: "connected" as const,
          tools: [{ name: "do_thing", description: "Does a thing", inputSchema: { type: "object" } }],
          resources: [],
          prompts: [],
        },
      },
      {
        id: "builtin-fs",
        name: "Filesystem",
        state: {
          status: "connected" as const,
          tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
          resources: [],
          prompts: [],
        },
      },
    ];
    let listCalls = 0;

    const result = await loadHydratedToolServersForBroadcast({
      getToolManager: () => ({
        listDisplayToolServers: async () => {
          listCalls += 1;
          return hydratedServers;
        },
      }),
    });

    assert.equal(listCalls, 1);
    assert.deepEqual(result, hydratedServers);
  });

  test("mergeStartupStatusIntoToolServers preserves hydrated metadata while surfacing failures", () => {
    const merged = mergeStartupStatusIntoToolServers(
      [
        {
          id: "custom-mcp",
          name: "Configured MCP",
          description: "Persisted description",
          config: { id: "custom-mcp", transport: "http", url: "https://mcp.example.com" },
          state: {
            status: "connected",
            tools: [{ name: "do_thing", description: "Does a thing", inputSchema: { type: "object" } }],
            resources: [],
            prompts: [],
          },
        },
        {
          id: "builtin-fs",
          name: "Filesystem",
          state: {
            status: "connected",
            tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
            resources: [],
            prompts: [],
          },
        },
      ],
      {
        name: "custom-mcp",
        status: "failed",
        error: "startup boom",
      },
    );

    assert.deepEqual(
      merged.map((server) => server.id),
      ["custom-mcp", "builtin-fs"],
    );
    assert.equal(merged[0]?.description, "Persisted description");
    assert.deepEqual(merged[0]?.config, {
      id: "custom-mcp",
      transport: "http",
      url: "https://mcp.example.com",
    });
    assert.deepEqual(merged[0]?.state, {
      status: "failed",
      error: "startup boom",
    });
    assert.deepEqual(merged[1]?.state, {
      status: "connected",
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      resources: [],
      prompts: [],
    });
  });

  test("mergeStartupStatusIntoToolServers preserves needsAuth when hydrated state has it", () => {
    const merged = mergeStartupStatusIntoToolServers(
      [
        {
          id: "github",
          name: "GitHub",
          description: "Search code and issues",
          config: { id: "github", transport: "http", url: "https://mcp.github.com" },
          state: {
            status: "failed",
            error: "OAuth login required",
            needsAuth: true,
          },
        },
      ],
      {
        name: "github",
        status: "failed",
        error: "AuthRequired: OAuth login required",
      },
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.state.status, "failed");
    assert.equal(
      (merged[0]?.state as { needsAuth?: boolean }).needsAuth,
      true,
      "startup status overlay must not strip needsAuth from the hydrated auth-required state",
    );
  });

  test("mergeStartupStatusIntoToolServers infers needsAuth from auth-related startup errors", () => {
    const merged = mergeStartupStatusIntoToolServers(
      [
        {
          id: "supabase",
          name: "Supabase",
          state: { status: "disconnected" },
        },
      ],
      {
        name: "supabase",
        status: "failed",
        error: "OAuth authorization required",
      },
    );

    assert.equal(merged[0]?.state.status, "failed");
    assert.equal(
      (merged[0]?.state as { needsAuth?: boolean }).needsAuth,
      true,
      "startup failure with auth-related error text should set needsAuth",
    );
  });

  test("emits server-request event for server-initiated requests", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const serverRequests: Array<{ request: ServerRequest; respond: (result: unknown) => void }> = [];

    client.subscribeServerRequests((request, respond) => {
      serverRequests.push({ request, respond });
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.emitServerRequest({
      id: 99,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", command: "ls" },
    });

    await waitFor(() => serverRequests.length >= 1);
    assert.equal(serverRequests.length, 1);
    const req = serverRequests[0]!.request as { id: number; method: string };
    assert.equal(req.id, 99);
    assert.equal(req.method, SERVER_REQUEST_METHOD.commandExecutionApproval);
  });

  test("respond callback writes approval response back to transport", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    client.subscribeServerRequests((_request, respond) => {
      respond({ decision: "accept" });
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    const sentBefore = transport.sent.length;

    transport.emitServerRequest({
      id: 100,
      method: SERVER_REQUEST_METHOD.fileChangeApproval,
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" },
    });

    await waitFor(() => transport.sent.length > sentBefore);
    const responseSent = transport.sent[sentBefore] as unknown as { id: number; result: unknown };
    assert.equal(responseSent.id, 100);
    assert.deepEqual(responseSent.result, { decision: "accept" });
  });

  test("server request is not routed to JSONRPCClient as a response", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    const serverRequests: ServerRequest[] = [];
    client.subscribeServerRequests((req) => serverRequests.push(req));

    transport.emitServerRequest({
      id: 300,
      method: SERVER_REQUEST_METHOD.toolCall,
      params: { toolName: "test", args: {} },
    });

    await waitFor(() => serverRequests.length >= 1);
    assert.equal(serverRequests.length, 1);
  });

  test("server request is not emitted as a notification", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const notifications: AppServerNotification[] = [];
    client.subscribe((n) => notifications.push(n));

    const serverRequests: ServerRequest[] = [];
    client.subscribeServerRequests((req) => serverRequests.push(req));

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.emitServerRequest({
      id: 400,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" },
    });

    await waitFor(() => serverRequests.length >= 1);
    assert.equal(notifications.length, 0);
  });

  test("close does not crash with unresponded server requests", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    client.subscribeServerRequests(() => {
      // NOTE(victor): intentionally not responding to simulate pending approval
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.emitServerRequest({
      id: 500,
      method: SERVER_REQUEST_METHOD.execCommandApproval,
      params: { command: "echo hi" },
    });

    transport.close(new Error("terminated"));
  });

  test("emits auth-invalidated when close error matches codex reauth pattern", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const authEvents: string[] = [];

    client.onAuthInvalidated((reason) => {
      authEvents.push(reason);
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.close(
      new Error(
        'codex app-server exited (null): Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_invalidated","message":"Your refresh token has been invalidated. Please try signing in again."}}',
      ),
    );

    assert.equal(authEvents.length, 1);
    assert.ok(authEvents[0]!.includes("401 Unauthorized"));
  });

  test("emits auth-invalidated when close error includes codex websocket 403 forbidden", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const authEvents: string[] = [];

    client.onAuthInvalidated((reason) => {
      authEvents.push(reason);
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.close(
      new Error(
        "codex app-server exited (null): Failed to cancel previous login server: connection timed out\nERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses",
      ),
    );

    assert.equal(authEvents.length, 1);
    assert.ok(authEvents[0]!.includes("403 Forbidden"));
  });

  test("does not emit auth-invalidated for non-auth close errors", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const authEvents: string[] = [];

    client.onAuthInvalidated((reason) => {
      authEvents.push(reason);
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.close(new Error("codex app-server exited (1): out of memory"));

    assert.equal(authEvents.length, 0);
  });

  test("emits disconnect when the transport closes", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const disconnectEvents: string[] = [];

    client.onDisconnect((reason) => {
      disconnectEvents.push(reason);
    });

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.close(new Error("codex app-server exited (1): out of memory"));

    assert.deepEqual(disconnectEvents, [
      "codex app-server exited (1): out of memory",
    ]);
  });

  test("retries account reads once after a codex runtime disconnect", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const accountPromise = client.getAccount();

    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await waitFor(() => transport.sent.length >= 3);

    const firstAccountRead = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.accountRead,
    );
    transport.close(new Error("codex app-server exited (null)"));

    await waitFor(() => transport.sent.length >= 4);
    const secondInit = assertSentRequest(
      transport,
      3,
      CLIENT_METHOD.initialize,
    );
    transport.respond(secondInit, { userAgent: "codex-test" });

    await waitFor(() => transport.sent.length >= 6);
    assertSentNotification(
      transport,
      4,
      CLIENT_NOTIFICATION_METHOD.initialized,
    );
    const retriedAccountRead = assertSentRequest(
      transport,
      5,
      CLIENT_METHOD.accountRead,
    );
    assert.equal(firstAccountRead.params.refreshToken, false);
    assert.equal(retriedAccountRead.params.refreshToken, false);

    transport.respond(retriedAccountRead, {
      account: null,
      requiresOpenaiAuth: false,
    });

    const account = await accountPromise;
    assert.deepEqual(account, {
      account: null,
      requiresOpenaiAuth: false,
    });
  });

  test("retries account reads once when the codex runtime disconnects during initialize", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const accountPromise = client.getAccount();

    await waitFor(() => transport.sent.length >= 1);
    assertSentRequest(
      transport,
      0,
      CLIENT_METHOD.initialize,
    );
    transport.close(new Error("codex app-server exited (null)"));

    await waitFor(() => transport.sent.length >= 2);
    const secondInit = assertSentRequest(
      transport,
      1,
      CLIENT_METHOD.initialize,
    );
    transport.respond(secondInit, { userAgent: "codex-test" });

    await waitFor(() => transport.sent.length >= 4);
    assertSentNotification(
      transport,
      2,
      CLIENT_NOTIFICATION_METHOD.initialized,
    );
    const accountRead = assertSentRequest(
      transport,
      3,
      CLIENT_METHOD.accountRead,
    );
    assert.equal(accountRead.params.refreshToken, false);

    transport.respond(accountRead, {
      account: null,
      requiresOpenaiAuth: false,
    });

    const account = await accountPromise;
    assert.deepEqual(account, {
      account: null,
      requiresOpenaiAuth: false,
    });
  });

  test("retries account reads once after a typed transport disconnect", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.failNextSend(
      new CodexRuntimeDisconnectedError("codex app-server stdio is not writable"),
    );
    const accountPromise = client.getAccount();

    await waitFor(() => transport.sent.length >= 3);
    const secondInit = assertSentRequest(
      transport,
      2,
      CLIENT_METHOD.initialize,
    );
    transport.respond(secondInit, { userAgent: "codex-test" });

    await waitFor(() => transport.sent.length >= 5);
    assertSentNotification(
      transport,
      3,
      CLIENT_NOTIFICATION_METHOD.initialized,
    );
    const retriedAccountRead = assertSentRequest(
      transport,
      4,
      CLIENT_METHOD.accountRead,
    );
    assert.equal(retriedAccountRead.params.refreshToken, false);

    transport.respond(retriedAccountRead, {
      account: null,
      requiresOpenaiAuth: false,
    });

    const account = await accountPromise;
    assert.deepEqual(account, {
      account: null,
      requiresOpenaiAuth: false,
    });
  });

  test("onAuthInvalidated returns unsubscribe function", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, null);
    const authEvents: string[] = [];

    const unsub = client.onAuthInvalidated((reason) => {
      authEvents.push(reason);
    });
    unsub();

    const connectPromise = client.ensureConnected();
    await waitFor(() => transport.sent.length >= 1);
    completeInitHandshake(transport);
    await connectPromise;

    transport.close(
      new Error(
        "codex app-server exited (null): 401 Unauthorized: authentication token has been invalidated",
      ),
    );

    assert.equal(authEvents.length, 0);
  });
});

describe("StdioJsonRpcTransport", () => {
  function createMockChildProcess() {
    const childEvents = new EventEmitter();
    const child = Object.assign(childEvents, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;

    return { child, childEvents };
  }

  function createTestTransport(
    child: ChildProcessWithoutNullStreams,
    childEvents: EventEmitter,
  ) {
    const transport = new StdioJsonRpcTransport(() => {
      queueMicrotask(() => {
        childEvents.emit("spawn");
      });
      return child;
    }, "/tmp/codex-home-test");

    (transport as any).resolveCodexHome = async () => "/tmp/codex-home-test";
    (transport as any).resolveInterpreterCliBinary = async () => "/tmp/interpreter";
    (transport as any).installBundledSkills = async () => {};
    return transport;
  }

  test("deduplicates concurrent start calls on one transport", async () => {
    const { child, childEvents } = createMockChildProcess();
    let spawnCount = 0;
    let installCount = 0;
    let releaseInstall!: () => void;
    const installReady = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });

    const transport = new StdioJsonRpcTransport(() => {
      spawnCount += 1;
      queueMicrotask(() => {
        childEvents.emit("spawn");
      });
      return child;
    }, "/tmp/codex-home-test");

    (transport as any).resolveCodexHome = async () => "/tmp/codex-home-test";
    (transport as any).resolveInterpreterCliBinary = async () => "/tmp/interpreter";
    (transport as any).installBundledSkills = async () => {
      installCount += 1;
      await installReady;
    };

    const firstStart = transport.start();
    const secondStart = transport.start();
    releaseInstall();

    try {
      await Promise.all([firstStart, secondStart]);
      assert.equal(installCount, 1);
      assert.equal(spawnCount, 1);
    } finally {
      childEvents.emit("close", 0);
    }
  });

  test("serializes bundled skill installs across transports sharing one codex home", async () => {
    const first = createMockChildProcess();
    const second = createMockChildProcess();
    let activeInstalls = 0;
    let maxActiveInstalls = 0;
    let releaseFirstInstall!: () => void;
    const firstInstallReady = new Promise<void>((resolve) => {
      releaseFirstInstall = resolve;
    });
    let firstInstallSeen = false;

    const createTransport = (
      child: ChildProcessWithoutNullStreams,
      childEvents: EventEmitter,
    ) => {
      const transport = new StdioJsonRpcTransport(() => {
        queueMicrotask(() => {
          childEvents.emit("spawn");
        });
        return child;
      }, "/tmp/codex-home-test");
      (transport as any).resolveCodexHome = async () => "/tmp/codex-home-test";
      (transport as any).resolveInterpreterCliBinary = async () => "/tmp/interpreter";
      (transport as any).installBundledSkills = async () => {
        activeInstalls += 1;
        maxActiveInstalls = Math.max(maxActiveInstalls, activeInstalls);
        if (!firstInstallSeen) {
          firstInstallSeen = true;
          await firstInstallReady;
        }
        activeInstalls -= 1;
      };
      return transport;
    };

    const firstTransport = createTransport(first.child, first.childEvents);
    const secondTransport = createTransport(second.child, second.childEvents);

    const firstStart = firstTransport.start();
    await waitFor(() => firstInstallSeen);
    const secondStart = secondTransport.start();
    releaseFirstInstall();

    try {
      await Promise.all([firstStart, secondStart]);
      assert.equal(maxActiveInstalls, 1);
    } finally {
      first.childEvents.emit("close", 0);
      second.childEvents.emit("close", 0);
    }
  });

  test("updates app-managed skills, retires removed ones, and preserves user skills", async () => {
    const interpreterHome = await mkdtemp(path.join(os.tmpdir(), "interpreter-managed-skills-"));
    const skillsDir = path.join(interpreterHome, "skills");
    const transport = new StdioJsonRpcTransport(() => {
      throw new Error("spawn is not used by this test");
    }, interpreterHome);

    try {
      await mkdir(skillsDir, { recursive: true });
      await (transport as any).installBundledSkills(skillsDir);

      const managedDocPath = path.join(skillsDir, "doc", "SKILL.md");
      const shippedDoc = await readFile(managedDocPath, "utf8");
      await writeFile(managedDocPath, `${shippedDoc}\nUSER EDIT\n`, "utf8");
      await mkdir(path.join(skillsDir, "my-company-skill"), { recursive: true });
      await writeFile(
        path.join(skillsDir, "my-company-skill", "SKILL.md"),
        "---\nname: my-company-skill\ndescription: private\n---\n",
        "utf8",
      );
      const retiredSkillDir = path.join(skillsDir, "retired-app-skill");
      await mkdir(retiredSkillDir, { recursive: true });
      await writeFile(path.join(retiredSkillDir, "SKILL.md"), "retired but edited\n", "utf8");
      const manifestPath = path.join(interpreterHome, ".interpreter-managed-skills.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        skills: Record<string, { installedTreeHash: string }>;
      };
      manifest.skills["retired-app-skill"] = { installedTreeHash: "previous-release-hash" };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      await (transport as any).installBundledSkills(skillsDir);

      assert.equal(await readFile(managedDocPath, "utf8"), shippedDoc);
      assert.equal(
        await readFile(path.join(skillsDir, "my-company-skill", "SKILL.md"), "utf8"),
        "---\nname: my-company-skill\ndescription: private\n---\n",
      );

      const backupSkillRoot = path.join(
        interpreterHome,
        ".interpreter-managed-skill-backups",
        "doc",
      );
      const backupEntries = await readdir(backupSkillRoot);
      assert.equal(backupEntries.length, 1);
      assert.match(
        await readFile(path.join(backupSkillRoot, backupEntries[0], "SKILL.md"), "utf8"),
        /USER EDIT/,
      );
      assert.equal(
        existsSync(path.join(interpreterHome, ".interpreter-managed-skills.json")),
        true,
      );
      assert.equal(existsSync(retiredSkillDir), false);
      const retiredBackups = await readdir(path.join(
        interpreterHome,
        ".interpreter-managed-skill-backups",
        "retired-app-skill",
      ));
      assert.equal(retiredBackups.length, 1);
      assert.equal(
        await readFile(path.join(
          interpreterHome,
          ".interpreter-managed-skill-backups",
          "retired-app-skill",
          retiredBackups[0],
          "SKILL.md",
        ), "utf8"),
        "retired but edited\n",
      );
    } finally {
      await rm(interpreterHome, { recursive: true, force: true });
    }
  });

  test("handles stdin EPIPE errors without uncaught exceptions", async () => {
    const childEvents = new EventEmitter();
    const child = Object.assign(childEvents, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;

    const transport = new StdioJsonRpcTransport(() => {
      queueMicrotask(() => {
        childEvents.emit("spawn");
      });
      return child;
    }, "/tmp/codex-home-test");

    // Keep the test scoped to transport behavior.

    (transport as any).resolveCodexHome = async () => "/tmp/codex-home-test";
    (transport as any).resolveInterpreterCliBinary = async () => "/tmp/interpreter";
    (transport as any).installBundledSkills = async () => {};
    let closeError: Error | undefined;
    transport.onClose((error) => {
      closeError = error;
    });

    await transport.start();
    transport.send('{"id":1,"method":"initialize","params":{}}');

    const epipeError = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });
    child.stdin.emit("error", epipeError);
    childEvents.emit("close", 1);

    await waitFor(() => closeError !== undefined);
    assert.match(closeError?.message ?? "", /codex app-server exited \(1\)/);
  });

  test("waits for child close when stopping the app-server process", async () => {
    const { child, childEvents } = createMockChildProcess();
    let killCalled = false;
    let childClosed = false;
    (child as any).kill = () => {
      killCalled = true;
      setTimeout(() => {
        childClosed = true;
        childEvents.emit("close", 0);
      }, 5);
      return true;
    };

    const transport = createTestTransport(child, childEvents);

    await transport.start();
    await transport.stop();

    assert.equal(killCalled, true);
    assert.equal(childClosed, true);
  });

  test("runs MCP CLI commands through the interpreter binary with isolated homes", async () => {
    const transport = new StdioJsonRpcTransport(() => {
      throw new Error("app-server spawn should not run for CLI commands");
    }, "/tmp/codex-home-test");
    let resolvedInterpreterCli = false;
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const binaryArgv = [path.basename(process.argv[1] || ''), ...process.argv.slice(2)];",
      "const argv = binaryArgv[0] === 'capture.cjs' ? binaryArgv.slice(1) : binaryArgv;",
      "fs.writeFileSync(process.env.INTERPRETER_CLI_TEST_CAPTURE, JSON.stringify({",
      "argv,",
      "env: {",
      "CODEX_HOME: process.env.CODEX_HOME,",
      "INTERPRETER_HOME: process.env.INTERPRETER_HOME,",
      "OPEN_INTERPRETER_HOME: process.env.OPEN_INTERPRETER_HOME,",
      "INTERPRETER_DISABLE_SYSTEM_IMPORT: process.env.INTERPRETER_DISABLE_SYSTEM_IMPORT,",
      "HOME: process.env.HOME,",
      "NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE",
      "}",
      "}));",
      "process.exit(0);",
    ].join("\n");

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "interpreter-cli-runner-"));
    const isWindows = process.platform === "win32";
    const interpreterBinaryName = isWindows ? "interpreter.exe" : "interpreter";
    const interpreterShim = path.join(tempRoot, interpreterBinaryName);
    const captureModulePath = path.join(tempRoot, "capture.cjs");
    const codexHome = path.join(tempRoot, "codex-home");
    const capturePath = path.join(tempRoot, "capture.json");
    const originalCapturePath = process.env.INTERPRETER_CLI_TEST_CAPTURE;
    if (!isWindows) {
      await writeFile(interpreterShim, `#!/bin/sh\nexec "${process.execPath}" "${captureModulePath}" "$@"\n`);
      await chmod(interpreterShim, 0o755);
    }
    await writeFile(captureModulePath, script);

    try {
      process.env.INTERPRETER_CLI_TEST_CAPTURE = capturePath;
      (transport as any).resolveCodexHome = async () => codexHome;
      (transport as any).resolveInterpreterCliBinary = async () => {
        resolvedInterpreterCli = true;
        return isWindows ? process.execPath : interpreterShim;
      };
      const cliArgs = isWindows ? [captureModulePath, "mcp", "list", "--json"] : ["mcp", "list", "--json"];
      await transport.runCodexCli(cliArgs);
      const payload = JSON.parse(await readFile(capturePath, "utf8")) as {
        argv: string[];
        env: Record<string, string | undefined>;
      };

      assert.equal(resolvedInterpreterCli, true);
      assert.deepEqual(payload.argv, ["mcp", "list", "--json"]);
      assert.equal(payload.env.CODEX_HOME, codexHome);
      assert.equal(payload.env.INTERPRETER_HOME, codexHome);
      assert.equal(payload.env.OPEN_INTERPRETER_HOME, codexHome);
      assert.equal(payload.env.INTERPRETER_DISABLE_SYSTEM_IMPORT, "1");
      assert.equal(payload.env.HOME, path.join(codexHome, "home"));
      assert.equal(payload.env.NODE_V8_COVERAGE, undefined);
    } finally {
      if (originalCapturePath === undefined) {
        delete process.env.INTERPRETER_CLI_TEST_CAPTURE;
      } else {
        process.env.INTERPRETER_CLI_TEST_CAPTURE = originalCapturePath;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("injects bundled runtime config when spawning interpreter app-server", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      codexApprovalPolicy: "on-request",
      codexSandboxMode: "workspace-write",
      codexNetworkAccess: false,
    });

    const { child, childEvents } = createMockChildProcess();
    let spawnCommand = "";
    let spawnArgs: string[] = [];
    const logs: string[] = [];
    const originalConsoleLog = console.log;

    const transport = new StdioJsonRpcTransport((command, args, env) => {
      spawnCommand = command;
      spawnArgs = args;
      queueMicrotask(() => {
        childEvents.emit("spawn");
      });
      return child;
    }, "/tmp/codex-home-test");

    (transport as any).resolveCodexHome = async () => "/tmp/codex-home-test";
    (transport as any).resolveInterpreterCliBinary = async () => "/tmp/interpreter";
    (transport as any).installBundledSkills = async () => {};
    try {
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      await transport.start();

      const strippedSystemSkillsConfig = `skills={config=[${[
        path.join("/tmp/codex-home-test", "skills", ".system", "imagegen", "SKILL.md"),
        path.join("/tmp/codex-home-test", "skills", ".system", "openai-docs", "SKILL.md"),
        path.join("/tmp/codex-home-test", "skills", ".system", "plugin-creator", "SKILL.md"),
      ].map((skillPath) => `{path=${JSON.stringify(skillPath)},enabled=false}`).join(",")}]}`;

      assert.equal(spawnCommand, "/tmp/interpreter");
      assert.deepEqual(
        spawnArgs.slice(0, 5),
        [
          "app-server",
          "-c",
          strippedSystemSkillsConfig,
          "-c",
          'approval_policy="on-request"',
        ],
      );
      assert.equal(spawnArgs.some((arg) => arg.startsWith("sandbox_mode=")), false);
      assert.equal(
        spawnArgs.some((arg) => arg.startsWith("sandbox_workspace_write.")),
        false,
      );
      assert.equal(spawnArgs.includes("--sandbox"), false);
      assert.equal(spawnArgs.includes("--ask-for-approval"), false);
      assert.equal(spawnArgs[0], "app-server");
      assert.equal(spawnArgs.includes("--enable"), false);
      assert.equal(spawnArgs.includes("features.skills=true"), false);
      assert.ok(
        !spawnArgs.some((arg) => arg.startsWith('mcp_servers={interpreter=')),
        'shared app-server runtime must not inject the interpreter MCP server',
      );
      assert.ok(
        spawnArgs.includes("mcp_servers={}"),
        'shared app-server runtime must start with an empty MCP table',
      );
      assert.ok(
        spawnArgs.includes('check_for_update_on_startup=false'),
        'bundled signed binary must never self-update',
      );
      assert.ok(
        logs.some((line) => line.startsWith("[interpreter-server] resolved app-server binary path:")),
      );
      assert.equal(
        logs.some((line) => line.startsWith("[codex-server]")),
        false,
      );
    } finally {
      console.log = originalConsoleLog;
      childEvents.emit("close", 0);
    }
  });

  test("does not serialize MCP secrets into codex spawn args", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      mcpServers: {
        remoteSecret: {
          id: "remoteSecret",
          name: "Remote Secret",
          transport: "http",
          url: "https://remote.example.com/mcp",
          headers: { Authorization: "Bearer top-secret-token" },
          state: {
            status: "connected",
            tools: [
              {
                name: "issue_942_huge_spawn_tool",
                description: "ISSUE_942_SPAWN_ARG_TOOL_DESCRIPTION_SHOULD_NOT_REACH_MODEL",
              },
            ],
          },
          enabled: true,
          createdAt: 1,
        },
        localSecret: {
          id: "localSecret",
          name: "Local Secret",
          transport: "stdio",
          command: "/usr/bin/env",
          env: { API_KEY: "stdio-secret-token" },
          enabled: true,
          createdAt: 1,
        },
      },
      codexApprovalPolicy: "on-request",
      codexSandboxMode: "workspace-write",
      codexNetworkAccess: false,
    } as any);

    const { child, childEvents } = createMockChildProcess();
    let spawnArgs: string[] = [];

    const transport = new StdioJsonRpcTransport((_command, args, _env) => {
      spawnArgs = args;
      queueMicrotask(() => {
        childEvents.emit("spawn");
      });
      return child;
    }, "/tmp/codex-home-test");

    (transport as any).resolveCodexHome = async () => "/tmp/codex-home-test";
    (transport as any).resolveInterpreterCliBinary = async () => "/tmp/interpreter";
    (transport as any).installBundledSkills = async () => {};

    try {
      await transport.start();

      const spawnArgBlob = spawnArgs.join(" ");
      assert.equal(spawnArgBlob.includes("top-secret-token"), false);
      assert.equal(spawnArgBlob.includes("stdio-secret-token"), false);
      assert.equal(spawnArgBlob.includes("remote.example.com"), false);
      assert.equal(spawnArgBlob.includes("/usr/bin/env"), false);
      assert.equal(spawnArgBlob.includes("issue_942_huge_spawn_tool"), false);
      assert.equal(
        spawnArgBlob.includes("ISSUE_942_SPAWN_ARG_TOOL_DESCRIPTION_SHOULD_NOT_REACH_MODEL"),
        false,
      );
    } finally {
      childEvents.emit("close", 0);
    }
  });

  test("keeps support issue 1390 MCP configs out of shared app-server startup", async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      mcpServers: {
        linear: {
          id: "linear",
          name: "Linear",
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          enabled: true,
          createdAt: 1,
          lastConnectionFailure: {
            error: "Missing or invalid access token",
            needsAuth: true,
            updatedAt: 2,
          },
        },
        notion: {
          id: "notion",
          name: "Notion",
          transport: "http",
          url: "https://mcp.notion.com/mcp",
          enabled: true,
          createdAt: 1,
          lastConnectionFailure: {
            error: "Missing or invalid access token",
            needsAuth: true,
            updatedAt: 2,
          },
        },
      },
      codexApprovalPolicy: "never",
      codexSandboxMode: "workspace-write",
      codexNetworkAccess: true,
    } as any);

    const { child, childEvents } = createMockChildProcess();
    let spawnCommand = "";
    let spawnArgs: string[] = [];

    const transport = new StdioJsonRpcTransport((command, args) => {
      spawnCommand = command;
      spawnArgs = args;
      queueMicrotask(() => {
        childEvents.emit("spawn");
      });
      return child;
    }, "/tmp/codex-home-test");

    (transport as any).resolveCodexHome = async () => "/tmp/codex-home-test";
    (transport as any).resolveInterpreterCliBinary = async () => "/tmp/interpreter";
    (transport as any).installBundledSkills = async () => {};

    try {
      await transport.start();

      const spawnArgBlob = spawnArgs.join(" ");
      assert.equal(spawnCommand, "/tmp/interpreter");
      assert.ok(spawnArgs.includes("mcp_servers={}"));
      assert.equal(spawnArgBlob.includes("mcp.linear.app"), false);
      assert.equal(spawnArgBlob.includes("mcp.notion.com"), false);
      assert.equal(spawnArgBlob.includes("invalid access token"), false);
      assert.equal(spawnArgs[0], "app-server");
    } finally {
      childEvents.emit("close", 0);
    }
  });

  test("uses and caches the shared OIX runtime resolver", async () => {
    const resourcesRoot = await mkdtemp(path.join(os.tmpdir(), "interpreter-cli-resource-"));
    const binaryName = process.platform === "win32" ? "interpreter.exe" : "interpreter";
    const packagedInterpreterPath = path.join(resourcesRoot, "oix", "bin", binaryName);
    await mkdir(path.dirname(packagedInterpreterPath), { recursive: true });
    await writeFile(packagedInterpreterPath, "fake");
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

    try {
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        writable: true,
        value: resourcesRoot,
      });

      let resolverCalls = 0;
      const transport = new StdioJsonRpcTransport(
        () => {
          throw new Error("spawn should not run while resolving interpreter CLI binary");
        },
        "/tmp/codex-home-test",
        undefined,
        async () => {
          resolverCalls += 1;
          return {
            binaryPath: packagedInterpreterPath,
            packageDir: path.dirname(path.dirname(packagedInterpreterPath)),
            source: "installed",
            version: "0.0.34",
          };
        },
      );

      assert.equal(
        await (transport as any).resolveInterpreterCliBinary(),
        packagedInterpreterPath,
      );
      assert.equal(
        await (transport as any).resolveInterpreterCliBinary(),
        packagedInterpreterPath,
      );
      assert.equal(resolverCalls, 1);
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        writable: true,
        value: originalResourcesPath,
      });
      await rm(resourcesRoot, { recursive: true, force: true });
    }
  });

  test("uses the shared Windows OIX runtime for support issues 1361 and 1395", async () => {
    const resourcesRoot = await mkdtemp(path.join(os.tmpdir(), "interpreter-runtime-resource-"));
    const packagedInterpreterPath = path.join(resourcesRoot, "oix", "bin", "interpreter.exe");
    await mkdir(path.dirname(packagedInterpreterPath), { recursive: true });
    await writeFile(packagedInterpreterPath, "fake");
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const originalPlatform = process.platform;
    const originalArch = process.arch;

    try {
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        writable: true,
        value: resourcesRoot,
      });
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });
      Object.defineProperty(process, "arch", {
        configurable: true,
        value: "x64",
      });

      const transport = new StdioJsonRpcTransport(
        () => {
          throw new Error("spawn should not run while resolving interpreter runtime");
        },
        "/tmp/codex-home-test",
        undefined,
        async () => ({
          binaryPath: packagedInterpreterPath,
          packageDir: path.dirname(path.dirname(packagedInterpreterPath)),
          source: "installed",
          version: "0.0.34",
        }),
      );

      assert.equal(
        await (transport as any).resolveInterpreterCliBinary(),
        packagedInterpreterPath,
      );
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        writable: true,
        value: originalResourcesPath,
      });
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(process, "arch", {
        configurable: true,
        value: originalArch,
      });
      await rm(resourcesRoot, { recursive: true, force: true });
    }
  });

  test("does not resolve Windows interpreter binaries from packaged app.asar source paths", async () => {
    const resourcesRoot = await mkdtemp(path.join(os.tmpdir(), "interpreter-runtime-asar-resource-"));
    const appAsarInterpreterPath = path.join(
      resourcesRoot,
      "app.asar",
      "resources",
      "oix",
      "win32-x64",
      "bin",
      "interpreter.exe",
    );
    await mkdir(path.dirname(appAsarInterpreterPath), { recursive: true });
    await writeFile(appAsarInterpreterPath, "fake");

    const originalArgvScript = process.argv[1];
    const originalCwd = process.cwd();
    const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const originalPlatform = process.platform;
    const originalArch = process.arch;

    try {
      process.argv[1] = path.join(resourcesRoot, "app.asar", "dist-electron", "electron", "main.cjs");
      process.chdir(resourcesRoot);
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        writable: true,
        value: resourcesRoot,
      });
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });
      Object.defineProperty(process, "arch", {
        configurable: true,
        value: "x64",
      });

      const transport = new StdioJsonRpcTransport(() => {
        throw new Error("spawn should not run while resolving interpreter runtime");
      }, "/tmp/codex-home-test");

      // A dev checkout may legitimately contain resources/oix/<platform>-<arch>/
      // (e.g. Windows CI after the OIX download step), so resolution succeeding
      // is fine. The invariant is that no app.asar path is resolved or reported.
      let resolved: string | null = null;
      try {
        resolved = await (transport as any).resolveInterpreterCliBinary();
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes(
            "No valid bundled Open Interpreter runtime",
          ),
        );
        assert.ok(!error.message.includes("app.asar"));
      }
      if (resolved !== null) {
        assert.ok(!resolved.includes(`${path.sep}app.asar${path.sep}`));
      }
    } finally {
      process.argv[1] = originalArgvScript;
      process.chdir(originalCwd);
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        writable: true,
        value: originalResourcesPath,
      });
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(process, "arch", {
        configurable: true,
        value: originalArch,
      });
      await rm(resourcesRoot, { recursive: true, force: true });
    }
  });

  test("fails startup when bundled skill install hits ENOENT", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);

    (transport as any).installBundledSkills = async () => {
      throw Object.assign(new Error("ENOENT: missing bundled skill file"), {
        code: "ENOENT",
      });
    };

    try {
      await assert.rejects(
        transport.start(),
        /ENOENT: missing bundled skill file/,
      );
    } finally {
      childEvents.emit("close", 0);
    }
  });

  test("forwards interpreter stdout events without mirroring them to console logs", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);
    const stdoutLogs: string[] = [];
    const messages: string[] = [];
    const originalConsoleLog = console.log;

    transport.onMessage((message) => {
      messages.push(message);
    });

    console.log = (...args: any[]) => {
      stdoutLogs.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      await transport.start();

      const payloads = [
        '{"method":"item/agentMessage/delta","params":{"threadId":"thr_1","turnId":"turn_1","itemId":"msg_1","delta":"hola"}}',
        '{"method":"thread/started","params":{"thread":{"id":"thr_1"}}}',
        JSON.stringify({
          id: 6,
          result: {
            data: [
              {
                id: "thr_1",
                status: { type: "idle" },
                updatedAt: 1774683599,
                cwd: "D:\\Dev\\Babel-Player",
                path: "\\\\?\\C:\\Users\\ander\\AppData\\Roaming\\interpreter\\codex-home\\a.jsonl",
                preview: `VERY_LONG_PREVIEW_TEXT_MARKER${"x".repeat(300)}`,
              },
            ],
          },
        }),
      ];

      for (const payload of payloads) {
        child.stdout.write(`${payload}\n`);
      }

      await waitFor(() => messages.length === payloads.length);
      assert.deepEqual(messages, payloads);

      const serverStdoutLogs = stdoutLogs.filter((line) =>
        line.includes("[interpreter-server:stdout]"),
      );
      assert.equal(serverStdoutLogs.length, 0);
    } finally {
      console.log = originalConsoleLog;
      childEvents.emit("close", 0);
    }
  });

  test("uses the first stderr line as the close preview", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);
    let closeError: Error | undefined;

    transport.onClose((error) => {
      closeError = error;
    });

    await transport.start();

    child.stderr.write("failed to bind stdio bridge on startup\n");
    child.stderr.write("secondary detail that should not be surfaced\n");
    childEvents.emit("close", 1);

    await waitFor(() => closeError !== undefined);
    assert.equal(
      closeError?.message,
      "codex app-server exited (1): stderr: failed to bind stdio bridge on startup",
    );
  });

  test("uses a structured stdout message as the close preview when stderr is empty", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);
    let closeError: Error | undefined;

    transport.onClose((error) => {
      closeError = error;
    });

    await transport.start();

    child.stdout.write('{"method":"thread/updated","params":{"threadId":"thr_1"}}\n');
    child.stdout.write(`${JSON.stringify(makeStreamErrorNotification("internal_server_error", {
      codexErrorInfo: "internalServerError",
    }))}\n`);
    childEvents.emit("close", 1);

    await waitFor(() => closeError !== undefined);
    assert.equal(
      closeError?.message,
      "codex app-server exited (1): stdout: internal_server_error",
    );
  });

  test("keeps a structured stdout path preview when stderr is empty", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);
    let closeError: Error | undefined;

    transport.onClose((error) => {
      closeError = error;
    });

    await transport.start();

    child.stdout.write(`${JSON.stringify(makeStreamErrorNotification("Workspace: C:\\Users\\alice\\secret\\project"))}\n`);
    childEvents.emit("close", 1);

    await waitFor(() => closeError !== undefined);
    assert.equal(
      closeError?.message,
      "codex app-server exited (1): stdout: Workspace: C:\\Users\\alice\\secret\\project",
    );
  });

  test("keeps full structured stdout detail without truncation", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);
    let closeError: Error | undefined;

    transport.onClose((error) => {
      closeError = error;
    });

    await transport.start();

    const longDetail = `child exited before initialize: ${"x".repeat(300)}`;
    child.stdout.write(`${JSON.stringify(makeStreamErrorNotification(longDetail))}\n`);
    childEvents.emit("close", 1);

    await waitFor(() => closeError !== undefined);
    assert.equal(
      closeError?.message,
      `codex app-server exited (1): stdout: ${longDetail}`,
    );
  });

  test("falls back to recent stdout diagnostics when no structured preview is available", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);
    let closeError: Error | undefined;

    transport.onClose((error) => {
      closeError = error;
    });

    await transport.start();

    child.stdout.write("Workspace: C:\\Users\\alice\\secret\\project\n");
    child.stdout.write("child exited before initialize\n");
    childEvents.emit("close", 1);

    await waitFor(() => closeError !== undefined);
    assert.match(
      closeError?.message ?? "",
      /codex app-server exited \(1\): recent stdout lines:/,
    );
    assert.match(closeError?.message ?? "", /Workspace: C:\\Users\\alice\\secret\\project/);
    assert.match(closeError?.message ?? "", /child exited before initialize/);
  });

  test("redacts auth-bearing data from recent stdout diagnostics", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);
    let closeError: Error | undefined;

    transport.onClose((error) => {
      closeError = error;
    });

    await transport.start();

    child.stdout.write(
      `${JSON.stringify({
        id: 32,
        result: {
          config: {
            authToken: "token-123",
            model_providers: {
              "openai-api": {
                experimental_bearer_token: "eyJabc.def.ghi",
                http_headers: {
                  Authorization: "Bearer fixture-secret-openai-key",
                  "x-api-key": "fixture-secret-openai-key",
                },
              },
            },
          },
        },
      })}\n`,
    );
    child.stdout.write("child exited before initialize\n");
    childEvents.emit("close", 1);

    await waitFor(() => closeError !== undefined);
    assert.match(closeError?.message ?? "", /recent stdout lines:/);
    assert.match(closeError?.message ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(closeError?.message ?? "", /eyJabc\.def\.ghi/);
    assert.doesNotMatch(closeError?.message ?? "", /fixture-secret-openai-key/);
    assert.doesNotMatch(closeError?.message ?? "", /token-123/);
  });

  test("truncates oversized recent stdout diagnostics after sanitization", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);
    let closeError: Error | undefined;

    transport.onClose((error) => {
      closeError = error;
    });

    await transport.start();

    child.stdout.write(
      `${JSON.stringify({
        id: 32,
        result: {
          config: {
            model_providers: {
              "openai-api": {
                http_headers: {
                  Authorization: "Bearer fixture-secret-openai-key",
                },
              },
            },
            giant: "x".repeat(5000),
          },
        },
      })}\n`,
    );
    childEvents.emit("close", 1);

    await waitFor(() => closeError !== undefined);
    assert.match(closeError?.message ?? "", /recent stdout lines:/);
    assert.match(closeError?.message ?? "", /… \[truncated \d+ chars\]/);
    assert.match(closeError?.message ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(closeError?.message ?? "", /fixture-secret-openai-key/);
  });

  test("caps recent stdout diagnostics and reports omitted older lines", async () => {
    const { child, childEvents } = createMockChildProcess();
    const transport = createTestTransport(child, childEvents);
    let closeError: Error | undefined;

    transport.onClose((error) => {
      closeError = error;
    });

    await transport.start();

    for (let index = 1; index <= 12; index += 1) {
      child.stdout.write(`stdout line ${index}\n`);
    }
    childEvents.emit("close", 1);

    await waitFor(() => closeError !== undefined);
    assert.match(closeError?.message ?? "", /recent stdout lines:/);
    assert.match(
      closeError?.message ?? "",
      /\[showing last 8 lines; 4 older lines omitted\]/,
    );
    assert.doesNotMatch(closeError?.message ?? "", /(?:^|\n)stdout line 1(?:\n|$)/);
    assert.doesNotMatch(closeError?.message ?? "", /(?:^|\n)stdout line 4(?:\n|$)/);
    assert.match(closeError?.message ?? "", /(?:^|\n)stdout line 5(?:\n|$)/);
    assert.match(closeError?.message ?? "", /(?:^|\n)stdout line 12(?:\n|$)/);
  });
});

// Recency policy for stderr in process-exit messages. This is the deterministic
// guard against the issue 1390 misattribution: a process that exits for an
// unrelated reason (e.g. a hosted-provider stall) must not be blamed on a stderr
// line that predates the exit by many seconds.
describe("assessCloseStderr", () => {
  const WINDOW = 5_000;

  test("treats stderr emitted just before exit as the cause", () => {
    assert.deepEqual(assessCloseStderr("panic: boom", 100, WINDOW), {
      kind: "recent",
      detail: "stderr: panic: boom",
    });
  });

  test("includes stderr exactly at the window boundary", () => {
    assert.deepEqual(assessCloseStderr("panic: boom", WINDOW, WINDOW), {
      kind: "recent",
      detail: "stderr: panic: boom",
    });
  });

  test("demotes stderr older than the window to a labeled breadcrumb (issue 1390)", () => {
    const staleMcpLine =
      "ERROR rmcp::transport::worker: worker quit with fatal: AuthRequired Missing or invalid access token";
    assert.deepEqual(assessCloseStderr(staleMcpLine, 26_000, WINDOW), {
      kind: "stale",
      detail: `last stderr 26s before exit (likely unrelated): ${staleMcpLine}`,
    });
  });

  test("classifies one millisecond past the window as stale", () => {
    const result = assessCloseStderr("old line", WINDOW + 1, WINDOW);
    assert.equal(result.kind, "stale");
  });

  test("surfaces stderr with unknown age rather than hiding a possible crash line", () => {
    assert.deepEqual(assessCloseStderr("segfault", null, WINDOW), {
      kind: "recent",
      detail: "stderr: segfault",
    });
  });

  test("reports no detail when there is no stderr preview", () => {
    assert.deepEqual(assessCloseStderr(null, 26_000, WINDOW), { kind: "none" });
    assert.deepEqual(assessCloseStderr("", 100, WINDOW), { kind: "none" });
  });

  test("floors the reported stale age at one second", () => {
    // 300ms past a tiny 100ms window rounds to 0s, but the label must read >= 1s.
    assert.deepEqual(assessCloseStderr("old line", 300, 100), {
      kind: "stale",
      detail: "last stderr 1s before exit (likely unrelated): old line",
    });
  });

  test("applies the default window when none is passed", () => {
    assert.equal(assessCloseStderr("x", 1_000).kind, "recent");
    assert.equal(assessCloseStderr("x", 60_000).kind, "stale");
  });
});
