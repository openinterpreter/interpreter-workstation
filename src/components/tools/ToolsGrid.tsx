/**
 * ToolsGrid - Grid display of tool servers
 *
 * Composable component that works in two modes:
 * - 'edit': Click cards to view/edit details (Settings > Tools)
 * - 'toggle': Enable/disable tools per agent (Agent Profile > Tools)
 *
 * Shows built-in tools and MCP servers with optional filtering.
 */

import { useState, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { matchesToolSearch, normalizeToolSearchQuery } from '@/lib/tool-search';
import { Checkbox } from '../ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { ToolCard, type ToolCardMode } from './ToolCard';
import {
  MCP_STORE_CATEGORIES,
  MCP_STORE_ENTRIES,
  getFaviconUrl,
  getSortedCategories,
  matchStoreEntryForCandidate,
  type McpStoreCategory,
  type McpStoreEntry,
} from './mcpStoreData';
import type { ToolServer } from '../../api';

export interface ToolsGridProps {
  tools: ToolServer[];
  mode: ToolCardMode;
  pendingStoreEntryIds?: ReadonlySet<string>;
  pendingOAuthServerIds?: ReadonlySet<string>;
  /** Set of enabled tool IDs (for toggle mode). If not provided, all are enabled. */
  enabledToolIds?: Set<string>;
  /** Whether to show built-in tools. Default: false (hidden to reduce clutter) */
  showBuiltIn?: boolean;
  /** Callback when showBuiltIn changes */
  onShowBuiltInChange?: (show: boolean) => void;
  /** Callback when a tool is clicked (edit mode) */
  onToolClick?: (tool: ToolServer) => void;
  /** Callback when a tool is toggled (toggle mode) */
  onToolToggle?: (toolId: string, enabled: boolean) => void;
  /** Callback when a tool's global state is toggled (edit mode with global toggles) */
  onGlobalToggle?: (toolId: string, enabled: boolean) => void;
  /** Callback to navigate to global tools settings (for globally disabled tools) */
  onNavigateToGlobalTools?: () => void;
  /** Callback to add new MCP server */
  onAddNew?: () => void;
  /** Callback to add server from MCP Store */
  onAddFromStore?: (entry: McpStoreEntry) => void;
  /** Callback to start OAuth for an auth-required MCP server */
  onCompleteAuth?: (tool: ToolServer) => void;
  /** Callback to delete an MCP server */
  onDeleteServer?: (toolId: string) => void;
  /** Callback to cancel a connecting MCP server */
  onCancelServer?: (toolId: string) => void;
  /** Additional class names */
  className?: string;
  /** Live search query for filtering tools in settings */
  searchQuery?: string;
  /** Hide the filter checkbox */
  hideFilter?: boolean;
  /** Hide section headers */
  hideSectionHeaders?: boolean;
}

// For the "All" tab, we need to merge installed MCPs with store entries
interface UnifiedMcpItem {
  id: string;
  name: string;
  category?: McpStoreCategory;
  description?: string;
  faviconUrl?: string;
  storeEntry?: McpStoreEntry;
  installedServer?: ToolServer;
  isInstalled: boolean;
}

const SECTION_HEADING_CLASS = 'px-2 text-[11px] font-medium text-muted-foreground';
const SETTINGS_LIST_CLASS = 'overflow-hidden rounded-[14px]';
const SETTINGS_LIST_STYLE = {
  background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 16%, transparent)',
  border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 42%, transparent)',
} as const;
const FLAT_TABS_LIST_CLASS = 'h-auto w-auto max-w-full gap-1 rounded-full bg-transparent p-0 shadow-none';
const FLAT_TABS_TRIGGER_CLASS = 'h-7 flex-none rounded-full px-3 text-ui-sm font-medium text-[#6b7280] shadow-none hover:bg-black/[0.035] hover:text-[#202123] data-[state=active]:border-transparent data-[state=active]:bg-black/[0.05] data-[state=active]:text-[#202123] data-[state=active]:shadow-none dark:text-[#b4b4b4] dark:hover:bg-white/[0.045] dark:hover:text-[#f5f5f5] dark:data-[state=active]:bg-white/[0.08] dark:data-[state=active]:text-[#f5f5f5]';

