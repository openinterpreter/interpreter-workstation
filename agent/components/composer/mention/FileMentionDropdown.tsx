/**
 * FileMentionDropdown Component
 *
 * Dropdown that appears when user types "@" to search and select files/folders/browser-tabs.
 * Uses shared filtering logic from useFileSearch for consistent behavior with Explorer.
 * Supports full keyboard navigation (arrow keys, enter).
 */

import React, { forwardRef, useImperativeHandle, useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { FileSystemProxy } from '../../../../src/components/FileSystemProxy';
import { tr } from '../../../../src/i18n';
import { filterSearchItems, type SearchItem } from './fileSearchBridge';
import type { MentionItem } from './fileMentionSuggestion';
import { MENTION_POPUP_ID } from '../../../../shared/element-ids';

interface FileMentionDropdownProps {
  items: MentionItem[];
  command: (item: MentionItem) => void;
  query?: string;
}

export const FileMentionDropdown = forwardRef<any, FileMentionDropdownProps>(
  ({ items, command, query = '' }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    // Use shared filtering logic
    const filteredItems = useMemo(() => {
      return filterSearchItems(items as SearchItem[], query);
    }, [items, query]);

    // Reset selection when query changes
    useEffect(() => {
      setSelectedIndex(0);
    }, [query]);

    // Scroll selected item into view
    useEffect(() => {
      const selectedEl = itemRefs.current.get(selectedIndex);
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, [selectedIndex]);

    const selectItem = useCallback((index: number) => {
      const item = filteredItems[index];
      if (!item) return;

      if (item.type === 'browser-tab') {
        command({
          id: item.browserId,
          label: item.name,
          itemType: 'browser-tab',
          url: item.url,
          faviconUrl: item.faviconUrl,
        } as any);
      } else {
        command({
          id: item.path,
          label: item.name,
          itemType: item.type,
        } as any);
      }
    }, [filteredItems, command]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === 'Escape') {
          return true;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedIndex(prev =>
            prev <= 0 ? filteredItems.length - 1 : prev - 1
          );
          return true;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedIndex(prev =>
            prev >= filteredItems.length - 1 ? 0 : prev + 1
          );
          return true;
        }

        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          selectItem(selectedIndex);
          return true;
        }

        return false;
      },
    }), [filteredItems.length, selectedIndex, selectItem]);

    if (filteredItems.length === 0) {
      // return (
      //   <div className="px-4 py-3 w-full" data-testid={MENTION_POPUP_ID}>
      //     <div className="text-muted-foreground text-ui-base">No matches found</div>
      //   </div>
      // );
      return null;
    }

    return (
      <div
        ref={scrollContainerRef}
        className="max-h-80 overflow-y-auto w-full"
        data-testid={MENTION_POPUP_ID}
      >
        {filteredItems.map((item, index) => {
          const isOpen = item.isOpen;
          const prevItem = filteredItems[index - 1];
          const isFirstOpen = isOpen && index === 0;
          const isFirstNonOpen = !isOpen && (index === 0 || prevItem?.isOpen);
          const isSelected = index === selectedIndex;

          return (
            <React.Fragment key={item.type === 'browser-tab' ? item.browserId : item.path}>
              {/* Section headers */}
              {isFirstOpen && (
                <div className="px-4 py-1.5 text-ui-sm text-muted-foreground font-normal">
                  {tr('common.open')}
                </div>
              )}
              {isFirstNonOpen && (
                <div className="px-4 py-1.5 text-ui-sm text-muted-foreground font-normal">
                  {tr('common.files')}
                </div>
              )}

              {/* Item */}
              <div
                ref={(el) => {
                  if (el) itemRefs.current.set(index, el);
                  else itemRefs.current.delete(index);
                }}
                className={`px-2 py-1 cursor-default text-muted-foreground hover:text-foreground ${isSelected ? 'bg-hover text-foreground' : 'hover:bg-muted/50'}`}
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
                />
              </div>
            </React.Fragment>
          );
        })}
      </div>
    );
  }
);

FileMentionDropdown.displayName = 'FileMentionDropdown';
