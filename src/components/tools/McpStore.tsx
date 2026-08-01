/**
 * McpStore - Grid of popular MCP servers from the store
 *
 * Displays curated MCP server entries organized by category.
 * Users can click entries to add them to their workspace.
 */

import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { Loader2 } from 'lucide-react';
import {
  MCP_STORE_CATEGORIES,
  getFaviconUrl,
  getEntriesByCategory,
  getSortedCategories,
  type McpStoreEntry,
} from './mcpStoreData';
import type { ToolServer } from '../../api';
import {
  isToolServerAuthRequired,
  isToolServerDisplayConnected,
} from '../../../shared/toolServerAvailability';

export interface McpStoreProps {
  onAddServer: (entry: McpStoreEntry) => void;
  existingServerUrls: Set<string>;
  toolServers?: ToolServer[];
  className?: string;
}

export function McpStore({ onAddServer, existingServerUrls, toolServers = [], className }: McpStoreProps) {
  // Create a map of URL to server state for quick lookup
  const serverStateByUrl = new Map<string, ToolServer['state']>();
  for (const server of toolServers) {
    const url = (server.config as { url?: string })?.url;
    if (url) {
      serverStateByUrl.set(url, server.state);
    }
  }

  const entriesByCategory = getEntriesByCategory();
  const sortedCategories = getSortedCategories();

  return (
    <div className={cn('space-y-4', className)}>
      <div className="space-y-0.5">
        <h4 className="text-ui-sm font-medium text-foreground">
          MCP Store
        </h4>
        <p className="text-ui-xs text-muted-foreground">
          Click to add integrations to your workspace
        </p>
      </div>

      {sortedCategories.map((category) => {
        const entries = entriesByCategory.get(category);
        if (!entries || entries.length === 0) return null;

        return (
          <div key={category} className="space-y-2">
            <h5 className="text-ui-xs text-muted-foreground uppercase tracking-wider">
              {MCP_STORE_CATEGORIES[category].label}
            </h5>
            <div className="grid grid-cols-2 gap-4">
              {entries.map((entry) => {
                const serverState = serverStateByUrl.get(entry.url);
                const needsAuth = isToolServerAuthRequired(serverState);
                const isConnecting = serverState?.status === 'connecting';
                const isConnected = isToolServerDisplayConnected({
                  state: serverState,
                  isBuiltin: false,
                });

                return (
                  <McpStoreCard
                    key={entry.id}
                    entry={entry}
                    isAdded={existingServerUrls.has(entry.url)}
                    needsAuth={needsAuth}
                    isConnecting={isConnecting}
                    isConnected={isConnected}
                    onAdd={() => onAddServer(entry)}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface McpStoreCardProps {
  entry: McpStoreEntry;
  isAdded: boolean;
  needsAuth?: boolean;
  isConnecting?: boolean;
  isConnected?: boolean;
  onAdd: () => void;
}

function McpStoreCard({ entry, isAdded, needsAuth, isConnecting, isConnected, onAdd }: McpStoreCardProps) {
  const handleClick = () => {
    if (!isAdded) {
      onAdd();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && !isAdded) {
      e.preventDefault();
      onAdd();
    }
  };

  // Determine badge to show
  const getBadge = () => {
    if (needsAuth) {
      return (
        <span className="flex items-center gap-1 text-ui-xs text-primary shrink-0">
          <Loader2 className="size-3 animate-spin" />
          Complete in browser
        </span>
      );
    }
    if (isConnecting) {
      return (
        <span className="flex items-center gap-1 text-ui-xs text-muted-foreground shrink-0">
          <Loader2 className="size-3 animate-spin" />
          Connecting
        </span>
      );
    }
    if (isConnected) {
      return (
        <Badge variant="default" className="rounded-full px-2.5 py-0.5 text-ui-xs font-medium shrink-0 bg-emerald-600">
          Connected
        </Badge>
      );
    }
    if (isAdded) {
      return (
        <Badge variant="secondary" className="rounded-full px-2.5 py-0.5 text-ui-xs font-medium shrink-0">
          Added
        </Badge>
      );
    }
    return null;
  };

  return (
    <div
      role="button"
      tabIndex={isAdded ? -1 : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative flex flex-col gap-1.5 p-4 rounded-control',
        'transition-colors',
        isAdded
          ? 'opacity-50 cursor-not-allowed'
          : 'cursor-default hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      style={{ border: 'var(--border-width) solid var(--border)' }}
    >
      {/* Header: Icon + Name */}
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center size-7 rounded-control bg-muted overflow-hidden">
          <img
            src={getFaviconUrl(entry.domain, 64)}
            alt=""
            className="size-4"
            loading="lazy"
          />
        </div>
        <span className="text-ui-base text-foreground font-medium truncate flex-1">
          {entry.name}
        </span>
        {getBadge()}
      </div>

      {/* Description */}
      <p className="text-ui-xs text-muted-foreground line-clamp-2">
        {entry.description}
      </p>

      {/* Note (if present) */}
      {entry.note && (
        <p className="text-ui-xs text-muted-foreground/70 italic">
          {entry.note}
        </p>
      )}
    </div>
  );
}
