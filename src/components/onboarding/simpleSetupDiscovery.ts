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
    configured: (existing.servers ?? []).map((server: { name: string }) => server.name),
    discovered: ('candidates' in imported && Array.isArray(imported.candidates)
      ? imported.candidates
      : imported.discovered ?? []).map((candidate: { name: string }) => candidate.name),
  };
}

export function shouldShowSimpleMcpStep(summary: SimpleMcpSummary | null): boolean {
  return Boolean(summary && (summary.configured.length || summary.discovered.length));
}
