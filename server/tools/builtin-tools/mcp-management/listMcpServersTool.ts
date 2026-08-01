/**
 * List MCP Servers Tool
 *
 * Lists all MCP servers (both custom and built-in) with their status.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { getMcpService, McpService } from '../../../../src/lib/codex/mcp-service';
import { getToolManager } from '../../toolManagerAccessor';

export const listMcpServersTool: BuiltinToolDefinition = {
  name: 'mcp_list_servers',
  description: 'List all MCP servers in the workstation, including their connection status, available tools, and configuration. Shows both user-added MCP servers and built-in tool servers.',
  inputSchema: {
    type: 'object',
    properties: {
      includeBuiltin: {
        type: 'boolean',
        description: 'Whether to include built-in servers in the list (default: false, only shows user-added MCP servers)',
      },
      includeTools: {
        type: 'boolean',
        description: 'Whether to include the list of tools for each server (default: false)',
      },
    },
    required: [],
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args: Record<string, any>) => {
    try {
      const includeBuiltin = args.includeBuiltin === true;
      const includeTools = args.includeTools === true;

      // Get MCP servers from the Codex runtime
      const response = await getMcpService().listServers();
      const mcpResults = response.data.map((server) => {
        const toolStatus = McpService.toToolServerStatus(server);
        const state = toolStatus.state as any;
        const base: Record<string, any> = {
          id: toolStatus.id,
          name: toolStatus.name,
          description: toolStatus.description,
          status: state?.status ?? 'unknown',
          isBuiltin: false,
          toolCount: state?.tools?.length ?? 0,
          resourceCount: state?.resources?.length ?? 0,
        };

        if (state?.status === 'failed' && state?.error) {
          base.error = state.error;
        }

        if (includeTools && state?.tools) {
          return {
            ...base,
            tools: state.tools.map((t: any) => ({
              name: t.name,
              description: t.description,
            })),
          };
        }

        return base;
      });

      let builtinResults: Record<string, any>[] = [];
      if (includeBuiltin) {
        const allServers = await getToolManager().listAllToolServers();
        builtinResults = allServers
          .filter(s => s.id.startsWith('builtin-'))
          .map(server => {
            const state = server.state as any;
            const base: Record<string, any> = {
              id: server.id,
              name: server.name,
              description: server.description,
              status: state?.status ?? 'unknown',
              isBuiltin: true,
              toolCount: state?.tools?.length ?? 0,
              resourceCount: state?.resources?.length ?? 0,
            };

            if (includeTools && state?.tools) {
              return {
                ...base,
                tools: state.tools.map((t: any) => ({
                  name: t.name,
                  description: t.description,
                })),
              };
            }

            return base;
          });
      }

      const result = [...mcpResults, ...builtinResults];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              totalServers: result.length,
              mcpServers: mcpResults.length,
              builtinServers: builtinResults.length,
              servers: result,
            }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Failed to list MCP servers: ${error.message}` }],
        isError: true,
      };
    }
  },
};
