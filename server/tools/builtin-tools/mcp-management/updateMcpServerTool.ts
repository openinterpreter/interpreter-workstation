/**
 * Update MCP Server Tool
 *
 * Allows the agent to update an existing MCP server's configuration.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { getAllowLocalMcpServersSync } from '../../../configStore';
import { getToolManager } from '../../toolManagerAccessor';

export const updateMcpServerTool: BuiltinToolDefinition = {
  name: 'mcp_update_server',
  description: `Update an existing MCP server's configuration. Use mcp_list_servers to find server IDs.

You can update any of the following fields:
- name: Change the display name
- description: Update the description
- transport: Change the transport type (stdio, http, sse, websocket)
- command/args/env: For stdio transport servers
- url/headers/oauthResource: For http transport servers
- startup_timeout_sec/tool_timeout_sec: Runtime and tool-call timeouts
- wsUrl: For websocket transport servers
- enabled: Enable or disable the server

The server will be reconnected after updating.`,
  inputSchema: {
    type: 'object',
    properties: {
      serverId: {
        type: 'string',
        description: 'The ID of the MCP server to update (get this from mcp_list_servers)',
      },
      transport: {
        type: 'string',
        enum: ['stdio', 'http', 'sse', 'websocket'],
        description: 'Change the transport type for connecting to the MCP server',
      },
      name: {
        type: 'string',
        description: 'New display name for the server',
      },
      description: {
        type: 'string',
        description: 'New description for the server',
      },
      command: {
        type: 'string',
        description: 'For stdio transport: The command to run',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'For stdio transport: Command-line arguments',
      },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'For stdio transport: Environment variables as key-value pairs',
      },
      url: {
        type: 'string',
        description: 'For http/sse transport: The HTTP(S) URL endpoint',
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'For http transport: HTTP headers',
      },
      oauthResource: {
        type: 'string',
        description: 'For remote OAuth transport: Protected resource metadata URL used to start the correct OAuth flow',
      },
      startup_timeout_sec: {
        type: 'number',
        minimum: 1,
        description: 'Startup timeout in seconds.',
      },
      tool_timeout_sec: {
        type: 'number',
        minimum: 1,
        description: 'Timeout in seconds for individual MCP tool calls.',
      },
      wsUrl: {
        type: 'string',
        description: 'For websocket transport: The WebSocket URL',
      },
      enabled: {
        type: 'boolean',
        description: 'Enable or disable the server',
      },
    },
    required: ['serverId'],
  },
  handler: async (args: Record<string, any>) => {
    try {
      const {
        serverId,
        transport,
        name,
        description,
        command,
        args: cmdArgs,
        env,
        url,
        headers,
        oauthResource,
        wsUrl,
        startup_timeout_sec,
        tool_timeout_sec,
        enabled,
      } = args;

      const existingServer = await getToolManager().getToolServer(serverId);
      if (!existingServer) {
        return {
          content: [{ type: 'text', text: `Error: No MCP server found with ID "${serverId}". Use mcp_list_servers to see available servers.` }],
          isError: true,
        };
      }

      const existingConfig = existingServer.config ?? {};
      const effectiveTransport = transport ?? existingConfig.transport;
      if (effectiveTransport === 'stdio') {
        const allowLocal = getAllowLocalMcpServersSync();
        if (!allowLocal) {
          return {
            content: [{
              type: 'text',
              text: `Cannot install local integrations (stdio transport). ` +
                    `The user has disabled "Install local integrations" in Settings > Tools. ` +
                    `Local integrations run code on the computer. ` +
                    `Ask the user to enable local integrations in Settings > Tools before switching this server to stdio.`,
            }],
            isError: true,
          };
        }
      }

      // Build updates object with only provided fields
      const updates: Record<string, any> = {};
      if (transport !== undefined) updates.transport = transport;
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (command !== undefined) updates.command = command;
      if (cmdArgs !== undefined) updates.args = cmdArgs;
      if (env !== undefined) updates.env = env;
      if (url !== undefined) updates.url = url;
      if (headers !== undefined) updates.headers = headers;
      if (oauthResource !== undefined) updates.oauthResource = oauthResource;
      if (wsUrl !== undefined) updates.wsUrl = wsUrl;
      if (startup_timeout_sec !== undefined) updates.startupTimeoutSec = startup_timeout_sec;
      if (tool_timeout_sec !== undefined) updates.toolTimeoutSec = tool_timeout_sec;
      if (enabled !== undefined) updates.enabled = enabled;

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: No updates provided. Specify at least one field to update.' }],
          isError: true,
        };
      }

      await getToolManager().updateServer(serverId, updates);

      const status = await getToolManager().getDisplayToolServer(serverId);
      const connectionStatus = status?.state?.status ?? 'unknown';
      const needsAuth = status?.state?.status === 'failed' && status.state.needsAuth === true;
      const toolCount = connectionStatus === 'connected' && status?.state?.status === 'connected'
        ? status.state.tools?.length ?? 0
        : 0;

      const response: Record<string, any> = {
        success: connectionStatus === 'connected' || needsAuth,
        serverId,
        updatedFields: Object.keys(updates),
        status: connectionStatus,
        toolCount,
        mcpRefresh: {
          currentTurnToolsAvailable: true,
          nextTurnRequired: false,
          refreshTool: 'mcp_refresh_tools',
          usage: `After refreshing, call ${serverId} MCP tools through interpreter-app tools when they are visible in the tool list.`,
        },
      };

      if (connectionStatus === 'connected') {
        response.message = `Successfully updated MCP server "${serverId}". Tools: ${toolCount}. Call mcp_refresh_tools, then call refreshed MCP tools through interpreter-app tools when they are visible.`;
      } else if (needsAuth) {
        response.message = `Updated MCP server "${serverId}". OAuth sign-in is required before tools become available.`;
      } else {
        response.message = `Updated MCP server "${serverId}" but connection status: ${connectionStatus}. Call mcp_refresh_tools to refresh the MCP registry in this turn.`;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
        isError: connectionStatus !== 'connected' && !needsAuth,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Failed to update MCP server: ${error.message}` }],
        isError: true,
      };
    }
  },
};
