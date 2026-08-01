import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTabManager } from "../../../server/agentTabManager";
import {
  setInterpreterHomeDir,
  clearConfigCache,
  setConfigOverride,
  type AppConfig,
} from "../../../server/configStore";
import { setToolManager } from "../../../server/tools/toolManagerAccessor";
import { ToolManager } from "../../../server/tools/toolManager";
import type { ToolServerStatus } from "../../../server/tools/toolTypes";
import { startInterpreterCliFileBridge } from "../../../server/utils/interpreterCliFileBridge";
import {
  buildInterpreterCliShellEnvironmentPolicy,
  buildInterpreterCliServerConnection,
  ensureInterpreterCliLauncher,
  getInterpreterCliBridgeDir,
  INTERPRETER_CALLER_TOKEN_ENV,
  INTERPRETER_CLI_SERVER_CONNECTION_ENV,
} from "../../../server/utils/interpreterCliRuntime";
import type { JsonValue } from "../../../server/handlers/codex-generated-types/serde_json/JsonValue";
import { CodexTestHarness } from "./test-fixtures/codex-test-harness";
import type { ScriptedScenario } from "./test-fixtures/scripted-local-provider";

const describeIfCodex = CodexTestHarness.appServerAvailable ? describe : describe.skip;
const NATIVE_FILE_TOOL_TIMEOUT_MS = 5_000;

function nativeShellToolCall(
  command: string,
  workdir: string,
  timeoutMs = NATIVE_FILE_TOOL_TIMEOUT_MS,
  platform: NodeJS.Platform = process.platform,
): { name: string; args: Record<string, unknown> } {
  // OIX intentionally falls back to the PowerShell-backed handler on Windows
  // hosts without ConPTY. shell_command remains dispatchable when unified exec
  // is available, so it is the portable Windows contract.
  if (platform === "win32") {
    return {
      name: "shell_command",
      args: {
        command,
        workdir,
        timeout_ms: timeoutMs,
      },
    };
  }

  return {
    name: "exec_command",
    args: {
      cmd: command,
      workdir,
      yield_time_ms: timeoutMs,
    },
  };
}

const MODELS_RESPONSE = {
  object: "list",
  data: [{ id: "test-model", object: "model", created: 0, owned_by: "local" }],
};

function chatSseData(data: object | "[DONE]"): string {
  return data === "[DONE]"
    ? "data: [DONE]\n\n"
    : `data: ${JSON.stringify(data)}\n\n`;
}

function chatToolCallStream(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): string {
  const id = `${callId}_completion`;
  const created = 0;
  return [
    chatSseData({
      id,
      object: "chat.completion.chunk",
      created,
      model: "test-model",
      choices: [{
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      }],
    }),
    chatSseData({
      id,
      object: "chat.completion.chunk",
      created,
      model: "test-model",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: callId,
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(args),
            },
          }],
        },
        finish_reason: null,
      }],
    }),
    chatSseData({
      id,
      object: "chat.completion.chunk",
      created,
      model: "test-model",
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
      }],
    }),
    chatSseData("[DONE]"),
  ].join("");
}

function chatAssistantMessageStream(text: string): string {
  const id = "chatcmpl_final";
  const created = 0;
  return [
    chatSseData({
      id,
      object: "chat.completion.chunk",
      created,
      model: "test-model",
      choices: [{
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      }],
    }),
    chatSseData({
      id,
      object: "chat.completion.chunk",
      created,
      model: "test-model",
      choices: [{
        index: 0,
        delta: { content: text },
        finish_reason: null,
      }],
    }),
    chatSseData({
      id,
      object: "chat.completion.chunk",
      created,
      model: "test-model",
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop",
      }],
    }),
    chatSseData("[DONE]"),
  ].join("");
}

function getChatCompletionRequests(harness: CodexTestHarness) {
  return harness.fakeServer
    .getCapturedRequests()
    .filter((request) => request.path.includes("/chat/completions"));
}

function findToolMessage(body: unknown, callId: string): unknown {
  const messages = (body as { messages?: unknown[] } | undefined)?.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }

  return messages.find((item) => {
    const typedItem = item as { role?: string; tool_call_id?: string };
    return typedItem.role === "tool" && typedItem.tool_call_id === callId;
  });
}

function createTestConfig(): AppConfig {
  return {
    agents: {},
    globalDisabledTools: [],
    codexApprovalPolicy: "never",
    codexSandboxMode: "danger-full-access",
    codexNetworkAccess: false,
  };
}

