import { mcpDiscovery, servers } from '../../ipc';

export interface SimpleMcpSummary {
  configured: string[];
  discovered: string[];
}

/** Only actual configured or locally discoverable MCPs warrant an onboarding step. */
export async function discoverSimpleMcps(): Promise<SimpleMcpSummary> {
  const [existing, imported] = await Promise.all([
    servers.list(),
    typeof mcpDiscovery.importedSetup === 'function'
      ? mcpDiscovery.importedSetup()
      : mcpDiscovery.discover(),
  ]);
  return {
    // The shared tool-server list includes Workstation's built-in tools. Only
    // configured MCP servers belong in this optional onboarding step.
    configured: (existing.servers ?? [])
      .filter((server: { id?: string; name?: string }) =>
        typeof server.id === 'string'
        && server.id.length > 0
        && !server.id.startsWith('builtin-')
        && typeof server.name === 'string'
        && server.name.length > 0)
      .map((server: { name: string }) => server.name),
    discovered: ('candidates' in imported && Array.isArray(imported.candidates)
      ? imported.candidates
      : imported.discovered ?? []).map((candidate: { name: string }) => candidate.name),
  };
}

export function shouldShowSimpleMcpStep(summary: SimpleMcpSummary | null): boolean {
  return Boolean(summary && (summary.configured.length || summary.discovered.length));
}
