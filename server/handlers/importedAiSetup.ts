import {
  buildOnboardingImportedToolSummary,
  type OnboardingImportedToolSummary,
} from '../../shared/types/onboardingState';
import type { DiscoveredMcp, McpDiscoveryResult } from './mcpDiscovery';
import { discoverMcps } from './mcpDiscovery';
import { addToolServer } from './toolServers';

export interface ImportedMcpCandidate {
  id: string;
  name: string;
  source: DiscoveredMcp['source'];
  transport: DiscoveredMcp['transport'];
  installable: true;
}

export interface ImportedAiSetupSnapshot {
  generatedAt: string;
  candidates: ImportedMcpCandidate[];
  summary: OnboardingImportedToolSummary;
}

let currentSnapshot: ImportedAiSetupSnapshot | null = null;
const candidateConfigs = new Map<string, DiscoveredMcp>();
let refreshPromise: Promise<ImportedAiSetupSnapshot> | null = null;

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'server';
}

function candidateIdFor(mcp: DiscoveredMcp): string {
  return `${mcp.source}:${slug(mcp.name)}`;
}

function toCandidate(mcp: DiscoveredMcp): ImportedMcpCandidate {
  return {
    id: candidateIdFor(mcp),
    name: mcp.name,
    source: mcp.source,
    transport: mcp.transport,
    installable: true,
  };
}

function buildToolServerConfig(mcp: DiscoveredMcp): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: mcp.name,
    transport: mcp.transport,
    enabled: true,
  };

  if (mcp.transport === 'stdio') {
    config.command = mcp.command;
    config.args = mcp.args ?? [];
    config.env = mcp.env ?? {};
  } else {
    config.url = mcp.url;
    config.headers = mcp.headers ?? {};
    if (mcp.oauthResource) {
      config.oauthResource = mcp.oauthResource;
    }
  }

  return config;
}

export function buildImportedAiSetupSnapshotForTest(
  discovery: Pick<McpDiscoveryResult, 'discovered'>,
  generatedAt = new Date().toISOString(),
): ImportedAiSetupSnapshot {
  return buildImportedAiSetupSnapshot(discovery, generatedAt);
}

function buildImportedAiSetupSnapshot(
  discovery: Pick<McpDiscoveryResult, 'discovered'>,
  generatedAt: string,
): ImportedAiSetupSnapshot {
  const candidates = discovery.discovered.map(toCandidate);
  const summary = buildOnboardingImportedToolSummary({
    detectedProviders: [],
    detectedTools: [],
    detectedConfigDirs: [],
    detectedApps: [],
    discoveredMcps: candidates.map((candidate) => ({
      name: candidate.name,
      source: candidate.source,
      transport: candidate.transport,
    })),
    generatedAt,
  });

  return {
    generatedAt,
    candidates,
    summary,
  };
}

export async function refreshImportedAiSetup(): Promise<ImportedAiSetupSnapshot> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const discovery = await discoverMcps();
    const generatedAt = new Date().toISOString();
    const nextConfigs = new Map<string, DiscoveredMcp>();
    for (const mcp of discovery.discovered) {
      nextConfigs.set(candidateIdFor(mcp), mcp);
    }

    const snapshot = buildImportedAiSetupSnapshot(discovery, generatedAt);
    candidateConfigs.clear();
    for (const [id, config] of nextConfigs) {
      candidateConfigs.set(id, config);
    }
    currentSnapshot = snapshot;
    console.log(`[Imported AI Setup] refreshed candidates=${snapshot.candidates.length}`);
    return snapshot;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

export async function getImportedAiSetup(): Promise<ImportedAiSetupSnapshot> {
  return currentSnapshot ?? refreshImportedAiSetup();
}

export async function installImportedMcpCandidate(candidateId: string): Promise<{ serverId: string }> {
  const mcp = candidateConfigs.get(candidateId);
  if (!mcp) {
    throw new Error(`Imported MCP candidate not found: ${candidateId}`);
  }

  return addToolServer(buildToolServerConfig(mcp));
}
