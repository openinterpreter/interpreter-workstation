import { mergeAttributes } from '@tiptap/core';
import { Mention } from '@tiptap/extension-mention';
import type { SuggestionOptions } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type { SkillSource } from '../../../shared/types/skill';
import { serializeSkillMentionToken } from '../../../shared/utils/skillMentions';

export interface OverlaySkillMentionItem {
  id: string;
  label: string;
  name: string;
  path: string;
  description?: string;
  source: SkillSource;
}

export interface OverlaySkillMentionDropdownData {
  globalItems: OverlaySkillMentionItem[];
  projectItems: OverlaySkillMentionItem[];
}

interface OverlaySkillMentionAttrs {
  id: string;
  label: string;
  name: string;
  path: string;
  description?: string;
}

function filterOverlaySkillItems(
  items: OverlaySkillMentionItem[],
  query: string,
): OverlaySkillMentionItem[] {
  if (!query) {
    return items;
  }

  const normalizedQuery = query.toLowerCase();
  return items.filter((item) => (
    item.label.toLowerCase().includes(normalizedQuery)
    || item.name.toLowerCase().includes(normalizedQuery)
    || item.id.toLowerCase().includes(normalizedQuery)
    || (item.description ?? '').toLowerCase().includes(normalizedQuery)
  ));
}