function uniqueBridgePort(): number {
  return 40_000 + Math.floor(Math.random() * 20_000);
}

function createInterpreterCliThreadConfig(
  callerToken: string,
  cliEnv: NodeJS.ProcessEnv,
  workspace: string,
): Record<string, JsonValue> {
  const serverConnection = cliEnv[INTERPRETER_CLI_SERVER_CONNECTION_ENV];
  return {
    shell_environment_policy: buildInterpreterCliShellEnvironmentPolicy(
      callerToken,
      { ...process.env, ...cliEnv },
      process.platform,
      workspace,
      serverConnection,
    ) as unknown as JsonValue,
  };
}

afterEach(() => {
  clearConfigCache();
  agentTabManager.clearAll();
  setInterpreterHomeDir(null);
  setToolManager(new ToolManager());
});

test("builds Windows Interpreter CLI tool commands for OIX exec_command", () => {
  const command = interpreterCliToolCommand(
    "C:\\Interpreter Data\\runtime\\interpreter-cli\\bin\\interpreter-app.cmd",
    "builtin-mcp-management",
    "mcp_add_server",
    '{"name":"Filesystem","transport":"stdio","command":"node"}',
    "win32",
  );

  expect(command).toBe(
    "& 'C:\\Interpreter Data\\runtime\\interpreter-cli\\bin\\interpreter-app.ps1' tools 'builtin-mcp-management' 'mcp_add_server' --json '{\"name\":\"Filesystem\",\"transport\":\"stdio\",\"command\":\"node\"}'",
  );
});

test("uses OIX's portable shell_command contract on Windows", () => {
  expect(nativeShellToolCall(
    "Get-Content fixture.txt",
    "C:\\workspace",
    5_000,
    "win32",
  )).toEqual({
    name: "shell_command",
    args: {
      command: "Get-Content fixture.txt",
      workdir: "C:\\workspace",
      timeout_ms: 5_000,
    },
  });
});

