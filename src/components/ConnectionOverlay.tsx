/**
 * ConnectionOverlay Component
 *
 * Portal-based SVG overlay that renders delayed connection lines between
 * file mention chips and their open tab headers.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLayout } from '../hooks/useLayout';
import { findTabByPath } from '../utils/layoutHelpers';

interface MentionHoverState {
  path: string;
  fragment?: string;
  lineStart?: number;
  lineEnd?: number;
  mentionRect: { top: number; left: number; width: number; height: number };
}

interface RectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Point {
  x: number;
  y: number;
}

const CONNECTION_COLORS = ['#0000FF', '#FFA500', '#00FF00', '#FF1493', '#FFFF00'];
const CONNECTION_HOVER_DELAY_MS = 2000;
const CONNECTION_PAD_PX = 12;
const CONNECTION_RADIUS_PX = 12;
const CONNECTION_LINE_OPACITY = 0.4;
const CONNECTION_BOX_OPACITY = 0.58;
const CONNECTION_LINE_WIDTH = 1.25;
const CONNECTION_BOX_WIDTH = 1.5;
const CONNECTION_Z_INDEX = 9990;

function filePathToColor(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  }
  return CONNECTION_COLORS[Math.abs(hash) % CONNECTION_COLORS.length];
}

function toRectBounds(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): RectBounds {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  };
}

function expandRect(rect: RectBounds, padding: number): RectBounds {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rectMidX(rect: RectBounds): number {
  return (rect.left + rect.right) / 2;
}

function rectMidY(rect: RectBounds): number {
  return (rect.top + rect.bottom) / 2;
}

function getClosestPointsBetweenRects(source: RectBounds, target: RectBounds): { start: Point; end: Point } {
  if (source.right < target.left) {
    if (source.bottom < target.top) {
      return {
        start: { x: source.right, y: source.bottom },
        end: { x: target.left, y: target.top },
      };
    }
    if (target.bottom < source.top) {
      return {
        start: { x: source.right, y: source.top },
        end: { x: target.left, y: target.bottom },
      };
    }

    const overlapTop = Math.max(source.top, target.top);
    const overlapBottom = Math.min(source.bottom, target.bottom);
    const y = (overlapTop + overlapBottom) / 2;
    return {
      start: { x: source.right, y },
      end: { x: target.left, y },
    };
  }

  if (target.right < source.left) {
    if (source.bottom < target.top) {
      return {
        start: { x: source.left, y: source.bottom },
        end: { x: target.right, y: target.top },
      };
    }
    if (target.bottom < source.top) {
      return {
        start: { x: source.left, y: source.top },
        end: { x: target.right, y: target.bottom },
      };
    }

    const overlapTop = Math.max(source.top, target.top);
    const overlapBottom = Math.min(source.bottom, target.bottom);
    const y = (overlapTop + overlapBottom) / 2;
    return {
      start: { x: source.left, y },
      end: { x: target.right, y },
    };
  }

  if (source.bottom < target.top) {
    const overlapLeft = Math.max(source.left, target.left);
    const overlapRight = Math.min(source.right, target.right);
    const x = (overlapLeft + overlapRight) / 2;
    return {
      start: { x, y: source.bottom },
      end: { x, y: target.top },
    };
  }

  if (target.bottom < source.top) {
    const overlapLeft = Math.max(source.left, target.left);
    const overlapRight = Math.min(source.right, target.right);
    const x = (overlapLeft + overlapRight) / 2;
    return {
      start: { x, y: source.top },
      end: { x, y: target.bottom },
    };
  }

  const sourceCenter = { x: rectMidX(source), y: rectMidY(source) };
  const targetCenter = { x: rectMidX(target), y: rectMidY(target) };
  const useHorizontal = Math.abs(targetCenter.x - sourceCenter.x) >= Math.abs(targetCenter.y - sourceCenter.y);

  if (useHorizontal) {
    const sourceX = targetCenter.x >= sourceCenter.x ? source.right : source.left;
    const targetX = targetCenter.x >= sourceCenter.x ? target.left : target.right;
    const y = clamp((sourceCenter.y + targetCenter.y) / 2, Math.max(source.top, target.top), Math.min(source.bottom, target.bottom));
    return {
      start: { x: sourceX, y },
      end: { x: targetX, y },
    };
  }

  const sourceY = targetCenter.y >= sourceCenter.y ? source.bottom : source.top;
  const targetY = targetCenter.y >= sourceCenter.y ? target.top : target.bottom;
  const x = clamp((sourceCenter.x + targetCenter.x) / 2, Math.max(source.left, target.left), Math.min(source.right, target.right));
  return {
    start: { x, y: sourceY },
    end: { x, y: targetY },
  };
}

function findTabElement(tabId: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('[data-tab-id]');
  for (const element of candidates) {
    if (element.dataset.tabId === tabId) {
      return element;
    }
  }
  return null;
}

export function ConnectionOverlay() {
  const [hoverState, setHoverState] = useState<MentionHoverState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { state } = useLayout();

  const clearHoverTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleHoverStart = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail as MentionHoverState;
    clearHoverTimer();
    setHoverState(null);
    timerRef.current = setTimeout(() => {
      setHoverState(detail);
      timerRef.current = null;
    }, CONNECTION_HOVER_DELAY_MS);
  }, [clearHoverTimer]);

  const handleHoverEnd = useCallback(() => {
    clearHoverTimer();
    setHoverState(null);
  }, [clearHoverTimer]);

  useEffect(() => {
    window.addEventListener('mention:hover-start', handleHoverStart);
    window.addEventListener('mention:hover-end', handleHoverEnd);
    return () => {
      clearHoverTimer();
      window.removeEventListener('mention:hover-start', handleHoverStart);
      window.removeEventListener('mention:hover-end', handleHoverEnd);
    };
  }, [clearHoverTimer, handleHoverEnd, handleHoverStart]);

  if (!hoverState) return null;

  const targetTab = findTabByPath(state.tabs, hoverState.path);
  if (!targetTab) return null;

  const targetTabElement = findTabElement(targetTab.id);
  if (!targetTabElement) return null;

  const targetTabRect = targetTabElement.getBoundingClientRect();
  const sourceRect = expandRect(toRectBounds(hoverState.mentionRect), CONNECTION_PAD_PX);
  const targetRect = expandRect(toRectBounds(targetTabRect), CONNECTION_PAD_PX);
  const { start, end } = getClosestPointsBetweenRects(sourceRect, targetRect);
  const connectionColor = filePathToColor(hoverState.path);

  return createPortal(
    <svg
      className="fixed inset-0 h-full w-full pointer-events-none"
      style={{ zIndex: CONNECTION_Z_INDEX }}
    >
      <rect
        x={sourceRect.left}
        y={sourceRect.top}
        width={sourceRect.right - sourceRect.left}
        height={sourceRect.bottom - sourceRect.top}
        rx={CONNECTION_RADIUS_PX}
        ry={CONNECTION_RADIUS_PX}
        fill="none"
        stroke={connectionColor}
        strokeOpacity={CONNECTION_BOX_OPACITY}
        strokeWidth={CONNECTION_BOX_WIDTH}
      />

      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke={connectionColor}
        strokeOpacity={CONNECTION_LINE_OPACITY}
        strokeWidth={CONNECTION_LINE_WIDTH}
        strokeLinecap="round"
      />

      <rect
        x={targetRect.left}
        y={targetRect.top}
        width={targetRect.right - targetRect.left}
        height={targetRect.bottom - targetRect.top}
        rx={CONNECTION_RADIUS_PX}
        ry={CONNECTION_RADIUS_PX}
        fill="none"
        stroke={connectionColor}
        strokeOpacity={CONNECTION_BOX_OPACITY}
        strokeWidth={CONNECTION_BOX_WIDTH}
      />
    </svg>,
    document.body,
  );
}
