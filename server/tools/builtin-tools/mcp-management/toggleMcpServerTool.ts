/**
 * Toggle MCP Server Tool
 *
 * Enables or disables an MCP server.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { getToolManager } from '../../toolManagerAccessor';

export const toggleMcpServerTool: BuiltinToolDefinition = {
  name: 'mcp_toggle_server',
  description: 'Enable or disable an MCP server. When disabled, the server will be disconnected and its tools will not be available. When enabled, the server will attempt to connect.',
  inputSchema: {
    type: 'object',
    properties: {
      serverId: {
        type: 'string',
        description: 'The ID of the MCP server to toggle',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether to enable (true) or disable (false) the server',
      },
    },
    required: ['serverId', 'enabled'],
  },
  handler: async (args: Record<string, any>) => {
    try {
      const { serverId, enabled } = args;

      if (!serverId) {
        return {
          content: [{ type: 'text', text: 'Error: serverId is required' }],
          isError: true,
        };
      }

      if (typeof enabled !== 'boolean') {
        return {
          content: [{ type: 'text', text: 'Error: enabled must be a boolean (true or false)' }],
          isError: true,
        };
      }

      const server = await getToolManager().getToolServer(serverId);
      if (!server || serverId.startsWith('builtin-')) {
        return {
          content: [{ type: 'text', text: `Error: MCP server with ID "${serverId}" not found` }],
          isError: true,
        };
      }

      await getToolManager().toggleToolServer(serverId, enabled);

      const updatedServer = await getToolManager().getToolServer(serverId);
      const newStatus = updatedServer?.state?.status ?? 'unknown';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              serverId,
              name: server.name,
              enabled,
              status: newStatus,
              mcpRefresh: {
                currentTurnToolsAvailable: true,
                nextTurnRequired: false,
                refreshTool: 'mcp_refresh_tools',
              },
              message: enabled
                ? `Enabled MCP server "${server.name}". Status: ${newStatus}. Call mcp_refresh_tools, then call refreshed MCP tools through interpreter-app tools when they are visible.`
                : `Disabled MCP server "${server.name}". Call mcp_refresh_tools to refresh the MCP registry in this turn.`,
            }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Failed to toggle MCP server: ${error.message}` }],
        isError: true,
      };
    }
  },
};
