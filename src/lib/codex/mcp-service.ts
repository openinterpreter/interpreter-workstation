import type { v2 } from "../../../server/handlers/codex-generated-types/index";
import type { JsonValue } from "../../../server/handlers/codex-generated-types/serde_json/JsonValue";
import { agentTabManager } from "../../../server/agentTabManager";
import type { ToolConnectionState, ToolServerStatus } from "../../../server/tools/toolTypes";

import {
  type McpServerEntry,
  type McpServerStatusListParams,
  type McpServerToolCallResponse,
  type McpResourceReadResponse,
  mcpServerEntryToToml,
} from "./protocol";
import type { CodexClient } from "./service";
import { getMcpCodexClient } from "./service";

const VALID_SERVER_NAME = /^[a-zA-Z0-9_-]+$/;
const TOOL_LIST_STATUS_DETAIL: NonNullable<McpServerStatusListParams["detail"]> =
  "toolsAndAuthOnly";
const MCP_STATUS_LIST_TIMEOUT_MS = 12_000;
let mcpServiceListServersRequestId = 0;
let mcpServiceAuthStatusListRequestId = 0;

type McpToolThreadContext = {
  ownerThreadId: string;
  model?: string | null;
  cwd?: string | null;
};

type CachedMcpToolThread = {
  id: string;
  ownerThreadId: string;
  generation: number;
  model: string | null;
  modelProvider: string | null;
  cwd: string | null;
};

type McpToolThreadBinder = {
  bindToolThread(ownerThreadId: string, toolThreadId: string): void;
};

type McpServiceOptions = {
  statusListTimeoutMs?: number;
};

const defaultMcpToolThreadBinder: McpToolThreadBinder = {
  bindToolThread(ownerThreadId, toolThreadId) {
    agentTabManager.bindAuxiliaryThread({
      ownerThreadId,
      threadId: toolThreadId,
    });
  },
};

function mergeDisplayStatuses(
  runtimeResponse: v2.ListMcpServerStatusResponse,
  cliAuthStatuses: ReadonlyMap<string, v2.McpAuthStatus>,
): v2.ListMcpServerStatusResponse {
  const merged = runtimeResponse.data.map((server) => ({
    ...server,
    authStatus: cliAuthStatuses.get(server.name) ?? server.authStatus,
  }));
  const runtimeNames = new Set(runtimeResponse.data.map((server) => server.name));

  for (const [name, authStatus] of cliAuthStatuses) {
    if (runtimeNames.has(name) || authStatus !== "notLoggedIn") {
      continue;
    }

    merged.push({
      name,
      serverInfo: null,
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus,
    });
  }

  return {
    data: merged,
    nextCursor: runtimeResponse.nextCursor,
  };
}

function mcpToolThreadCacheKey(context: {
  ownerThreadId: string;
  model: string | null;
  modelProvider: string | null;
  cwd: string | null;
}): string {
  return JSON.stringify([
    context.ownerThreadId,
    context.model,
    context.modelProvider,
    context.cwd,
  ]);
}

export class McpService {
  private runtimeStatusListPromise: Promise<v2.ListMcpServerStatusResponse> | null = null;
  private authStatusListPromise: Promise<ReadonlyMap<string, v2.McpAuthStatus>> | null = null;
  private toolThreadGeneration = 0;
  private readonly cachedToolThreads = new Map<string, CachedMcpToolThread>();
  private readonly statusListTimeoutMs: number;

  constructor(
    private readonly client: CodexClient,
    private readonly toolThreadBinder: McpToolThreadBinder = defaultMcpToolThreadBinder,
    options: McpServiceOptions = {},
  ) {
    this.statusListTimeoutMs = options.statusListTimeoutMs ?? MCP_STATUS_LIST_TIMEOUT_MS;
  }

  async createServer(entry: McpServerEntry): Promise<void> {
    this.validateName(entry.name);
    await this.writeServerConfig(entry);
    await this.client.mcpServerReload();
    this.invalidateToolThread();
  }

  async reloadServers(): Promise<void> {
    this.invalidateStatusLists();
    await this.client.mcpServerReload();
    this.invalidateStatusLists();
    this.invalidateToolThread();
  }

  private invalidateStatusLists(): void {
    this.runtimeStatusListPromise = null;
    this.authStatusListPromise = null;
  }

