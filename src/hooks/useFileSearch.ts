/**
 * Shared hook for file/tab search functionality
 * Used by both the Explorer search bar and the @ mentions system
 */

import { useMemo } from 'react';
import { getFileCache } from '../stores/fileStore';
import { pathBasename } from '@/ipc';

export interface SearchItem {
  path?: string;
  name: string;
  type: 'file' | 'directory' | 'browser-tab';
  url?: string;
  browserId?: string;
  faviconUrl?: string;
  isOpen?: boolean;
}

/**
 * Get open tabs (files + browser) from layout state - instant, no API call
 */
export function getOpenTabs(): { files: SearchItem[]; browserTabs: SearchItem[] } {
  const layoutContext = (window as any).__layoutContext;
  if (!layoutContext?.getState) {
    return { files: [], browserTabs: [] };
  }

  const state = layoutContext.getState();
  const files: SearchItem[] = [];
  const browserTabs: SearchItem[] = [];

  for (const tab of Object.values(state.tabs || {}) as any[]) {
      if (tab.type === 'browser' && tab.browserId) {
        browserTabs.push({
          name: tab.label || 'Browser',
          type: 'browser-tab',
          url: tab.url,
          browserId: tab.browserId,
          faviconUrl: tab.faviconUrl,
          isOpen: true,
        });
      } else if (tab.type === 'file' && tab.path) {
        files.push({
          path: tab.path,
          name: tab.label || pathBasename(tab.path) || 'File',
          type: 'file',
          isOpen: true,
        });
      }
  }

  return { files, browserTabs };
}

/**
 * Get all files from cache (populated by Explorer) - instant
 */
export function getWorkspaceFiles(): SearchItem[] {
  const cached = getFileCache();
  return cached.map(f => ({
    path: f.path,
    name: f.name,
    type: f.type,
  }));
}

/**
 * Get all searchable items: open browser tabs, open files, workspace files
 * Deduplicates open files from workspace files
 */
export function getAllSearchItems(): SearchItem[] {
  const openTabs = getOpenTabs();
  const workspaceFiles = getWorkspaceFiles();

  // Dedupe: don't show open files twice
  const openFilePaths = new Set(openTabs.files.map(f => f.path));
  const otherFiles = workspaceFiles.filter(f => !openFilePaths.has(f.path));

  // Order: open browser tabs, open files, then all other files
  return [...openTabs.browserTabs, ...openTabs.files, ...otherFiles];
}

/**
 * Filter items based on query string
 * Searches name, path (for files), and URL (for browser tabs)
 */
export function filterSearchItems(items: SearchItem[], query: string): SearchItem[] {
  if (!query) return items;

  const lowerQuery = query.toLowerCase();

  return items.filter(item => {
    // Match by name
    if (item.name.toLowerCase().includes(lowerQuery)) return true;

    // Match by path (for files/directories)
    if (item.path?.toLowerCase().includes(lowerQuery)) return true;

    // Match by URL (for browser tabs)
    if (item.url?.toLowerCase().includes(lowerQuery)) return true;

    return false;
  });
}

/**
 * Hook for file search - returns filtered and grouped items
 * Note: We intentionally don't memoize getAllSearchItems() because the
 * file cache can be populated after this hook first runs. Each query
 * change should re-fetch from the current cache state.
 */
export function useFileSearch(query: string) {
  const filteredItems = useMemo(() => {
    const items = getAllSearchItems();
    return filterSearchItems(items, query);
  }, [query]);

  const allItems = useMemo(() => getAllSearchItems(), [query]);

  return {
    items: filteredItems,
    allItems: allItems,
    hasResults: filteredItems.length > 0,
  };
}
