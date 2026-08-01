/**
 * AttachmentChip Tiptap Extension
 *
 * An inline, atomic, selectable TipTap node representing a pasted snippet or,
 * on overlay surfaces, a pasted/dropped image. The node stores only light
 * metadata in `attrs`; heavy content (text body, image dataUrl) lives in an
 * external per-composer store keyed by attrs.id.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { AttachmentChipNodeView } from './AttachmentChipNodeView';
import type { ComposerAttachmentAttrs, ComposerAttachmentKind } from './types';

export const ATTACHMENT_CHIP_NAME = 'attachmentChip';

export const AttachmentChip = Node.create({
  name: ATTACHMENT_CHIP_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-id'),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-id': attrs.id }),
      },
      kind: {
        default: 'pasted-text' as ComposerAttachmentKind,
        parseHTML: (el: HTMLElement) =>
          (el.getAttribute('data-kind') as ComposerAttachmentKind) || 'pasted-text',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-kind': attrs.kind }),
      },
      label: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-label': attrs.label }),
      },
      mimeType: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-mime-type'),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-mime-type': attrs.mimeType }),
      },
      size: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-size');
          return raw ? parseInt(raw, 10) : null;
        },
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-size': attrs.size }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-type="${this.name}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as ComposerAttachmentAttrs;
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': this.name,
        'data-id': attrs.id,
        'data-kind': attrs.kind,
        'data-label': attrs.label,
        'data-mime-type': attrs.mimeType ?? null,
        'data-size': attrs.size ?? null,
      }),
      attrs.label,
    ];
  },

  /**
   * When the message is serialized to text (e.g. copy/paste out of the
   * editor), images become an inline placeholder the model can still reason
   * about. For pasted-text chips the body is not inlined here; callers that
   * want full bodies must use `serializeEditorWithAttachments` which reads
   * from the attachment store.
   */
  renderText({ node }) {
    const attrs = node.attrs as ComposerAttachmentAttrs;
    if (attrs.kind === 'pasted-image' || attrs.kind === 'file-image') {
      return `[image: ${attrs.label}]`;
    }
    return `[pasted: ${attrs.label}]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentChipNodeView);
  },
});