describeIfCodex("local provider integration - native file tools", () => {
  test("should_create_a_file_via_native_shell", async () => {
    setConfigOverride(createTestConfig());

    const workspace = mkdtempSync(join(tmpdir(), "codex-create-file-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-create-file-"));
    const harness = new CodexTestHarness(codexHome);
    const targetFile = join(workspace, "created-by-tool.txt");
    const callId = "call_create_file";
    const command = createFixtureFileCommand();
    const shellCall = nativeShellToolCall(command, workspace);

    const scenario: ScriptedScenario = {
      name: "exec-command-create-file",
      modelsResponse: MODELS_RESPONSE,
      responseBehavior: {
        type: "sequence",
        responses: [
          {
            type: "sse",
            body: chatToolCallStream(callId, shellCall.name, shellCall.args),
          },
          {
            type: "sse",
            body: chatAssistantMessageStream("Created the file."),
          },
        ],
      },
    };

    try {
      await harness.start("ollama", scenario);

      const threadId = await harness.client.startThread(
        "test-model",
        harness.modelProvider,
        null,
        workspace,
      );
      const turn = await harness.client.startTurn({
        threadId,
        message: "Create created-by-tool.txt in the workspace.",
        model: "test-model",
      });

      const completed = await harness.recorder.waitForTurnCompleted(turn.id, 60_000);
      expect(completed).toBeTruthy();
      if ("turn" in completed.params) {
        expect(completed.params.turn.status).toBe("completed");
      }

      expect(readFileSync(targetFile, "utf8")).toBe("hello from tool\n");

      const chatRequests = getChatCompletionRequests(harness);
      expect(chatRequests).toHaveLength(2);
      const toolOutput = findToolMessage(chatRequests[1]?.body, callId);
      expect(toolOutput).toBeTruthy();
    } finally {
      await harness.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  test("should_install_and_use_an_mcp_server_through_interpreter_app_cli", async () => {
    setConfigOverride(createTestConfig());

    const workspace = mkdtempSync(join(tmpdir(), "codex-mcp-cli-workspace-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-mcp-cli-"));
    const interpreterHome = mkdtempSync(join(tmpdir(), "interpreter-home-mcp-cli-"));
    const callerToken = "agtok_mcp_cli_agent";
    const bridgePort = uniqueBridgePort();
    setInterpreterHomeDir(interpreterHome);
    const bridge = await startInterpreterCliFileBridge(bridgePort);
    expect(bridge.bridgeDir).toBe(getInterpreterCliBridgeDir(bridgePort));
    const toolCalls: string[] = [];
    const installedServers = new Set<string>();
    const mcpServer = (): ToolServerStatus => ({
      id: "filesystem",
      name: "Filesystem",
      state: {
        status: "connected",
        tools: [
          {
            name: "read_file",
            description: "Read a file from the configured workspace.",
            inputSchema: {
              type: "object",
              required: ["path"],
              properties: {
                path: { type: "string" },
              },
            },
          },
        ],
        resources: [],
        prompts: [],
      },
    });
    const builtinMcpManagementServer: ToolServerStatus = {
      id: "builtin-mcp-management",
      name: "MCP Management",
      state: {
        status: "connected",
        tools: [
          {
            name: "mcp_add_server",
            description: "Add a local MCP server.",
            inputSchema: {
              type: "object",
              required: ["name", "transport", "command"],
              properties: {
                name: { type: "string" },
                transport: { type: "string" },
                command: { type: "string" },
                args: { type: "array", items: { type: "string" } },
              },
            },
          },
          {
            name: "mcp_refresh_tools",
            description: "Refresh MCP tools.",
            inputSchema: {
              type: "object",
              properties: {
                reason: { type: "string" },
              },
            },
          },
        ],
        resources: [],
        prompts: [],
      },
    };

    const launcherPath = ensureInterpreterCliLauncher(process.platform);
    setToolManager({
      async listAllToolServers() {
        return installedServers.has("filesystem") ? [mcpServer()] : [];
      },
      async listDisplayToolServers() {
        return this.listAllToolServers();
      },
      async getToolServer(serverId: string) {
        if (serverId === "builtin-mcp-management") {
          return builtinMcpManagementServer;
        }
        if (serverId === "filesystem" && installedServers.has("filesystem")) {
          return mcpServer();
        }
        return undefined;
      },
      async getToolServerIncludingHidden(serverId: string) {
        if (serverId === "builtin-mcp-management") {
          return builtinMcpManagementServer;
        }
        return this.getToolServer(serverId);
      },
      async callTool(serverId: string, toolName: string, args: Record<string, unknown>) {
        toolCalls.push(`${serverId}/${toolName}`);
        if (serverId === "builtin-mcp-management" && toolName === "mcp_add_server") {
          expect(args.name).toBe("Filesystem");
          expect(args.transport).toBe("stdio");
          installedServers.add("filesystem");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                status: "configured",
                serverId: "filesystem",
                message: "Added MCP server \"Filesystem\".",
              }),
            }],
            isError: false,
          };
        }
        if (serverId === "builtin-mcp-management" && toolName === "mcp_refresh_tools") {
          expect(args.reason).toBe("Refresh MCP tools");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                currentTurnToolsAvailable: true,
                nextTurnRequired: false,
              }),
            }],
            isError: false,
          };
        }
        if (serverId === "filesystem" && toolName === "read_file") {
          expect(args.path).toBe("fixture.txt");
          return {
            content: [{
              type: "text",
              text: "fixture contents from newly installed MCP",
            }],
            isError: false,
          };
        }
        throw new Error(`Unexpected tool call: ${serverId}/${toolName}`);
      },
    } as unknown as ToolManager);

    const cliEnv: NodeJS.ProcessEnv = {
      [INTERPRETER_CALLER_TOKEN_ENV]: callerToken,
      [INTERPRETER_CLI_SERVER_CONNECTION_ENV]: buildInterpreterCliServerConnection(bridgePort, {
        platform: process.platform,
        transport: "file",
      }),
    };
    const harness = new CodexTestHarness(codexHome, cliEnv);
    const installCallId = "call_install_mcp";
    const refreshCallId = "call_refresh_mcp";
    const useCallId = "call_use_mcp";
    const installArgs = JSON.stringify({
      name: "Filesystem",
      transport: "stdio",
      command: "node",
      args: ["fake-filesystem-server.js"],
    });
    const readArgs = JSON.stringify({ path: "fixture.txt" });
    const installCall = nativeShellToolCall(
      interpreterCliToolCommand(
        launcherPath,
        "builtin-mcp-management",
        "mcp_add_server",
        installArgs,
      ),
      workspace,
    );
    const refreshCall = nativeShellToolCall(
      interpreterCliToolCommand(
        launcherPath,
        "builtin-mcp-management",
        "mcp_refresh_tools",
        JSON.stringify({ reason: "Refresh MCP tools" }),
      ),
      workspace,
    );
    const useCall = nativeShellToolCall(
      interpreterCliToolCommand(
        launcherPath,
        "filesystem",
        "read_file",
        readArgs,
      ),
      workspace,
    );

    const scenario: ScriptedScenario = {
      name: "agent-installs-and-uses-mcp-through-interpreter-app",
      modelsResponse: MODELS_RESPONSE,
      responseBehavior: {
        type: "sequence",
        responses: [
          {
            type: "sse",
            body: chatToolCallStream(installCallId, installCall.name, installCall.args),
          },
          {
            type: "sse",
            body: chatToolCallStream(refreshCallId, refreshCall.name, refreshCall.args),
          },
          {
            type: "sse",
            body: chatToolCallStream(useCallId, useCall.name, useCall.args),
          },
          {
            type: "sse",
            body: chatAssistantMessageStream("Installed and used the filesystem MCP."),
          },
        ],
      },
    };

    try {
      await harness.start("ollama", scenario);

      const threadId = await harness.client.startThreadWithConfig(
        "test-model",
        harness.modelProvider,
        null,
        workspace,
        createInterpreterCliThreadConfig(callerToken, cliEnv, workspace),
      );
      agentTabManager.bindThread({
        agentId: "agent-mcp-cli",
        callerToken,
        threadId,
        workspacePath: workspace,
      });
      const turn = await harness.client.startTurn({
        threadId,
        message: "Install the filesystem MCP and read fixture.txt with it.",
        model: "test-model",
        cwd: workspace,
      });

      const completed = await harness.recorder.waitForTurnCompleted(turn.id, 60_000);
      expect(completed).toBeTruthy();
      if ("turn" in completed.params) {
        expect(completed.params.turn.status).toBe("completed");
      }

      expect(toolCalls).toEqual([
        "builtin-mcp-management/mcp_add_server",
        "builtin-mcp-management/mcp_refresh_tools",
        "filesystem/read_file",
      ]);

      const chatRequests = getChatCompletionRequests(harness);
      expect(chatRequests).toHaveLength(4);
      expect(JSON.stringify(findToolMessage(chatRequests[1]?.body, installCallId)))
        .toContain("filesystem");
      expect(JSON.stringify(findToolMessage(chatRequests[2]?.body, refreshCallId)))
        .toContain("nextTurnRequired");
      expect(JSON.stringify(findToolMessage(chatRequests[3]?.body, useCallId)))
        .toContain("fixture contents from newly installed MCP");
    } finally {
      await harness.stop();
      await bridge.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(interpreterHome, { recursive: true, force: true });
    }
  }, 90_000);

  test("should_install_and_use_an_http_mcp_server_through_interpreter_app_cli", async () => {
    setConfigOverride(createTestConfig());

    const workspace = mkdtempSync(join(tmpdir(), "codex-http-mcp-cli-workspace-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-http-mcp-cli-"));
    const interpreterHome = mkdtempSync(join(tmpdir(), "interpreter-home-http-mcp-cli-"));
    const callerToken = "agtok_http_mcp_cli_agent";
    const bridgePort = uniqueBridgePort();
    setInterpreterHomeDir(interpreterHome);
    const bridge = await startInterpreterCliFileBridge(bridgePort);
    expect(bridge.bridgeDir).toBe(getInterpreterCliBridgeDir(bridgePort));
    const toolCalls: string[] = [];
    const installedServers = new Set<string>();
    const serverUrl = "http://127.0.0.1:31337/mcp";
    const httpMcpServer = (): ToolServerStatus => ({
      id: "harmless-http",
      name: "Harmless HTTP",
      state: {
        status: "connected",
        tools: [
          {
            name: "ping",
            description: "Ping the harmless HTTP MCP.",
            inputSchema: {
              type: "object",
              required: ["value"],
              properties: {
                value: { type: "string" },
              },
            },
          },
        ],
        resources: [],
        prompts: [],
      },
    });
    const builtinMcpManagementServer: ToolServerStatus = {
      id: "builtin-mcp-management",
      name: "MCP Management",
      state: {
        status: "connected",
        tools: [
          {
            name: "mcp_add_server",
            description: "Add an HTTP MCP server.",
            inputSchema: {
              type: "object",
              required: ["name", "transport", "url"],
              properties: {
                name: { type: "string" },
                transport: { type: "string" },
                url: { type: "string" },
              },
            },
          },
          {
            name: "mcp_refresh_tools",
            description: "Refresh MCP tools.",
            inputSchema: {
              type: "object",
              properties: {
                reason: { type: "string" },
              },
            },
          },
        ],
        resources: [],
        prompts: [],
      },
    };

    const launcherPath = ensureInterpreterCliLauncher(process.platform);
    setToolManager({
      async listAllToolServers() {
        return installedServers.has("harmless-http") ? [httpMcpServer()] : [];
      },
      async listDisplayToolServers() {
        return this.listAllToolServers();
      },
      async getToolServer(serverId: string) {
        if (serverId === "builtin-mcp-management") {
          return builtinMcpManagementServer;
        }
        if (serverId === "harmless-http" && installedServers.has("harmless-http")) {
          return httpMcpServer();
        }
        return undefined;
      },
      async getToolServerIncludingHidden(serverId: string) {
        if (serverId === "builtin-mcp-management") {
          return builtinMcpManagementServer;
        }
        return this.getToolServer(serverId);
      },
      async callTool(serverId: string, toolName: string, args: Record<string, unknown>) {
        toolCalls.push(`${serverId}/${toolName}`);
        if (serverId === "builtin-mcp-management" && toolName === "mcp_add_server") {
          expect(args.name).toBe("Harmless HTTP");
          expect(args.transport).toBe("http");
          expect(args.url).toBe(serverUrl);
          installedServers.add("harmless-http");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                status: "connected",
                serverId: "harmless-http",
                toolCount: 1,
                message: "Added MCP server \"Harmless HTTP\".",
              }),
            }],
            isError: false,
          };
        }
        if (serverId === "builtin-mcp-management" && toolName === "mcp_refresh_tools") {
          expect(args.reason).toBe("Refresh MCP tools");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                currentTurnToolsAvailable: true,
                nextTurnRequired: false,
              }),
            }],
            isError: false,
          };
        }
        if (serverId === "harmless-http" && toolName === "ping") {
          expect(args.value).toBe("from-agent");
          return {
            content: [{
              type: "text",
              text: "pong from harmless HTTP MCP",
            }],
            isError: false,
          };
        }
        throw new Error(`Unexpected tool call: ${serverId}/${toolName}`);
      },
    } as unknown as ToolManager);

    const cliEnv: NodeJS.ProcessEnv = {
      [INTERPRETER_CALLER_TOKEN_ENV]: callerToken,
      [INTERPRETER_CLI_SERVER_CONNECTION_ENV]: buildInterpreterCliServerConnection(bridgePort, {
        platform: process.platform,
        transport: "file",
      }),
    };
    const harness = new CodexTestHarness(codexHome, cliEnv);
    const installCallId = "call_install_http_mcp";
    const refreshCallId = "call_refresh_http_mcp";
    const useCallId = "call_use_http_mcp";
    const installArgs = JSON.stringify({
      name: "Harmless HTTP",
      transport: "http",
      url: serverUrl,
    });
    const pingArgs = JSON.stringify({ value: "from-agent" });
    const installCall = nativeShellToolCall(
      interpreterCliToolCommand(
        launcherPath,
        "builtin-mcp-management",
        "mcp_add_server",
        installArgs,
      ),
      workspace,
    );
    const refreshCall = nativeShellToolCall(
      interpreterCliToolCommand(
        launcherPath,
        "builtin-mcp-management",
        "mcp_refresh_tools",
        JSON.stringify({ reason: "Refresh MCP tools" }),
      ),
      workspace,
    );
    const useCall = nativeShellToolCall(
      interpreterCliToolCommand(
        launcherPath,
        "harmless-http",
        "ping",
        pingArgs,
      ),
      workspace,
    );

    const scenario: ScriptedScenario = {
      name: "agent-installs-and-uses-http-mcp-through-interpreter-app",
      modelsResponse: MODELS_RESPONSE,
      responseBehavior: {
        type: "sequence",
        responses: [
          {
            type: "sse",
            body: chatToolCallStream(installCallId, installCall.name, installCall.args),
          },
          {
            type: "sse",
            body: chatToolCallStream(refreshCallId, refreshCall.name, refreshCall.args),
          },
          {
            type: "sse",
            body: chatToolCallStream(useCallId, useCall.name, useCall.args),
          },
          {
            type: "sse",
            body: chatAssistantMessageStream("Installed and used the HTTP MCP."),
          },
        ],
      },
    };

    try {
      await harness.start("ollama", scenario);

      const threadId = await harness.client.startThreadWithConfig(
        "test-model",
        harness.modelProvider,
        null,
        workspace,
        createInterpreterCliThreadConfig(callerToken, cliEnv, workspace),
      );
      agentTabManager.bindThread({
        agentId: "agent-http-mcp-cli",
        callerToken,
        threadId,
        workspacePath: workspace,
      });
      const turn = await harness.client.startTurn({
        threadId,
        message: "Install the harmless HTTP MCP at http://127.0.0.1:31337/mcp and ping it.",
        model: "test-model",
        cwd: workspace,
      });

      const completed = await harness.recorder.waitForTurnCompleted(turn.id, 60_000);
      expect(completed).toBeTruthy();
      if ("turn" in completed.params) {
        expect(completed.params.turn.status).toBe("completed");
      }

      expect(toolCalls).toEqual([
        "builtin-mcp-management/mcp_add_server",
        "builtin-mcp-management/mcp_refresh_tools",
        "harmless-http/ping",
      ]);

      const chatRequests = getChatCompletionRequests(harness);
      expect(chatRequests).toHaveLength(4);
      expect(JSON.stringify(findToolMessage(chatRequests[1]?.body, installCallId)))
        .toContain("harmless-http");
      expect(JSON.stringify(findToolMessage(chatRequests[2]?.body, refreshCallId)))
        .toContain("nextTurnRequired");
      expect(JSON.stringify(findToolMessage(chatRequests[3]?.body, useCallId)))
        .toContain("pong from harmless HTTP MCP");
    } finally {
      await harness.stop();
      await bridge.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(interpreterHome, { recursive: true, force: true });
    }
  }, 90_000);

  test("should_read_a_file_via_native_shell", async () => {
    setConfigOverride(createTestConfig());

    const workspace = mkdtempSync(join(tmpdir(), "codex-read-file-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-read-file-"));
    const harness = new CodexTestHarness(codexHome);
    const fixturePath = join(workspace, "fixture.txt");
    const fixtureContents = "alpha from fixture\nbeta line\n";
    const callId = "call_read_file";

    writeFileSync(fixturePath, fixtureContents, "utf8");
    const shellCall = nativeShellToolCall(readFixtureFileCommand(), workspace);

    const scenario: ScriptedScenario = {
      name: "native-read-file",
      modelsResponse: MODELS_RESPONSE,
      responseBehavior: {
        type: "sequence",
        responses: [
          {
            type: "sse",
            body: chatToolCallStream(callId, shellCall.name, shellCall.args),
          },
          {
            type: "sse",
            body: chatAssistantMessageStream("I read the file."),
          },
        ],
      },
    };

    try {
      await harness.start("ollama", scenario);

      const threadId = await harness.client.startThread(
        "test-model",
        harness.modelProvider,
        null,
        workspace,
      );
      const turn = await harness.client.startTurn({
        threadId,
        message: "Read fixture.txt and report back.",
        model: "test-model",
      });

      const completed = await harness.recorder.waitForTurnCompleted(turn.id, 60_000);
      expect(completed).toBeTruthy();
      if ("turn" in completed.params) {
        expect(completed.params.turn.status).toBe("completed");
      }

      const chatRequests = getChatCompletionRequests(harness);
      expect(chatRequests).toHaveLength(2);

      const toolOutput = findToolMessage(chatRequests[1]?.body, callId);
      expect(toolOutput).toBeTruthy();
      expect(JSON.stringify(toolOutput)).toContain("alpha from fixture");
      expect(JSON.stringify(toolOutput)).toContain("beta line");
    } finally {
      await harness.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function interpreterCliToolCommand(
  launcherPath: string,
  serverId: string,
  toolName: string,
  jsonArgs: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const powerShellLauncherPath = launcherPath.replace(/\.cmd$/i, ".ps1");
    return [
      "&",
      powershellQuote(powerShellLauncherPath),
      "tools",
      powershellQuote(serverId),
      powershellQuote(toolName),
      "--json",
      powershellQuote(jsonArgs),
    ].join(" ");
  }

  return `${shellQuote(launcherPath)} tools ${shellQuote(serverId)} ${shellQuote(toolName)} --json ${shellQuote(jsonArgs)}`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readFixtureFileCommand(): string {
  if (process.platform === "win32") {
    return "Get-Content -Raw -LiteralPath fixture.txt";
  }

  return "cat fixture.txt";
}

function createFixtureFileCommand(): string {
  if (process.platform === "win32") {
    return "Set-Content -NoNewline -LiteralPath created-by-tool.txt -Value \"hello from tool`n\"";
  }

  return "printf 'hello from tool\\n' > created-by-tool.txt";
}
