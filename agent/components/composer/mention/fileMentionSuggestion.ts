/**
 * File Mention Suggestion Configuration
 *
 * Configures the "@" trigger and suggestion dropdown for file/folder/browser-tab mentions.
 * Uses shared file search hook for consistent behavior with Explorer search.
 */

import { ReactRenderer } from '@tiptap/react';
import { SuggestionOptions } from '@tiptap/suggestion';
import { FileMentionDropdown } from './FileMentionDropdown';
import { filterSearchItems, getAllSearchItems, type SearchItem } from './fileSearchBridge';

// Re-export SearchItem as MentionItem for backward compatibility
export type MentionItem = SearchItem;

/**
 * Create suggestion configuration for file mentions
 */
export function createFileMentionSuggestion(options?: {
  getContainer?: () => HTMLElement | null;
}): Omit<SuggestionOptions, 'editor'> {
  return {
    char: '@',
    allowSpaces: true,
    allowedPrefixes: [' ', '\n'],
    startOfLine: false,

    allow: ({ state, range }) => {
      const text = state.doc.textBetween(range.from, range.to);
      const query = text.slice('@'.length);
      if (query.startsWith(' ')) {
        return false;
      }
      if (!query) {
        return true;
      }

      return filterSearchItems(getAllSearchItems(), query).length > 0;
    },

    items: () => {
      // Use shared function - all synchronous, instant!
      return getAllSearchItems();
    },

    render: () => {
      let component: ReactRenderer;

      return {
        onStart: (props) => {
          component = new ReactRenderer(FileMentionDropdown, {
            props: {
              ...props,
              query: props.query,
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
              // Position above cursor
              wrapper.style.bottom = `${window.innerHeight - cursorRect.top + 4}px`;
              wrapper.style.top = 'auto';
            } else {
              // Fallback if no cursor rect
              wrapper.style.top = `${containerRect.top + 100}px`;
              wrapper.style.bottom = 'auto';
            }
          };

          updatePosition();

          // Store for cleanup and updates
          (component as any).__wrapper = wrapper;
          (component as any).__updatePosition = updatePosition;
          (component as any).__setClientRect = (fn: any) => { clientRectFn = fn; };
        },

        onUpdate(props) {
          component.updateProps({
            ...props,
            query: props.query,
          });

          // Update clientRect and position
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
