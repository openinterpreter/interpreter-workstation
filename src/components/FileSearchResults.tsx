/**
 * FileSearchResults Component
 *
 * Shared component for displaying search results for files and tabs.
 * Used by both the Explorer search bar and the @ mentions dropdown.
 * Supports keyboard navigation and groups items by "Open" vs "Files".
 */

import React, { forwardRef, useImperativeHandle, useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FileSystemProxy } from './FileSystemProxy';
import { useFileSearch, type SearchItem } from '../hooks/useFileSearch';
import type { WorkspaceContentMatch } from '../api';
import { pathBasename } from '@/ipc';
import { cn } from '@/lib/utils';
import { RUN_AGENT_SEARCH_BUTTON_ID, SEARCH_COMPUTER_BUTTON_ID } from '../../shared/element-ids';
import { Button } from './ui/button';
import { shouldOfferExplorerAgentSearch } from '../utils/explorerAgentSearch';
import type { VaultSearchResult } from '../../shared/types/vault';
import type { LocaleKey } from '../i18n';

export interface SystemSearchResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export interface FileSearchResultsProps {
  query: string;
  onSelect: (item: SearchItem) => void;
  className?: string;
  maxHeight?: string;
  showBorder?: boolean;
  emptyMessage?: string;
  showSearchComputer?: boolean;
  onSearchComputer?: (query: string) => Promise<SystemSearchResult[]>;
  emptyActionLabel?: string;
  emptyActionDescription?: string;
  onEmptyAction?: (query: string) => void;
  noteMatches?: VaultSearchResult[];
  noteSearchLoading?: boolean;
  onSelectNoteMatch?: (match: VaultSearchResult) => void;
  contentMatches?: WorkspaceContentMatch[];
  contentSearchLoading?: boolean;
  onSelectContentMatch?: (match: WorkspaceContentMatch) => void;
}

export interface FileSearchResultsRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
  getSelectedItem: () => SearchItem | null;
}

function getResultRowClassName(isSelected: boolean, className: string): string {
  return cn(
    'file-search-result-row',
    className,
    isSelected && 'text-foreground',
  );
}

