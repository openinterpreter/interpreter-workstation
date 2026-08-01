import type { BuiltinToolDefinition } from '../../builtinTools';
import { getMcpService } from '../../../utils/mcpServiceBridge';

export const refreshMcpToolsTool: BuiltinToolDefinition = {
  name: 'mcp_refresh_tools',
  description: `Refresh configured MCP servers after adding, removing, updating, or toggling MCP servers. After refresh, call changed MCP tools through interpreter-app tools when they are visible in the same turn.`,
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Short reason for refreshing MCP tools.',
      },
    },
  },
  handler: async (args: Record<string, any>) => {
    const reason = typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim()
      : 'Refresh MCP tools';

    try {
      await getMcpService().reloadServers();

      const response = {
        success: true,
        reason,
        message: 'Interpreter refreshed MCP servers. Call the changed MCP tools through interpreter-app tools when they are visible.',
        currentTurnToolsAvailable: true,
        nextTurnRequired: false,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Failed to refresh MCP tools: ${error.message}` }],
        isError: true,
      };
    }
  },
};
