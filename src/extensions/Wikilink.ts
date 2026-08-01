import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { WikilinkNodeView } from './WikilinkNodeView';

/**
 * Obsidian-style [[wikilink]] node.
 *
 * Inline, atomic node. Stores:
 *   - target: the page name / path being linked to (e.g. "Page Name" or "folder/Page Name")
 *   - fragment: optional heading anchor (e.g. "Section-Title")
 *   - display: optional alias shown instead of the target (e.g. "Display Text")
 *
 * Rendered as a styled <span data-wikilink> so click handling can be done
 * centrally in the parent editor by inspecting the clicked element.
 */

export interface WikilinkAttrs {
  target: string;
  fragment: string | null;
  display: string | null;
}

export const Wikilink = Node.create({
  name: 'wikilink',

  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      target: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-target') || '',
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-target': attributes.target,
        }),
      },
      fragment: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-fragment') || null,
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.fragment ? { 'data-fragment': attributes.fragment } : {},
      },
      display: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-display') || null,
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.display ? { 'data-display': attributes.display } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-wikilink]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // NOTE: The React NodeView is what users actually see inside Tiptap.
    // This HTML fallback is used for copy/paste and cached view rendering.
    const attrs = node.attrs as WikilinkAttrs;
    const label = attrs.display || attrs.target;
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-wikilink': '' }),
      label,
    ];
  },

  renderText({ node }) {
    const attrs = node.attrs as WikilinkAttrs;
    const targetWithFragment = attrs.fragment ? `${attrs.target}#${attrs.fragment}` : attrs.target;
    return attrs.display
      ? `[[${targetWithFragment}|${attrs.display}]]`
      : `[[${targetWithFragment}]]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikilinkNodeView);
  },
});