  private withStatusListTimeout<T>(promise: Promise<T>, requestId: number): Promise<T> {
    if (!Number.isFinite(this.statusListTimeoutMs) || this.statusListTimeoutMs <= 0) {
      return promise;
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new Error(
            `MCP server status list timed out after ${this.statusListTimeoutMs}ms (requestId=${requestId})`,
          ),
        );
      }, this.statusListTimeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  }

  private async listRuntimeServers(caller: string): Promise<v2.ListMcpServerStatusResponse> {
    // The settings/tool-list UI only needs tool names plus auth state.
    // Requesting the lighter detail mode avoids blocking on full resource inventory.
    const requestId = ++mcpServiceListServersRequestId;
    if (this.runtimeStatusListPromise) {
      console.log(
        `[mcp-service] ${caller} join requestId=${requestId} detail=${TOOL_LIST_STATUS_DETAIL}`,
      );
      return this.runtimeStatusListPromise;
    }

    const startedAt = Date.now();
    console.log(
      `[mcp-service] ${caller} start requestId=${requestId} detail=${TOOL_LIST_STATUS_DETAIL}`,
    );

    const promise = this.withStatusListTimeout(
      this.client.mcpServerStatusList({ detail: TOOL_LIST_STATUS_DETAIL }),
      requestId,
    );
    this.runtimeStatusListPromise = promise;
    try {
      const response = await promise;
      console.log(
        `[mcp-service] ${caller} done requestId=${requestId} durationMs=${Date.now() - startedAt} count=${response.data.length}`,
      );
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[mcp-service] ${caller} failed requestId=${requestId} durationMs=${Date.now() - startedAt} detail=${TOOL_LIST_STATUS_DETAIL} error=${message}`,
        error,
      );
      throw error;
    } finally {
      if (this.runtimeStatusListPromise === promise) {
        this.runtimeStatusListPromise = null;
      }
    }
  }

  async listServers(): Promise<v2.ListMcpServerStatusResponse> {
    // NOTE(interpreter-cli-mcp): The CLI's MCP tool list ultimately comes from the
    // shared app-server MCP runtime through `mcpServerStatusList`, not from the
    // generated shell script or global config files. `ToolManager.listServerStatuses()`
    // is the app-side caller.
    return this.listRuntimeServers("listServers");
  }

  async listServersForDisplay(
    cliAuthStatuses?: ReadonlyMap<string, v2.McpAuthStatus>,
  ): Promise<v2.ListMcpServerStatusResponse> {
    const requestId = ++mcpServiceListServersRequestId;
    const startedAt = Date.now();
    console.log(
      `[mcp-service] listServersForDisplay start requestId=${requestId} detail=${TOOL_LIST_STATUS_DETAIL}`,
    );
    try {
      let runtimeResponse: v2.ListMcpServerStatusResponse;
      let displayAuthStatuses: ReadonlyMap<string, v2.McpAuthStatus>;
      if (cliAuthStatuses) {
        runtimeResponse = await this.listRuntimeServers("listServersForDisplay/runtime");
        displayAuthStatuses = cliAuthStatuses;
      } else {
        [runtimeResponse, displayAuthStatuses] = await Promise.all([
          this.listRuntimeServers("listServersForDisplay/runtime"),
          this.listAuthStatusesViaCli(),
        ]);
      }

      const response = mergeDisplayStatuses(runtimeResponse, displayAuthStatuses);
      console.log(
        `[mcp-service] listServersForDisplay done requestId=${requestId} durationMs=${Date.now() - startedAt} count=${response.data.length}`,
      );
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[mcp-service] listServersForDisplay failed requestId=${requestId} durationMs=${Date.now() - startedAt} detail=${TOOL_LIST_STATUS_DETAIL} error=${message}`,
        error,
      );
      throw error;
    }
  }

  async getServerStatus(name: string): Promise<v2.McpServerStatus | null> {
    const response = await this.listServers();
    return response.data.find((s: v2.McpServerStatus) => s.name === name) ?? null;
  }

  async getDisplayServerStatus(name: string): Promise<v2.McpServerStatus | null> {
    const response = await this.listServersForDisplay();
    return response.data.find((s: v2.McpServerStatus) => s.name === name) ?? null;
  }

  async listAuthStatusesViaCli(): Promise<ReadonlyMap<string, v2.McpAuthStatus>> {
    const requestId = ++mcpServiceAuthStatusListRequestId;
    if (this.authStatusListPromise) {
      console.log(`[mcp-service] listAuthStatusesViaCli join requestId=${requestId}`);
      return this.authStatusListPromise;
    }

    const startedAt = Date.now();
    console.log(`[mcp-service] listAuthStatusesViaCli start requestId=${requestId}`);
    const promise = this.client.mcpServerAuthStatusListViaCli();
    this.authStatusListPromise = promise;
    try {
      const statuses = await promise;
      console.log(
        `[mcp-service] listAuthStatusesViaCli done requestId=${requestId} durationMs=${Date.now() - startedAt} count=${statuses.size}`,
      );
      return statuses;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[mcp-service] listAuthStatusesViaCli failed requestId=${requestId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    } finally {
      if (this.authStatusListPromise === promise) {
        this.authStatusListPromise = null;
      }
    }
  }

  async updateServer(entry: McpServerEntry): Promise<void> {
    this.validateName(entry.name);
    await this.writeServerConfig(entry);
    await this.client.mcpServerReload();
    this.invalidateToolThread();
  }

  async deleteServer(name: string): Promise<void> {
    this.validateName(name);
    await this.logoutServer(name);
    await this.client.configValueWrite(`mcp_servers.${name}`, null);
    await this.client.mcpServerReload();
    this.invalidateToolThread();
  }

  async logoutServer(name: string): Promise<void> {
    this.validateName(name);
    try {
      await this.client.mcpServerLogoutViaCli(name);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[mcp-service] logoutServer failed name=${name} error=${message}`);
    }
  }

  async enableServer(name: string): Promise<void> {
    this.validateName(name);
    await this.client.configValueWrite(`mcp_servers.${name}.enabled`, true);
    await this.client.mcpServerReload();
    this.invalidateToolThread();
  }

  async disableServer(name: string): Promise<void> {
    this.validateName(name);
    await this.client.configValueWrite(`mcp_servers.${name}.enabled`, false);
    await this.client.mcpServerReload();
    this.invalidateToolThread();
  }

  async initiateOAuthLogin(
    name: string,
    scopes?: string[],
  ): Promise<v2.McpServerOauthLoginResponse> {
    return this.client.mcpServerOauthLogin({
      name,
      scopes: scopes ?? null,
    });
  }

  async callTool(
    threadId: string,
    server: string,
    tool: string,
    args?: Record<string, unknown>,
    context?: Omit<McpToolThreadContext, "ownerThreadId">,
  ): Promise<McpServerToolCallResponse> {
    /**
     * NOTE(interpreter-cli-mcp): Approved MCP execution happens on an auxiliary
     * app-server tool thread bound back to the owning app thread. The caller
     * must already have passed through `ToolManager.callTool()`'s MCP approval
     * branch; this method is not an approval boundary.
     *
     * Trail: [approval gate](../../../server/tools/toolManager.ts) ->
     * [owner binding](../../../server/agentTabManager.ts) ->
     * [isolated MCP client](./service.ts).
     */
    const toolThreadId = await this.getToolThread({
      ownerThreadId: threadId,
      ...context,
    });
    return this.client.mcpServerToolCall({
      threadId: toolThreadId,
      server,
      tool,
      arguments: args ?? null,
    });
  }

  async readResource(
    threadId: string,
    server: string,
    uri: string,
    context?: Omit<McpToolThreadContext, "ownerThreadId">,
  ): Promise<McpResourceReadResponse> {
    const toolThreadId = await this.getToolThread({
      ownerThreadId: threadId,
      ...context,
    });
    return this.client.mcpResourceRead({
      threadId: toolThreadId,
      server,
      uri,
    });
  }

  static toToolConnectionState(server: v2.McpServerStatus): ToolConnectionState {
    const toolsObj = server.tools;
    const toolsArray = Object.values(toolsObj)
      .filter((t): t is NonNullable<typeof t> => t != null)
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

    const resources = server.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));

    if (server.authStatus === "notLoggedIn") {
      return {
        status: "failed",
        error: "OAuth login required",
        needsAuth: true,
      };
    }

    if (toolsArray.length === 0 && resources.length === 0) {
      return { status: "connected", tools: [], resources: [], prompts: [] };
    }

    return {
      status: "connected",
      tools: toolsArray,
      resources,
      prompts: [],
    };
  }

  static toToolServerStatus(server: v2.McpServerStatus): ToolServerStatus {
    return {
      id: server.name,
      name: server.name,
      state: McpService.toToolConnectionState(server),
    };
  }

  private validateName(name: string): void {
    if (!VALID_SERVER_NAME.test(name)) {
      throw new Error(
        `Invalid server name "${name}": must match [a-zA-Z0-9_-]+`,
      );
    }
  }

  private async writeServerConfig(entry: McpServerEntry): Promise<void> {
    const toml = mcpServerEntryToToml(entry) satisfies JsonValue;
    await this.client.configValueWrite(
      `mcp_servers.${entry.name}`,
      toml,
    );
  }

  private invalidateToolThread(): void {
    this.toolThreadGeneration += 1;
    this.cachedToolThreads.clear();
  }

  private async getToolThread(context: McpToolThreadContext): Promise<string> {
    const ownerThread = await this.client.threadRead({
      threadId: context.ownerThreadId,
      includeTurns: false,
    });
    const model = context.model ?? null;
    const modelProvider = ownerThread.thread.modelProvider ?? null;
    const cwd = context.cwd ?? ownerThread.thread.cwd ?? null;

    const cacheKey = mcpToolThreadCacheKey({
      ownerThreadId: context.ownerThreadId,
      model,
      modelProvider,
      cwd,
    });
    const cached = this.cachedToolThreads.get(cacheKey);
    if (
      cached
      && cached.generation === this.toolThreadGeneration
    ) {
      return cached.id;
    }

    const id = await this.client.startMcpToolThread({
      model,
      modelProvider,
      cwd,
    });
    this.toolThreadBinder.bindToolThread(context.ownerThreadId, id);
    this.cachedToolThreads.set(cacheKey, {
      id,
      ownerThreadId: context.ownerThreadId,
      generation: this.toolThreadGeneration,
      model,
      modelProvider,
      cwd,
    });
    return id;
  }
}

let mcpService: McpService | null = null;
let mcpServiceClient: CodexClient | null = null;

export function getMcpService(): McpService {
  const client = getMcpCodexClient();
  if (!mcpService || mcpServiceClient !== client) {
    mcpService = new McpService(client);
    mcpServiceClient = client;
  }
  return mcpService;
}
