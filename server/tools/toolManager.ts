import type { ToolServerStatus } from './toolTypes';
import * as configStore from '../configStore';
import { getMcpService, McpService } from '../utils/mcpServiceBridge';
import {
  getAgentFacingHiddenBuiltinServers,
  getBuiltinServers,
  getBuiltinServerLoadFailures,
  getBuiltinServer,
  getBuiltinServerIncludingHidden,
  getBuiltinToolHandler,
  getBuiltinToolHandlerIncludingHidden,
  type BuiltinToolDefinition,
} from './builtinTools';
import { emitToolServersChanged } from '../utils/ipcBridge';
import { getCurrentWorkspace } from '../utils/workspace';
import { enforceFilesystemBoundary } from './filesystemBoundary';
import { getToolCallMetadata } from '../utils/codexMcpBridge';
import { getCurrentTurnMessageId } from '../utils/turnMessageIdRegistry';
import { runWithWorkspaceOverride } from '../utils/workspace';
import type { McpServerEntry } from '../../src/lib/codex/protocol';
import type { ToolServerInfo } from '../../electron/ipc/registry';
import type { McpServerConfig } from './mcpTypes';
import { isToolServerAgentAccessible } from '../../shared/toolServerAvailability';
import { prefixToolName } from '../../shared/utils/mcpToolName';
import { approvalManager } from '../approvalManager';

let toolManagerBroadcastRequestId = 0;
let toolManagerListStatusesRequestId = 0;
let toolManagerListAllRequestId = 0;
let toolManagerAddServerRequestId = 0;
let toolManagerRemoveServerRequestId = 0;
let toolManagerToggleServerRequestId = 0;
let toolManagerStartServerRequestId = 0;
let toolManagerStopServerRequestId = 0;
let toolManagerOAuthRequestId = 0;

type AppToolApprovalMode = 'auto' | 'prompt' | 'approve';

