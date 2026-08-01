import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ATTACHMENT_PREVIEW_DELAY_MS,
  ATTACHMENT_PREVIEW_END_EVENT,
  ATTACHMENT_PREVIEW_START_EVENT,
  type AttachmentPreviewEndDetail,
  type AttachmentPreviewDetail,
} from './attachmentPreviewEvents';
import type { ComposerAttachmentAttrs } from './types';

type AttachmentPreviewTriggerAttrs = Pick<
  ComposerAttachmentAttrs,
  'id' | 'kind' | 'label' | 'mimeType' | 'size'
>;

export function useAttachmentPreviewTrigger<T extends HTMLElement = HTMLSpanElement>(
  attrs: AttachmentPreviewTriggerAttrs,
) {
  const wrapperRef = useRef<T>(null);
  const [previewSourceKey] = useState(
    () => `attachment-preview-${Math.random().toString(36).slice(2, 10)}`,
  );
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatchEndEvent = useCallback(() => {
    const detail: AttachmentPreviewEndDetail = {
      sourceKey: previewSourceKey,
    };
    window.dispatchEvent(new CustomEvent(ATTACHMENT_PREVIEW_END_EVENT, { detail }));
  }, [previewSourceKey]);

  const handleMouseEnter = useCallback(() => {
    if (!attrs.id) return;
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    previewTimeoutRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const detail: AttachmentPreviewDetail = {
        sourceKey: previewSourceKey,
        attachmentId: attrs.id,
        kind: attrs.kind,
        label: attrs.label,
        mimeType: attrs.mimeType ?? null,
        size: attrs.size ?? null,
        chipRect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
      };
      window.dispatchEvent(
        new CustomEvent(ATTACHMENT_PREVIEW_START_EVENT, { detail }),
      );
    }, ATTACHMENT_PREVIEW_DELAY_MS);
  }, [attrs.id, attrs.kind, attrs.label, attrs.mimeType, attrs.size, previewSourceKey]);

  const handleMouseLeave = useCallback(() => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    dispatchEndEvent();
  }, [dispatchEndEvent]);

  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) {
        clearTimeout(previewTimeoutRef.current);
      }
      dispatchEndEvent();
    };
  }, [dispatchEndEvent]);

  return {
    wrapperRef,
    previewSourceKey,
    handleMouseEnter,
    handleMouseLeave,
  };
}
