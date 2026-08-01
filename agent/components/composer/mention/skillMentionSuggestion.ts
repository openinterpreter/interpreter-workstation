/**
 * Skill Mention Suggestion Configuration
 *
 * Configures the "/" trigger and suggestion dropdown for skill mentions.
 * Selecting a skill inserts a skill mention chip.
 */

import { ReactRenderer } from '@tiptap/react';
import { SuggestionOptions } from '@tiptap/suggestion';
import {
  SkillMentionDropdown,
  filterSkillItems,
  type SkillMentionDropdownData,
  type SkillMentionItem,
} from './SkillMentionDropdown';

let _skillItemsById: Map<string, SkillMentionItem> = new Map();

/**
 * Update the cached skill items used for mention hover metadata.
 */
export function setSkillItemRegistry(items: SkillMentionItem[]): void {
  _skillItemsById = new Map(items.map((item) => [item.id, item]));
}

export function getSkillItemById(skillId: string): SkillMentionItem | undefined {
  return _skillItemsById.get(skillId);
}

/**
 * Create suggestion configuration for skill mentions
 */
export function createSkillMentionSuggestion(options?: {
  getContainer?: () => HTMLElement | null;
  getDropdownData?: () => SkillMentionDropdownData;
}): Omit<SuggestionOptions, 'editor'> {
  return {
    char: '/',
    allowSpaces: true,
    allowedPrefixes: [' ', '\n'],
    startOfLine: false,

    allow: ({ state, range }) => {
      const text = state.doc.textBetween(range.from, range.to);
      const query = text.slice('/'.length);
      if (query.startsWith(' ')) {
        return false;
      }
      if (!query) {
        return true;
      }

      const dropdownData = options?.getDropdownData?.();
      const allItems = dropdownData
        ? [...dropdownData.projectItems, ...dropdownData.globalItems]
        : [];

      return filterSkillItems(allItems, query).length > 0;
    },

    items: () => {
      const dropdownData = options?.getDropdownData?.();
      return dropdownData
        ? [...dropdownData.projectItems, ...dropdownData.globalItems]
        : [];
    },

    command: ({ editor, range, props }: any) => {
      const item = props as SkillMentionItem;
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
            description: item.description || '',
          },
        })
        .insertContent(' ')
        .run();
    },

    render: () => {
      let component: ReactRenderer;

      return {
        onStart: (props) => {
          component = new ReactRenderer(SkillMentionDropdown, {
            props: {
              ...props,
              query: props.query,
              data: options?.getDropdownData?.(),
            },
            editor: props.editor,
          });

          // Find the container for positioning — use the editor's own DOM,
          // walking up to the nearest composer wrapper or sidebar panel.
          const editorEl = props.editor.view.dom as HTMLElement;
          const container = options?.getContainer?.()
            ?? editorEl.closest('[data-testid="agent-sidebar"]')
            ?? editorEl.closest('.new-tab-composer-wrapper')
            ?? editorEl.closest('.tiptap-composer-root')
            ?? editorEl.parentElement;

          // Create a wrapper div that we manually position
          const wrapper = document.createElement('div');
          wrapper.setAttribute('data-mention-popup', 'true');
          wrapper.style.position = 'fixed';
          wrapper.style.zIndex = '9999';
          wrapper.className = 'bg-background rounded-lg shadow-xl overflow-hidden';
          document.body.appendChild(wrapper);
          wrapper.appendChild(component.element);

          // Store clientRect getter for updates
          let clientRectFn = props.clientRect;

          // Position the dropdown relative to the container that holds the editor
          const updatePosition = () => {
            const cursorRect = clientRectFn?.();
            const containerRect = container?.getBoundingClientRect();

            if (!containerRect) {
              // Fallback: position near cursor
              if (cursorRect) {
                wrapper.style.left = `${cursorRect.left}px`;
                wrapper.style.width = '320px';
                wrapper.style.bottom = `${window.innerHeight - cursorRect.top + 4}px`;
                wrapper.style.top = 'auto';
              } else {
                wrapper.style.left = '50px';
                wrapper.style.width = '300px';
                wrapper.style.top = '100px';
              }
              return;
            }

            const margin = 8;
            const width = containerRect.width - (margin * 2);
            const left = containerRect.left + margin;

            wrapper.style.left = `${left}px`;
            wrapper.style.width = `${width}px`;

            if (cursorRect) {
              wrapper.style.bottom = `${window.innerHeight - cursorRect.top + 4}px`;
              wrapper.style.top = 'auto';
            } else {
              wrapper.style.top = `${containerRect.top + 100}px`;
              wrapper.style.bottom = 'auto';
            }
          };

          updatePosition();

          (component as any).__wrapper = wrapper;
          (component as any).__updatePosition = updatePosition;
          (component as any).__setClientRect = (fn: any) => { clientRectFn = fn; };
        },

        onUpdate(props) {
          component.updateProps({
            ...props,
            query: props.query,
            data: options?.getDropdownData?.(),
          });

          const setClientRect = (component as any).__setClientRect;
          if (setClientRect && props.clientRect) {
            setClientRect(props.clientRect);
          }

          const updatePosition = (component as any).__updatePosition;
          if (updatePosition) {
            updatePosition();
          }
        },

        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            const wrapper = (component as any).__wrapper;
            if (wrapper) wrapper.style.display = 'none';
            return true;
          }

          return (component.ref as { onKeyDown?: (props: unknown) => boolean })?.onKeyDown?.(props) || false;
        },

        onExit() {
          const wrapper = (component as any).__wrapper;
          if (wrapper && wrapper.parentNode) {
            wrapper.parentNode.removeChild(wrapper);
          }
          component.destroy();
        },
      };
    },
  };
}
