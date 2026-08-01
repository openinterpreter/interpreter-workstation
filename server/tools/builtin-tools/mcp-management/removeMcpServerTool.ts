/**
 * Remove MCP Server Tool
 *
 * Allows the agent to remove an MCP server from the workstation.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { getToolManager } from '../../toolManagerAccessor';

export const removeMcpServerTool: BuiltinToolDefinition = {
  name: 'mcp_remove_server',
  description: 'Remove an MCP server from the workstation. This will disconnect the server and remove its configuration. Use mcp_list_servers to find server IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      serverId: {
        type: 'string',
        description: 'The ID of the MCP server to remove (use mcp_list_servers to find IDs)',
      },
    },
    required: ['serverId'],
  },
  handler: async (args: Record<string, any>) => {
    try {
      const { serverId } = args;

      if (!serverId) {
        return {
          content: [{ type: 'text', text: 'Error: serverId is required' }],
          isError: true,
        };
      }

      // Don't allow removing built-in servers
      if (serverId.startsWith('builtin-')) {
        return {
          content: [{ type: 'text', text: `Error: Cannot remove built-in server "${serverId}"` }],
          isError: true,
        };
      }

      const status = await getToolManager().getToolServer(serverId);
      if (!status) {
        return {
          content: [{ type: 'text', text: `Error: MCP server with ID "${serverId}" not found` }],
          isError: true,
        };
      }

      const serverName = status.name;
      await getToolManager().removeServer(serverId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              serverId,
              name: serverName,
              mcpRefresh: {
                currentTurnToolsAvailable: true,
                nextTurnRequired: false,
                refreshTool: 'mcp_refresh_tools',
              },
              message: `Successfully removed MCP server "${serverName}". Call mcp_refresh_tools to refresh the MCP registry in this turn.`,
            }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Failed to remove MCP server: ${error.message}` }],
        isError: true,
      };
    }
  },
};