function sortOverlaySkillItems(items: OverlaySkillMentionItem[]): OverlaySkillMentionItem[] {
  return [...items].sort((left, right) => {
    if (left.source !== right.source) {
      return left.source === 'project' ? -1 : 1;
    }

    return left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function OverlaySkillMentionList({
  items,
  selectedIndex,
  selectItem,
  itemRefs,
}: {
  items: OverlaySkillMentionItem[];
  selectedIndex: number;
  selectItem: (index: number) => void;
  itemRefs: MutableRefObject<Map<number, HTMLButtonElement>>;
}) {
  return (
    <div className="overlay-skill-mention-list">
      {items.map((item, index) => {
        const isSelected = index === selectedIndex;
        const badgeLabel = item.source === 'project' ? 'Project' : 'Global';

        return (
          <button
            type="button"
            key={`${item.source}:${item.id}`}
            ref={(element) => {
              if (element) {
                itemRefs.current.set(index, element);
                return;
              }
              itemRefs.current.delete(index);
            }}
            className={`overlay-skill-mention-item${isSelected ? ' overlay-skill-mention-item-selected' : ''}`}
            onClick={() => selectItem(index)}
          >
            <div className="overlay-skill-mention-item-header">
              <span className="overlay-skill-mention-item-label">{item.label}</span>
              <span className="overlay-skill-mention-item-source">{badgeLabel}</span>
            </div>
            {item.description ? (
              <div className="overlay-skill-mention-item-description">{item.description}</div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

const OverlaySkillMentionDropdown = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  {
    items: OverlaySkillMentionItem[];
    command: (item: OverlaySkillMentionItem) => void;
    query?: string;
  }
>(function OverlaySkillMentionDropdown(
  {
    items,
    command,
    query = '',
  },
  ref,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const filteredItems = useMemo(
    () => sortOverlaySkillItems(filterOverlaySkillItems(items, query)),
    [items, query],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const selectedElement = itemRefs.current.get(selectedIndex);
    selectedElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  const selectItem = useCallback((index: number) => {
    const item = filteredItems[index];
    if (!item) {
      return;
    }

    command(item);
  }, [command, filteredItems]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === 'Escape') {
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((previous) => (
          previous <= 0 ? filteredItems.length - 1 : previous - 1
        ));
        return true;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((previous) => (
          previous >= filteredItems.length - 1 ? 0 : previous + 1
        ));
        return true;
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        selectItem(selectedIndex);
        return true;
      }

      return false;
    },
  }), [filteredItems.length, selectItem, selectedIndex]);

  if (filteredItems.length === 0) {
    return null;
  }

  return (
    <div className="overlay-skill-mention-popup">
      <OverlaySkillMentionList
        items={filteredItems}
        selectedIndex={selectedIndex}
        selectItem={selectItem}
        itemRefs={itemRefs}
      />
    </div>
  );
});

export function createOverlaySkillMentionSuggestion(options: {
  getContainer?: () => HTMLElement | null;
  getDropdownData?: () => OverlaySkillMentionDropdownData | null;
}): Omit<SuggestionOptions, 'editor'> {
  return {
    char: '/',
    allowSpaces: true,
    allowedPrefixes: [' ', '\n'],
    startOfLine: false,

    allow: ({ state, range }) => {
      const text = state.doc.textBetween(range.from, range.to);
      const query = text.slice(1);
      if (query.startsWith(' ')) {
        return false;
      }

      if (!query) {
        return true;
      }

      const dropdownData = options.getDropdownData?.();
      const allItems = dropdownData
        ? [...dropdownData.projectItems, ...dropdownData.globalItems]
        : [];

      return filterOverlaySkillItems(allItems, query).length > 0;
    },

    items: () => {
      const dropdownData = options.getDropdownData?.();
      return dropdownData
        ? [...dropdownData.projectItems, ...dropdownData.globalItems]
        : [];
    },

    command: ({ editor, range, props }: any) => {
      const item = props as OverlaySkillMentionItem;
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: 'skillMention',
          attrs: {
            id: item.id,
            label: item.label,
            name: item.name,
            path: item.path,
            description: item.description ?? '',
          },
        })
        .insertContent(' ')
        .run();
    },

    render: () => {
      let component: ReactRenderer;

      return {
        onStart: (props) => {
          component = new ReactRenderer(OverlaySkillMentionDropdown, {
            props: {
              ...props,
              query: props.query,
            },
            editor: props.editor,
          });

          const editorElement = props.editor.view.dom as HTMLElement;
          const container = options.getContainer?.()
            ?? editorElement.closest('.overlay-skill-mention-anchor')
            ?? editorElement.parentElement;

          const wrapper = document.createElement('div');
          wrapper.style.position = 'fixed';
          wrapper.style.zIndex = '10010';
          document.body.appendChild(wrapper);
          wrapper.appendChild(component.element);

          let clientRectFn = props.clientRect;

          const updatePosition = () => {
            const cursorRect = clientRectFn?.();
            const containerRect = container?.getBoundingClientRect();
            const fallbackWidth = 360;

            if (cursorRect) {
              wrapper.style.left = `${Math.max(24, cursorRect.left - 8)}px`;
              wrapper.style.bottom = `${Math.max(24, window.innerHeight - cursorRect.top + 10)}px`;
              wrapper.style.top = 'auto';
              wrapper.style.width = `${Math.min(fallbackWidth, window.innerWidth - 48)}px`;
              return;
            }

            if (containerRect) {
              wrapper.style.left = `${containerRect.left}px`;
              wrapper.style.bottom = `${Math.max(24, window.innerHeight - containerRect.top + 10)}px`;
              wrapper.style.top = 'auto';
              wrapper.style.width = `${Math.min(420, Math.max(280, containerRect.width))}px`;
            }
          };

          updatePosition();
          (component as any).__wrapper = wrapper;
          (component as any).__updatePosition = updatePosition;
          (component as any).__setClientRect = (nextClientRect: any) => {
            clientRectFn = nextClientRect;
          };
        },

        onUpdate(props) {
          component.updateProps({
            ...props,
            query: props.query,
          });

          const setClientRect = (component as any).__setClientRect;
          if (setClientRect && props.clientRect) {
            setClientRect(props.clientRect);
          }

          const updatePosition = (component as any).__updatePosition;
          updatePosition?.();
        },

        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            const wrapper = (component as any).__wrapper as HTMLDivElement | undefined;
            if (wrapper) {
              wrapper.style.display = 'none';
            }
            return true;
          }

          return (component.ref as { onKeyDown?: (props: unknown) => boolean })?.onKeyDown?.(props) || false;
        },

        onExit() {
          const wrapper = (component as any).__wrapper as HTMLDivElement | undefined;
          if (wrapper?.parentNode) {
            wrapper.parentNode.removeChild(wrapper);
          }
          component.destroy();
        },
      };
    },
  };
}

export const OverlaySkillMention = Mention.extend({
  name: 'skillMention',

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-id'),
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-id': attributes.id,
        }),
      },
      label: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-label'),
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-label': attributes.label,
        }),
      },
      name: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-name'),
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-name': attributes.name,
        }),
      },
      path: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-path'),
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-path': attributes.path,
        }),
      },
      description: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-description') || '',
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-description': attributes.description,
        }),
      },
    };
  },

  parseHTML() {
    return [{
      tag: `span[data-type="${this.name}"]`,
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as OverlaySkillMentionAttrs;
    return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      'data-type': this.name,
      'data-id': attrs.id,
      'data-label': attrs.label,
      'data-name': attrs.name,
      'data-path': attrs.path,
      'data-description': attrs.description ?? '',
      class: 'overlay-skill-mention-chip',
    }), attrs.label];
  },

  renderText({ node }) {
    const attrs = node.attrs as OverlaySkillMentionAttrs;
    return serializeSkillMentionToken({
      id: attrs.id,
      label: attrs.label,
      name: attrs.name,
      path: attrs.path,
    });
  },
});
