/**
 * AttachmentPreviewPopover
 *
 * Floating preview that shows when the user hovers an attachment chip. For
 * text attachments it renders the full text in a <pre>; for image attachments
 * it renders the full image from the store's dataUrl.
 *
 * The popover is host-mounted: the composer (main or overlay) renders it once
 * and it listens globally for attachment:preview-start / -end events.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerAttachmentRecord } from './types';
import {
  ATTACHMENT_PREVIEW_END_EVENT,
  ATTACHMENT_PREVIEW_START_EVENT,
  type AttachmentPreviewDetail,
  type AttachmentPreviewEndDetail,
} from './attachmentPreviewEvents';
import {
  clearAttachmentPreview,
  createAttachmentPreviewHoverState,
  endAttachmentPreviewFromSource,
  enterAttachmentPreviewPopover,
  leaveAttachmentPreviewPopover,
  shouldDismissAttachmentPreview,
  startAttachmentPreview,
} from './attachmentPreviewState';

interface AttachmentPreviewPopoverProps {
  resolveRecord: (attachmentId: string) => ComposerAttachmentRecord | undefined;
  truncateText?: boolean;
}

const MAX_PREVIEW_WIDTH = 520;
const MAX_PREVIEW_HEIGHT = 360;
const GAP = 8;
const DISMISS_GRACE_MS = 120;

export function AttachmentPreviewPopover({
  resolveRecord,
  truncateText = false,
}: AttachmentPreviewPopoverProps) {
  const [detail, setDetail] = useState<AttachmentPreviewDetail | null>(null);
  const hoverStateRef = useRef(createAttachmentPreviewHoverState());
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const syncDetail = useCallback((nextDetail: AttachmentPreviewDetail | null) => {
    setDetail(nextDetail);
  }, []);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const dismissPreview = useCallback(() => {
    clearDismissTimer();
    hoverStateRef.current = clearAttachmentPreview();
    syncDetail(null);
  }, [clearDismissTimer, syncDetail]);

  const scheduleDismiss = useCallback(() => {
    clearDismissTimer();
    dismissTimerRef.current = setTimeout(() => {
      if (shouldDismissAttachmentPreview(hoverStateRef.current)) {
        dismissPreview();
      }
    }, DISMISS_GRACE_MS);
  }, [clearDismissTimer, dismissPreview]);

  const handleWindowScroll = useCallback((event: Event) => {
    const target = event.target;
    const previewNode = previewRef.current;
    if (previewNode && target instanceof Node && previewNode.contains(target)) {
      return;
    }
    dismissPreview();
  }, [dismissPreview]);

  useEffect(() => {
    const onStart = (event: Event) => {
      const custom = event as CustomEvent<AttachmentPreviewDetail>;
      if (!custom.detail) return;
      if (!resolveRecord(custom.detail.attachmentId)) return;
      clearDismissTimer();
      hoverStateRef.current = startAttachmentPreview(
        hoverStateRef.current,
        custom.detail,
      );
      syncDetail(custom.detail);
    };
    const onEnd = (event: Event) => {
      const custom = event as CustomEvent<AttachmentPreviewEndDetail | undefined>;
      hoverStateRef.current = endAttachmentPreviewFromSource(
        hoverStateRef.current,
        custom.detail?.sourceKey,
      );
      if (shouldDismissAttachmentPreview(hoverStateRef.current)) {
        scheduleDismiss();
      }
    };
    window.addEventListener(ATTACHMENT_PREVIEW_START_EVENT, onStart as EventListener);
    window.addEventListener(ATTACHMENT_PREVIEW_END_EVENT, onEnd as EventListener);
    window.addEventListener('scroll', handleWindowScroll, true);
    window.addEventListener('resize', dismissPreview);
    return () => {
      window.removeEventListener(ATTACHMENT_PREVIEW_START_EVENT, onStart as EventListener);
      window.removeEventListener(ATTACHMENT_PREVIEW_END_EVENT, onEnd as EventListener);
      window.removeEventListener('scroll', handleWindowScroll, true);
      window.removeEventListener('resize', dismissPreview);
    };
  }, [clearDismissTimer, dismissPreview, handleWindowScroll, resolveRecord, scheduleDismiss, syncDetail]);

  useEffect(() => {
    return () => {
      clearDismissTimer();
    };
  }, [clearDismissTimer]);

  useEffect(() => {
    if (!detail?.sourceKey) return;
    let frame = 0;
    const checkSourcePresence = () => {
      const source = document.querySelector(
        `[data-attachment-preview-key="${detail.sourceKey}"]`,
      );
      if (!source) {
        dismissPreview();
        return;
      }
      frame = requestAnimationFrame(checkSourcePresence);
    };

    frame = requestAnimationFrame(checkSourcePresence);
    return () => cancelAnimationFrame(frame);
  }, [detail, dismissPreview]);

  const record = useMemo(
    () => (detail ? resolveRecord(detail.attachmentId) : undefined),
    [detail, resolveRecord],
  );

  const handleMouseEnter = () => {
    clearDismissTimer();
    hoverStateRef.current = enterAttachmentPreviewPopover(hoverStateRef.current);
  };

  const handleMouseLeave = () => {
    hoverStateRef.current = leaveAttachmentPreviewPopover(hoverStateRef.current);
    if (shouldDismissAttachmentPreview(hoverStateRef.current)) {
      scheduleDismiss();
    }
  };

  if (!detail || !record) return null;

  // Position above the chip, left-aligned with it, clamped to viewport.
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 1080;

  let left = detail.chipRect.left;
  let top = detail.chipRect.top - GAP;
  // flip below the chip if not enough room above
  const placeAbove = detail.chipRect.top >= MAX_PREVIEW_HEIGHT + GAP;
  if (!placeAbove) {
    top = detail.chipRect.top + detail.chipRect.height + GAP;
  }
  // clamp horizontally
  left = Math.max(8, Math.min(left, viewportW - MAX_PREVIEW_WIDTH - 8));
  // clamp vertically
  top = Math.max(8, Math.min(top, viewportH - MAX_PREVIEW_HEIGHT - 8));

  const hasImage = typeof record.dataUrl === 'string' && record.dataUrl.length > 0;
  const hasText = typeof record.text === 'string' && record.text.trim().length > 0;

  return (
    <div
      ref={previewRef}
      className="composer-attachment-preview"
      style={{
        position: 'fixed',
        top: placeAbove ? undefined : top,
        bottom: placeAbove ? viewportH - detail.chipRect.top + GAP : undefined,
        left,
        maxWidth: MAX_PREVIEW_WIDTH,
        maxHeight: MAX_PREVIEW_HEIGHT,
        zIndex: 10000,
        pointerEvents: 'auto',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="tooltip"
      aria-label={`Attachment preview: ${record.label}`}
    >
      <div className="composer-attachment-preview__header">
        <span className="composer-attachment-preview__title">{record.label}</span>
        {record.size != null && (
          <span className="composer-attachment-preview__meta">
            {formatSize(record.size)}
          </span>
        )}
      </div>
      <div className="composer-attachment-preview__body">
        {hasImage ? (
          <img
            src={record.dataUrl}
            alt={record.label}
            style={{
              maxWidth: MAX_PREVIEW_WIDTH - 24,
              maxHeight: MAX_PREVIEW_HEIGHT - 64,
              display: 'block',
            }}
          />
        ) : null}
        {hasText ? (
          <pre className="composer-attachment-preview__text">
            {truncateText ? truncateForPreview(record.text ?? '') : record.text}
          </pre>
        ) : null}
        {!hasImage && !hasText ? (
          <pre className="composer-attachment-preview__text">Preview unavailable.</pre>
        ) : null}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateForPreview(text: string): string {
  const MAX_LINES = 24;
  const MAX_CHARS = 2000;
  const lines = text.split('\n');
  let truncated = lines.slice(0, MAX_LINES).join('\n');
  if (lines.length > MAX_LINES) {
    truncated += `\n… (${lines.length - MAX_LINES} more lines)`;
  }
  if (truncated.length > MAX_CHARS) {
    truncated = `${truncated.slice(0, MAX_CHARS)}…`;
  }
  return truncated;
}
