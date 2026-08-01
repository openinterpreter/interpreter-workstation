/**
 * Add MCP Server Tool
 *
 * Allows the agent to add a new MCP server to the workstation.
 * Supports stdio and streamable_http transport types via the Codex runtime.
 */

import type { BuiltinToolDefinition } from "../../builtinTools";
import {
  getAllowAgentAddToolsSync,
  getAllowLocalMcpServersSync,
} from "../../../configStore";
import { getToolManager } from "../../toolManagerAccessor";

const DEFAULT_LOCAL_STARTUP_TIMEOUT_SEC = 120;

export const addMcpServerTool: BuiltinToolDefinition = {
  name: "mcp_add_server",
  description: `Add a new MCP (Model Context Protocol) server to the workstation. MCP servers provide additional tools and capabilities.

Transport types:
- stdio: Run a local command (requires 'command', optionally 'args' and 'env')
- http: Connect to HTTP endpoint (requires 'url', optionally 'headers' and 'oauthResource')
- sse: Connect to Server-Sent Events endpoint (requires 'url')
- websocket: Connect to WebSocket endpoint (requires 'wsUrl')

The server will be enabled and started automatically after adding.`,
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          'A unique, human-readable name for the server (e.g., "GitHub MCP", "Local Python Tools")',
      },
      description: {
        type: "string",
        description: "Optional description of what this MCP server provides",
      },
      transport: {
        type: "string",
        enum: ["stdio", "http", "sse", "websocket"],
        description: "The transport type for connecting to the MCP server",
      },
      command: {
        type: "string",
        description:
          'For stdio transport: The command to run (e.g., "npx", "python", "node")',
      },
      args: {
        type: "array",
        items: { type: "string" },
        description:
          'For stdio transport: Command-line arguments as an array (e.g., ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"])',
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          'For stdio transport: Environment variables as key-value pairs (e.g., {"API_KEY": "xxx", "DEBUG": "true"})',
      },
      url: {
        type: "string",
        description: "For http/sse transport: The HTTP(S) URL endpoint",
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          'For http transport: HTTP headers for authentication (e.g., {"Authorization": "Bearer xxx"})',
      },
      oauthResource: {
        type: "string",
        description:
          "For remote OAuth transport: Protected resource metadata URL used to start the correct OAuth flow",
      },
      startup_timeout_sec: {
        type: "number",
        minimum: 1,
        description: `Optional startup timeout in seconds. Local stdio installs default to ${DEFAULT_LOCAL_STARTUP_TIMEOUT_SEC} seconds so first-run package downloads can finish.`,
      },
      tool_timeout_sec: {
        type: "number",
        minimum: 1,
        description:
          "Optional timeout in seconds for individual MCP tool calls.",
      },
      wsUrl: {
        type: "string",
        description:
          "For websocket transport: The WebSocket URL (ws:// or wss://)",
      },
    },
    required: ["name", "transport"],
  },
  handler: async (args: Record<string, any>) => {
    try {
      const {
        name,
        transport,
        command,
        args: cmdArgs,
        env,
        url,
        headers,
        oauthResource,
        wsUrl,
        startup_timeout_sec,
        tool_timeout_sec,
      } = args;

      // Check permissions based on transport type
      const isLocalTransport = transport === "stdio";
      if (isLocalTransport) {
        const allowLocal = getAllowLocalMcpServersSync();
        if (!allowLocal) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Cannot install local integrations (stdio transport). ` +
                  `The user has disabled "Install local integrations" in Settings > Tools. ` +
                  `Local integrations run code on the computer. ` +
                  `Try searching the official store with mcp_search_store for a remote alternative, ` +
                  `or ask the user to enable local integrations in Settings > Tools.`,
              },
            ],
            isError: true,
          };
        }
      } else {
        const allowRemote = getAllowAgentAddToolsSync();
        if (!allowRemote) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Cannot install remote integrations. ` +
                  `The user has disabled "Install remote integrations" in Settings > Tools. ` +
                  `Ask them to enable it if they want you to add integrations.`,
              },
            ],
            isError: true,
          };
        }
      }

      // Validate required fields based on transport type
      if (transport === "stdio" && !command) {
        return {
          content: [
            {
              type: "text",
              text: 'Error: "command" is required for stdio transport',
            },
          ],
          isError: true,
        };
      }

      if ((transport === "http" || transport === "sse") && !url) {
        return {
          content: [
            {
              type: "text",
              text: `Error: "url" is required for ${transport} transport`,
            },
          ],
          isError: true,
        };
      }

      if (transport === "websocket" && !wsUrl) {
        return {
          content: [
            {
              type: "text",
              text: 'Error: "wsUrl" is required for websocket transport',
            },
          ],
          isError: true,
        };
      }

      const serverId = await getToolManager().addServer({
        name,
        description: args.description,
        transport,
        command,
        args: cmdArgs,
        env,
        url,
        headers,
        oauthResource,
        wsUrl,
        startupTimeoutSec:
          startup_timeout_sec ??
          (isLocalTransport ? DEFAULT_LOCAL_STARTUP_TIMEOUT_SEC : undefined),
        toolTimeoutSec: tool_timeout_sec,
        enabled: true,
      });

      const shouldCheckRuntimeStatus = !isLocalTransport;
      const status = shouldCheckRuntimeStatus
        ? await getToolManager().getDisplayToolServer(serverId)
        : undefined;
      const connectionStatus = status?.state?.status ?? "configured";
      const needsAuth =
        status?.state?.status === "failed" && status.state.needsAuth === true;
      const toolCount =
        connectionStatus === "connected" &&
        status?.state?.status === "connected"
          ? (status.state.tools?.length ?? 0)
          : 0;

      const response: Record<string, any> = {
        success:
          connectionStatus === "connected" ||
          connectionStatus === "configured" ||
          needsAuth,
        serverId,
        name,
        transport,
        status: connectionStatus,
        toolCount,
        mcpRefresh: {
          currentTurnToolsAvailable: true,
          nextTurnRequired: false,
          refreshTool: "mcp_refresh_tools",
          usage: `After refreshing, call ${serverId} MCP tools through interpreter-app tools when they are visible in the tool list.`,
        },
      };

      if (connectionStatus === "configured") {
        response.message = `Added MCP server "${name}". Call mcp_refresh_tools, then call refreshed ${serverId} MCP tools through interpreter-app tools when they are visible.`;
      } else if (connectionStatus === "connected") {
        response.message =
          toolCount > 0
            ? `Successfully added and connected to MCP server "${name}" with ${toolCount} tools available. Call mcp_refresh_tools, then call refreshed ${serverId} MCP tools through interpreter-app tools when they are visible.`
            : `Successfully added and connected to MCP server "${name}". Call mcp_refresh_tools, then call refreshed ${serverId} MCP tools through interpreter-app tools when they are visible.`;
      } else if (needsAuth) {
        response.message = `Added MCP server "${name}". OAuth sign-in is required before tools become available.`;
      } else {
        response.message = `Added MCP server "${name}" but connection status: ${connectionStatus}.`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2),
          },
        ],
        isError:
          connectionStatus !== "connected" &&
          connectionStatus !== "configured" &&
          !needsAuth,
      };
    } catch (error: any) {
      return {
        content: [
          { type: "text", text: `Failed to add MCP server: ${error.message}` },
        ],
        isError: true,
      };
    }
  },
};
