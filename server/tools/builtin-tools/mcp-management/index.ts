/**
 * MCP Management Server
 *
 * Provides tools for the agent to manage MCP (Model Context Protocol) servers.
 * This allows the agent to dynamically add, remove, and configure MCP servers.
 */

import type { BuiltinServerDefinition } from '../../builtinTools';
import { addMcpServerTool } from './addMcpServerTool';
import { updateMcpServerTool } from './updateMcpServerTool';
import { removeMcpServerTool } from './removeMcpServerTool';
import { listMcpServersTool } from './listMcpServersTool';
import { getMcpServerTool } from './getMcpServerTool';
import { toggleMcpServerTool } from './toggleMcpServerTool';
import { searchStoreTool } from './searchStoreTool';
import { refreshMcpToolsTool } from './refreshMcpToolsTool';

export const mcpManagementServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-mcp-management',
  name: 'MCP Management',
  description: 'Tools for managing MCP (Model Context Protocol) servers - add, remove, update, list, and configure MCP servers',
  isBuiltin: true,
  tools: [
    addMcpServerTool,
    updateMcpServerTool,
    removeMcpServerTool,
    listMcpServersTool,
    getMcpServerTool,
    toggleMcpServerTool,
    searchStoreTool,
    refreshMcpToolsTool,
  ],
  resources: [],
  prompts: [],
};
