import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";

import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "@/lib/codex/app-server-client";
import type { v2 } from "@/schemas";
import { pollUntil } from "@/lib/codex/test-utils";
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from "@/lib/codex/test-fixtures/interpreter-app-server-test-binary";

const TEST_CODEX_HOME = "/tmp/test-mcp-codex-home";
const TEST_MODEL = "gpt-5.3-codex";
const BASELINE_SERVER = "baseline";
const BASELINE_TOOLS = [
  "baseline_alpha",
  "baseline_beta",
];
const FILESYSTEM_TOOLS = [
  "read_file",
  "read_multiple_files",
  "write_file",
  "edit_file",
  "create_directory",
  "list_directory",
  "directory_tree",
  "move_file",
  "search_files",
  "get_file_info",
];
const EVERYTHING_TOOLS = [
  "echo",
  "add",
  "subtract",
  "multiply",
  "divide",
  "reverse",
  "uppercase",
  "lowercase",
  "sort",
  "dedupe",
];
const HTTP_SERVER = "harmless_http";
const HTTP_TOOLS = [
  "http_echo",
];

const appServerAvailable = interpreterAppServerTestBinaryAvailable;
// NOTE(victor): bun test has a child_process spawning issue when running a
// single integration test file -- the app-server process exits with code 0 in ~50ms
// before responding. Running via `pnpm run test:unit` (multi-file invocation)
// works reliably. Use `pnpm run test:unit` to run these tests.
const describeIf = appServerAvailable ? describe : describe.skip;

function serverByName(data: Array<v2.McpServerStatus>, name: string) {
  return data.find((s) => s.name === name);
}

function toolCount(server: v2.McpServerStatus | undefined): number {
  if (!server) return 0;
  return Object.keys(server.tools).length;
}

function buildInlineMcpServerScript(serverName: string, toolNames: string[]): string {
  const registrations = toolNames.map((toolName) => [
    `server.registerTool(${JSON.stringify(toolName)}, {`,
    `  title: ${JSON.stringify(toolName)},`,
    `  description: ${JSON.stringify(`${toolName} tool`)},`,
    "  inputSchema: { value: z.string().optional() },",
    "  outputSchema: { value: z.string() },",
    "}, async ({ value }) => ({",
    `  content: [{ type: "text", text: value ?? ${JSON.stringify(toolName)} }],`,
    `  structuredContent: { value: value ?? ${JSON.stringify(toolName)} },`,
    "}));",
  ].join("\n"));

  return [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    'import { z } from "zod";',
    `const server = new McpServer({ name: ${JSON.stringify(serverName)}, version: "1.0.0" });`,
    ...registrations,
    "const transport = new StdioServerTransport();",
    "await server.connect(transport);",
  ].join("\n");
}

function createInProcessMcpServer(serverName: string, toolNames: string[]): McpServer {
  const server = new McpServer({ name: serverName, version: "1.0.0" });

  for (const toolName of toolNames) {
    server.registerTool(toolName, {
      title: toolName,
      description: `${toolName} tool`,
      inputSchema: { value: z.string().optional() },
      outputSchema: { value: z.string() },
    }, async ({ value }) => ({
      content: [{ type: "text", text: value ?? toolName }],
      structuredContent: { value: value ?? toolName },
    }));
  }

  return server;
}

