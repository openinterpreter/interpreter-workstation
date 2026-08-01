/**
 * ToolsSection - Settings section for managing tools
 *
 * Shows a grid of all tool servers (built-in + MCP).
 * - Built-in tools: Read-only detail view
 * - MCP servers: Editable form with delete option
 * - Global enable/disable toggles for all tools
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToolServers } from '../../contexts/ToolServersContext';
import { useToast } from '../../contexts/ToastContext';
import { useMcpServerForm } from '../../hooks/useMcpServerForm';
import { TOOLS_SECTION_ID, TOOL_TOGGLE_SWITCH_ID } from '../../../shared/element-ids';
import { ToolsGrid, ToolDetailView, McpServerForm } from '../tools';
import type { McpStoreEntry } from '../tools';
import { matchStoreEntryForCandidate } from '../tools/mcpStoreData';
import { DetailListHeader } from '../ui/detail-list';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { globalTools, openExternal, providers, setup, toolServers as toolServersIpc } from '../../ipc';
import { addToolServer, getToolServer, startToolServerOAuth, toolServerNeedsAuth, type ToolServer } from '../../api';
import { isInterpreterCliServerVisible } from '../../../shared/utils/interpreterToolSurface';
import { cn } from '@/lib/utils';

type ApprovalMode = 'auto' | 'prompt' | 'approve';

type ViewState =
  | { type: 'grid' }
  | { type: 'detail'; tool: ToolServer }
  | { type: 'add-new' };

type OAuthResolution =
  | { type: 'server'; server: ToolServer | null }
  | { type: 'oauth-failed'; error?: string; server: ToolServer | null };

type SetupCompletedEvent = {
  serverId: string;
  configured: boolean;
  error?: string;
};

function ToolApprovalPicker({
  value,
  onChange,
}: {
  value: ApprovalMode;
  onChange: (value: ApprovalMode) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1 rounded-control bg-muted p-1">
      {(['auto', 'prompt', 'approve'] as const).map((mode) => (
        <Button
          key={mode}
          type="button"
          size="sm"
          variant={value === mode ? 'secondary' : 'ghost'}
          className={cn(
            'h-7 px-2 text-ui-xs capitalize',
            value === mode
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onChange(mode)}
        >
          {mode}
        </Button>
      ))}
    </div>
  );
}

export function ToolsSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const { showToast } = useToast();
  const { servers: toolServers, loading, deleteServer } = useToolServers();
  const visibleToolServers = toolServers.filter((server) => isInterpreterCliServerVisible(server.id));
  const [viewState, setViewState] = useState<ViewState>({ type: 'grid' });
  const [confirmingDeleteTool, setConfirmingDeleteTool] = useState<string | null>(null);
  const pendingStoreEntryIdsRef = useRef(new Set<string>());
  const [pendingStoreEntryIds, setPendingStoreEntryIds] = useState<ReadonlySet<string>>(new Set());
  const pendingOAuthServerIdsRef = useRef(new Set<string>());
  const [pendingOAuthServerIds, setPendingOAuthServerIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingDeletedServerIds, setPendingDeletedServerIds] = useState<ReadonlySet<string>>(new Set());
  const [optimisticGlobalEnabledById, setOptimisticGlobalEnabledById] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [showBuiltIn, setShowBuiltIn] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (pendingStoreEntryIdsRef.current.size === 0) {
      return;
    }

    const installedStoreEntryIds = new Set(
      toolServers
        .map((server) =>
          matchStoreEntryForCandidate({
            id: server.id,
            name: server.name,
            url: server.config?.url,
            command: server.config?.command,
            args: server.config?.args,
          })?.id,
        )
        .filter((entryId): entryId is string => typeof entryId === 'string' && entryId.length > 0),
    );

    let changed = false;
    for (const entryId of pendingStoreEntryIdsRef.current) {
      if (installedStoreEntryIds.has(entryId)) {
        pendingStoreEntryIdsRef.current.delete(entryId);
        changed = true;
      }
    }

    if (changed) {
      setPendingStoreEntryIds(new Set(pendingStoreEntryIdsRef.current));
    }
  }, [toolServers]);

  const displayedToolServers = visibleToolServers
    .filter((server) => !pendingDeletedServerIds.has(server.id))
    .map((server) => {
      const optimisticEnabled = optimisticGlobalEnabledById.get(server.id);
      if (optimisticEnabled === undefined) {
        return server;
      }

      return {
        ...server,
        globallyDisabled: !optimisticEnabled,
      };
    });

  const formatMcpErrorMessage = useCallback((serverName: string, error?: string) => {
    const base = `${serverName} MCP server is not configured correctly.`;
    const detail = error?.trim();
    if (serverName === 'GitHub' && detail && detail.includes('GH_TOKEN/GITHUB_TOKEN')) {
      return detail;
    }
    return detail ? `${base} ${detail}` : base;
  }, []);

  const waitForServerOutcome = useCallback(async (serverId: string): Promise<ToolServer | null> => {
    try {
      const current = await getToolServer(serverId);
      if (current && current.state.status !== 'connecting' && current.state.status !== 'disconnected') {
        return current;
      }
    } catch {
      // Ignore transient lookup failures and fall back to the live IPC update.
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (server: ToolServer | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        unsubscribe();
        resolve(server);
      };

      const unsubscribe = toolServersIpc.onChanged((event: { servers: ToolServer[] }) => {
        const server = (event.servers as ToolServer[]).find((candidate) => candidate.id === serverId) ?? null;
        if (!server) return;
        if (server.state.status === 'failed' || server.state.status === 'connected') {
          finish(server);
        }
      });

      const timeoutId = window.setTimeout(() => finish(null), 10_000);
    });
  }, []);

  const notifyIfServerFailed = useCallback(async (serverId: string, serverName: string) => {
    const server = await waitForServerOutcome(serverId);
    if (server?.state.status === 'failed' && !toolServerNeedsAuth(server)) {
      showToast(formatMcpErrorMessage(serverName, server.state.error), 'error', 8000);
    }
  }, [formatMcpErrorMessage, showToast, waitForServerOutcome]);

  const setStoreEntryPending = useCallback((entryId: string, pending: boolean) => {
    if (pending) {
      pendingStoreEntryIdsRef.current.add(entryId);
    } else {
      pendingStoreEntryIdsRef.current.delete(entryId);
    }
    setPendingStoreEntryIds(new Set(pendingStoreEntryIdsRef.current));
  }, []);

  const waitForOAuthResolution = useCallback(async (serverId: string): Promise<OAuthResolution> => {
    try {
      const current = await getToolServer(serverId);
      if (current && (current.state.status === 'connected' || (current.state.status === 'failed' && !toolServerNeedsAuth(current)))) {
        return { type: 'server', server: current };
      }
    } catch {
      // Ignore transient lookup failures and wait for the next state change.
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: OAuthResolution) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        unsubscribeToolServers();
        unsubscribeSetup();
        resolve(result);
      };

      const unsubscribeToolServers = toolServersIpc.onChanged((event: { servers: ToolServer[] }) => {
        const server = event.servers.find((candidate) => candidate.id === serverId) ?? null;
        if (!server) {
          return;
        }
        if (server.state.status === 'connected' || (server.state.status === 'failed' && !toolServerNeedsAuth(server))) {
          finish({ type: 'server', server });
        }
      });

      const unsubscribeSetup = setup.onCompleted((event: SetupCompletedEvent) => {
        if (event.serverId !== serverId || event.configured) {
          return;
        }

        void (async () => {
          try {
            const server = await getToolServer(serverId);
            finish({ type: 'oauth-failed', error: event.error, server });
          } catch {
            finish({ type: 'oauth-failed', error: event.error, server: null });
          }
        })();
      });

      const timeoutId = window.setTimeout(() => finish({ type: 'server', server: null }), 300_000);
    });
  }, []);

  const setOAuthPending = useCallback((serverId: string, pending: boolean) => {
    if (pending) {
      pendingOAuthServerIdsRef.current.add(serverId);
    } else {
      pendingOAuthServerIdsRef.current.delete(serverId);
    }
    setPendingOAuthServerIds(new Set(pendingOAuthServerIdsRef.current));
  }, []);

  const setServerDeletePending = useCallback((serverId: string, pending: boolean) => {
    setPendingDeletedServerIds((previous) => {
      const next = new Set(previous);
      if (pending) {
        next.add(serverId);
      } else {
        next.delete(serverId);
      }
      return next;
    });
  }, []);

  const setOptimisticGlobalEnabled = useCallback((serverId: string, enabled: boolean | null) => {
    setOptimisticGlobalEnabledById((previous) => {
      const next = new Map(previous);
      if (enabled === null) {
        next.delete(serverId);
      } else {
        next.set(serverId, enabled);
      }
      return next;
    });
  }, []);

  const mcpForm = useMcpServerForm({
    onSuccess: (savedServer) => {
      if (savedServer) {
        void notifyIfServerFailed(savedServer.serverId, savedServer.name);
      }
    },
    onError: (error, attemptedServer) => {
      showToast(formatMcpErrorMessage(attemptedServer?.name || 'This', error.message), 'error', 8000);
    },
    onSaveComplete: () => {
      setViewState({ type: 'grid' });
    }
  });

  // Handle adding server from MCP Store
  const handleAddFromStore = useCallback((entry: McpStoreEntry) => {
    if (pendingStoreEntryIdsRef.current.has(entry.id)) {
      return;
    }

    setStoreEntryPending(entry.id, true);

    void (async () => {
      let addedServer = false;
      try {
        // GitHub UX shortcut: auto-create server in backend when gh CLI auth exists.
        if (entry.id === 'github') {
          try {
            const result = await providers.addGitHubMcpServerFromCliAuth();
            if (result.success) {
              addedServer = true;
              if (result.serverId) {
                void notifyIfServerFailed(result.serverId, entry.name);
              }
              return;
            }
            if (result.error) {
              console.error('Failed to auto-configure GitHub MCP auth from gh CLI:', result.error);
              showToast(formatMcpErrorMessage(entry.name, result.error), 'error', 8000);
            }
            return;
          } catch (error) {
            console.error('Failed to auto-configure GitHub MCP auth from gh CLI:', error);
            showToast(
              formatMcpErrorMessage(entry.name, error instanceof Error ? error.message : String(error)),
              'error',
              8000,
            );
            return;
          }
        }

        try {
          const { serverId } = await addToolServer({
            name: entry.name,
            transport: entry.transport,
            url: entry.url,
            headers: entry.headers,
            oauthResource: entry.oauthResource,
            enabled: true,
          });
          addedServer = true;
          void notifyIfServerFailed(serverId, entry.name);
        } catch (error) {
          console.error('Failed to add MCP server from store:', error);
          showToast(
            formatMcpErrorMessage(entry.name, error instanceof Error ? error.message : String(error)),
            'error',
            8000,
          );
        }
      } finally {
        if (addedServer) {
          return;
        }
        setStoreEntryPending(entry.id, false);
      }
    })();
  }, [formatMcpErrorMessage, notifyIfServerFailed, setStoreEntryPending, showToast]);

  const handleCompleteAuth = useCallback((server: ToolServer) => {
    if (!toolServerNeedsAuth(server) || pendingOAuthServerIdsRef.current.has(server.id)) {
      return;
    }

    setOAuthPending(server.id, true);

    void (async () => {
      try {
        if (server.id === 'github') {
          const result = await providers.addGitHubMcpServerFromCliAuth();
          if (!result.success) {
            showToast(
              formatMcpErrorMessage(server.name, result.error),
              'error',
              8000,
            );
            return;
          }

          const serverId = result.serverId ?? server.id;
          const resolution = await waitForOAuthResolution(serverId);
          if (resolution.type === 'oauth-failed') {
            showToast(
              formatMcpErrorMessage(server.name, resolution.error ?? resolution.server?.state.error),
              'error',
              8000,
            );
            return;
          }

          if (resolution.server?.state.status === 'failed' && !toolServerNeedsAuth(resolution.server)) {
            showToast(formatMcpErrorMessage(server.name, resolution.server.state.error), 'error', 8000);
          }
          return;
        }

        const { authorizationUrl } = await startToolServerOAuth(server.id);
        await openExternal(authorizationUrl);

        const resolution = await waitForOAuthResolution(server.id);
        if (resolution.type === 'oauth-failed') {
          showToast(
            formatMcpErrorMessage(server.name, resolution.error ?? resolution.server?.state.error),
            'error',
            8000,
          );
          return;
        }

        if (resolution.server?.state.status === 'failed' && !toolServerNeedsAuth(resolution.server)) {
          showToast(formatMcpErrorMessage(server.name, resolution.server.state.error), 'error', 8000);
        }
      } catch (error) {
        console.error('Failed to start MCP OAuth login:', error);
        showToast(
          formatMcpErrorMessage(server.name, error instanceof Error ? error.message : String(error)),
          'error',
          8000,
        );
      } finally {
        setOAuthPending(server.id, false);
      }
    })();
  }, [formatMcpErrorMessage, setOAuthPending, showToast, waitForOAuthResolution]);

  // Handle global tool enable/disable
  const handleGlobalToggle = useCallback(async (toolId: string, enabled: boolean) => {
    setOptimisticGlobalEnabled(toolId, enabled);
    try {
      await globalTools.set(toolId, enabled);
    } catch (error) {
      console.error('Failed to toggle global tool state:', error);
      setOptimisticGlobalEnabled(toolId, null);
    }
  }, [setOptimisticGlobalEnabled]);

  async function handleDeleteToolServer(toolId: string) {
    if (confirmingDeleteTool === toolId) {
      setConfirmingDeleteTool(null);
      setViewState({ type: 'grid' });
      setServerDeletePending(toolId, true);
      try {
        await deleteServer(toolId);
        setServerDeletePending(toolId, false);
      } catch (error) {
        console.error('Failed to remove tool server:', error);
        setServerDeletePending(toolId, false);
      }
    } else {
      setConfirmingDeleteTool(toolId);
      setTimeout(() => setConfirmingDeleteTool(null), 3000);
    }
  }

  // Direct delete from grid (single click deletes immediately)
  const handleDeleteFromGrid = useCallback(async (toolId: string) => {
    setServerDeletePending(toolId, true);
    try {
      await deleteServer(toolId);
      setServerDeletePending(toolId, false);
    } catch (error) {
      console.error('Failed to delete tool server:', error);
      setServerDeletePending(toolId, false);
    }
  }, [deleteServer, setServerDeletePending]);

  // Cancel a connecting server (removes it)
  const handleCancelServer = useCallback(async (toolId: string) => {
    setServerDeletePending(toolId, true);
    try {
      await deleteServer(toolId);
      setServerDeletePending(toolId, false);
    } catch (error) {
      console.error('Failed to cancel tool server:', error);
      setServerDeletePending(toolId, false);
    }
  }, [deleteServer, setServerDeletePending]);

  function handleToolClick(tool: ToolServer) {
    if (!tool.id.startsWith('builtin-')) {
      // MCP server - start editing
      mcpForm.startEditing(tool);
    }
    setViewState({ type: 'detail', tool });
  }

  function handleAddNew() {
    mcpForm.startAdding();
    setViewState({ type: 'add-new' });
  }

  function handleBack() {
    mcpForm.resetForm();
    setConfirmingDeleteTool(null);
    setViewState({ type: 'grid' });
  }

  if (loading) {
    return <div className="text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  // Detail view for a specific tool
  if (viewState.type === 'detail') {
    const tool = viewState.tool;
    const isBuiltin = tool.id.startsWith('builtin-');

    return (
      <div className="space-y-3" data-testid={TOOLS_SECTION_ID}>
        <ToolDetailView
          tool={tool}
          onBack={handleBack}
          renderContent={
            !isBuiltin ? () => (
              <McpServerForm
                form={mcpForm}
                isNew={false}
                onDelete={() => handleDeleteToolServer(mcpForm.editingServerId!)}
                confirmingDelete={confirmingDeleteTool === mcpForm.editingServerId}
                autoFocus={false}
              />
            ) : undefined
          }
          renderToolControls={
            !isBuiltin ? (toolName) => (
              <ToolApprovalPicker
                value={mcpForm.formState.toolApprovalModes[toolName] ?? mcpForm.formState.defaultToolsApprovalMode}
                onChange={(mode) => mcpForm.setToolApprovalMode(toolName, mode)}
              />
            ) : undefined
          }
        />
      </div>
    );
  }

  // Add new MCP server view
  if (viewState.type === 'add-new') {
    return (
      <div data-testid={TOOLS_SECTION_ID}>
        <div className="space-y-3">
          <DetailListHeader title={t('settings.tools.newMcpServer')} onBack={handleBack} />
          <div className="pt-1">
            <McpServerForm
              form={mcpForm}
              isNew={true}
              autoFocus={true}
            />
          </div>
        </div>
      </div>
    );
  }

  // Grid view
  return (
    <div className="space-y-3" data-testid={TOOLS_SECTION_ID} data-tool-toggle={TOOL_TOGGLE_SWITCH_ID}>
      <p className="text-ui-xs text-muted-foreground">
        Add the apps and services you want Interpreter to use.
      </p>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search tools, apps, and services"
          aria-label="Search tools"
          spellCheck={false}
          className="pl-9 pr-9"
        />
        {searchQuery.trim().length > 0 && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/[0.06]"
            aria-label="Clear tools search"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <ToolsGrid
        tools={displayedToolServers}
        mode="edit"
        pendingStoreEntryIds={pendingStoreEntryIds}
        pendingOAuthServerIds={pendingOAuthServerIds}
        searchQuery={searchQuery}
        showBuiltIn={showBuiltIn}
        onShowBuiltInChange={setShowBuiltIn}
        onToolClick={handleToolClick}
        onGlobalToggle={handleGlobalToggle}
        onAddNew={handleAddNew}
        onAddFromStore={handleAddFromStore}
        onCompleteAuth={handleCompleteAuth}
        onDeleteServer={handleDeleteFromGrid}
        onCancelServer={handleCancelServer}
      />
    </div>
  );
}
