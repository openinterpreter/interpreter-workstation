/**
 * RefMention Suggestion Config
 *
 * Configures the "@" trigger for block output references in automation inputs.
 */

import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions } from '@tiptap/suggestion';
import { RefMentionDropdown, type RefSuggestionItem } from './RefMentionDropdown';
import type { AutomationBlock, BlockOutput, AutomationConstant } from '../../../types/automation';
import { collectOutputPaths } from '../../../lib/automationEngine';

/** Special blockId used to group constants in the dropdown */
const CONSTANTS_GROUP = '__constants__';

/**
 * Build the list of suggestion items from constants and previous block outputs.
 */
function buildSuggestionItems(
  blocksBefore: AutomationBlock[],
  blockOutputs: Record<string, BlockOutput>,
  constants: AutomationConstant[]
): RefSuggestionItem[] {
  const items: RefSuggestionItem[] = [];

  // Add constants first (always available)
  for (const c of constants) {
    items.push({
      id: c.id,
      label: c.label,
      blockId: CONSTANTS_GROUP,
      blockLabel: 'Constants',
      path: '',
      resolvedValue: c.value,
    });
  }

  for (const block of blocksBefore) {
    const output = blockOutputs[block.id];
    if (!output || output.error) continue;

    // Add the full block output as a reference
    items.push({
      id: `@${block.id}`,
      label: `${block.label}`,
      blockId: block.id,
      blockLabel: block.label,
      path: '',
    });

    // Walk the output to find sub-paths
    const paths = collectOutputPaths({ [block.id]: output }, [block]);
    for (const path of paths) {
      if (path === `@${block.id}`) continue; // Skip duplicate of the root
      const subPath = path.slice(`@${block.id}`.length + 1); // Remove "@blockId." prefix
      if (!subPath) continue;
      items.push({
        id: path,
        label: `${block.label} → ${subPath}`,
        blockId: block.id,
        blockLabel: block.label,
        path: subPath,
      });
    }
  }

  return items;
}

export function createRefMentionSuggestion(
  getBlocksBefore: () => AutomationBlock[],
  getBlockOutputs: () => Record<string, BlockOutput>,
  getConstants: () => AutomationConstant[]
): Omit<SuggestionOptions, 'editor'> {
  return {
    char: '@',
    allowSpaces: false,
    allowedPrefixes: null,
    startOfLine: false,

    // No trailing space after mention insertion — allows constructing paths like @workspace/test.txt
    command: ({ editor, range, props }) => {
      editor.chain()
        .focus()
        .insertContentAt(range, [
          { type: 'refMention', attrs: props },
        ])
        .run();
    },

    items: ({ query }) => {
      const all = buildSuggestionItems(getBlocksBefore(), getBlockOutputs(), getConstants());
      if (!query) return all;
      const q = query.toLowerCase();
      return all.filter(item =>
        item.id.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q)
      );
    },

    render: () => {
      let component: ReactRenderer;
      let wrapper: HTMLDivElement;

      return {
        onStart: (props) => {
          component = new ReactRenderer(RefMentionDropdown, {
            props: { ...props, query: props.query },
            editor: props.editor,
          });

          wrapper = document.createElement('div');
          wrapper.setAttribute('data-ref-mention-popup', 'true');
          wrapper.style.position = 'fixed';
          wrapper.style.zIndex = '9999';
          wrapper.className = 'bg-background rounded-lg shadow-xl overflow-hidden';
          wrapper.style.minWidth = '240px';
          wrapper.style.maxWidth = '400px';
          wrapper.style.border = 'var(--border-width) solid var(--border)';
          document.body.appendChild(wrapper);
          wrapper.appendChild(component.element);

          const cursorRect = props.clientRect?.();
          if (cursorRect) {
            wrapper.style.left = `${cursorRect.left}px`;
            wrapper.style.bottom = `${window.innerHeight - cursorRect.top + 4}px`;
            wrapper.style.top = 'auto';
          }
        },

        onUpdate(props) {
          component.updateProps({ ...props, query: props.query });

          const cursorRect = props.clientRect?.();
          if (cursorRect) {
            wrapper.style.left = `${cursorRect.left}px`;
            wrapper.style.bottom = `${window.innerHeight - cursorRect.top + 4}px`;
          }
        },

        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            wrapper.style.display = 'none';
            return true;
          }
          return (component.ref as any)?.onKeyDown?.(props) || false;
        },

        onExit() {
          if (wrapper?.parentNode) {
            wrapper.parentNode.removeChild(wrapper);
          }
          component.destroy();
        },
      };
    },
  };
}