async function startStreamableHttpMcpServer(
  serverName: string,
  toolNames: string[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createInProcessMcpServer(serverName, toolNames);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const closeSession = () => {
      void transport.close();
      void server.close();
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", closeSession);
    } catch (error) {
      closeSession();
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string", "HTTP MCP server should bind to a TCP port");

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function inlineServerConfig(serverName: string, toolNames: string[], enabled = true) {
  return {
    command: "node",
    args: [
      "--input-type=module",
      "-e",
      buildInlineMcpServerScript(serverName, toolNames),
    ],
    ...(enabled ? {} : { enabled: false }),
  };
}

describeIf("MCP server lifecycle (integration)", () => {
  let transport: StdioJsonRpcTransport;
  let client: CodexAppServerClient;
  let threadId1: string;
  let unsubscribe: (() => void) | undefined;
  const startupStatus = new Map<string, { status: string; error: string | null }>();

  async function waitForStatus(
    predicate: (res: v2.ListMcpServerStatusResponse) => boolean,
    timeoutMs = 25_000,
  ) {
    try {
      return await pollUntil(
        () => client.mcpServerStatusList(),
        predicate,
        { timeoutMs },
      );
    } catch (error) {
      const latest = await client.mcpServerStatusList().catch(() => null);
      const startup = Object.fromEntries(startupStatus);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\nstartup=${JSON.stringify(startup)}\nstatus=${JSON.stringify(latest?.data ?? null)}`,
      );
    }
  }

  beforeAll(async () => {
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });

    transport = new StdioJsonRpcTransport(
      (_command, args, env) => spawnInterpreterAppServerForTest(args, env),
      TEST_CODEX_HOME,
    );
    client = new CodexAppServerClient(transport, null);
    await client.ensureConnected();
    unsubscribe = client.subscribe((notification) => {
      if (notification.method !== "mcpServer/startupStatus/updated") {
        return;
      }

      const params = notification.params as {
        name?: string;
        status?: string;
        error?: string | null;
      };
      if (typeof params.name !== "string") {
        return;
      }

      startupStatus.set(params.name, {
        status: typeof params.status === "string" ? params.status : "unknown",
        error: typeof params.error === "string" ? params.error : null,
      });
    });
  }, 30_000);

  afterAll(async () => {
    unsubscribe?.();
    await transport.stop();
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });
  });

  test("should_add_mcp_server_and_discover_tools", async () => {
    await client.configValueWrite(
      `mcp_servers.${BASELINE_SERVER}`,
      inlineServerConfig(BASELINE_SERVER, BASELINE_TOOLS),
    );
    await client.mcpServerReload();

    const status = await waitForStatus(
      (res) => toolCount(serverByName(res.data, BASELINE_SERVER)) >= BASELINE_TOOLS.length,
    );

    const server = serverByName(status.data, BASELINE_SERVER);
    assert.ok(server, `${BASELINE_SERVER} server should exist`);
    assert.ok(
      BASELINE_TOOLS.every((toolName) => !!server.tools[toolName]),
      `${BASELINE_SERVER} tools should be registered`,
    );

    threadId1 = await client.startThread(TEST_MODEL);
    assert.ok(threadId1, "thread should be created");

    const afterThread = await waitForStatus(
      (res) => BASELINE_TOOLS.every(
        (toolName) => !!serverByName(res.data, BASELINE_SERVER)?.tools[toolName],
      ),
    );
    assert.ok(
      BASELINE_TOOLS.every(
        (toolName) => !!serverByName(afterThread.data, BASELINE_SERVER)?.tools[toolName],
      ),
      "tools should persist after thread start",
    );
  }, 30_000);

  test("should_enable_additional_mcps_and_verify_all_tools", async () => {
    await client.configValueWrite(
      "mcp_servers.filesystem",
      inlineServerConfig("filesystem", FILESYSTEM_TOOLS),
    );
    await client.configValueWrite(
      "mcp_servers.everything",
      inlineServerConfig("everything", EVERYTHING_TOOLS),
    );
    await client.mcpServerReload();

    const status = await waitForStatus(
      (res) =>
        toolCount(serverByName(res.data, BASELINE_SERVER)) >= BASELINE_TOOLS.length &&
        toolCount(serverByName(res.data, "filesystem")) > 0 &&
        toolCount(serverByName(res.data, "everything")) > 0,
      45_000,
    );

    const baseline = serverByName(status.data, BASELINE_SERVER);
    const fs = serverByName(status.data, "filesystem");
    const everything = serverByName(status.data, "everything");

    assert.ok(BASELINE_TOOLS.every((toolName) => !!baseline?.tools[toolName]));
    assert.ok(toolCount(fs) >= 10, `filesystem should have >= 10 tools, got ${toolCount(fs)}`);
    assert.ok(toolCount(everything) >= 10, `everything should have >= 10 tools, got ${toolCount(everything)}`);
  }, 60_000);

  test("should_add_streamable_http_mcp_server_and_discover_tools", async () => {
    const httpMcp = await startStreamableHttpMcpServer(HTTP_SERVER, HTTP_TOOLS);

    try {
      await client.configValueWrite(
        `mcp_servers.${HTTP_SERVER}`,
        { url: httpMcp.url },
      );
      await client.mcpServerReload();

      const status = await waitForStatus(
        (res) => HTTP_TOOLS.every(
          (toolName) => !!serverByName(res.data, HTTP_SERVER)?.tools[toolName],
        ),
        45_000,
      );

      const server = serverByName(status.data, HTTP_SERVER);
      assert.ok(server, `${HTTP_SERVER} server should exist`);
      assert.ok(
        HTTP_TOOLS.every((toolName) => !!server.tools[toolName]),
        `${HTTP_SERVER} tools should be registered`,
      );
    } finally {
      await client.configValueWrite(`mcp_servers.${HTTP_SERVER}`, null).catch(() => {});
      await client.mcpServerReload().catch(() => {});
      await httpMcp.close();
    }
  }, 60_000);

  test("should_disable_mcp_and_remove_its_tools", async () => {
    await client.configValueWrite(
      "mcp_servers.filesystem",
      inlineServerConfig("filesystem", FILESYSTEM_TOOLS, false),
    );
    await client.mcpServerReload();

    const status = await waitForStatus((res) => (
      toolCount(serverByName(res.data, BASELINE_SERVER)) >= BASELINE_TOOLS.length &&
      toolCount(serverByName(res.data, "everything")) > 0 &&
      toolCount(serverByName(res.data, "filesystem")) === 0
    ));

    assert.ok(
      toolCount(serverByName(status.data, BASELINE_SERVER)) >= BASELINE_TOOLS.length,
      `${BASELINE_SERVER} should still have tools`,
    );
    assert.ok(
      toolCount(serverByName(status.data, "everything")) > 0,
      "everything should still have tools",
    );
    assert.equal(
      toolCount(serverByName(status.data, "filesystem")),
      0,
      "filesystem should have no tools",
    );
  }, 30_000);

  test("should_delete_mcp_via_null_write", async () => {
    await client.configValueWrite("mcp_servers.everything", null);
    await client.mcpServerReload();

    const status = await waitForStatus(
      (res) => !serverByName(res.data, "everything"),
    );

    assert.ok(
      toolCount(serverByName(status.data, BASELINE_SERVER)) >= BASELINE_TOOLS.length,
      `${BASELINE_SERVER} should still have tools`,
    );
    assert.equal(
      serverByName(status.data, "everything"),
      undefined,
      "everything should be gone",
    );
  }, 30_000);

  test("should_isolate_tools_in_new_thread", async () => {
    const threadId2 = await client.startThread(TEST_MODEL);
    assert.notEqual(threadId2, threadId1, "should be a distinct thread");

    const status = await waitForStatus(
      (res) => {
        const baseline = serverByName(res.data, BASELINE_SERVER);
        const everything = serverByName(res.data, "everything");
        const fs = serverByName(res.data, "filesystem");
        return BASELINE_TOOLS.every((toolName) => !!baseline?.tools[toolName]) &&
          !everything &&
          toolCount(fs) === 0;
      },
      30_000,
    );

    const baseline = serverByName(status.data, BASELINE_SERVER);
    assert.ok(
      BASELINE_TOOLS.every((toolName) => !!baseline?.tools[toolName]),
      `${BASELINE_SERVER} should be present`,
    );

    assert.equal(
      serverByName(status.data, "everything"),
      undefined,
      "everything should be absent",
    );

    const fs = serverByName(status.data, "filesystem");
    assert.equal(toolCount(fs), 0, "filesystem should have no tools (disabled)");
  }, 30_000);
});
