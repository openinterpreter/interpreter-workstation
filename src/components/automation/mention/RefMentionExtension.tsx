/**
 * RefMention TipTap Extension
 *
 * Custom mention extension for referencing previous block outputs and constants.
 * Stores blockId + path, serializes to @blockId.path, renders as a chip.
 */

import { Mention } from '@tiptap/extension-mention';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { RefMentionNodeView } from './RefMentionNodeView';
import { mergeAttributes } from '@tiptap/core';

export interface RefMentionAttrs {
  id: string;    // e.g. "@block_abc123.content[0].text" or "@workspace"
  label: string; // Display label e.g. "Read Config → content[0].text" or "workspace"
  blockId: string;
  path: string;  // The path part after blockId, e.g. "content[0].text"
  resolvedValue?: string; // For constants: the resolved value (e.g. "/Users/.../project")
}

export const RefMention = Mention.extend({
  name: 'refMention',

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-id'),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-id': attributes.id }),
      },
      label: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-label'),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-label': attributes.label }),
      },
      blockId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-block-id'),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-block-id': attributes.blockId }),
      },
      path: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-path'),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-path': attributes.path }),
      },
      resolvedValue: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-resolved-value'),
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes.resolvedValue) return {};
          return { 'data-resolved-value': attributes.resolvedValue };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-type="${this.name}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      'data-type': this.name,
    });
    return ['span', attrs, node.attrs.id];
  },

  renderText({ node }) {
    return node.attrs.id as string;
  },

  addNodeView() {
    return ReactNodeViewRenderer(RefMentionNodeView);
  },
});
