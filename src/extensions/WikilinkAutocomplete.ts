import { Extension } from '@tiptap/core';
import { Suggestion, SuggestionPluginKey } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import { getFileCache } from '../stores/fileStore';
import { getWorkspacePathSnapshot } from '../stores/workspaceStore';
import { pathBasename, pathNormalize, pathStartsWith, pathStripPrefix } from '@/ipc';
import { stripMarkdownFileExtension } from '../utils/localReferenceDisplay';
import { WikilinkSuggestionDropdown, type WikilinkSuggestionItem } from './WikilinkSuggestionDropdown';

/**
 * Obsidian-style `[[` autocomplete.
 *
 * When the user types `[[` inside the editor, a suggestion dropdown appears
 * listing workspace markdown files. Selecting one inserts a wikilink node
 * whose `target` is the filename without its markdown extension.
 *
 * Pressing Enter with no matches commits the raw query as the target
 * (creating a dangling wikilink, matching Obsidian's behavior).
 */

const WIKILINK_PLUGIN_KEY = new PluginKey('wikilinkSuggestion');
const MAX_ITEMS = 20;

function relativeFromWorkspace(absolutePath: string, workspacePath: string | null): string {
  if (!workspacePath) return absolutePath;
  if (pathNormalize(absolutePath) === pathNormalize(workspacePath)) {
    return pathBasename(absolutePath);
  }
  if (pathStartsWith(absolutePath, workspacePath)) {
    const rest = pathStripPrefix(absolutePath, workspacePath);
    return rest || pathBasename(absolutePath);
  }
  return absolutePath;
}

function listMarkdownCandidates(query: string): WikilinkSuggestionItem[] {
  const files = getFileCache();
  const workspacePath = getWorkspacePathSnapshot();
  const lowerQuery = query.trim().toLowerCase();

  const results: WikilinkSuggestionItem[] = [];
  for (const entry of files) {
    if (entry.type !== 'file') continue;
    if (!/\.(md|markdown)$/i.test(entry.name)) continue;
    const displayName = stripMarkdownFileExtension(entry.name);
    if (lowerQuery && !displayName.toLowerCase().includes(lowerQuery) && !entry.path.toLowerCase().includes(lowerQuery)) {
      continue;
    }
    results.push({
      path: entry.path,
      name: displayName,
      relativePath: relativeFromWorkspace(entry.path, workspacePath),
    });
    if (results.length >= MAX_ITEMS) break;
  }
  return results;
}

export const WikilinkAutocomplete = Extension.create({
  name: 'wikilinkAutocomplete',

  addProseMirrorPlugins() {
    return [
      Suggestion<WikilinkSuggestionItem, { target: string; display: string | null }>({
        editor: this.editor,
        pluginKey: WIKILINK_PLUGIN_KEY,
        char: '[[',
        allowSpaces: true,
        allowToIncludeChar: false,
        startOfLine: false,

        items: ({ query }) => listMarkdownCandidates(query),

        command: ({ editor, range, props }) => {
          const target = props.target.trim();
          if (!target) return;
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: 'wikilink',
                attrs: {
                  target,
                  fragment: null,
                  display: props.display,
                },
              },
              { type: 'text', text: ' ' },
            ])
            .run();
        },

        render: () => {
          let component: ReactRenderer;
          let wrapper: HTMLDivElement | null = null;

          const updatePosition = (clientRect: (() => DOMRect | null) | null | undefined) => {
            if (!wrapper) return;
            const rect = clientRect?.();
            if (!rect) {
              wrapper.style.display = 'none';
              return;
            }
            wrapper.style.display = 'block';
            wrapper.style.left = `${rect.left}px`;
            wrapper.style.top = `${rect.bottom + 4}px`;
          };

          return {
            onStart: (props) => {
              component = new ReactRenderer(WikilinkSuggestionDropdown, {
                props: { ...props, query: props.query },
                editor: props.editor,
              });
              wrapper = document.createElement('div');
              wrapper.setAttribute('data-wikilink-popup', 'true');
              wrapper.style.position = 'fixed';
              wrapper.style.zIndex = '9999';
              document.body.appendChild(wrapper);
              wrapper.appendChild(component.element);
              updatePosition(props.clientRect);
            },

            onUpdate: (props) => {
              component.updateProps({ ...props, query: props.query });
              updatePosition(props.clientRect);
            },

            onKeyDown: (props) => {
              if (props.event.key === 'Escape') {
                if (wrapper) wrapper.style.display = 'none';
                return true;
              }
              return (component.ref as { onKeyDown?: (p: unknown) => boolean } | null)?.onKeyDown?.(props) || false;
            },

            onExit: () => {
              if (wrapper?.parentNode) wrapper.parentNode.removeChild(wrapper);
              wrapper = null;
              component?.destroy();
            },
          };
        },
      }),
    ];
  },
});

// Re-export key so callers (tests, etc.) can reach the plugin key if needed.
export { WIKILINK_PLUGIN_KEY, SuggestionPluginKey };
