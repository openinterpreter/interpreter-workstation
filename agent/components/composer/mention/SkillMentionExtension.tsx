/**
 * SkillMention Tiptap Extension
 *
 * Custom mention extension for skills (slash commands).
 * Uses "/" trigger. Instruction skills render as chips and serialize
 * to skill:[Label](id). Prompt skills insert text directly.
 */

import { Mention } from '@tiptap/extension-mention';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { SkillMentionNodeView } from './SkillMentionNodeView';
import { mergeAttributes } from '@tiptap/core';
import { serializeSkillMentionToken } from '../../../../shared/utils/skillMentions';

export interface SkillMentionAttrs {
  id: string;
  label: string;
  name: string;
  path: string;
  description?: string;
}

/**
 * SkillMention extension - "/" triggered mentions for skills
 */
export const SkillMention = Mention.extend({
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
    return [
      {
        tag: `span[data-type="${this.name}"]`,
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const nodeAttrs = node.attrs as SkillMentionAttrs;
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      'data-type': this.name,
      'data-id': nodeAttrs.id,
      'data-label': nodeAttrs.label,
      'data-name': nodeAttrs.name,
      'data-path': nodeAttrs.path,
      'data-description': nodeAttrs.description,
    });

    return ['span', attrs, nodeAttrs.label];
  },

  renderText({ node }) {
    const nodeAttrs = node.attrs as SkillMentionAttrs;
    return serializeSkillMentionToken({
      id: nodeAttrs.id,
      label: nodeAttrs.label,
      name: nodeAttrs.name,
      path: nodeAttrs.path,
    });
  },

  addNodeView() {
    return ReactNodeViewRenderer(SkillMentionNodeView);
  },
});
