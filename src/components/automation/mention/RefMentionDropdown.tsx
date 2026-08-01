/**
 * RefMentionDropdown
 *
 * Dropdown for selecting block output references when typing @.
 */

import React, { forwardRef, useImperativeHandle, useMemo, useState, useEffect, useRef, useCallback } from 'react';

export interface RefSuggestionItem {
  id: string;      // Full ref e.g. "@block_abc123.content[0].text" or "@workspace"
  label: string;   // Display label e.g. "Read Config → content[0].text" or "workspace"
  blockId: string;
  blockLabel: string;
  path: string;
  resolvedValue?: string; // For constants: the actual value (e.g. "/Users/.../project")
}

interface RefMentionDropdownProps {
  items: RefSuggestionItem[];
  command: (item: any) => void;
  query?: string;
}

export const RefMentionDropdown = forwardRef<any, RefMentionDropdownProps>(
  ({ items, command, query = '' }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    const filtered = useMemo(() => {
      if (!query) return items;
      const q = query.toLowerCase();
      return items.filter(item =>
        item.id.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        item.blockLabel.toLowerCase().includes(q)
      );
    }, [items, query]);

    useEffect(() => {
      setSelectedIndex(0);
    }, [query]);

    useEffect(() => {
      const el = itemRefs.current.get(selectedIndex);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [selectedIndex]);

    const selectItem = useCallback((index: number) => {
      const item = filtered[index];
      if (!item) return;
      command({
        id: item.id,
        label: item.label,
        blockId: item.blockId,
        path: item.path,
        resolvedValue: item.resolvedValue || null,
      });
    }, [filtered, command]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === 'Escape') return true;
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedIndex(prev => prev <= 0 ? filtered.length - 1 : prev - 1);
          return true;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedIndex(prev => prev >= filtered.length - 1 ? 0 : prev + 1);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }), [filtered.length, selectedIndex, selectItem]);

    if (filtered.length === 0) {
      return (
        <div className="px-3 py-2 text-ui-xs text-muted-foreground">
          {items.length === 0
            ? 'No references available. Run previous blocks to reference their outputs.'
            : 'No matches found'}
        </div>
      );
    }

    return (
      <div ref={scrollRef} className="max-h-64 overflow-y-auto">
        {filtered.map((item, index) => {
          const showHeader = index === 0 || item.blockId !== filtered[index - 1]?.blockId;
          const isSelected = index === selectedIndex;

          return (
            <React.Fragment key={item.id}>
              {showHeader && (
                <div className="px-3 py-1 text-ui-xs text-muted-foreground font-medium">
                  {item.blockLabel}
                </div>
              )}
              <div
                ref={(el) => {
                  if (el) itemRefs.current.set(index, el);
                  else itemRefs.current.delete(index);
                }}
                className={`px-3 py-1 font-mono text-ui-xs ${isSelected ? 'bg-hover text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
                onClick={() => selectItem(index)}
              >
                {item.blockId === '__constants__' ? (
                  <span className="flex items-center" style={{ gap: 'var(--spacing-xs)' }}>
                    <span className="text-foreground">{item.id}</span>
                    {item.resolvedValue && (
                      <span className="text-muted-foreground truncate" style={{ maxWidth: 200 }}>{item.resolvedValue}</span>
                    )}
                  </span>
                ) : (item.path || '(full output)')}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    );
  }
);

RefMentionDropdown.displayName = 'RefMentionDropdown';
