import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { FileText } from 'lucide-react';

export interface WikilinkSuggestionItem {
  /** Absolute workspace path (or whatever path we want to resolve later). */
  path: string;
  /** Display name and target (filename without extension). */
  name: string;
  /** Relative path from workspace root, shown as the hint line. */
  relativePath: string;
}

interface DropdownProps {
  items: WikilinkSuggestionItem[];
  command: (item: { target: string; display: string | null }) => void;
  query: string;
}

export interface DropdownRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const WikilinkSuggestionDropdown = forwardRef<DropdownRef, DropdownProps>(
  function WikilinkSuggestionDropdown({ items, command, query }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useEffect(() => {
      const el = itemRefs.current.get(selectedIndex);
      el?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    const commit = (index: number) => {
      // Interpret the case where no items match: use the user's query verbatim as
      // the wikilink target. This is the "create new page" path Obsidian also uses.
      if (items.length === 0) {
        const target = query.trim();
        if (target) command({ target, display: null });
        return;
      }
      const item = items[index];
      if (!item) return;
      command({ target: item.name, display: null });
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedIndex((prev) => (prev <= 0 ? Math.max(items.length - 1, 0) : prev - 1));
          return true;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedIndex((prev) => (prev >= items.length - 1 ? 0 : prev + 1));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          commit(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    const trimmedQuery = query.trim();

    return (
      <div
        ref={scrollRef}
        className="max-h-[280px] min-w-[240px] overflow-y-auto rounded-lg border border-border bg-background shadow-xl"
      >
        {items.length === 0 ? (
          <div className="px-3 py-2 text-ui-sm text-muted-foreground">
            {trimmedQuery
              ? <>Press Enter to create <span className="font-medium text-foreground">[[{trimmedQuery}]]</span></>
              : 'Type a page name…'}
          </div>
        ) : (
          items.map((item, index) => {
            const isSelected = index === selectedIndex;
            return (
              <div
                key={item.path}
                ref={(el) => {
                  if (el) itemRefs.current.set(index, el);
                  else itemRefs.current.delete(index);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(index);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`flex items-start gap-2 px-3 py-1.5 cursor-pointer ${isSelected ? 'bg-hover' : ''}`}
              >
                <FileText className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 opacity-60" />
                <div className="min-w-0 flex-1">
                  <div className="text-ui-sm truncate text-foreground">{item.name}</div>
                  <div className="text-ui-xs truncate text-muted-foreground">{item.relativePath}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
    );
  }
);