export function ToolsGrid({
  tools,
  mode,
  pendingStoreEntryIds,
  pendingOAuthServerIds,
  enabledToolIds,
  showBuiltIn: controlledShowBuiltIn,
  onShowBuiltInChange,
  onToolClick,
  onToolToggle,
  onGlobalToggle,
  onNavigateToGlobalTools,
  onAddNew,
  onAddFromStore,
  onCompleteAuth,
  onDeleteServer,
  onCancelServer,
  className,
  searchQuery = '',
  hideFilter = false,
  hideSectionHeaders = false,
}: ToolsGridProps) {
  // Separate built-in and MCP tools
  const builtinTools = tools.filter(t => t.id.startsWith('builtin-'));
  const mcpTools = tools.filter(t => !t.id.startsWith('builtin-'));
  const normalizedSearchQuery = normalizeToolSearchQuery(searchQuery);
  const hasActiveSearch = normalizedSearchQuery.length > 0;

  // For toggle mode (agent profiles), use the old layout
  // For edit mode (settings), use the new tabbed layout
  const useTabLayout = mode === 'edit' && onAddFromStore;

  const installedStoreMatches = useMemo(() => {
    const matchedServerIds = new Set<string>();
    const installedServersByStoreEntryId = new Map<string, ToolServer>();

    for (const server of mcpTools) {
      const match = matchStoreEntryForCandidate({
        id: server.id,
        name: server.name,
        url: server.config?.url,
        command: server.config?.command,
        args: server.config?.args,
      });

      if (!match || installedServersByStoreEntryId.has(match.id)) {
        continue;
      }

      matchedServerIds.add(server.id);
      installedServersByStoreEntryId.set(match.id, server);
    }

    return { matchedServerIds, installedServersByStoreEntryId };
  }, [mcpTools]);

  // Create unified list: all store entries + any custom MCPs not in store
  const unifiedMcpItems = useMemo((): UnifiedMcpItem[] => {
    const items: UnifiedMcpItem[] = [];
    const processedUrls = new Set<string>();

    // Add all store entries first
    for (const entry of MCP_STORE_ENTRIES) {
      const installedServer = installedStoreMatches.installedServersByStoreEntryId.get(entry.id);
      if (installedServer?.config?.url) {
        processedUrls.add(installedServer.config.url);
      }

      items.push({
        id: installedServer?.id || `store-${entry.id}`,
        name: entry.name,
        category: entry.category,
        description: entry.description,
        faviconUrl: getFaviconUrl(entry.domain, 64),
        storeEntry: entry,
        installedServer,
        isInstalled: !!installedServer,
      });
    }

    // Add custom MCPs that aren't from the store (local command-based or custom URLs)
    for (const server of mcpTools) {
      if (installedStoreMatches.matchedServerIds.has(server.id)) continue;

      const matchedEntry = matchStoreEntryForCandidate({
        id: server.id,
        name: server.name,
        url: server.config?.url,
        command: server.config?.command,
        args: server.config?.args,
      });
      if (matchedEntry) continue;

      const url = (server.config as { url?: string })?.url;
      // Skip if this URL was already processed (from store)
      if (url && processedUrls.has(url)) continue;

      // Only add if not already in the list (no URL means local MCP, always add)
      items.push({
        id: server.id,
        name: server.name,
        installedServer: server,
        isInstalled: true,
      });
    }

    return items;
  }, [installedStoreMatches, mcpTools]);

  const filteredUnifiedMcpItems = useMemo(
    () =>
      unifiedMcpItems.filter((item) =>
        matchesToolSearch(normalizedSearchQuery, {
          tool: item.installedServer,
          storeEntry: item.storeEntry,
        }),
      ),
    [normalizedSearchQuery, unifiedMcpItems],
  );

  const customMcpItems = useMemo(
    () => unifiedMcpItems.filter(item => !item.storeEntry),
    [unifiedMcpItems]
  );

  const storeItemsByCategory = useMemo(() => {
    const itemsByCategory = new Map<McpStoreCategory, UnifiedMcpItem[]>();

    for (const item of unifiedMcpItems) {
      if (!item.storeEntry || !item.category) continue;
      const items = itemsByCategory.get(item.category) || [];
      items.push(item);
      itemsByCategory.set(item.category, items);
    }

    for (const items of itemsByCategory.values()) {
      items.sort((a, b) => a.name.localeCompare(b.name));
    }

    return itemsByCategory;
  }, [unifiedMcpItems]);

  const sortedStoreCategories = useMemo(
    () => getSortedCategories().filter(category => (storeItemsByCategory.get(category)?.length ?? 0) > 0),
    [storeItemsByCategory]
  );

  const filteredBuiltinTools = useMemo(
    () => builtinTools.filter((tool) => matchesToolSearch(normalizedSearchQuery, { tool })),
    [builtinTools, normalizedSearchQuery],
  );

  // For uncontrolled mode
  const [internalShowBuiltIn, setInternalShowBuiltIn] = useState(false);
  const showBuiltIn = controlledShowBuiltIn !== undefined ? controlledShowBuiltIn : internalShowBuiltIn;
  const setShowBuiltIn = (show: boolean) => {
    if (onShowBuiltInChange) {
      onShowBuiltInChange(show);
    } else {
      setInternalShowBuiltIn(show);
    }
  };

  const isToolEnabled = (toolId: string) => {
    if (!enabledToolIds) return true;
    return enabledToolIds.has(toolId);
  };

  const handleToolClick = (tool: ToolServer) => {
    if (onToolClick) {
      onToolClick(tool);
    }
  };

  const handleToolToggle = (toolId: string, enabled: boolean) => {
    if (onToolToggle) {
      onToolToggle(toolId, enabled);
    }
  };

  const handleGlobalToggle = (toolId: string, enabled: boolean) => {
    if (onGlobalToggle) {
      onGlobalToggle(toolId, enabled);
    }
  };

  const handleAddFromStore = (entry: McpStoreEntry) => {
    if (onAddFromStore) {
      onAddFromStore(entry);
    }
  };

  const hasBuiltinTools = builtinTools.length > 0;

  // Render the Add Custom MCP card
  const renderAddCustomCard = () => {
    if (!onAddNew) return null;
    return (
      <button
        type="button"
        onClick={onAddNew}
        className="flex w-full items-center gap-3 rounded-[14px] px-3.5 py-3 text-left transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/[0.04]"
        style={{
          background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 12%, transparent)',
          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 36%, transparent)',
        }}
      >
        <div
          className="flex size-7 shrink-0 items-center justify-center rounded-full"
          style={{
            background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 54%, transparent)',
          }}
        >
          <Plus className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ui-sm font-medium text-foreground">Custom MCP server</div>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            Connect a local command or remote endpoint
          </p>
        </div>
      </button>
    );
  };

  const renderUnifiedToolList = (items: UnifiedMcpItem[]) => (
    <div className={SETTINGS_LIST_CLASS} style={SETTINGS_LIST_STYLE}>
      <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
        {items.map(item => (
          <ToolCard
            key={item.id}
            tool={item.installedServer}
            storeEntry={item.storeEntry}
            faviconUrl={item.faviconUrl}
            mode={mode}
            isAdding={item.storeEntry ? pendingStoreEntryIds?.has(item.storeEntry.id) ?? false : false}
            isAuthPending={item.installedServer ? pendingOAuthServerIds?.has(item.installedServer.id) ?? false : false}
            enabled={item.installedServer ? isToolEnabled(item.installedServer.id) : false}
            globallyDisabled={item.installedServer?.globallyDisabled}
            onClick={item.installedServer ? () => handleToolClick(item.installedServer!) : undefined}
            onToggle={item.installedServer ? (enabled) => handleToolToggle(item.installedServer!.id, enabled) : undefined}
            onGlobalToggle={item.installedServer && onGlobalToggle ? (enabled) => handleGlobalToggle(item.installedServer!.id, enabled) : undefined}
            onCompleteAuth={item.installedServer && onCompleteAuth ? () => onCompleteAuth(item.installedServer!) : undefined}
            onDelete={item.installedServer && onDeleteServer ? () => onDeleteServer(item.installedServer!.id) : undefined}
            onCancel={item.installedServer && onCancelServer ? () => onCancelServer(item.installedServer!.id) : undefined}
            onAdd={!item.isInstalled && item.storeEntry ? () => handleAddFromStore(item.storeEntry!) : undefined}
          />
        ))}
      </div>
    </div>
  );

  const renderInstalledToolList = (toolsToRender: ToolServer[]) => (
    <div className={SETTINGS_LIST_CLASS} style={SETTINGS_LIST_STYLE}>
      <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
        {toolsToRender.map(tool => (
          <ToolCard
            key={tool.id}
            tool={tool}
            mode={mode}
            enabled={isToolEnabled(tool.id)}
            globallyDisabled={tool.globallyDisabled}
            onClick={() => handleToolClick(tool)}
            onToggle={(enabled) => handleToolToggle(tool.id, enabled)}
            onGlobalToggle={onGlobalToggle ? (enabled) => handleGlobalToggle(tool.id, enabled) : undefined}
            onNavigateToGlobalTools={tool.globallyDisabled ? onNavigateToGlobalTools : undefined}
            onDelete={onDeleteServer && !tool.id.startsWith('builtin-') ? () => onDeleteServer(tool.id) : undefined}
            onCancel={onCancelServer && !tool.id.startsWith('builtin-') ? () => onCancelServer(tool.id) : undefined}
          />
        ))}
      </div>
    </div>
  );

  // New tabbed layout for Settings > Tools
  if (useTabLayout) {
    const installedItems = unifiedMcpItems.filter(item => item.isInstalled);
    const filteredInstalledItems = filteredUnifiedMcpItems.filter((item) => item.isInstalled);
    const filteredAvailableStoreItems = filteredUnifiedMcpItems.filter((item) => item.storeEntry && !item.isInstalled);

    if (hasActiveSearch) {
      const hasSearchResults =
        filteredInstalledItems.length > 0 ||
        filteredAvailableStoreItems.length > 0 ||
        filteredBuiltinTools.length > 0;

      return (
        <div className={cn('space-y-3', className)}>
          <div className="space-y-3.5">
            {onAddNew && renderAddCustomCard()}

            {filteredInstalledItems.length > 0 && (
              <div className="space-y-1.5">
                <h4 className={SECTION_HEADING_CLASS}>Connected</h4>
                {renderUnifiedToolList(filteredInstalledItems)}
              </div>
            )}

            {filteredAvailableStoreItems.length > 0 && (
              <div className="space-y-1.5">
                <h4 className={SECTION_HEADING_CLASS}>Available in Store</h4>
                {renderUnifiedToolList(filteredAvailableStoreItems)}
              </div>
            )}

            {filteredBuiltinTools.length > 0 && (
              <div className="space-y-1.5">
                <h4 className={SECTION_HEADING_CLASS}>Built-in</h4>
                {renderInstalledToolList(filteredBuiltinTools)}
              </div>
            )}

            {!hasSearchResults && (
              <div
                className="rounded-[14px] px-3 py-4 text-center text-ui-sm text-muted-foreground"
                style={{
                  background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 42%, transparent)',
                  border: 'var(--border-width) dashed color-mix(in srgb, var(--oa-border, var(--border)) 56%, transparent)',
                }}
              >
                No tools match "{searchQuery.trim()}".
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className={cn('space-y-3', className)}>
        <Tabs defaultValue="all" className="gap-3">
          <TabsList className={FLAT_TABS_LIST_CLASS}>
            <TabsTrigger value="all" className={FLAT_TABS_TRIGGER_CLASS}>Store</TabsTrigger>
            <TabsTrigger value="installed" className={FLAT_TABS_TRIGGER_CLASS}>
              Connected{installedItems.length > 0 ? ` (${installedItems.length})` : ''}
            </TabsTrigger>
            {hasBuiltinTools && (
              <TabsTrigger value="builtin" className={FLAT_TABS_TRIGGER_CLASS}>Built-in</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="all" className="mt-2.5">
            <div className="space-y-3.5">
              {onAddNew && renderAddCustomCard()}

              {customMcpItems.length > 0 && (
                <div className="space-y-1.5">
                  <h4 className={SECTION_HEADING_CLASS}>
                    Custom MCP Servers
                  </h4>
                  {renderUnifiedToolList(customMcpItems)}
                </div>
              )}

              {sortedStoreCategories.map((category) => {
                const items = storeItemsByCategory.get(category);
                if (!items || items.length === 0) return null;

                return (
                  <div key={category} className="space-y-1.5">
                    <h4 className={SECTION_HEADING_CLASS}>
                      {MCP_STORE_CATEGORIES[category].label}
                    </h4>
                    {renderUnifiedToolList(items)}
                  </div>
                );
              })}
            </div>
          </TabsContent>

          <TabsContent value="installed" className="mt-2.5">
            <div className="space-y-3">
              {onAddNew && renderAddCustomCard()}

              {/* Installed MCP items */}
              {installedItems.length > 0 && renderUnifiedToolList(installedItems)}

              {/* Empty state when only the add button exists */}
              {installedItems.length === 0 && !onAddNew && (
                <div
                  className="rounded-[14px] px-3 py-4 text-center text-ui-sm text-muted-foreground"
                  style={{
                    background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 42%, transparent)',
                    border: 'var(--border-width) dashed color-mix(in srgb, var(--oa-border, var(--border)) 56%, transparent)',
                  }}
                >
                  No MCP servers installed
                </div>
              )}
            </div>
          </TabsContent>

          {hasBuiltinTools && (
            <TabsContent value="builtin" className="mt-2.5">
              {renderInstalledToolList(builtinTools)}
            </TabsContent>
          )}
        </Tabs>
      </div>
    );
  }

  // Original layout for toggle mode (agent profiles)
  const visibleBuiltinTools = showBuiltIn ? filteredBuiltinTools : [];
  const visibleMcpTools = mcpTools.filter((tool) => matchesToolSearch(normalizedSearchQuery, { tool }));
  const hasMcpTools = visibleMcpTools.length > 0;

  return (
    <div className={cn('space-y-4', className)}>
      {/* Filter toggle */}
      {!hideFilter && hasBuiltinTools && (
        <label className="inline-flex items-center gap-2 text-ui-sm text-muted-foreground hover:text-foreground transition-colors cursor-default select-none">
          <Checkbox
            checked={showBuiltIn}
            onCheckedChange={(checked) => setShowBuiltIn(checked === true)}
          />
          <span>Show built-in tools</span>
        </label>
      )}

      {/* Built-in Tools Section */}
      {visibleBuiltinTools.length > 0 && (
        <div className="space-y-2">
          {!hideSectionHeaders && (
            <h4 className="text-ui-xs text-muted-foreground uppercase tracking-wider">
              Built-in Tools
            </h4>
          )}
          <div className="grid grid-cols-2 gap-4">
            {visibleBuiltinTools.map(tool => (
              <ToolCard
                key={tool.id}
                tool={tool}
                mode={mode}
                enabled={isToolEnabled(tool.id)}
                globallyDisabled={tool.globallyDisabled}
                onClick={() => handleToolClick(tool)}
                onToggle={(enabled) => handleToolToggle(tool.id, enabled)}
                onGlobalToggle={onGlobalToggle ? (enabled) => handleGlobalToggle(tool.id, enabled) : undefined}
                onNavigateToGlobalTools={tool.globallyDisabled ? onNavigateToGlobalTools : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* MCP Servers Section */}
      {(hasMcpTools || onAddNew) && (
        <div className="space-y-2">
          {!hideSectionHeaders && (visibleBuiltinTools.length > 0 || hasMcpTools) && (
            <h4 className="text-ui-xs text-muted-foreground uppercase tracking-wider">
              MCP Servers
            </h4>
          )}
          <div className="grid grid-cols-2 gap-4">
            {visibleMcpTools.map(tool => (
              <ToolCard
                key={tool.id}
                tool={tool}
                mode={mode}
                enabled={isToolEnabled(tool.id)}
                globallyDisabled={tool.globallyDisabled}
                onClick={() => handleToolClick(tool)}
                onToggle={(enabled) => handleToolToggle(tool.id, enabled)}
                onGlobalToggle={onGlobalToggle ? (enabled) => handleGlobalToggle(tool.id, enabled) : undefined}
                onNavigateToGlobalTools={tool.globallyDisabled ? onNavigateToGlobalTools : undefined}
                onDelete={onDeleteServer ? () => onDeleteServer(tool.id) : undefined}
                onCancel={onCancelServer ? () => onCancelServer(tool.id) : undefined}
              />
            ))}

            {/* Add New Button */}
            {onAddNew && (
              <button
                type="button"
                onClick={onAddNew}
                className={cn(
                  'flex flex-col items-center justify-center gap-1.5 p-4 h-full',
                  'border-dashed rounded-control',
                  'text-ui-sm text-muted-foreground',
                  'hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'min-h-[72px]'
                )}
                style={{ border: 'var(--border-width) dashed var(--border)' }}
              >
                <Plus className="size-5" />
                <span>Add MCP Server</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Empty state */}
      {visibleBuiltinTools.length === 0 && visibleMcpTools.length === 0 && !onAddNew && (
        <div
          className="text-ui-sm text-muted-foreground text-center p-4 rounded-control"
          style={{ border: 'var(--border-width) dashed var(--border)' }}
        >
          No tools available
        </div>
      )}
    </div>
  );
}
