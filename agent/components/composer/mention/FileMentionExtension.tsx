/**
 * FileMention Tiptap Extension
 *
 * Custom mention extension for files and folders.
 * Stores paths, serializes to markdown links, renders as FileSystemProxy.
 */

import { Mention } from '@tiptap/extension-mention';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MentionNodeView } from './MentionNodeView';
import { mergeAttributes } from '@tiptap/core';
import { serializeLocalLinkHref } from '../../../../src/utils/localLinkDetection';

export interface FileMentionAttrs {
  id: string; // Absolute path for files/directories, browserId for browser tabs
  label: string; // Display name (filename or page title)
  itemType: 'file' | 'directory' | 'browser-tab';
  url?: string; // URL for browser tabs
  faviconUrl?: string; // Favicon URL for browser tabs
  fragment?: string; // Heading slug, e.g. "section-heading"
  lineStart?: number; // Start line, from :L10
  lineEnd?: number; // End line, from :L10-L20
}

/**
 * FileMention extension - extends base Mention with file/folder support
 */
export const FileMention = Mention.extend({
  name: 'fileMention',

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
      itemType: {
        default: 'file',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-item-type') || 'file',
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-item-type': attributes.itemType,
        }),
      },
      url: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-url'),
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-url': attributes.url,
        }),
      },
      faviconUrl: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-favicon-url'),
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-favicon-url': attributes.faviconUrl,
        }),
      },
      fragment: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-fragment') || null,
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-fragment': attributes.fragment,
        }),
      },
      lineStart: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const val = element.getAttribute('data-line-start');
          return val ? parseInt(val, 10) : null;
        },
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-line-start': attributes.lineStart,
        }),
      },
      lineEnd: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const val = element.getAttribute('data-line-end');
          return val ? parseInt(val, 10) : null;
        },
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-line-end': attributes.lineEnd,
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
    // Cast attrs to our custom type (Tiptap's base type is generic)
    const nodeAttrs = node.attrs as FileMentionAttrs;
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      'data-type': this.name,
      'data-id': nodeAttrs.id,
      'data-label': nodeAttrs.label,
      'data-item-type': nodeAttrs.itemType,
      'data-url': nodeAttrs.url,
      'data-favicon-url': nodeAttrs.faviconUrl,
      'data-fragment': nodeAttrs.fragment,
      'data-line-start': nodeAttrs.lineStart,
      'data-line-end': nodeAttrs.lineEnd,
    });

    return ['span', attrs, nodeAttrs.label];
  },

  renderText({ node }) {
    // Cast attrs to our custom type (Tiptap's base type is generic)
    const nodeAttrs = node.attrs as FileMentionAttrs;
    // NOTE(victor): Browser tabs serialize with browser:// protocol so agents can distinguish them from files
    if (nodeAttrs.itemType === 'browser-tab') {
      return `[${nodeAttrs.label}](browser://${nodeAttrs.id})`;
    }
    // Serialize as standard markdown link [label](path#fragment:L10-L20).
    // Directory mentions carry a trailing slash so they round-trip unambiguously.
    const href = serializeLocalLinkHref({
      path: nodeAttrs.id,
      itemType: nodeAttrs.itemType,
      fragment: nodeAttrs.fragment,
      lineStart: nodeAttrs.lineStart,
      lineEnd: nodeAttrs.lineEnd,
    });
    return `[${nodeAttrs.label}](<${href}>)`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionNodeView);
  },
});
