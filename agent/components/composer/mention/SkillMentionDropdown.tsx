/**
 * SkillMentionDropdown Component
 *
 * Dropdown that appears when user types "/" to search and select skills.
 * Supports keyboard navigation (arrow keys, enter).
 */

import { Globe } from 'lucide-react';
import { forwardRef, useImperativeHandle, useMemo, useState, useEffect, useRef, useCallback, type MutableRefObject } from 'react';
import { tr } from '../../../../src/i18n';
import type { SkillSource } from '../../../../shared/types/skill';

export interface SkillMentionItem {
  id: string;
  label: string;
  name: string;
  path: string;
  description?: string;
  source: SkillSource;
}

export interface SkillMentionDropdownData {
  globalRootPath: string;
  projectRootPath: string | null;
  globalItems: SkillMentionItem[];
  projectItems: SkillMentionItem[];
}

interface SkillMentionDropdownProps {
  items: SkillMentionItem[];
  command: (item: SkillMentionItem) => void;
  query?: string;
  data?: SkillMentionDropdownData;
}

export function filterSkillItems(items: SkillMentionItem[], query: string): SkillMentionItem[] {
  if (!query) return items;

  const q = query.toLowerCase();
  return items.filter((item) =>
    item.label.toLowerCase().includes(q)
    || item.name.toLowerCase().includes(q)
    || (item.description || '').toLowerCase().includes(q)
    || item.id.toLowerCase().includes(q)
  );
}

function sortSkillItems(items: SkillMentionItem[]): SkillMentionItem[] {
  return [...items].sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === 'project' ? -1 : 1;
    }

    return a.label.localeCompare(b.label, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function SkillList({
  items,
  selectedIndex,
  selectItem,
  itemRefs,
}: {
  items: SkillMentionItem[];
  selectedIndex: number;
  selectItem: (index: number) => void;
  itemRefs: MutableRefObject<Map<number, HTMLButtonElement>>;
}) {
  return (
    <div className="px-1 py-2">
      {items.map((item, index) => {
        const isSelected = index === selectedIndex;

        return (
          <button
            type="button"
            key={item.id}
            ref={(el) => {
              if (el) itemRefs.current.set(index, el);
              else itemRefs.current.delete(index);
            }}
            className={`group flex w-full items-start gap-2 rounded-[14px] px-2 py-1 text-left transition-[background-color,transform] duration-200 ${
              isSelected
                ? 'bg-black/[0.045] dark:bg-white/[0.07]'
                : 'hover:bg-black/[0.035] dark:hover:bg-white/[0.05]'
            }`}
            onClick={() => selectItem(index)}
          >
            <div className="flex min-w-0 flex-1 items-start gap-2 rounded-[12px] px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-ui-sm text-[#202123] dark:text-[#f5f5f5]">
                    {item.label}
                  </span>
                  {item.source === 'global' ? (
                    <span
                      className="flex size-4 flex-shrink-0 items-center justify-center text-[#7a808a] dark:text-[#9ea3ab]"
                      aria-label={tr('mention.skillDropdown.globalSkill')}
                      title={tr('mention.skillDropdown.globalSkill')}
                    >
                      <Globe className="size-3" />
                    </span>
                  ) : null}
                </div>
                {item.description ? (
                  <div className="mt-0.5 line-clamp-2 text-ui-xs text-[#6b7280] dark:text-[#b4b4b4]">
                    {item.description}
                  </div>
                ) : null}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export const SkillMentionDropdown = forwardRef<any, SkillMentionDropdownProps>(
  ({ items, command, query = '' }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

    const filteredItems = useMemo(
      () => sortSkillItems(filterSkillItems(items, query)),
      [items, query],
    );

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
      command(item);
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
    }), [filteredItems, selectedIndex, selectItem]);

    if (filteredItems.length === 0) {
      return null;
    }

    return (
      <div
        ref={scrollContainerRef}
        className="max-h-80 w-full overflow-y-auto"
        data-mention-popup
      >
        <SkillList
          items={filteredItems}
          selectedIndex={selectedIndex}
          selectItem={selectItem}
          itemRefs={itemRefs}
        />
      </div>
    );
  }
);

SkillMentionDropdown.displayName = 'SkillMentionDropdown';
