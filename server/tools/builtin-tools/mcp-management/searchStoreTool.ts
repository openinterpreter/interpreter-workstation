/**
 * Search MCP Store Tool
 *
 * Allows the agent to search the official MCP tool store for available tools.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  MCP_STORE_ENTRIES,
  MCP_STORE_CATEGORIES,
  type McpStoreCategory,
  type McpStoreEntry,
} from '../../../../src/components/tools/mcpStoreData';

export const searchStoreTool: BuiltinToolDefinition = {
  name: 'mcp_search_store',
  description: `Search the official MCP tool store for available tools.
Returns matching tools with their names, descriptions, and URLs.
Use mcp_add_server with the returned URL and transport to install a tool.`,

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to match against tool names and descriptions (optional)',
      },
      category: {
        type: 'string',
        enum: ['productivity', 'finance', 'developer', 'data', 'research', 'academic'],
        description: 'Filter by category (optional)',
      },
    },
  },
  annotations: {
    readOnlyHint: true,
  },

  handler: async (args: Record<string, any>) => {
    const { query, category } = args;
    const MAX_RESULTS = 50;

    let results: McpStoreEntry[] = [...MCP_STORE_ENTRIES];

    // Filter by category if provided
    if (category) {
      results = results.filter(entry => entry.category === category);
    }

    // Score and sort by relevance if query provided
    if (query && typeof query === 'string') {
      const queryLower = query.toLowerCase();

      // Score each entry by relevance
      const scored = results.map(entry => {
        let score = 0;
        const nameLower = entry.name.toLowerCase();
        const descLower = entry.description.toLowerCase();
        const idLower = entry.id.toLowerCase();

        // Exact name match
        if (nameLower === queryLower) score += 100;
        // Name starts with query
        else if (nameLower.startsWith(queryLower)) score += 50;
        // Name contains query
        else if (nameLower.includes(queryLower)) score += 30;

        // ID match
        if (idLower === queryLower) score += 40;
        else if (idLower.includes(queryLower)) score += 20;

        // Description contains query
        if (descLower.includes(queryLower)) score += 10;

        return { entry, score };
      });

      // Sort by score descending
      scored.sort((a, b) => b.score - a.score);
      results = scored.map(s => s.entry);
    }

    // Limit to max results
    results = results.slice(0, MAX_RESULTS);

    // Format results for the agent
    const formattedResults = results.map(entry => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      categoryLabel: MCP_STORE_CATEGORIES[entry.category as McpStoreCategory]?.label || entry.category,
      url: entry.url,
      transport: entry.transport,
      ...(entry.headers && { headers: entry.headers }),
      ...(entry.oauthResource && { oauthResource: entry.oauthResource }),
      ...(entry.note && { note: entry.note }),
    }));

    // Build response
    const response = {
      count: formattedResults.length,
      tools: formattedResults,
      hint: 'To add a tool, use mcp_add_server with name, url, and transport from the results above.',
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2),
        },
      ],
      isError: false,
    };
  },
};
