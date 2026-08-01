const SEPARATOR = "__";

export function prefixToolName(serverId: string, toolName: string): string {
  return `${serverId}${SEPARATOR}${toolName}`;
}

export function parseToolName(prefixedName: string): { serverId: string; toolName: string } | null {
  const idx = prefixedName.indexOf(SEPARATOR);
  if (idx < 0) return null;
  return {
    serverId: prefixedName.slice(0, idx),
    toolName: prefixedName.slice(idx + SEPARATOR.length),
  };
}

export function displayToolName(prefixedName: string): string {
  const parsed = parseToolName(prefixedName);
  return parsed ? parsed.toolName : prefixedName;
}
