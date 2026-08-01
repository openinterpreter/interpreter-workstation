/**
 * AttachmentChipNodeView
 *
 * Renders an attachmentChip node as a compact chip inside the composer.
 * Emits hover events so a host popover can show a preview of the pasted
 * content (text body or full image).
 */

import { useCallback } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { AttachmentChipBody } from './AttachmentChipBody';
import type { ComposerAttachmentAttrs } from './types';
import { useAttachmentPreviewTrigger } from './useAttachmentPreviewTrigger';

export function AttachmentChipNodeView({
  node,
  deleteNode,
}: {
  node: { attrs: Record<string, unknown> };
  deleteNode: () => void;
}) {
  const attrs = node.attrs as unknown as ComposerAttachmentAttrs;
  const {
    wrapperRef,
    previewSourceKey,
    handleMouseEnter,
    handleMouseLeave,
  } = useAttachmentPreviewTrigger(attrs);

  const handleRemoveMouseDown = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      deleteNode();
    },
    [deleteNode],
  );

  return (
    <NodeViewWrapper
      as="span"
      ref={wrapperRef}
      data-attachment-preview-key={previewSourceKey}
      data-attachment-kind={attrs.kind}
      className="composer-attachment-chip"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      contentEditable={false}
    >
      <AttachmentChipBody
        kind={attrs.kind}
        label={attrs.label}
        onRemoveMouseDown={handleRemoveMouseDown}
      />
    </NodeViewWrapper>
  );
}
