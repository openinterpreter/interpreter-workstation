import { describe, spyOn, test } from "bun:test";
import assert from "node:assert/strict";

import type { v2 } from "@/schemas";
import type { JsonValue } from "@/schemas/serde_json/JsonValue";

import type {
  AppServerNotification,
  McpResourceReadParams,
  McpServerStatusListParams,
  McpServerToolCallParams,
} from "./protocol";
import type { CodexClient } from "./service";
import { McpService } from "./mcp-service";

function createMcpFakeClient() {
  let handler: ((notification: AppServerNotification) => void) | null = null;
  let disconnectHandler: ((reason: string) => void) | null = null;

  const calls = {
    configValueWrite: [] as Array<{ keyPath: string; value: JsonValue }>,
    configBatchWrite: [] as Array<v2.ConfigBatchWriteParams>,
    mcpServerReload: 0,
    mcpServerStatusList: [] as Array<McpServerStatusListParams | undefined>,
    mcpServerAuthStatusListViaCli: 0,
    mcpServerOauthLogin: [] as Array<v2.McpServerOauthLoginParams>,
    startMcpToolThread: [] as Array<{ model?: string | null; modelProvider?: string | null; cwd?: string | null }>,
    mcpServerToolCall: [] as Array<McpServerToolCallParams>,
    mcpResourceRead: [] as Array<McpResourceReadParams>,
    threadRead: [] as Array<v2.ThreadReadParams>,
  };

  const client: CodexClient = {
    async ensureConnected() {},
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
    async startThread() {
      return "thr_new";
    },
    async startMcpToolThread(params) {
      calls.startMcpToolThread.push(params);
      return `thr_mcp_${calls.startMcpToolThread.length}`;
    },
    async resumeThread(threadId: string) {
      return threadId;
    },
    async startTurn() {
      return { id: "turn_1", items: [], status: "inProgress" as const, error: null };
    },
    async interruptTurn() {},
    async configValueWrite(keyPath: string, value: JsonValue) {
      calls.configValueWrite.push({ keyPath, value });
    },
    async configRead() {
      return { config: {} as never, origins: {}, layers: null };
    },
    async configBatchWrite(params: v2.ConfigBatchWriteParams) {
      calls.configBatchWrite.push(params);
      return {
        status: "ok" as const,
        version: "1",
        filePath: "/tmp/config.toml",
        overriddenMetadata: null,
      };
    },
    async mcpServerReload() {
      calls.mcpServerReload += 1;
      return {};
    },
    async mcpServerStatusList(params?: McpServerStatusListParams) {
      calls.mcpServerStatusList.push(params);
      return {
        data: [
          {
            name: "existing-server",
            tools: {},
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported" as const,
          },
        ],
        nextCursor: null,
      };
    },
    async mcpServerAuthStatusListViaCli() {
      calls.mcpServerAuthStatusListViaCli += 1;
      return new Map([
        ["existing-server", "unsupported" as const],
      ]);
    },
    async mcpServerOauthLogin(params: v2.McpServerOauthLoginParams) {
      calls.mcpServerOauthLogin.push(params);
      return { authorizationUrl: "https://auth.example.com/oauth" };
    },
    async mcpServerToolCall(params) {
      calls.mcpServerToolCall.push(params);
      return { content: [], structuredContent: null, isError: false };
    },
    async mcpResourceRead(params) {
      calls.mcpResourceRead.push(params);
      return { contents: [] };
    },
    async loginWithChatGPT() { return { loginId: 'test-login', authUrl: 'https://auth.openai.com/test' }; },
    async getAccount() { return { account: null, requiresOpenaiAuth: false }; },
    async cancelLogin() {},
    async logout() {},
    async threadList() {
      return { data: [], nextCursor: null };
    },
    async threadRead(params) {
      calls.threadRead.push(params);
      return {
        thread: {
          id: params.threadId,
          preview: '',
          modelProvider: 'interpreter',
          createdAt: 0,
          updatedAt: 0,
          status: { type: 'idle' },
          path: null,
          cwd: '/workspace',
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
      handler?.(notification);
    },
    emitDisconnect(reason: string) {
      disconnectHandler?.(reason);
    },
  };
}

describe("McpService", () => {
  test("should_create_stdio_server_and_reload", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    await svc.createServer({
      name: "my-stdio",
      config: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "my-server"],
        enabled: true,
      },
    });

    assert.equal(fake.calls.configValueWrite.length, 1);
    assert.equal(
      fake.calls.configValueWrite[0]?.keyPath,
      "mcp_servers.my-stdio",
    );
    const written = fake.calls.configValueWrite[0]?.value as Record<string, unknown>;
    assert.equal(written.command, "npx");
    assert.deepEqual(written.args, ["-y", "my-server"]);
    assert.equal(written.enabled, true);
    assert.equal("transport" in written, false);
    assert.equal(fake.calls.mcpServerReload, 1);
  });

  test("should_create_http_server_and_reload", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    await svc.createServer({
      name: "my-http",
      config: {
        transport: "streamable_http",
        url: "https://mcp.example.com",
        bearerTokenEnvVar: "TOKEN",
        required: true,
      },
    });

    assert.equal(fake.calls.configValueWrite.length, 1);
    assert.equal(
      fake.calls.configValueWrite[0]?.keyPath,
      "mcp_servers.my-http",
    );
    const written = fake.calls.configValueWrite[0]?.value as Record<string, unknown>;
    assert.equal(written.url, "https://mcp.example.com");
    assert.equal(written.bearer_token_env_var, "TOKEN");
    assert.equal(written.required, true);
    assert.equal("transport" in written, false);
    assert.equal(fake.calls.mcpServerReload, 1);
  });

  test("should_list_servers", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    const result = await svc.listServers();

    assert.equal(fake.calls.mcpServerStatusList.length, 1);
    assert.deepEqual(fake.calls.mcpServerStatusList[0], {
      detail: "toolsAndAuthOnly",
    });
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.name, "existing-server");
  });

  test("should_list_servers_for_display_using_cli_auth_statuses", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    const result = await svc.listServersForDisplay();

    assert.equal(fake.calls.mcpServerStatusList.length, 1);
    assert.equal(fake.calls.mcpServerAuthStatusListViaCli, 1);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.name, "existing-server");
    assert.equal(result.data[0]?.authStatus, "unsupported");
  });

  test("should_list_servers_for_display_using_preloaded_cli_auth_statuses", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);
    const cliAuthStatuses = new Map<string, v2.McpAuthStatus>([
      ["existing-server", "notLoggedIn"],
    ]);

    const result = await svc.listServersForDisplay(cliAuthStatuses);

    assert.equal(fake.calls.mcpServerStatusList.length, 1);
    assert.equal(fake.calls.mcpServerAuthStatusListViaCli, 0);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.name, "existing-server");
    assert.equal(result.data[0]?.authStatus, "notLoggedIn");
  });

  test("should_coalesce_concurrent_runtime_status_lists", async () => {
    const fake = createMcpFakeClient();
    let resolveStatus!: (value: v2.ListMcpServerStatusResponse) => void;
    fake.client.mcpServerStatusList = async (params?: McpServerStatusListParams) => {
      fake.calls.mcpServerStatusList.push(params);
      return await new Promise<v2.ListMcpServerStatusResponse>((resolve) => {
        resolveStatus = resolve;
      });
    };
    const svc = new McpService(fake.client);

    const listPromise = svc.listServers();
    const displayPromise = svc.listServersForDisplay();
    await Promise.resolve();

    assert.equal(fake.calls.mcpServerStatusList.length, 1);
    resolveStatus({
      data: [
        {
          name: "existing-server",
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: "unsupported" as const,
        },
      ],
      nextCursor: null,
    });

    await Promise.all([listPromise, displayPromise]);
    assert.equal(fake.calls.mcpServerStatusList.length, 1);
    assert.equal(fake.calls.mcpServerAuthStatusListViaCli, 1);
  });

  test("should_clear_runtime_status_cache_after_status_list_timeout", async () => {
    const fake = createMcpFakeClient();
    fake.client.mcpServerStatusList = async (params?: McpServerStatusListParams) => {
      fake.calls.mcpServerStatusList.push(params);
      return await new Promise<v2.ListMcpServerStatusResponse>(() => {});
    };
    const svc = new McpService(fake.client, undefined, { statusListTimeoutMs: 5 });
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await assert.rejects(
        () => svc.listServers(),
        /MCP server status list timed out after 5ms/,
      );

      await assert.rejects(
        () => svc.listServers(),
        /MCP server status list timed out after 5ms/,
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }

    assert.equal(fake.calls.mcpServerStatusList.length, 2);
  });

  test("should_clear_pending_status_cache_before_reload", async () => {
    const fake = createMcpFakeClient();
    let resolveStatus!: (value: v2.ListMcpServerStatusResponse) => void;
    fake.client.mcpServerStatusList = async (params?: McpServerStatusListParams) => {
      fake.calls.mcpServerStatusList.push(params);
      return await new Promise<v2.ListMcpServerStatusResponse>((resolve) => {
        resolveStatus = resolve;
      });
    };
    const svc = new McpService(fake.client);

    const firstPromise = svc.listServers();
    await Promise.resolve();
    assert.equal(fake.calls.mcpServerStatusList.length, 1);

    await svc.reloadServers();

    fake.client.mcpServerStatusList = async (params?: McpServerStatusListParams) => {
      fake.calls.mcpServerStatusList.push(params);
      return {
        data: [],
        nextCursor: null,
      };
    };

    const result = await svc.listServers();
    assert.equal(result.data.length, 0);
    assert.equal(fake.calls.mcpServerStatusList.length, 2);

    resolveStatus({
      data: [],
      nextCursor: null,
    });
    await firstPromise;
  });

  test("should_coalesce_concurrent_cli_auth_status_lists", async () => {
    const fake = createMcpFakeClient();
    let resolveAuthStatuses!: (value: ReadonlyMap<string, v2.McpAuthStatus>) => void;
    fake.client.mcpServerAuthStatusListViaCli = async () => {
      fake.calls.mcpServerAuthStatusListViaCli += 1;
      return await new Promise<ReadonlyMap<string, v2.McpAuthStatus>>((resolve) => {
        resolveAuthStatuses = resolve;
      });
    };
    const svc = new McpService(fake.client);

    const firstPromise = svc.listAuthStatusesViaCli();
    const secondPromise = svc.listAuthStatusesViaCli();
    await Promise.resolve();

    assert.equal(fake.calls.mcpServerAuthStatusListViaCli, 1);
    const cliAuthStatuses = new Map<string, v2.McpAuthStatus>([
      ["existing-server", "unsupported"],
    ]);
    resolveAuthStatuses(cliAuthStatuses);

    assert.equal(await firstPromise, cliAuthStatuses);
    assert.equal(await secondPromise, cliAuthStatuses);
    assert.equal(fake.calls.mcpServerAuthStatusListViaCli, 1);
  });

  test("should_surface_cli_not_logged_in_servers_missing_from_runtime_status_list", async () => {
    const fake = createMcpFakeClient();
    fake.client.mcpServerStatusList = async (params?: McpServerStatusListParams) => {
      fake.calls.mcpServerStatusList.push(params);
      return {
        data: [],
        nextCursor: null,
      };
    };
    fake.client.mcpServerAuthStatusListViaCli = async () => {
      fake.calls.mcpServerAuthStatusListViaCli += 1;
      return new Map([
        ["supabase", "notLoggedIn" as const],
      ]);
    };
    const svc = new McpService(fake.client);

    const result = await svc.listServersForDisplay();

    assert.equal(result.data.length, 1);
    assert.deepEqual(result.data[0], {
      name: "supabase",
      serverInfo: null,
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: "notLoggedIn",
    });
  });

  test("should_get_server_status_when_found", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    const status = await svc.getServerStatus("existing-server");

    assert.ok(status);
    assert.equal(status.name, "existing-server");
    assert.deepEqual(fake.calls.mcpServerStatusList[0], {
      detail: "toolsAndAuthOnly",
    });
  });

  test("should_return_null_when_server_not_found", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    const status = await svc.getServerStatus("nonexistent");

    assert.equal(status, null);
  });

  test("should_update_server_and_reload", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    await svc.updateServer({
      name: "my-stdio",
      config: {
        transport: "stdio",
        command: "new-command",
        enabled: false,
      },
    });

    assert.equal(fake.calls.configValueWrite.length, 1);
    assert.equal(
      fake.calls.configValueWrite[0]?.keyPath,
      "mcp_servers.my-stdio",
    );
    const written = fake.calls.configValueWrite[0]?.value as Record<string, unknown>;
    assert.equal(written.command, "new-command");
    assert.equal(written.enabled, false);
    assert.equal(fake.calls.mcpServerReload, 1);
  });

  test("should_delete_server_by_writing_null_and_reload", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    await svc.deleteServer("old-server");

    assert.equal(fake.calls.configValueWrite.length, 1);
    assert.equal(
      fake.calls.configValueWrite[0]?.keyPath,
      "mcp_servers.old-server",
    );
    assert.equal(fake.calls.configValueWrite[0]?.value, null);
    assert.equal(fake.calls.mcpServerReload, 1);
  });

  test("should_initiate_oauth_login_and_return_url", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    const result = await svc.initiateOAuthLogin("remote-mcp", ["read", "write"]);

    assert.equal(result.authorizationUrl, "https://auth.example.com/oauth");
    assert.equal(fake.calls.mcpServerOauthLogin.length, 1);
    assert.equal(fake.calls.mcpServerOauthLogin[0]?.name, "remote-mcp");
    assert.deepEqual(fake.calls.mcpServerOauthLogin[0]?.scopes, [
      "read",
      "write",
    ]);
  });

  test("should_reject_invalid_server_name", async () => {
    const fake = createMcpFakeClient();
    const svc = new McpService(fake.client);

    await assert.rejects(
      () =>
        svc.createServer({
          name: "invalid name!",
          config: { transport: "stdio", command: "echo" },
        }),
      /invalid server name/i,
    );

    assert.equal(fake.calls.configValueWrite.length, 0);
    assert.equal(fake.calls.mcpServerReload, 0);
  });

  test("should_call_tools_through_hidden_mcp_thread", async () => {
    const fake = createMcpFakeClient();
    const boundToolThreads: Array<{ ownerThreadId: string; toolThreadId: string }> = [];
    const svc = new McpService(fake.client, {
      bindToolThread(ownerThreadId, toolThreadId) {
        boundToolThreads.push({ ownerThreadId, toolThreadId });
      },
    });

    await svc.callTool("thr_visible", "memory", "create_entities", {
      entities: [],
    }, {
      model: "interpreter-smart",
      cwd: "/workspace",
    });

    assert.deepEqual(fake.calls.threadRead, [{
      threadId: "thr_visible",
      includeTurns: false,
    }]);
    assert.deepEqual(fake.calls.startMcpToolThread, [{
      model: "interpreter-smart",
      modelProvider: "interpreter",
      cwd: "/workspace",
    }]);
    assert.deepEqual(boundToolThreads, [{
      ownerThreadId: "thr_visible",
      toolThreadId: "thr_mcp_1",
    }]);
    assert.deepEqual(fake.calls.mcpServerToolCall, [{
      threadId: "thr_mcp_1",
      server: "memory",
      tool: "create_entities",
      arguments: { entities: [] },
    }]);
  });

  test("should_reuse_hidden_mcp_thread_until_servers_reload", async () => {
    const fake = createMcpFakeClient();
    const boundToolThreads: Array<{ ownerThreadId: string; toolThreadId: string }> = [];
    const svc = new McpService(fake.client, {
      bindToolThread(ownerThreadId, toolThreadId) {
        boundToolThreads.push({ ownerThreadId, toolThreadId });
      },
    });

    await svc.callTool("thr_visible", "memory", "create_entities");
    await svc.callTool("thr_visible", "memory", "read_graph");

    assert.equal(fake.calls.startMcpToolThread.length, 1);
    assert.deepEqual(boundToolThreads, [{
      ownerThreadId: "thr_visible",
      toolThreadId: "thr_mcp_1",
    }]);
    assert.equal(fake.calls.mcpServerToolCall[0]?.threadId, "thr_mcp_1");
    assert.equal(fake.calls.mcpServerToolCall[1]?.threadId, "thr_mcp_1");

    await svc.reloadServers();
    await svc.callTool("thr_visible", "memory", "read_graph");

    assert.equal(fake.calls.startMcpToolThread.length, 2);
    assert.deepEqual(boundToolThreads[1], {
      ownerThreadId: "thr_visible",
      toolThreadId: "thr_mcp_2",
    });
    assert.equal(fake.calls.mcpServerToolCall[2]?.threadId, "thr_mcp_2");
  });

  test("should_reuse_hidden_mcp_thread_per_owner_thread", async () => {
    const fake = createMcpFakeClient();
    const boundToolThreads: Array<{ ownerThreadId: string; toolThreadId: string }> = [];
    const svc = new McpService(fake.client, {
      bindToolThread(ownerThreadId, toolThreadId) {
        boundToolThreads.push({ ownerThreadId, toolThreadId });
      },
    });

    await svc.callTool("thr_visible_a", "memory", "read_graph");
    await svc.callTool("thr_visible_b", "memory", "read_graph");
    await svc.callTool("thr_visible_a", "memory", "read_graph");

    assert.equal(fake.calls.startMcpToolThread.length, 2);
    assert.deepEqual(boundToolThreads, [
      { ownerThreadId: "thr_visible_a", toolThreadId: "thr_mcp_1" },
      { ownerThreadId: "thr_visible_b", toolThreadId: "thr_mcp_2" },
    ]);
    assert.equal(fake.calls.mcpServerToolCall[0]?.threadId, "thr_mcp_1");
    assert.equal(fake.calls.mcpServerToolCall[1]?.threadId, "thr_mcp_2");
    assert.equal(fake.calls.mcpServerToolCall[2]?.threadId, "thr_mcp_1");
  });
});