function builtinToolStatus(tool: BuiltinToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

function normalizeToolApprovalMode(value: unknown): AppToolApprovalMode | null {
  return value === 'auto' || value === 'prompt' || value === 'approve' ? value : null;
}

export class ToolManager {
  private validateMcpConfig(config: Record<string, any>): {
    normalizedTransport: 'stdio' | 'streamable_http';
    normalizedUrl?: string;
  } {
    const transport = config.transport;

    if (transport === 'stdio') {
      if (!config.command) {
        throw new Error('command is required for stdio transport');
      }
      if (config.url !== undefined) {
        throw new Error('url is not valid for stdio transport');
      }
      if (config.wsUrl !== undefined) {
        throw new Error('wsUrl is not valid for stdio transport');
      }
      if (config.headers !== undefined) {
        throw new Error('headers are not valid for stdio transport');
      }
      if (config.oauthResource !== undefined) {
        throw new Error('oauthResource is not valid for stdio transport');
      }

      return { normalizedTransport: 'stdio' };
    }

    if (transport === 'http' || transport === 'sse' || transport === 'streamable_http') {
      if (config.command !== undefined) {
        throw new Error('command is only valid for stdio transport');
      }
      if (config.args !== undefined) {
        throw new Error('args are only valid for stdio transport');
      }
      if (config.env !== undefined) {
        throw new Error('env is only valid for stdio transport');
      }
      if (!config.url) {
        throw new Error('url is required for remote transport');
      }
      if (config.wsUrl !== undefined) {
        throw new Error('wsUrl is only valid for websocket transport');
      }

      return {
        normalizedTransport: 'streamable_http',
        normalizedUrl: config.url,
      };
    }

    if (transport === 'websocket') {
      if (config.command !== undefined) {
        throw new Error('command is only valid for stdio transport');
      }
      if (config.args !== undefined) {
        throw new Error('args are only valid for stdio transport');
      }
      if (config.env !== undefined) {
        throw new Error('env is only valid for stdio transport');
      }
      if (config.url !== undefined) {
        throw new Error('url is not valid for websocket transport');
      }
      if (config.headers !== undefined) {
        throw new Error('headers are not valid for websocket transport');
      }
      if (config.oauthResource !== undefined) {
        throw new Error('oauthResource is not valid for websocket transport');
      }
      if (!config.wsUrl) {
        throw new Error('wsUrl is required for websocket transport');
      }

      return {
        normalizedTransport: 'streamable_http',
        normalizedUrl: config.wsUrl,
      };
    }

    throw new Error(`Unsupported MCP transport: ${String(transport)}`);
  }

  private async resolveMcpToolApprovalMode(serverId: string, toolName: string): Promise<AppToolApprovalMode> {
    const persistedConfig = await configStore.getMcpServer(serverId);
    const toolConfig = persistedConfig?.tools?.[toolName] as Record<string, unknown> | undefined;
    const toolMode = normalizeToolApprovalMode(toolConfig?.approvalMode ?? toolConfig?.approval_mode);
    if (toolMode) {
      return toolMode;
    }
    return normalizeToolApprovalMode(persistedConfig?.defaultToolsApprovalMode) ?? 'prompt';
  }

  private async hydrateMcpStatus(status: ToolServerStatus): Promise<ToolServerStatus> {
    const persistedConfig = await configStore.getMcpServer(status.id);
    if (!persistedConfig) {
      return status;
    }

    const preservePersistedFailure = this.shouldPreservePersistedMcpFailure(
      persistedConfig,
      status.state,
    );

    const nextConfig = await this.reconcilePersistedMcpState(
      status.id,
      persistedConfig,
      status.state,
    );

    return {
      ...status,
      name: nextConfig.name || status.name,
      description: status.description ?? nextConfig.description,
      state: preservePersistedFailure
        ? this.disconnectedPersistedMcpStatus(nextConfig).state
        : status.state,
      config: nextConfig,
    };
  }

  private disconnectedPersistedMcpStatus(
    persistedConfig: Awaited<ReturnType<typeof configStore.listMcpServers>>[number],
  ): ToolServerStatus {
    const failure = persistedConfig.lastConnectionFailure;
    return {
      id: persistedConfig.id,
      name: persistedConfig.name || persistedConfig.id,
      description: persistedConfig.description,
      state: failure
        ? {
            status: 'failed',
            error: failure.error,
            ...(failure.needsAuth ? { needsAuth: true } : {}),
          }
        : { status: 'disconnected' },
      config: persistedConfig,
    };
  }

  private async reconcilePersistedMcpState(
    serverId: string,
    persistedConfig: McpServerConfig,
    state: ToolServerStatus['state'],
  ): Promise<McpServerConfig> {
    if (state.status === 'connected') {
      if (this.shouldPreservePersistedMcpFailure(persistedConfig, state)) {
        return persistedConfig;
      }

      if (persistedConfig.lastConnectionFailure !== undefined) {
        await configStore.clearMcpServerConnectionFailure(serverId);
        const nextConfig = { ...persistedConfig };
        delete nextConfig.lastConnectionFailure;
        return nextConfig;
      }

      return persistedConfig;
    }

    if (state.status === 'failed') {
      const nextFailure = {
        error: state.error,
        ...(state.needsAuth ? { needsAuth: true } : {}),
        updatedAt: persistedConfig.lastConnectionFailure?.updatedAt ?? Date.now(),
      };
      const currentFailure = persistedConfig.lastConnectionFailure;
      const unchanged = currentFailure?.error === nextFailure.error
        && currentFailure?.needsAuth === nextFailure.needsAuth;
      if (!unchanged) {
        await configStore.setMcpServerConnectionFailure(serverId, nextFailure);
      }

      return {
        ...persistedConfig,
        lastConnectionFailure: unchanged ? currentFailure : nextFailure,
      };
    }

    return persistedConfig;
  }

  private shouldPreservePersistedMcpFailure(
    persistedConfig: McpServerConfig,
    state: ToolServerStatus['state'],
  ): boolean {
    if (state.status !== 'connected' || persistedConfig.lastConnectionFailure === undefined) {
      return false;
    }

    return state.tools.length === 0
      && state.resources.length === 0
      && state.prompts.length === 0;
  }

  private async listInitialToolServers(): Promise<ToolServerStatus[]> {
    const persistedConfigs = await configStore.listMcpServers();
    let cliAuthStatuses: Awaited<ReturnType<ReturnType<typeof getMcpService>["listAuthStatusesViaCli"]>>;
    try {
      cliAuthStatuses = await getMcpService().listAuthStatusesViaCli();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[toolManager] listInitialToolServers cliAuth failed, using persisted configs only error=${message}`);
      cliAuthStatuses = new Map();
    }
    const cliAuthEntries = Array.from(cliAuthStatuses.entries());
    console.log(`[toolManager] listInitialToolServers cliAuth entries=${JSON.stringify(cliAuthEntries)}`);
    const hasOAuthPrompt = cliAuthEntries.some(([, status]) => status === 'notLoggedIn');
    console.log(`[toolManager] listInitialToolServers hasOAuthPrompt=${hasOAuthPrompt} persistedCount=${persistedConfigs.length}`);
    const persistedMcpServers = await Promise.all(
      persistedConfigs.map(async (persistedConfig) => {
        const globalEnabled = await configStore.isBuiltinToolEnabled(persistedConfig.id);
        if (!globalEnabled) {
          return {
            id: persistedConfig.id,
            name: persistedConfig.name || persistedConfig.id,
            description: persistedConfig.description,
            state: { status: 'disconnected' } as const,
            config: persistedConfig,
            globallyDisabled: true,
          } satisfies ToolServerStatus;
        }

        if (hasOAuthPrompt) {
          const result = this.buildDisplayMcpStatusFromCliAuth(persistedConfig, cliAuthStatuses.get(persistedConfig.id));
          console.log(`[toolManager] listInitialToolServers server=${persistedConfig.id} path=cliAuth authStatus=${cliAuthStatuses.get(persistedConfig.id)} resultStatus=${result.state.status} needsAuth=${'needsAuth' in result.state ? (result.state as any).needsAuth : false}`);
          return result;
        }

        const result = this.disconnectedPersistedMcpStatus(persistedConfig);
        console.log(`[toolManager] listInitialToolServers server=${persistedConfig.id} path=disconnectedFallback resultStatus=${result.state.status}`);
        return result;
      }),
    );

    const builtinServers = await Promise.all(
      getBuiltinServers().map(async (builtin) => {
        const enabled = await configStore.isBuiltinToolEnabled(builtin.id);
        return {
          id: builtin.id,
          name: builtin.name,
          description: builtin.description,
          state: {
            status: enabled ? 'connected' : 'disconnected',
            tools: enabled ? builtin.tools.map(builtinToolStatus) : [],
            resources: enabled ? builtin.resources : [],
            prompts: enabled ? builtin.prompts : [],
          },
          globallyDisabled: !enabled,
        } satisfies ToolServerStatus;
      }),
    );

    return [...persistedMcpServers, ...builtinServers];
  }

  private async buildBuiltinServerStatus(
    serverId: string,
    includeHidden = false,
  ): Promise<ToolServerStatus | undefined> {
    const builtin = includeHidden
      ? getBuiltinServerIncludingHidden(serverId)
      : getBuiltinServer(serverId);
    if (!builtin) {
      return undefined;
    }

    const enabled = await configStore.isBuiltinToolEnabled(serverId);
    return {
      id: builtin.id,
      name: builtin.name,
      description: builtin.description,
      state: {
        status: enabled ? 'connected' : 'disconnected',
        tools: enabled ? builtin.tools.map(builtinToolStatus) : [],
        resources: enabled ? builtin.resources : [],
        prompts: enabled ? builtin.prompts : [],
      },
    };
  }

  private buildDisplayMcpStatusFromCliAuth(
    persistedConfig: Awaited<ReturnType<typeof configStore.listMcpServers>>[number],
    authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth",
  ): ToolServerStatus {
    const baseStatus = this.disconnectedPersistedMcpStatus(persistedConfig);

    if (authStatus === "notLoggedIn") {
      return {
        ...baseStatus,
        state: {
          status: "failed",
          error: "OAuth login required",
          needsAuth: true,
        },
      };
    }

    if (baseStatus.state.status === "failed") {
      return baseStatus;
    }

    if (authStatus) {
      return {
        ...baseStatus,
        state: {
          status: "connected",
          tools: [],
          resources: [],
          prompts: [],
        },
      };
    }

    return baseStatus;
  }

  private async mergePersistedMcpStatuses(
    response: Awaited<ReturnType<ReturnType<typeof getMcpService>["listServers"]>>,
  ): Promise<ToolServerStatus[]> {
    const runtimeStatuses = await Promise.all(
      response.data.map((status) => this.hydrateMcpStatus(McpService.toToolServerStatus(status))),
    );
    const runtimeStatusesById = new Map(runtimeStatuses.map((status) => [status.id, status]));
    const persistedConfigs = await configStore.listMcpServers();
    const mergedStatuses = persistedConfigs.map((persistedConfig) => {
      const runtimeStatus = runtimeStatusesById.get(persistedConfig.id);
      if (runtimeStatus) {
        runtimeStatusesById.delete(persistedConfig.id);
        return runtimeStatus;
      }
      return this.disconnectedPersistedMcpStatus(persistedConfig);
    });

    return [...mergedStatuses, ...runtimeStatusesById.values()];
  }

  private async buildToolServersFromMcpStatuses(mcpServers: ToolServerStatus[]): Promise<ToolServerStatus[]> {
    const statuses: ToolServerStatus[] = [];

    for (const mcp of mcpServers) {
      const globalEnabled = await configStore.isBuiltinToolEnabled(mcp.id);
      if (!globalEnabled) {
        statuses.push({
          id: mcp.id,
          name: mcp.name,
          description: mcp.description,
          state: { status: 'disconnected' },
          config: mcp.config,
          globallyDisabled: true,
        });
        continue;
      }

      statuses.push({
        id: mcp.id,
        name: mcp.name,
        description: mcp.description,
        state: mcp.state,
        config: mcp.config,
      });
    }

    for (const builtin of getBuiltinServers()) {
      const enabled = await configStore.isBuiltinToolEnabled(builtin.id);
      statuses.push({
        id: builtin.id,
        name: builtin.name,
        description: builtin.description,
        state: {
          status: enabled ? 'connected' : 'disconnected',
          tools: enabled ? builtin.tools.map(builtinToolStatus) : [],
          resources: enabled ? builtin.resources : [],
          prompts: enabled ? builtin.prompts : [],
        },
        globallyDisabled: !enabled,
      });
    }

    return statuses;
  }

  private toToolServerInfo(server: ToolServerStatus): ToolServerInfo {
    return {
      id: server.id,
      name: server.name,
      description: server.description,
      state: server.state,
      config: server.config,
      globallyDisabled: server.globallyDisabled,
    };
  }

  async listToolServerSnapshot(): Promise<ToolServerInfo[]> {
    const servers = await this.listInitialToolServers();
    return servers.map((server) => this.toToolServerInfo(server));
  }

  private async listDisplayToolServerSnapshot(): Promise<ToolServerInfo[]> {
    const servers = await this.listDisplayToolServers();
    return servers.map((server) => this.toToolServerInfo(server));
  }

  private async listToolServerSnapshotFromRuntimeResponse(
    response: Awaited<ReturnType<ReturnType<typeof getMcpService>["listServers"]>>,
  ): Promise<ToolServerInfo[]> {
    const mcpServers = await this.mergePersistedMcpStatuses(response);
    const servers = await this.buildToolServersFromMcpStatuses(mcpServers);
    return servers.map((server) => this.toToolServerInfo(server));
  }

  /**
   * Broadcast tool server changes to the renderer via IPC
   */
  private async broadcastChanges(source: 'initial' | 'display' = 'display'): Promise<void> {
    const requestId = ++toolManagerBroadcastRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] broadcastChanges start requestId=${requestId} source=${source}`);
    try {
      const servers = source === 'initial'
        ? await this.listToolServerSnapshot()
        : await this.listDisplayToolServerSnapshot();
      emitToolServersChanged(servers);
      console.log(
        `[toolManager] broadcastChanges done requestId=${requestId} source=${source} durationMs=${Date.now() - startedAt} count=${servers.length}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] broadcastChanges failed requestId=${requestId} source=${source} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
    }
  }

  private async broadcastRuntimeStatusResponse(
    response: Awaited<ReturnType<ReturnType<typeof getMcpService>["listServers"]>>,
  ): Promise<void> {
    const requestId = ++toolManagerBroadcastRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] broadcastChanges start requestId=${requestId} source=runtimeResponse`);
    try {
      const servers = await this.listToolServerSnapshotFromRuntimeResponse(response);
      emitToolServersChanged(servers);
      console.log(
        `[toolManager] broadcastChanges done requestId=${requestId} source=runtimeResponse durationMs=${Date.now() - startedAt} count=${servers.length}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] broadcastChanges failed requestId=${requestId} source=runtimeResponse durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
    }
  }

  private async broadcastInitialMcpConnectionPending(serverId: string): Promise<void> {
    const requestId = ++toolManagerBroadcastRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] broadcastChanges start requestId=${requestId} source=initialConnecting serverId=${serverId}`);
    try {
      const servers = (await this.listToolServerSnapshot()).map((server) => {
        if (server.id !== serverId || server.state.status !== 'disconnected') {
          return server;
        }

        return {
          ...server,
          state: { status: 'connecting' as const },
        };
      });
      emitToolServersChanged(servers);
      console.log(
        `[toolManager] broadcastChanges done requestId=${requestId} source=initialConnecting serverId=${serverId} durationMs=${Date.now() - startedAt} count=${servers.length}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] broadcastChanges failed requestId=${requestId} source=initialConnecting serverId=${serverId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
    }
  }

  async initialize(): Promise<void> {
    console.log('[Tool Manager] Initializing...');

    const builtinServerLoadFailures = Array.from(getBuiltinServerLoadFailures().entries());
    if (builtinServerLoadFailures.length > 0) {
      console.warn(
        '[Tool Manager] Built-in server load failures:',
        builtinServerLoadFailures.map(([serverId, details]) => ({
          serverId,
          details,
        })),
      );
    }

    const allBuiltins = getBuiltinServers();
    const enabledChecks = await Promise.all(allBuiltins.map(s => configStore.isBuiltinToolEnabled(s.id)));
    const enabledBuiltins = allBuiltins.filter((_, i) => enabledChecks[i]);
    console.log('[Tool Manager] Initialized with', enabledBuiltins.length, 'built-in tool servers');

    try {
      emitToolServersChanged(await this.listToolServerSnapshot());
    } catch (error) {
      console.error('[Tool Manager] Failed to broadcast initial tool server snapshot:', error);
    }
  }

  async addServer(config: {
    name: string;
    description?: string;
    transport: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    oauthResource?: string;
    wsUrl?: string;
    startupTimeoutSec?: number;
    toolTimeoutSec?: number;
    enabled?: boolean;
  }): Promise<string> {
    const requestId = ++toolManagerAddServerRequestId;
    const startedAt = Date.now();
    const serverId = this.slugifyServerName(config.name);
    console.log(`[toolManager] addServer start requestId=${requestId} serverId=${serverId}`);

    try {
      const existingConfig = await configStore.getMcpServer(serverId);
      if (existingConfig) {
        const existingRuntimeServer = await getMcpService().getServerStatus(serverId);
        if (existingRuntimeServer) {
          throw new Error(`MCP server "${serverId}" already exists`);
        }

        console.warn(
          `[toolManager] addServer repairing missing runtime server requestId=${requestId} serverId=${serverId}`,
        );
        const persistedEntry = this.configToMcpServerEntry(serverId, existingConfig);
        await getMcpService().createServer(persistedEntry);
        await this.broadcastInitialMcpConnectionPending(serverId);
        void this.pollNewServerStatus(serverId, requestId);
        console.log(
          `[toolManager] addServer repaired requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt}`,
        );
        return serverId;
      }

      const entry = this.configToMcpServerEntry(serverId, config);
      await getMcpService().createServer(entry);
      await configStore.addMcpServer({ ...config, id: serverId, enabled: config.enabled ?? true, createdAt: Date.now() } as any);
      await this.broadcastInitialMcpConnectionPending(serverId);

      void this.pollNewServerStatus(serverId, requestId);

      console.log(
        `[toolManager] addServer done requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt}`,
      );
      return serverId;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] addServer failed requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  private async pollNewServerStatus(serverId: string, parentRequestId: number): Promise<void> {
    const pollIntervalMs = 500;
    const maxAttempts = 20;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      try {
        const response = await getMcpService().listServers();
        const server = response.data.find((s) => s.name === serverId);
        if (!server) {
          console.log(`[toolManager] pollNewServerStatus parentRequestId=${parentRequestId} serverId=${serverId} attempt=${attempt} serverNotFound`);
          continue;
        }
        const state = McpService.toToolConnectionState(server);
        console.log(`[toolManager] pollNewServerStatus parentRequestId=${parentRequestId} serverId=${serverId} attempt=${attempt} status=${state.status} needsAuth=${'needsAuth' in state ? (state as any).needsAuth : false}`);
        if (state.status === 'connected' || state.status === 'failed') {
          await this.broadcastRuntimeStatusResponse(response);
          return;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[toolManager] pollNewServerStatus parentRequestId=${parentRequestId} serverId=${serverId} attempt=${attempt} error=${message}`);
      }
    }
    console.warn(`[toolManager] pollNewServerStatus parentRequestId=${parentRequestId} serverId=${serverId} exhausted maxAttempts=${maxAttempts}`);
  }

  async removeServer(serverId: string): Promise<void> {
    const requestId = ++toolManagerRemoveServerRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] removeServer start requestId=${requestId} serverId=${serverId}`);
    try {
      await getMcpService().deleteServer(serverId);
      await configStore.removeMcpServer(serverId);
      await this.broadcastChanges();
      console.log(
        `[toolManager] removeServer done requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] removeServer failed requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  async updateServer(serverId: string, updates: Record<string, any>): Promise<void> {
    const existingConfig = await configStore.getMcpServer(serverId);
    if (!existingConfig) {
      throw new Error(`Server ${serverId} not found`);
    }

    const merged = {
      ...existingConfig,
      ...updates,
      id: serverId,
      name: updates.name ?? existingConfig.name ?? serverId,
    };
    const entry = this.configToMcpServerEntry(serverId, merged);
    await getMcpService().updateServer(entry);
    await configStore.updateMcpServer(serverId, updates);
    await this.broadcastChanges();
  }

  async startServer(serverId: string): Promise<void> {
    const requestId = ++toolManagerStartServerRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] startServer start requestId=${requestId} serverId=${serverId}`);
    try {
      await getMcpService().enableServer(serverId);
      await configStore.updateMcpServer(serverId, { enabled: true });
      await this.broadcastChanges();
      console.log(
        `[toolManager] startServer done requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] startServer failed requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  async startOAuthLogin(
    serverId: string,
    scopes?: string[],
  ): Promise<{ authorizationUrl: string }> {
    const requestId = ++toolManagerOAuthRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] startOAuthLogin start requestId=${requestId} serverId=${serverId} scopes=${scopes?.length ?? 0}`);
    if (getBuiltinServer(serverId)) {
      throw new Error(`Built-in server "${serverId}" does not support OAuth login`);
    }

    try {
      const existingConfig = await configStore.getMcpServer(serverId);
      if (!existingConfig) {
        throw new Error(`Server ${serverId} not found`);
      }

      const result = await getMcpService().initiateOAuthLogin(serverId, scopes);
      console.log(
        `[toolManager] startOAuthLogin done requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt}`,
      );
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] startOAuthLogin failed requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  async stopServer(serverId: string): Promise<void> {
    const requestId = ++toolManagerStopServerRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] stopServer start requestId=${requestId} serverId=${serverId}`);
    try {
      await getMcpService().disableServer(serverId);
      await configStore.updateMcpServer(serverId, { enabled: false });
      await this.broadcastChanges();
      console.log(
        `[toolManager] stopServer done requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] stopServer failed requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  async restartServer(serverId: string): Promise<void> {
    await getMcpService().disableServer(serverId);
    await getMcpService().enableServer(serverId);
    await this.broadcastChanges();
  }

  async getServerStatus(serverId: string): Promise<ToolServerStatus | undefined> {
    const status = await getMcpService().getServerStatus(serverId);
    if (status) {
      return this.hydrateMcpStatus(McpService.toToolServerStatus(status));
    }

    const persistedConfig = await configStore.getMcpServer(serverId);
    if (!persistedConfig) {
      return undefined;
    }

    return this.disconnectedPersistedMcpStatus(persistedConfig);
  }

  async getDisplayServerStatus(serverId: string): Promise<ToolServerStatus | undefined> {
    const persistedConfig = await configStore.getMcpServer(serverId);
    const cliAuthStatuses = await getMcpService().listAuthStatusesViaCli();
    if (Array.from(cliAuthStatuses.values()).some((status) => status === "notLoggedIn")) {
      if (!persistedConfig) {
        return undefined;
      }
      return this.buildDisplayMcpStatusFromCliAuth(persistedConfig, cliAuthStatuses.get(serverId));
    }

    const status = await getMcpService().getDisplayServerStatus(serverId);
    if (status) {
      return this.hydrateMcpStatus(McpService.toToolServerStatus(status));
    }

    if (!persistedConfig) {
      return undefined;
    }

    return this.disconnectedPersistedMcpStatus(persistedConfig);
  }

  async listServerStatuses(): Promise<ToolServerStatus[]> {
    // NOTE(interpreter-cli-mcp): CLI-visible MCP listing starts here after
    // `server/handlers/interpreterCli.ts`. This method asks
    // `src/lib/codex/mcp-service.ts` for live runtime statuses and then merges
    // persisted app config from `server/configStore.ts` so app state and runtime
    // state stay joined.
    const requestId = ++toolManagerListStatusesRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] listServerStatuses start requestId=${requestId}`);
    try {
      const response = await getMcpService().listServers();
      const allStatuses = await this.mergePersistedMcpStatuses(response);
      console.log(
        `[toolManager] listServerStatuses done requestId=${requestId} durationMs=${Date.now() - startedAt} runtimeCount=${response.data.length} mergedCount=${allStatuses.length}`,
      );
      return allStatuses;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] listServerStatuses failed requestId=${requestId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  async listDisplayServerStatuses(): Promise<ToolServerStatus[]> {
    const requestId = ++toolManagerListStatusesRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] listDisplayServerStatuses start requestId=${requestId}`);
    try {
      let cliAuthStatuses: Awaited<ReturnType<ReturnType<typeof getMcpService>["listAuthStatusesViaCli"]>>;
      try {
        cliAuthStatuses = await getMcpService().listAuthStatusesViaCli();
      } catch (cliError: unknown) {
        const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
        console.warn(
          `[toolManager] listDisplayServerStatuses cliAuth failed requestId=${requestId} error=${cliMessage}, falling back to runtime+persisted`,
        );
        cliAuthStatuses = new Map();
      }

      if (Array.from(cliAuthStatuses.values()).some((status) => status === "notLoggedIn")) {
        const persistedConfigs = await configStore.listMcpServers();
        const allStatuses = persistedConfigs.map((persistedConfig) =>
          this.buildDisplayMcpStatusFromCliAuth(persistedConfig, cliAuthStatuses.get(persistedConfig.id)),
        );
        console.log(
          `[toolManager] listDisplayServerStatuses done requestId=${requestId} durationMs=${Date.now() - startedAt} runtimeCount=0 mergedCount=${allStatuses.length} source=cliAuthOnly`,
        );
        return allStatuses;
      }

      const response = await getMcpService().listServersForDisplay(cliAuthStatuses);
      const allStatuses = await this.mergePersistedMcpStatuses(response);
      console.log(
        `[toolManager] listDisplayServerStatuses done requestId=${requestId} durationMs=${Date.now() - startedAt} runtimeCount=${response.data.length} mergedCount=${allStatuses.length}`,
      );
      return allStatuses;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] listDisplayServerStatuses failed requestId=${requestId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  // =========================================================================
  // UNIFIED API - Works with both MCP servers and built-in tools
  // =========================================================================

  /**
   * List all tool servers
   */
  async listAllToolServers(): Promise<ToolServerStatus[]> {
    // NOTE(interpreter-cli-mcp): `interpreter-app tools list` depends on this method,
    // not on direct MCP config parsing. It joins app-managed MCP servers with
    // built-in Interpreter tool servers before caller-specific filtering in the
    // CLI handler at `server/handlers/interpreterCli.ts`.
    const requestId = ++toolManagerListAllRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] listAllToolServers start requestId=${requestId}`);
    const statuses: ToolServerStatus[] = [];

    try {
      const mcpServers = await this.listServerStatuses();
      statuses.push(...await this.buildToolServersFromMcpStatuses(mcpServers));

      console.log(
        `[toolManager] listAllToolServers done requestId=${requestId} durationMs=${Date.now() - startedAt} mcpCount=${mcpServers.length} totalCount=${statuses.length}`,
      );
      return statuses;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] listAllToolServers failed requestId=${requestId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  async listDisplayToolServers(): Promise<ToolServerStatus[]> {
    const requestId = ++toolManagerListAllRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] listDisplayToolServers start requestId=${requestId}`);

    try {
      const mcpServers = await this.listDisplayServerStatuses();
      const statuses = await this.buildToolServersFromMcpStatuses(mcpServers);
      console.log(
        `[toolManager] listDisplayToolServers done requestId=${requestId} durationMs=${Date.now() - startedAt} mcpCount=${mcpServers.length} totalCount=${statuses.length}`,
      );
      return statuses;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] listDisplayToolServers failed requestId=${requestId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Get a specific tool server
   */
  async getToolServer(serverId: string): Promise<ToolServerStatus | undefined> {
    const builtin = await this.buildBuiltinServerStatus(serverId);
    if (builtin) {
      return builtin;
    }

    const mcpStatus = await this.getServerStatus(serverId);
    if (mcpStatus) {
      return mcpStatus;
    }

    return undefined;
  }

  async getDisplayToolServer(serverId: string): Promise<ToolServerStatus | undefined> {
    const builtin = await this.buildBuiltinServerStatus(serverId);
    if (builtin) {
      return builtin;
    }

    const mcpStatus = await this.getDisplayServerStatus(serverId);
    if (mcpStatus) {
      return mcpStatus;
    }

    return undefined;
  }

  async getToolServerIncludingHidden(serverId: string): Promise<ToolServerStatus | undefined> {
    const builtin = await this.buildBuiltinServerStatus(serverId, true);
    if (builtin) {
      return builtin;
    }

    // Check if it's an MCP server
    const mcpStatus = await this.getServerStatus(serverId);
    if (mcpStatus) {
      return mcpStatus;
    }

    return undefined;
  }

  /**
   * Call a tool (MCP or built-in)
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, any>,
    _saveToDisk?: boolean,
    callerTabId?: string,
    toolContext?: {
      profileId?: string;
      modelConfig?: import('../../shared/types/model').AgentModelConfig;
      workspace?: string;
      progressReporter?: import('./builtinTools').BuiltinToolContext['reportProgress'];
      threadId?: string;
      saveToDiskPath?: string;
      overlayReviewedAction?: boolean;
    },
    externalToolCallId?: string,
    options?: {
      includeHiddenBuiltins?: boolean;
    },
  ): Promise<any> {
    // Check if it's a built-in tool
    const builtinTool = options?.includeHiddenBuiltins
      ? getBuiltinToolHandlerIncludingHidden(serverId, toolName)
      : getBuiltinToolHandler(serverId, toolName);
    if (builtinTool) {
      const enabled = await configStore.isBuiltinToolEnabled(serverId);
      if (!enabled) {
        throw new Error('Built-in tool server is disabled');
      }
      // CRITICAL: Pass workspace so tools don't use process.cwd()!
      const workspace = toolContext?.workspace ?? getCurrentWorkspace();

      // Resolve profileId → AgentModelConfig if provided
      let modelConfig: import('./builtinTools').BuiltinToolContext['modelConfig'] = toolContext?.modelConfig;
      if (!modelConfig && toolContext?.profileId) {
        const profile = await configStore.getProfile(toolContext.profileId);
        if (profile) {
          const { profileToModelConfig } = await import('../../shared/types/profile');
          modelConfig = profileToModelConfig(profile);
        }
      }

      // When called without a real caller tab (e.g. direct automation), provide a
      // synthetic agent/tool identity so sub-agent tools can resolve permissions
      // and track depth. CLI-bound calls already have a stable owner tab and
      // must preserve it for approvals and inline chat routing.
      let agentId: string | undefined;
      let toolCallId: string | undefined;
      let toolCallPath: string[] | undefined;
      let maxDepth: number | undefined;
      if (!callerTabId && toolContext?.profileId && modelConfig) {
        agentId = `automation-${Date.now()}`;
        toolCallId = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        toolCallPath = [];
        maxDepth = modelConfig.maxSubagentDepth;
      }

      // NOTE(mcp-approval-correlation): When called from the MCP bridge, externalToolCallId
      // carries the app-server stream item ID so the approval's toolCallId
      // matches the sidebar's tc.id. See `server/utils/codexMcpBridge.ts` and
      // `agent/components/prompt-kit/tool-fallback.tsx`.
      if (!toolCallId && externalToolCallId) {
        toolCallId = externalToolCallId;
      }

      const effectiveAgentId = agentId ?? callerTabId;
      const messageId = getCurrentTurnMessageId() ?? undefined;

      // NOTE(filesystem-approvals): Enforce workspace boundaries before handler
      // execution. This is the builtin-tool approval choke point for CLI, MCP
      // bridge, HTTP, IPC, and other callers; see
      // `server/tools/filesystemBoundary.ts` and `server/tools/filesystemGuard.ts`.
      const denial = await enforceFilesystemBoundary({
        builtinTool, args, workspace, serverId, toolCallId, agentId: effectiveAgentId,
      });
      if (denial) return denial;

      return await runWithWorkspaceOverride(workspace, async () => {
        return await builtinTool.handler(args, {
          workspace: workspace || undefined,
          callerTabId,
          threadId: toolContext?.threadId ?? getToolCallMetadata(externalToolCallId)?.threadId,
          modelConfig,
          agentId: effectiveAgentId,
          toolCallId,
          reportProgress: toolContext?.progressReporter,
          saveToDiskPath: toolContext?.saveToDiskPath,
          overlayReviewedAction: toolContext?.overlayReviewedAction,
          toolCallPath,
          maxDepth,
          messageId,
        });
      });
    }

    const enabled = await configStore.isBuiltinToolEnabled(serverId);
    if (!enabled) {
      throw new Error('MCP tool server is disabled');
    }

    const threadId = toolContext?.threadId
      ?? getToolCallMetadata(externalToolCallId)?.threadId;
    if (!threadId) {
      throw new Error('MCP tool calls require a Codex thread context');
    }

    const approvalToolName = prefixToolName(serverId, toolName);
    const approvalMode = await this.resolveMcpToolApprovalMode(serverId, toolName);
    const needsApproval = approvalMode !== 'auto';

    /**
     * NOTE(interpreter-cli-mcp): This is the approval gate for app-managed MCP tools.
     * Non-builtin MCP calls use the same app-tool approval mode contract as the
     * CLI-backed app tools: auto runs, prompt asks, approve asks through the
     * session-aware approval manager. `callerTabId` becomes `approval.agentId`;
     * `threadId` also goes into approval context so the renderer can recover
     * ownership if needed.
     *
     * Ingress paths:
     * - CLI: [interpreterCli.ts](../handlers/interpreterCli.ts)
     * - scoped MCP: [mcp.ts](../routes/mcp.ts) -> [codexMcpBridge.ts](../utils/codexMcpBridge.ts)
     *
     * Runtime path after approval:
     * [mcp-service.ts](../../src/lib/codex/mcp-service.ts).
     *
     * Do not add a direct execution path before this branch. The chat runtime's
     * global `mcp_servers` table stays empty in [codexRuntime.ts](../utils/codexRuntime.ts)
     * so app MCP tools cannot bypass this gate.
     */
    if (
      needsApproval
      && !approvalManager.isApprovedForSession(callerTabId, approvalToolName, serverId)
      && !approvalManager.isAutoApproveEnabled()
    ) {
      await toolContext?.progressReporter?.(
        `Waiting for user approval to call MCP tool ${approvalToolName}. Do not retry; this command will continue after approval.`,
      );
    }

    if (needsApproval) {
      const mcpApproval = await approvalManager.createSessionAwareApproval(
        approvalToolName,
        serverId,
        {
          message: 'Interpreter wants to use an MCP tool.',
          description: 'Review this action before continuing.',
          serverId,
          toolName,
          args,
          threadId,
          approvalMode,
        },
        '',
        0,
        externalToolCallId,
        callerTabId,
      );

      if (!mcpApproval.approved) {
        return {
          content: [{
            type: 'text',
            text: `MCP tool call denied by user: ${approvalToolName}`,
          }],
          isError: false,
        };
      }
    }

    return await getMcpService().callTool(
      threadId,
      serverId,
      toolName,
      args as Record<string, unknown>,
      {
        model: toolContext?.modelConfig?.modelId,
        cwd: toolContext?.workspace,
      },
    );
  }

  /**
   * Toggle a tool server (enable/disable)
   */
  async toggleToolServer(serverId: string, enabled: boolean): Promise<void> {
    const requestId = ++toolManagerToggleServerRequestId;
    const startedAt = Date.now();
    console.log(`[toolManager] toggleToolServer start requestId=${requestId} serverId=${serverId} enabled=${enabled}`);

    try {
      // Check if it's a built-in server
      const builtin = getBuiltinServer(serverId);
      if (builtin) {
        await configStore.setBuiltinToolEnabled(serverId, enabled);
        await this.broadcastChanges();
        console.log(
          `[toolManager] toggleToolServer done requestId=${requestId} serverId=${serverId} enabled=${enabled} builtin=true durationMs=${Date.now() - startedAt}`,
        );
        return;
      }

      // Otherwise, it's an MCP server
      if (enabled) {
        await this.startServer(serverId);
      } else {
        await this.stopServer(serverId);
      }

      console.log(
        `[toolManager] toggleToolServer done requestId=${requestId} serverId=${serverId} enabled=${enabled} builtin=false durationMs=${Date.now() - startedAt}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[toolManager] toggleToolServer failed requestId=${requestId} serverId=${serverId} enabled=${enabled} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    console.log('[Tool Manager] Shutting down (MCP lifecycle managed by Codex runtime)');
  }

  /**
   * Get all enabled tools for the agent.
   * Returns ALL connected tools (builtins + MCP servers).
   * Global disabled tools list should be applied by the caller.
   */
  async getEnabledToolsForAgent(): Promise<Array<{
    serverId: string;
    name: string;
    description: string;
    inputSchema: any;
    isBuiltin: boolean;
    handler?: (args: Record<string, any>, context?: any) => Promise<any>;
    fileAccess?: { mode: 'read' | 'write'; pathArg: string | string[]; pathArgModes?: Record<string, 'read' | 'write'> };
    mainAgentOnly?: boolean;
  }>> {
    const tools: Array<{
      serverId: string;
      name: string;
      description: string;
      inputSchema: any;
      isBuiltin: boolean;
      handler?: (args: Record<string, any>, context?: any) => Promise<any>;
      fileAccess?: { mode: 'read' | 'write'; pathArg: string | string[]; pathArgModes?: Record<string, 'read' | 'write'> };
      mainAgentOnly?: boolean;
    }> = [];

    // Get all visible tool servers
    const servers = await this.listAllToolServers();

    for (const server of servers) {
      if (!isToolServerAgentAccessible(server.state)) continue;

      const isBuiltin = server.id.startsWith('builtin-');
      const serverTools = 'tools' in server.state && Array.isArray(server.state.tools)
        ? server.state.tools
        : [];

      for (const tool of serverTools) {
        // For builtin tools, get the full definition with handler
        if (isBuiltin) {
          const builtinTool = getBuiltinToolHandler(server.id, tool.name);
          if (builtinTool) {
            tools.push({
              serverId: server.id,
              name: tool.name,
              description: builtinTool.description,
              inputSchema: builtinTool.inputSchema,
              isBuiltin: true,
              handler: builtinTool.handler,
              fileAccess: builtinTool.fileAccess,
              mainAgentOnly: builtinTool.mainAgentOnly,
            });
          }
        } else {
          // MCP tool - no handler, will be called via callTool()
          tools.push({
            serverId: server.id,
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema || { type: 'object', properties: {} },
            isBuiltin: false,
          });
        }
      }
    }

    // Hidden built-in servers are intentionally omitted from UI/server discovery,
    // but a small internal subset still needs to remain agent-facing.
    for (const builtin of getAgentFacingHiddenBuiltinServers()) {
      if (!builtin.id.startsWith('builtin-')) continue;
      const alreadyIncluded = tools.some((tool) => tool.serverId === builtin.id);
      if (alreadyIncluded) continue;

      const enabled = await configStore.isBuiltinToolEnabled(builtin.id);
      if (!enabled) continue;

      for (const tool of builtin.tools) {
        tools.push({
          serverId: builtin.id,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          isBuiltin: true,
          handler: tool.handler,
          fileAccess: tool.fileAccess,
          mainAgentOnly: tool.mainAgentOnly,
        });
      }
    }

    return tools;
  }

  private configToMcpServerEntry(serverId: string, config: Record<string, any>): McpServerEntry {
    const { normalizedTransport, normalizedUrl } = this.validateMcpConfig(config);
    const defaultToolsApprovalMode = normalizeToolApprovalMode(config.defaultToolsApprovalMode) ?? 'prompt';
    const tools = this.normalizeMcpToolApprovalConfigs(config.tools);
    if (normalizedTransport === 'stdio') {
      return {
        name: serverId,
        config: {
          transport: 'stdio',
          command: config.command,
          ...(config.args && { args: config.args }),
          ...(config.env && { env: config.env }),
          ...(config.enabled !== undefined && { enabled: config.enabled }),
          ...(config.startupTimeoutSec !== undefined && { startupTimeoutSec: config.startupTimeoutSec }),
          ...(config.toolTimeoutSec !== undefined && { toolTimeoutSec: config.toolTimeoutSec }),
          defaultToolsApprovalMode,
          ...(tools && { tools }),
        },
      };
    }

    return {
      name: serverId,
      config: {
        transport: 'streamable_http',
        url: normalizedUrl!,
        ...(config.headers && { httpHeaders: config.headers }),
        ...(config.oauthResource && { oauthResource: config.oauthResource }),
        ...(config.enabled !== undefined && { enabled: config.enabled }),
        ...(config.startupTimeoutSec !== undefined && { startupTimeoutSec: config.startupTimeoutSec }),
        ...(config.toolTimeoutSec !== undefined && { toolTimeoutSec: config.toolTimeoutSec }),
        defaultToolsApprovalMode,
        ...(tools && { tools }),
      },
    };
  }

  private normalizeMcpToolApprovalConfigs(
    tools: unknown,
  ): Record<string, { approvalMode: AppToolApprovalMode }> | undefined {
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
      return undefined;
    }

    const normalized = Object.fromEntries(
      Object.entries(tools as Record<string, Record<string, unknown>>).flatMap(([toolName, toolConfig]) => {
        if (!toolConfig || typeof toolConfig !== 'object' || Array.isArray(toolConfig)) {
          return [];
        }
        const approvalMode = normalizeToolApprovalMode(toolConfig.approvalMode ?? toolConfig.approval_mode);
        return approvalMode ? [[toolName, { approvalMode }]] : [];
      }),
    );

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private slugifyServerName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
