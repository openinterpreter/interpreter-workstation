/**
 * Tool Keyword Highlight Extension for Tiptap
 *
 * Highlights official tool names (like "PubMed") in blue
 * to make them appear as recognized keywords.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Tool keywords to highlight - these are official tools from the MCP store
const TOOL_KEYWORDS = [
  'PubMed',
  'Asana',
  'Atlassian',
  'Linear',
  'Notion',
  'Fellow',
  'Fireflies',
  'Intercom',
  'Ramp',
  'PayPal',
  'Square',
  'Sentry',
  'Explorium',
  'Windsor',
  'Open Targets',
  'Scholar Gateway',
];

// Create case-insensitive regex that matches whole words
function createKeywordRegex(): RegExp {
  const escaped = TOOL_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
}

const pluginKey = new PluginKey('toolKeywordHighlight');

export const ToolKeywordHighlight = Extension.create({
  name: 'toolKeywordHighlight',

  addProseMirrorPlugins() {
    const regex = createKeywordRegex();

    return [
      new Plugin({
        key: pluginKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const doc = state.doc;

            doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;

              const text = node.text;
              let match;

              // Reset regex lastIndex for each text node
              regex.lastIndex = 0;

              while ((match = regex.exec(text)) !== null) {
                const start = pos + match.index;
                const end = start + match[0].length;

                decorations.push(
                  Decoration.inline(start, end, {
                    class: 'tool-keyword-highlight',
                    style: 'color: var(--color-blue-500); font-weight: 500;',
                  })
                );
              }
            });

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});
