/**
 * Get MCP Server Tool
 *
 * Gets detailed information about a specific MCP server.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { getMcpService, McpService } from '../../../../src/lib/codex/mcp-service';
import { getToolManager } from '../../toolManagerAccessor';

export const getMcpServerTool: BuiltinToolDefinition = {
  name: 'mcp_get_server',
  description: 'Get detailed information about a specific MCP server, including its configuration, connection status, and available tools.',
  inputSchema: {
    type: 'object',
    properties: {
      serverId: {
        type: 'string',
        description: 'The ID of the MCP server to get details for',
      },
    },
    required: ['serverId'],
  },
  annotations: {
    readOnlyHint: true,
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

      const isBuiltin = serverId.startsWith('builtin-');

      // For builtin servers, delegate to ToolManager
      if (isBuiltin) {
        const server = await getToolManager().getToolServer(serverId);
        if (!server) {
          return {
            content: [{ type: 'text', text: `Error: Server with ID "${serverId}" not found` }],
            isError: true,
          };
        }

        const state = server.state as any;
        const result = {
          id: server.id,
          name: server.name,
          description: server.description,
          isBuiltin: true,
          status: state?.status ?? 'unknown',
          tools: state?.tools?.map((t: any) => ({
            name: t.name,
            description: t.description,
          })) ?? [],
          resources: state?.resources?.map((r: any) => ({
            uri: r.uri,
            name: r.name,
          })) ?? [],
          prompts: state?.prompts?.map((p: any) => ({
            name: p.name,
            description: p.description,
          })) ?? [],
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      }

      // For MCP servers, query the Codex runtime
      const status = await getMcpService().getServerStatus(serverId);
      if (!status) {
        return {
          content: [{ type: 'text', text: `Error: MCP server with ID "${serverId}" not found` }],
          isError: true,
        };
      }

      const toolStatus = McpService.toToolServerStatus(status);
      const state = toolStatus.state as any;

      const result = {
        id: toolStatus.id,
        name: toolStatus.name,
        isBuiltin: false,
        status: state?.status ?? 'unknown',
        error: state?.error,
        authStatus: status.authStatus,
        tools: state?.tools?.map((t: any) => ({
          name: t.name,
          description: t.description,
        })) ?? [],
        resources: state?.resources?.map((r: any) => ({
          uri: r.uri,
          name: r.name,
        })) ?? [],
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Failed to get MCP server: ${error.message}` }],
        isError: true,
      };
    }
  },
};
