/**
 * ToolServersContext
 *
 * Shared state for tool servers (MCP + builtin).
 * All components that need tool server data should use this context
 * instead of fetching their own copy.
 *
 * Uses IPC events for real-time updates (event-driven, no polling).
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  listAllToolServers,
  addToolServer as apiAddToolServer,
  deleteToolServer as apiDeleteToolServer,
  toggleToolServer as apiToggleToolServer,
  ToolServer,
} from '../api';
import { toolServers } from '@/ipc';
import type { ToolServersChangedEvent } from '../../electron/ipc/registry';
import { isMarketingDemoMode } from '../demo/marketingDemo';

interface ToolServersContextType {
  servers: ToolServer[];
  loading: boolean;
  error: string | null;
  // Actions
  refresh: () => Promise<void>;
  addServer: (config: any) => Promise<string>;
  deleteServer: (serverId: string) => Promise<void>;
  toggleServer: (serverId: string, enabled: boolean) => Promise<void>;
}

const ToolServersContext = createContext<ToolServersContextType | null>(null);
let toolServersRefreshRequestId = 0;
let toolServersInitialLoadRequestId = 0;

function nextToolServersRefreshRequestId() {
  toolServersRefreshRequestId += 1;
  return toolServersRefreshRequestId;
}

function nextToolServersInitialLoadRequestId() {
  toolServersInitialLoadRequestId += 1;
  return toolServersInitialLoadRequestId;
}

export function ToolServersProvider({ children }: { children: React.ReactNode }) {
  "use no memo";

  const [servers, setServers] = useState<ToolServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const marketingDemoMode = isMarketingDemoMode();

  const refresh = useCallback(async () => {
    const requestId = nextToolServersRefreshRequestId();
    const startedAt = Date.now();
    console.log(`[tools-ui] refresh start requestId=${requestId} marketingDemoMode=${marketingDemoMode}`);
    if (marketingDemoMode) {
      setServers([]);
      setError(null);
      console.log(
        `[tools-ui] refresh done requestId=${requestId} durationMs=${Date.now() - startedAt} count=0 marketingDemoMode=true`,
      );
      return;
    }

    try {
      const data = await listAllToolServers();
      const nextServers = data.servers || [];
      setServers(nextServers);
      setError(null);
      console.log(
        `[tools-ui] refresh done requestId=${requestId} durationMs=${Date.now() - startedAt} count=${nextServers.length}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[tools-ui] refresh failed requestId=${requestId} durationMs=${Date.now() - startedAt} error=${message}`,
        error,
      );
      setError(message);
    }
  }, [marketingDemoMode]);

  // Initial load
  useEffect(() => {
    if (marketingDemoMode) {
      console.log('[tools-ui] initial load skip marketingDemoMode=true');
      setLoading(false);
      return;
    }

    async function load() {
      const requestId = nextToolServersInitialLoadRequestId();
      const startedAt = Date.now();
      console.log(`[tools-ui] initial-load start requestId=${requestId}`);
      setLoading(true);
      let snapshotCount = 0;
      try {
        const snapshot = await toolServers.getSnapshot();
        if (snapshot) {
          const nextServers = snapshot.servers as ToolServer[];
          snapshotCount = nextServers.length;
          setServers(nextServers);
          setError(null);
          setLoading(false);
          console.log(
            `[tools-ui] initial-load snapshot requestId=${requestId} count=${snapshotCount} loading=false`,
          );
        } else {
          console.log(`[tools-ui] initial-load snapshot requestId=${requestId} count=0 available=false`);
        }
        await refresh();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[tools-ui] initial-load failed requestId=${requestId} durationMs=${Date.now() - startedAt} error=${message}`,
          error,
        );
        setError(message);
      }
      setLoading(false);
      console.log(
        `[tools-ui] initial-load done requestId=${requestId} durationMs=${Date.now() - startedAt} loading=false snapshotCount=${snapshotCount}`,
      );
    }
    void load();
  }, [marketingDemoMode, refresh]);

  // Listen for real-time updates via IPC (event-driven, no polling)
  useEffect(() => {
    if (marketingDemoMode) {
      console.log('[tools-ui] event subscription skip marketingDemoMode=true');
      return;
    }

    console.log('[tools-ui] toolServers subscription ready');
    const unsubscribe = toolServers.onChanged((event: ToolServersChangedEvent) => {
      console.log(`[tools-ui] toolServers changed count=${event.servers.length}`);
      setServers(event.servers as ToolServer[]);
      setError(null);
      // The Tools page is event-driven after mount. If the initial list request
      // stalls, a live IPC snapshot is still enough to render the page.
      setLoading(false);
    });

    return unsubscribe;
  }, [marketingDemoMode]);

  const addServer = useCallback(async (config: any): Promise<string> => {
    if (marketingDemoMode) {
      return '';
    }

    const startedAt = Date.now();
    console.log('[tools-ui] add start');

    try {
      const result = await apiAddToolServer(config);
      console.log(`[tools-ui] add done durationMs=${Date.now() - startedAt} serverId=${result.serverId}`);
      return result.serverId;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tools-ui] add failed durationMs=${Date.now() - startedAt} error=${message}`, error);
      throw error;
    }
  }, [marketingDemoMode]);

  const deleteServer = useCallback(async (serverId: string): Promise<void> => {
    if (marketingDemoMode) {
      return;
    }

    const startedAt = Date.now();
    console.log(`[tools-ui] delete start serverId=${serverId}`);

    try {
      await apiDeleteToolServer(serverId);
      console.log(`[tools-ui] delete done durationMs=${Date.now() - startedAt} serverId=${serverId}`);
      // IPC event will confirm the final state.
      setServers(prev => prev.filter(s => s.id !== serverId));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tools-ui] delete failed durationMs=${Date.now() - startedAt} serverId=${serverId} error=${message}`, error);
      throw error;
    }
  }, [marketingDemoMode]);

  const toggleServer = useCallback(async (serverId: string, enabled: boolean): Promise<void> => {
    if (marketingDemoMode) {
      return;
    }

    const startedAt = Date.now();
    console.log(`[tools-ui] toggle start serverId=${serverId} enabled=${enabled}`);

    try {
      await apiToggleToolServer(serverId, enabled);
      console.log(`[tools-ui] toggle done durationMs=${Date.now() - startedAt} serverId=${serverId} enabled=${enabled}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tools-ui] toggle failed durationMs=${Date.now() - startedAt} serverId=${serverId} enabled=${enabled} error=${message}`, error);
      throw error;
    }
  }, [marketingDemoMode]);

  return (
    <ToolServersContext.Provider
      value={{
        servers,
        loading,
        error,
        refresh,
        addServer,
        deleteServer,
        toggleServer,
      }}
    >
      {children}
    </ToolServersContext.Provider>
  );
}

export function useToolServers() {
  const context = useContext(ToolServersContext);
  if (!context) {
    throw new Error('useToolServers must be used within a ToolServersProvider');
  }
  return context;
}

/**
 * Hook for just the custom MCP servers (not builtin)
 */
export function useMcpServers() {
  const { servers, ...rest } = useToolServers();
  const mcpServers = servers.filter(s => s.config); // MCP servers have config
  return { servers: mcpServers, ...rest };
}
