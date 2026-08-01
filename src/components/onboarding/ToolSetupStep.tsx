/**
 * ToolSetupStep Component
 *
 * Onboarding step: Discover and import MCP tool servers.
 * Scans global configs for existing MCPs from Claude Code and Cursor.
 * Two-phase UI: selection phase, then sequential setup with live status.
 *
 * Phase 2 reuses ToolCard from the shared tools components and
 * ToolServersContext for real-time server state, keeping the rendering
 * and status tracking consistent with Settings > Tools.
 */

import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, Check, Plug, FolderSearch, Loader2, Server } from 'lucide-react';
import { mcpDiscovery, servers } from '../../ipc';
import { useToolServers } from '../../contexts/ToolServersContext';
import { ToolCard } from '../tools/ToolCard';

interface DiscoveredMcp {
  id: string;
  name: string;
  source: 'claude-code' | 'cursor';
  transport: 'stdio' | 'http' | 'sse' | 'websocket';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpDiscoveryResult {
  discovered: DiscoveredMcp[];
  sources: {
    claudeCode: { found: boolean; path: string };
    cursor: { found: boolean; path: string };
  };
}

interface ToolSetupStepProps {
  onComplete: () => void | Promise<void>;
  onBack: () => void;
}

const SETUP_TIMEOUT_MS = 120_000;

const LIST_CONTAINER_STYLE = {
  background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 16%, transparent)',
  border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 42%, transparent)',
} as const;

function getSourceLabel(mcp: DiscoveredMcp): string {
  if (mcp.id.startsWith('project-')) return 'Project';
  return mcp.source === 'claude-code' ? 'Claude Code' : 'Cursor';
}

