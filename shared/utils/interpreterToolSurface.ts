import { prefixToolName } from './mcpToolName';

const DEFAULT_HIDDEN_TOOL_NAMES = new Set<string>([
  prefixToolName('builtin-docx', 'add_docx_relationship'),
  prefixToolName('builtin-docx', 'add_docx_image'),
]);

const DEFAULT_HIDDEN_SERVER_IDS = new Set<string>([
  'builtin-browser',
]);

export function isInterpreterCliServerVisible(serverId: string): boolean {
  return !DEFAULT_HIDDEN_SERVER_IDS.has(serverId);
}

export function isInterpreterCliToolVisible(params: {
  serverId: string;
  toolName: string;
  allowedToolNames?: Iterable<string> | null;
}): boolean {
  if (!isInterpreterCliServerVisible(params.serverId)) {
    return false;
  }

  const prefixedToolName = prefixToolName(params.serverId, params.toolName);

  if (params.allowedToolNames) {
    const allowed = params.allowedToolNames instanceof Set
      ? params.allowedToolNames
      : new Set(params.allowedToolNames);
    return allowed.has(prefixedToolName);
  }

  return !DEFAULT_HIDDEN_TOOL_NAMES.has(prefixedToolName);
}
