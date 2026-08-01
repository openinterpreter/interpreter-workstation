import type { ToolServer } from '@/api';
import {
  MCP_STORE_CATEGORIES,
  type McpStoreEntry,
} from '@/components/tools/mcpStoreData';

function normalizeSearchValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildSearchTerms(query: string): string[] {
  const normalizedQuery = normalizeSearchValue(query);
  return normalizedQuery.length > 0 ? normalizedQuery.split(/\s+/g) : [];
}

function joinSearchValues(values: Array<string | null | undefined>): string {
  return normalizeSearchValue(values.filter(Boolean).join(' '));
}

export function normalizeToolSearchQuery(query: string): string {
  return buildSearchTerms(query).join(' ');
}

export function getToolServerSearchText(tool: ToolServer): string {
  const config = tool.config;
  const declaredTools = (tool.state.tools || []).flatMap((declaredTool) => [
    declaredTool.name,
    declaredTool.description,
  ]);

  return joinSearchValues([
    tool.id,
    tool.name,
    tool.description,
    tool.state.status,
    config?.transport,
    config?.url,
    config?.command,
    config?.args?.join(' '),
    ...declaredTools,
  ]);
}

export function getStoreEntrySearchText(entry: McpStoreEntry): string {
  return joinSearchValues([
    entry.id,
    entry.name,
    entry.description,
    entry.domain,
    entry.url,
    entry.transport,
    entry.note,
    MCP_STORE_CATEGORIES[entry.category]?.label,
  ]);
}

export function matchesToolSearch(
  query: string,
  {
    tool,
    storeEntry,
    extraTerms = [],
  }: {
    tool?: ToolServer | null;
    storeEntry?: McpStoreEntry | null;
    extraTerms?: string[];
  },
): boolean {
  const terms = buildSearchTerms(query);
  if (terms.length === 0) return true;

  const haystack = joinSearchValues([
    ...(tool ? [getToolServerSearchText(tool)] : []),
    ...(storeEntry ? [getStoreEntrySearchText(storeEntry)] : []),
    ...extraTerms,
  ]);

  return terms.every((term) => haystack.includes(term));
}
