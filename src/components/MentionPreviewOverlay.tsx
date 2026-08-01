import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MENTION_PREVIEW_END_EVENT,
  MENTION_PREVIEW_START_EVENT,
  type MentionPreviewDetail,
} from '../../shared/types/mentionPreview';
import {
  fetchMentionPreviewThumbnails,
  FILE_MENTION_PREVIEW_HEIGHT,
  FILE_MENTION_PREVIEW_WIDTH,
} from '../utils/mentionPreviewThumbnails';

const EDGE_PADDING = 10;
const VERTICAL_OFFSET = 8;
const HORIZONTAL_OFFSET = 8;
const SKILL_PREVIEW_WIDTH = 260;
const SKILL_PREVIEW_ESTIMATED_HEIGHT = 68;

type PreviewSide = 'top' | 'bottom' | 'left' | 'right';
type AnimationDirection = 'from-top' | 'from-bottom' | 'from-left' | 'from-right';

interface PreviewPosition {
  left: number;
  top: number;
  side: PreviewSide;
  animationDirection: AnimationDirection;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function computeOverflow(left: number, top: number, width: number, height: number): number {
  const right = left + width;
  const bottom = top + height;
  const overflowLeft = Math.max(0, EDGE_PADDING - left);
  const overflowTop = Math.max(0, EDGE_PADDING - top);
  const overflowRight = Math.max(0, right - (window.innerWidth - EDGE_PADDING));
  const overflowBottom = Math.max(0, bottom - (window.innerHeight - EDGE_PADDING));
  return overflowLeft + overflowTop + overflowRight + overflowBottom;
}

function animationDirectionFromCenters(
  mentionRect: MentionPreviewDetail['mentionRect'],
  left: number,
  top: number,
  width: number,
  height: number,
): AnimationDirection {
  const mentionCenterX = mentionRect.left + mentionRect.width / 2;
  const mentionCenterY = mentionRect.top + mentionRect.height / 2;
  const popoverCenterX = left + width / 2;
  const popoverCenterY = top + height / 2;
  const dx = popoverCenterX - mentionCenterX;
  const dy = popoverCenterY - mentionCenterY;

  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? 'from-left' : 'from-right';
  }
  return dy >= 0 ? 'from-top' : 'from-bottom';
}

function computePopoverPosition(
  mentionRect: MentionPreviewDetail['mentionRect'],
  width: number,
  height: number,
): PreviewPosition {
  const mentionBottom = mentionRect.top + mentionRect.height;
  const mentionCenterX = mentionRect.left + mentionRect.width / 2;
  const mentionCenterY = mentionRect.top + mentionRect.height / 2;

  const candidates: Array<{ side: PreviewSide; left: number; top: number }> = [
    {
      side: 'bottom',
      left: mentionCenterX - width / 2,
      top: mentionBottom + VERTICAL_OFFSET,
    },
    {
      side: 'top',
      left: mentionCenterX - width / 2,
      top: mentionRect.top - height - VERTICAL_OFFSET,
    },
    {
      side: 'right',
      left: mentionRect.left + mentionRect.width + HORIZONTAL_OFFSET,
      top: mentionCenterY - height / 2,
    },
    {
      side: 'left',
      left: mentionRect.left - width - HORIZONTAL_OFFSET,
      top: mentionCenterY - height / 2,
    },
  ];

  let best = candidates[0];
  let bestOverflow = computeOverflow(best.left, best.top, width, height);
  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const overflow = computeOverflow(candidate.left, candidate.top, width, height);
    if (overflow < bestOverflow) {
      best = candidate;
      bestOverflow = overflow;
    }
  }

  const clampedLeft = clamp(best.left, EDGE_PADDING, Math.max(EDGE_PADDING, window.innerWidth - width - EDGE_PADDING));
  const clampedTop = clamp(best.top, EDGE_PADDING, Math.max(EDGE_PADDING, window.innerHeight - height - EDGE_PADDING));
  const animationDirection = animationDirectionFromCenters(mentionRect, clampedLeft, clampedTop, width, height);

  return {
    left: clampedLeft,
    top: clampedTop,
    side: best.side,
    animationDirection,
  };
}

