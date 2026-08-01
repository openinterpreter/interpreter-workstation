import { prefixToolName } from '../../shared/utils/mcpToolName';

export interface ToolExecutionScope {
  allowedToolNames?: string[] | null;
}

export function createAllowedToolSet(
  allowedToolNames?: string[] | null,
): Set<string> | null {
  if (!allowedToolNames || allowedToolNames.length === 0) {
    return null;
  }
  return new Set(allowedToolNames);
}

export function matchesAllowedToolScope(
  allowedTools: Set<string> | null,
  serverId: string,
  toolName: string,
): boolean {
  if (!allowedTools) {
    return true;
  }
  return allowedTools.has(prefixToolName(serverId, toolName));
}