export function ToolSetupStep({ onComplete, onBack }: ToolSetupStepProps) {
  const [loading, setLoading] = useState(true);
  const [discoveryResult, setDiscoveryResult] = useState<McpDiscoveryResult | null>(null);
  const [selectedMcps, setSelectedMcps] = useState<Set<string>>(new Set());
  const [installedMcps, setInstalledMcps] = useState<Set<string>>(new Set());
  const [isDeepScanning, setIsDeepScanning] = useState(false);
  const [deepScanResults, setDeepScanResults] = useState<DiscoveredMcp[]>([]);

  // Phase 2: Setup state
  const [setupPhase, setSetupPhase] = useState(false);
  const [installingMcps, setInstallingMcps] = useState<Array<{ mcp: DiscoveredMcp; serverId: string | null }>>([]);
  const [addingComplete, setAddingComplete] = useState(false);
  const [setupTimedOut, setSetupTimedOut] = useState(false);

  // Shared server context for real-time state and add operations
  const { servers: contextServers, addServer } = useToolServers();

  // Load discovered MCPs
  useEffect(() => {
    async function loadMcps() {
      try {
        const [discovery, existingServers] = await Promise.all([
          mcpDiscovery.discover(),
          servers.list(),
        ]);

        setDiscoveryResult(discovery);

        // Pre-select all discovered MCPs
        const discoveredIds = new Set<string>(discovery.discovered.map((m: DiscoveredMcp) => m.id));
        setSelectedMcps(discoveredIds);

        // Track already installed MCPs
        const existingServerList = existingServers?.servers || [];
        const installed = new Set<string>(existingServerList.map((s: any) => s.id));
        setInstalledMcps(installed);
      } catch (error) {
        console.error('[ToolSetupStep] Error loading MCPs:', error);
      } finally {
        setLoading(false);
      }
    }
    loadMcps();
  }, []);

  // Toggle MCP selection
  const toggleMcp = useCallback((mcpId: string) => {
    setSelectedMcps((prev) => {
      const next = new Set(prev);
      if (next.has(mcpId)) {
        next.delete(mcpId);
      } else {
        next.add(mcpId);
      }
      return next;
    });
  }, []);

  // Deep scan for project-scope MCPs
  const handleDeepScan = useCallback(async () => {
    setIsDeepScanning(true);
    try {
      const result = await mcpDiscovery.deepScan();
      const newMcps = result.discovered || [];
      setDeepScanResults(newMcps);

      // Pre-select all newly discovered MCPs
      setSelectedMcps((prev) => {
        const next = new Set(prev);
        for (const mcp of newMcps) {
          next.add(mcp.id);
        }
        return next;
      });
    } catch (error) {
      console.error('[ToolSetupStep] Error during deep scan:', error);
    } finally {
      setIsDeepScanning(false);
    }
  }, []);

  // Build config from discovered MCP
  const buildConfig = (mcp: DiscoveredMcp) => {
    const config: any = {
      name: mcp.name,
      transport: mcp.transport,
      enabled: true,
    };

    if (mcp.transport === 'stdio') {
      config.command = mcp.command;
      config.args = mcp.args || [];
      config.env = mcp.env || {};
    } else {
      config.url = mcp.url;
      config.headers = mcp.headers || {};
    }

    return config;
  };

  // Phase 2: Add servers sequentially via shared context
  const runSetup = useCallback(async (mcpsToInstall: DiscoveredMcp[]) => {
    setSetupPhase(true);
    setInstallingMcps(mcpsToInstall.map(mcp => ({ mcp, serverId: null })));

    // Process each MCP sequentially
    for (let i = 0; i < mcpsToInstall.length; i++) {
      try {
        const config = buildConfig(mcpsToInstall[i]);
        const serverId = await addServer(config);
        setInstallingMcps(prev => {
          const next = [...prev];
          next[i] = { ...next[i], serverId };
          return next;
        });
      } catch (error) {
        console.error(`[ToolSetupStep] Error adding ${mcpsToInstall[i].name}:`, error);
      }
    }
    setAddingComplete(true);
  }, [addServer]);

  // Safety timeout so the user is never stuck
  useEffect(() => {
    if (!setupPhase) return;
    const timer = setTimeout(() => setSetupTimedOut(true), SETUP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [setupPhase]);

  // Derive setup completion from real server states in context
  const setupComplete = addingComplete && installingMcps.every(({ serverId }) => {
    if (!serverId) return true;
    const server = contextServers.find(s => s.id === serverId);
    if (!server) return false;
    const { status } = server.state;
    const needsAuth = status === 'failed' && (server.state as any).needsAuth === true;
    return status === 'connected' || (status === 'failed' && !needsAuth);
  });

  // Phase 1 → Phase 2 transition
  const handleContinue = async () => {
    if (setupPhase) {
      await onComplete();
      return;
    }

    const allDiscovered = [
      ...(discoveryResult?.discovered || []),
      ...deepScanResults,
    ];

    const toInstall = allDiscovered.filter(
      (mcp) => selectedMcps.has(mcp.id) && !installedMcps.has(mcp.id)
    );

    // Nothing to install, skip to next step
    if (toInstall.length === 0) {
      await onComplete();
      return;
    }

    runSetup(toInstall);
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full px-8 py-12">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-ui-sm">Scanning for tools...</span>
        </div>
      </div>
    );
  }

  const discovered = discoveryResult?.discovered || [];
  const allDiscovered = [...discovered, ...deepScanResults];
  const hasDiscoveredMcps = allDiscovered.length > 0;
  const sources = discoveryResult?.sources;

  // Build source description
  const getSourceDescription = () => {
    const parts: string[] = [];
    if (sources?.claudeCode.found) parts.push('Claude Code');
    if (sources?.cursor.found) parts.push('Cursor');
    if (deepScanResults.length > 0) parts.push('projects');
    return parts.length > 0 ? `from ${parts.join(' & ')}` : '';
  };

  const totalSetupCount = installingMcps.length;

  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full px-8 py-12">
      <div className="max-w-md w-full space-y-8">
        {/* Back button - hidden during setup phase */}
        {!setupPhase && (
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-ui-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="size-4" />
            Back
          </button>
        )}

        {/* Header */}
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-normal leading-[1.1] text-foreground">
            Connect your tools
          </h1>
          <p className="text-base text-muted-foreground">
            {setupPhase
              ? (setupComplete || setupTimedOut)
                ? `Finished setting up ${totalSetupCount} tool${totalSetupCount === 1 ? '' : 's'}`
                : `Setting up ${totalSetupCount} tool${totalSetupCount === 1 ? '' : 's'}...`
              : hasDiscoveredMcps
                ? `Found ${allDiscovered.length} tool${allDiscovered.length === 1 ? '' : 's'} ${getSourceDescription()}`
                : 'Import tools from Claude Code or Cursor'}
          </p>
        </div>

        {/* Phase 2: Setup progress using shared ToolCard */}
        {setupPhase && (
          <div className="overflow-hidden rounded-[14px]" style={LIST_CONTAINER_STYLE}>
            <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
              {installingMcps.map(({ mcp, serverId }) => {
                const server = serverId
                  ? contextServers.find(s => s.id === serverId)
                  : null;

                if (server) {
                  return (
                    <ToolCard
                      key={mcp.id}
                      tool={server}
                      mode="edit"
                    />
                  );
                }

                return (
                  <div
                    key={mcp.id}
                    className="flex items-center gap-3 px-3.5 py-3"
                  >
                    <div
                      className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px]"
                      style={{
                        background: 'color-mix(in srgb, var(--oa-primary, var(--foreground)) 7%, var(--oa-bg-subtle, var(--muted)) 93%)',
                        border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 24%, transparent)',
                      }}
                    >
                      <Server className="size-4 text-muted-foreground" />
                    </div>
                    <span className="text-ui-sm font-medium text-foreground flex-1 truncate">
                      {mcp.name}
                    </span>
                    <span className="flex items-center gap-1 text-ui-xs text-muted-foreground shrink-0">
                      <Loader2 className="size-3 animate-spin" />
                      Queued
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Phase 1: Selection UI */}
        {!setupPhase && (
          <>
            {hasDiscoveredMcps && (
              <div className="overflow-hidden rounded-[14px]" style={LIST_CONTAINER_STYLE}>
                <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                  {allDiscovered.map((mcp) => {
                    const isInstalled = installedMcps.has(mcp.id);
                    const isSelected = selectedMcps.has(mcp.id);

                    return (
                      <button
                        key={mcp.id}
                        onClick={() => toggleMcp(mcp.id)}
                        disabled={isInstalled}
                        className="w-full flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-[color-mix(in_srgb,var(--oa-bg-subtle,var(--muted))_54%,transparent)]"
                      >
                        <div
                          className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px]"
                          style={{
                            background: 'color-mix(in srgb, var(--oa-primary, var(--foreground)) 7%, var(--oa-bg-subtle, var(--muted)) 93%)',
                            border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 24%, transparent)',
                          }}
                        >
                          <Plug className="size-4 text-muted-foreground" />
                        </div>
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <span className="text-ui-sm font-medium text-foreground truncate">
                            {mcp.name}
                          </span>
                          <span className="text-ui-xs text-muted-foreground shrink-0">
                            {getSourceLabel(mcp)}
                          </span>
                        </div>
                        {isInstalled ? (
                          <span className="text-ui-xs text-muted-foreground shrink-0">Added</span>
                        ) : isSelected ? (
                          <Check className="size-4 text-foreground shrink-0" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Deep Scan Button */}
            {deepScanResults.length === 0 && (
              <button
                onClick={handleDeepScan}
                disabled={isDeepScanning}
                className="w-full flex items-center gap-3 px-3.5 py-3 rounded-[14px] transition-colors hover:bg-[color-mix(in_srgb,var(--oa-bg-subtle,var(--muted))_54%,transparent)]"
                style={{
                  background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 12%, transparent)',
                  border: 'var(--border-width) dashed color-mix(in srgb, var(--oa-border, var(--border)) 36%, transparent)',
                }}
              >
                <div
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px]"
                  style={{
                    background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 54%, transparent)',
                  }}
                >
                  {isDeepScanning ? (
                    <Loader2 className="size-4 text-muted-foreground animate-spin" />
                  ) : (
                    <FolderSearch className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <div className="text-ui-sm font-medium text-foreground">
                    {isDeepScanning ? 'Scanning...' : 'Scan for more tools'}
                  </div>
                  {!isDeepScanning && (
                    <p className="mt-0.5 text-ui-xs text-muted-foreground">
                      Documents, Downloads, Desktop
                    </p>
                  )}
                </div>
              </button>
            )}

            {/* Empty state */}
            {!hasDiscoveredMcps && !isDeepScanning && (
              <p className="text-ui-sm text-muted-foreground text-center">
                No tools found. You can add tools later in Settings.
              </p>
            )}
          </>
        )}

        {/* Help text */}
        <p className="text-ui-xs text-muted-foreground text-center">
          You can manage tools anytime in Settings
        </p>

        {/* Continue button */}
        <button
          onClick={handleContinue}
          disabled={setupPhase && !setupComplete && !setupTimedOut}
          className="w-full py-2 rounded-control bg-foreground text-background text-ui-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