export function MentionPreviewOverlay() {
  const [preview, setPreview] = useState<MentionPreviewDetail | null>(null);
  const [position, setPosition] = useState<PreviewPosition>({
    left: 0,
    top: 0,
    side: 'bottom',
    animationDirection: 'from-top',
  });
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbnailLoading, setThumbnailLoading] = useState(false);
  const [isEntered, setIsEntered] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  const handlePreviewStart = useCallback((event: Event) => {
    const detail = (event as CustomEvent<MentionPreviewDetail>).detail;
    if (!detail?.mentionRect) return;
    if (detail.type !== 'skill' && detail.type !== 'file') return;

    setPreview(detail);
    setThumbnailUrl(null);
    setThumbnailLoading(detail.type === 'file');

    const width = detail.type === 'skill' ? SKILL_PREVIEW_WIDTH : FILE_MENTION_PREVIEW_WIDTH;
    const height = detail.type === 'skill' ? SKILL_PREVIEW_ESTIMATED_HEIGHT : FILE_MENTION_PREVIEW_HEIGHT;
    setPosition(computePopoverPosition(detail.mentionRect, width, height));
  }, []);

  const handlePreviewEnd = useCallback(() => {
    setPreview(null);
    setThumbnailUrl(null);
    setThumbnailLoading(false);
  }, []);

  useEffect(() => {
    window.addEventListener(MENTION_PREVIEW_START_EVENT, handlePreviewStart);
    window.addEventListener(MENTION_PREVIEW_END_EVENT, handlePreviewEnd);
    window.addEventListener('scroll', handlePreviewEnd, true);
    window.addEventListener('resize', handlePreviewEnd);

    return () => {
      window.removeEventListener(MENTION_PREVIEW_START_EVENT, handlePreviewStart);
      window.removeEventListener(MENTION_PREVIEW_END_EVENT, handlePreviewEnd);
      window.removeEventListener('scroll', handlePreviewEnd, true);
      window.removeEventListener('resize', handlePreviewEnd);
    };
  }, [handlePreviewStart, handlePreviewEnd]);

  useLayoutEffect(() => {
    if (!preview || !previewRef.current) return;
    const rect = previewRef.current.getBoundingClientRect();
    setPosition(computePopoverPosition(preview.mentionRect, rect.width, rect.height));
  }, [preview, thumbnailLoading, thumbnailUrl]);

  useEffect(() => {
    if (!preview?.sourceKey) return;

    let frame = 0;
    const checkSourcePresence = () => {
      const source = document.querySelector(`[data-mention-preview-key="${preview.sourceKey}"]`);
      if (!source) {
        handlePreviewEnd();
        return;
      }
      frame = requestAnimationFrame(checkSourcePresence);
    };

    frame = requestAnimationFrame(checkSourcePresence);
    return () => cancelAnimationFrame(frame);
  }, [preview, handlePreviewEnd]);

  useEffect(() => {
    if (!preview) {
      setIsEntered(false);
      return;
    }
    setIsEntered(false);
    const frame = requestAnimationFrame(() => {
      setIsEntered(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [preview, position.animationDirection]);

  useEffect(() => {
    if (!preview || preview.type !== 'file' || !preview.path) return;

    let cancelled = false;
    setThumbnailLoading(true);

    fetchMentionPreviewThumbnails([preview.path]).then((thumbnails) => {
      if (cancelled) return;
      setThumbnailUrl(thumbnails[preview.path as string] ?? null);
    }).catch(() => {
      if (!cancelled) setThumbnailUrl(null);
    }).finally(() => {
      if (!cancelled) setThumbnailLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [preview]);

  if (!preview) return null;
  if (preview.type === 'file' && !thumbnailLoading && !thumbnailUrl) return null;
  if (preview.type === 'skill' && !String(preview.description || '').trim()) return null;

  const initialTransform = (() => {
    switch (position.animationDirection) {
      case 'from-left':
        return 'translate3d(-4px, 0, 0) scale(0.985)';
      case 'from-right':
        return 'translate3d(4px, 0, 0) scale(0.985)';
      case 'from-bottom':
        return 'translate3d(0, 4px, 0) scale(0.985)';
      case 'from-top':
      default:
        return 'translate3d(0, -4px, 0) scale(0.985)';
    }
  })();

  return (
    <div
      ref={previewRef}
      className="fixed z-[10000] pointer-events-none overflow-hidden rounded-[14px]"
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
        backgroundColor: 'color-mix(in srgb, var(--oa-surface-center, var(--popover)) 94%, transparent)',
        color: 'var(--oa-text, var(--popover-foreground))',
        border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 82%, transparent)',
        boxShadow: 'var(--oa-shadow-md)',
        backdropFilter: 'blur(14px)',
        opacity: isEntered ? 1 : 0,
        transform: isEntered ? 'translate3d(0, 0, 0) scale(1)' : initialTransform,
        transition: 'opacity 120ms ease-out, transform 120ms ease-out',
        willChange: 'opacity, transform',
      }}
    >
      {preview.type === 'skill' ? (
        <div className="max-w-[260px] px-3 py-2.5 text-ui-sm leading-5 whitespace-pre-wrap text-[var(--oa-text)]">
          {preview.description}
        </div>
      ) : (
        <div
          className="flex items-center justify-center"
          style={{
            width: `${FILE_MENTION_PREVIEW_WIDTH}px`,
            height: `${FILE_MENTION_PREVIEW_HEIGHT}px`,
            background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 74%, transparent)',
          }}
        >
          {thumbnailLoading ? (
            <span className="text-ui-xs text-[var(--oa-text-muted)]">Loading...</span>
          ) : (
            <img
              src={thumbnailUrl || undefined}
              alt=""
              className="h-full w-full object-cover object-top"
            />
          )}
        </div>
      )}
    </div>
  );
}