export const FileSearchResults = forwardRef<FileSearchResultsRef, FileSearchResultsProps>(
  ({
    query,
    onSelect,
    className = '',
    maxHeight = '320px',
    showBorder = true,
    emptyMessage,
    showSearchComputer = false,
    onSearchComputer,
    emptyActionLabel,
    emptyActionDescription,
    onEmptyAction,
    noteMatches = [],
    noteSearchLoading = false,
    onSelectNoteMatch,
    contentMatches = [],
    contentSearchLoading = false,
    onSelectContentMatch,
  }, ref) => {
    "use no memo";

    const { t } = useTranslation();
    const translate = useCallback((key: LocaleKey, options?: Record<string, unknown>) => t(key, options), [t]);
    const { items: filteredItems } = useFileSearch(query);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    // System search state
    const [isSearchingSystem, setIsSearchingSystem] = useState(false);
    const [systemResults, setSystemResults] = useState<SystemSearchResult[]>([]);
    const [hasSearchedSystem, setHasSearchedSystem] = useState(false);
    const trimmedQuery = query.trim();
    const noteMatchPaths = new Set(noteMatches.map((match) => match.path));
    const dedupedItems = filteredItems.filter((item) => item.type !== 'file' || !item.path || !noteMatchPaths.has(item.path));
    const noteMatchesCount = noteMatches.length;
    const contentMatchesCount = contentMatches.length;
    const totalResultCount = noteMatchesCount + dedupedItems.length + contentMatchesCount + systemResults.length;
    const showEmptyAction = Boolean(emptyActionLabel && onEmptyAction && shouldOfferExplorerAgentSearch(trimmedQuery, totalResultCount));
    const actionIndex = showEmptyAction ? totalResultCount : -1;
    const selectableCount = totalResultCount + (showEmptyAction ? 1 : 0);
    const fileItemsStartIndex = noteMatchesCount;
    const contentMatchesStartIndex = noteMatchesCount + dedupedItems.length;
    const systemResultsStartIndex = noteMatchesCount + dedupedItems.length + contentMatchesCount;

    // Reset selection and system search when query changes
    useEffect(() => {
      setSelectedIndex(0);
      setHasSearchedSystem(false);
      setSystemResults([]);
    }, [query]);

    // Handle system search
    const handleSearchComputer = useCallback(async () => {
      if (!onSearchComputer || !query.trim()) return;

      setIsSearchingSystem(true);
      try {
        const results = await onSearchComputer(query.trim());
        setSystemResults(results);
        setHasSearchedSystem(true);
      } catch (error) {
        console.error('[FileSearchResults] System search failed:', error);
        setSystemResults([]);
        setHasSearchedSystem(true);
      }
      setIsSearchingSystem(false);
    }, [onSearchComputer, query]);

    // Handle selecting a system search result
    const handleSystemResultSelect = useCallback((result: SystemSearchResult) => {
      // Convert to SearchItem format
      const item: SearchItem = {
        type: result.type,
        path: result.path,
        name: result.name,
        isOpen: false,
      };
      onSelect(item);
    }, [onSelect]);

    // Scroll selected item into view
    useEffect(() => {
      const selectedEl = itemRefs.current.get(selectedIndex);
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, [selectedIndex]);

    const selectItem = useCallback((index: number) => {
      const item = dedupedItems[index];
      if (item) {
        onSelect(item);
      }
    }, [dedupedItems, onSelect]);

    const handleEmptyAction = useCallback(() => {
      if (!onEmptyAction || !trimmedQuery) {
        return;
      }

      onEmptyAction(trimmedQuery);
    }, [onEmptyAction, trimmedQuery]);

    const handleKeyDown = useCallback((event: KeyboardEvent): boolean => {
      if (selectableCount === 0) {
        return false;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex(prev =>
          prev <= 0 ? selectableCount - 1 : prev - 1
        );
        return true;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex(prev =>
          prev >= selectableCount - 1 ? 0 : prev + 1
        );
        return true;
      }

      if (event.key === 'Enter') {
        if (showEmptyAction && selectedIndex === actionIndex) {
          event.preventDefault();
          handleEmptyAction();
          return true;
        }

        event.preventDefault();
        if (selectedIndex < noteMatchesCount) {
          const noteMatch = noteMatches[selectedIndex];
          if (noteMatch && onSelectNoteMatch) {
            onSelectNoteMatch(noteMatch);
            return true;
          }
          return true;
        }

        if (selectedIndex >= fileItemsStartIndex && selectedIndex < contentMatchesStartIndex) {
          selectItem(selectedIndex - fileItemsStartIndex);
          return true;
        }

        const contentMatch = contentMatches[selectedIndex - contentMatchesStartIndex];
        if (contentMatch && selectedIndex >= contentMatchesStartIndex && selectedIndex < systemResultsStartIndex && onSelectContentMatch) {
          onSelectContentMatch(contentMatch);
          return true;
        }

        const systemResult = systemResults[selectedIndex - systemResultsStartIndex];
        if (systemResult) {
          handleSystemResultSelect(systemResult);
          return true;
        }

        return true;
      }

      return false;
    }, [actionIndex, contentMatches, contentMatchesStartIndex, contentMatchesCount, dedupedItems.length, fileItemsStartIndex, handleEmptyAction, handleSystemResultSelect, noteMatches, noteMatchesCount, onSelectContentMatch, onSelectNoteMatch, selectableCount, selectedIndex, selectItem, showEmptyAction, systemResults, systemResultsStartIndex]);

    useImperativeHandle(ref, () => ({
      onKeyDown: handleKeyDown,
      getSelectedItem: () => (
        selectedIndex >= fileItemsStartIndex && selectedIndex < contentMatchesStartIndex
          ? dedupedItems[selectedIndex - fileItemsStartIndex] || null
          : null
      ),
    }), [contentMatchesStartIndex, dedupedItems, fileItemsStartIndex, handleKeyDown, selectedIndex]);

    const noResultsMessage = noteMatchesCount === 0 && dedupedItems.length === 0 && contentMatchesCount === 0 && !contentSearchLoading && !noteSearchLoading
      ? (hasSearchedSystem && systemResults.length === 0
        ? translate('explorer.search.noFilesFoundOnComputer')
        : (emptyMessage ?? translate('explorer.search.noMatchesFound')))
      : null;

    const renderContentSnippet = (match: WorkspaceContentMatch, queryStr: string): React.ReactNode => {
      const text = match.text;
      if (!queryStr) return text;
      const lowerText = text.toLowerCase();
      const lowerQuery = queryStr.toLowerCase();
      const matchIdx = lowerText.indexOf(lowerQuery);
      if (matchIdx < 0) return text;
      const contextBefore = 24;
      const start = Math.max(0, matchIdx - contextBefore);
      const prefix = start > 0 ? '…' : '';
      const before = text.slice(start, matchIdx);
      const hit = text.slice(matchIdx, matchIdx + queryStr.length);
      const after = text.slice(matchIdx + queryStr.length);
      return (
        <>
          {prefix}
          {before}
          <span className="font-medium text-foreground">{hit}</span>
          {after}
        </>
      );
    };

    // Render the search button component
    const SearchComputerButton = showSearchComputer && onSearchComputer && trimmedQuery.length > 0 && !hasSearchedSystem && (
      <Button
        variant="outline"
        onClick={handleSearchComputer}
        disabled={isSearchingSystem}
        data-testid={SEARCH_COMPUTER_BUTTON_ID}
        className="mx-2 mb-2 flex items-center gap-2 text-ui-base w-[calc(100%-16px)] justify-center"
      >
        {isSearchingSystem ? (
          <>
            <Loader2 className="animate-spin" />
            <span>{translate('common.searching')}</span>
          </>
        ) : (
          <>
            <Search />
            <span>{translate('explorer.search.searchWholeComputer')}</span>
          </>
        )}
      </Button>
    );

    return (
      <div
        ref={scrollContainerRef}
        className={`${showBorder ? 'border border-border rounded-control shadow-lg' : ''} overflow-y-auto ${className}`}
        style={{ maxHeight }}
      >
        {noResultsMessage && (
          <div className="px-4 py-3 text-muted-foreground text-ui-base">
            {noResultsMessage}
          </div>
        )}

        {noteSearchLoading && noteMatchesCount === 0 && trimmedQuery.length >= 1 && (
          <div className="px-4 py-1.5 flex items-center gap-2 text-muted-foreground text-ui-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{translate('explorer.search.searchingNotes')}</span>
          </div>
        )}

        {noteMatchesCount > 0 && (
          <>
            <div className="px-4 py-1.5 text-ui-sm text-muted-foreground font-normal">
              {translate('common.notes')}
            </div>
            {noteMatches.map((match, index) => {
              const isSelected = index === selectedIndex;
              const aliasText = match.aliases.slice(0, 2).join(', ');
              const tagText = match.tags.slice(0, 3).map((tag) => `#${tag}`).join(' ');
              return (
                <div
                  key={match.path}
                  ref={(el) => {
                    if (el) itemRefs.current.set(index, el);
                    else itemRefs.current.delete(index);
                  }}
                  className={getResultRowClassName(isSelected, 'px-3 py-2')}
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={() => onSelectNoteMatch?.(match)}
                  title={match.relativePath}
                >
                  <div className="flex items-start gap-2">
                    <FileText className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-ui-sm font-medium text-foreground">{match.title}</span>
                        <span className="truncate text-ui-xs text-muted-foreground">{match.relativePath}</span>
                      </div>
                      {(aliasText || tagText) ? (
                        <div className="truncate text-ui-xs text-muted-foreground">
                          {aliasText ? `${translate('explorer.search.aliases')}: ${aliasText}` : ''}
                          {aliasText && tagText ? ' • ' : ''}
                          {tagText}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* Workspace results */}
        {dedupedItems.map((item, index) => {
          const overallIndex = fileItemsStartIndex + index;
          const isOpen = item.isOpen;
          const prevItem = dedupedItems[index - 1];
          const isFirstOpen = isOpen && index === 0;
          const isFirstNonOpen = !isOpen && (index === 0 || prevItem?.isOpen);
          const isSelected = overallIndex === selectedIndex;

          return (
            <React.Fragment key={item.type === 'browser-tab' ? item.browserId : item.path}>
              {/* Section headers */}
              {isFirstOpen && (
                <div className="px-4 py-1.5 text-ui-sm text-muted-foreground font-normal">
                  {translate('common.open')}
                </div>
              )}
              {isFirstNonOpen && (
                <div className="px-4 py-1.5 text-ui-sm text-muted-foreground font-normal">
                  {translate('common.files')}
                </div>
              )}

              {/* Item */}
              <div
                ref={(el) => {
                  if (el) itemRefs.current.set(overallIndex, el);
                  else itemRefs.current.delete(overallIndex);
                }}
                className={getResultRowClassName(isSelected, 'px-2 py-1.5')}
                data-selected={isSelected ? 'true' : 'false'}
                onClick={() => selectItem(index)}
              >
                <FileSystemProxy
                  type={item.type}
                  path={item.path}
                  filename={item.name}
                  url={item.url}
                  browserId={item.browserId}
                  faviconUrl={item.faviconUrl}
                  variant="card"
                  showPath={item.type !== 'browser-tab'}
                  showIcon={true}
                />
              </div>
            </React.Fragment>
          );
        })}

        {/* Content matches (full-text via ripgrep) */}
        {contentSearchLoading && contentMatchesCount === 0 && trimmedQuery.length >= 2 && (
          <div className="px-4 py-1.5 flex items-center gap-2 text-muted-foreground text-ui-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{translate('explorer.search.searchingFileContents')}</span>
          </div>
        )}
        {contentMatchesCount > 0 && (
          <>
            <div className="px-4 py-1.5 text-ui-sm text-muted-foreground font-normal">
              {translate('explorer.search.inFiles')}
            </div>
            {contentMatches.map((match, index) => {
              const overallIndex = contentMatchesStartIndex + index;
              const isSelected = overallIndex === selectedIndex;
              const fileName = pathBasename(match.path) || match.path;
              return (
                <div
                  key={`${match.path}:${match.line}:${match.column}`}
                  ref={(el) => {
                    if (el) itemRefs.current.set(overallIndex, el);
                    else itemRefs.current.delete(overallIndex);
                  }}
                  className={getResultRowClassName(isSelected, 'px-3 py-2')}
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={() => onSelectContentMatch?.(match)}
                  title={`${match.path}:${match.line}`}
                >
                  <div className="flex items-start gap-2">
                    <FileText className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 opacity-60" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-ui-sm font-medium text-foreground truncate">{fileName}</span>
                        <span className="text-ui-xs text-muted-foreground flex-shrink-0">:{match.line}</span>
                      </div>
                      <div className="text-ui-xs text-muted-foreground truncate font-mono">
                        {renderContentSnippet(match, trimmedQuery)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* System search results */}
        {hasSearchedSystem && systemResults.length > 0 && (
          <>
            <div className="px-4 py-1.5 text-ui-sm text-muted-foreground font-normal">
              Found on Computer
            </div>
            {systemResults.map((result, index) => {
              const overallIndex = systemResultsStartIndex + index;
              const isSelected = overallIndex === selectedIndex;
              return (
                <div
                  key={result.path}
                  ref={(el) => {
                    if (el) itemRefs.current.set(overallIndex, el);
                    else itemRefs.current.delete(overallIndex);
                  }}
                  className={getResultRowClassName(isSelected, 'px-2 py-1.5')}
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={() => handleSystemResultSelect(result)}
                >
                  <FileSystemProxy
                    type={result.type}
                    path={result.path}
                    filename={result.name}
                    variant="card"
                    showPath={true}
                    showIcon={true}
                  />
                </div>
              );
            })}
          </>
        )}

        {showEmptyAction && (
          <>
            <div className="px-4 py-1.5 text-ui-sm font-normal text-muted-foreground">
              Action
            </div>
            <div className="px-2 pb-2">
              <button
                type="button"
                onClick={handleEmptyAction}
                data-testid={RUN_AGENT_SEARCH_BUTTON_ID}
                className={`flex w-full items-start gap-2 rounded-[12px] border px-3 py-2.5 text-left transition-colors ${
                  selectedIndex === actionIndex
                    ? 'border-black/[0.08] bg-black/[0.055] text-foreground dark:border-white/[0.12] dark:bg-white/[0.08]'
                    : 'border-black/[0.06] bg-black/[0.025] text-[#202123] hover:bg-black/[0.04] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#f5f5f5] dark:hover:bg-white/[0.06]'
                }`}
              >
                <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-black/[0.055] text-[#202123] dark:bg-white/[0.08] dark:text-[#f5f5f5]">
                  <Search className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-ui-sm font-medium">{emptyActionLabel}</span>
                  {emptyActionDescription ? (
                    <span className="mt-0.5 block text-ui-xs text-muted-foreground">
                      {emptyActionDescription}
                    </span>
                  ) : null}
                </span>
              </button>
            </div>
          </>
        )}

        {/* Search whole computer button - always at the end */}
        {SearchComputerButton}
      </div>
    );
  }
);

FileSearchResults.displayName = 'FileSearchResults';
