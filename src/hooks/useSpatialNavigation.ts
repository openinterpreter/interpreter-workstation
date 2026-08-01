import { useCallback, useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

function getRect(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
    centerX: r.left + r.width / 2,
    centerY: r.top + r.height / 2,
  };
}

function findClosest(
  current: Rect,
  candidates: { el: HTMLElement; rect: Rect }[],
  direction: 'up' | 'down' | 'left' | 'right'
): HTMLElement | null {
  let best: { el: HTMLElement; distance: number } | null = null;

  for (const { el, rect } of candidates) {
    let isInDirection = false;
    let distance = Infinity;

    // Use center points for more intuitive navigation
    const currentCenter = { x: current.centerX, y: current.centerY };
    const candidateCenter = { x: rect.centerX, y: rect.centerY };

    switch (direction) {
      case 'right':
        // Element's center must be to the right of current center
        if (candidateCenter.x > currentCenter.x + 10) {
          isInDirection = true;
          const horizontalDist = candidateCenter.x - currentCenter.x;
          const verticalDist = Math.abs(candidateCenter.y - currentCenter.y);
          // Heavily prefer elements on same horizontal level
          distance = horizontalDist + verticalDist * 3;
        }
        break;

      case 'left':
        if (candidateCenter.x < currentCenter.x - 10) {
          isInDirection = true;
          const horizontalDist = currentCenter.x - candidateCenter.x;
          const verticalDist = Math.abs(candidateCenter.y - currentCenter.y);
          distance = horizontalDist + verticalDist * 3;
        }
        break;

      case 'down':
        // Element's center must be below current center
        if (candidateCenter.y > currentCenter.y + 10) {
          isInDirection = true;
          const verticalDist = candidateCenter.y - currentCenter.y;
          const horizontalDist = Math.abs(candidateCenter.x - currentCenter.x);
          // For down navigation, be more lenient with horizontal distance
          // This helps navigate from wide inputs to narrower buttons
          distance = verticalDist + horizontalDist * 0.5;
        }
        break;

      case 'up':
        if (candidateCenter.y < currentCenter.y - 10) {
          isInDirection = true;
          const verticalDist = currentCenter.y - candidateCenter.y;
          const horizontalDist = Math.abs(candidateCenter.x - currentCenter.x);
          distance = verticalDist + horizontalDist * 0.5;
        }
        break;
    }

    if (isInDirection && (!best || distance < best.distance)) {
      best = { el, distance };
    }
  }

  return best?.el || null;
}

interface UseSpatialNavigationOptions {
  /**
   * Whether spatial navigation is enabled
   */
  enabled?: boolean;
  /**
   * Callback when focus moves
   */
  onFocusChange?: (element: HTMLElement) => void;
}

/**
 * Hook for spatial keyboard navigation based on visual element positions.
 * Arrow keys navigate to the closest focusable element in that direction.
 */
export function useSpatialNavigation(options: UseSpatialNavigationOptions = {}) {
  const { enabled = true, onFocusChange } = options;
  const containerRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;

    const direction = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    }[e.key] as 'up' | 'down' | 'left' | 'right' | undefined;

    if (!direction) return;

    const container = containerRef.current;
    if (!container) return;

    const activeEl = document.activeElement as HTMLElement;
    if (!activeEl || !container.contains(activeEl)) return;

    // Handle inputs - don't interfere with left/right cursor movement
    const isInput = activeEl.tagName === 'INPUT';
    if (isInput && (direction === 'left' || direction === 'right')) return;

    // Handle textareas - only navigate out when cursor is at boundaries
    const isTextarea = activeEl.tagName === 'TEXTAREA';
    if (isTextarea) {
      const textarea = activeEl as HTMLTextAreaElement;
      const { selectionStart, selectionEnd, value } = textarea;

      // Left/right: don't interfere
      if (direction === 'left' || direction === 'right') return;

      // Up: only navigate out if cursor is on first line
      if (direction === 'up') {
        const textBeforeCursor = value.substring(0, selectionStart);
        const isFirstLine = !textBeforeCursor.includes('\n');
        if (!isFirstLine) return;
      }

      // Down: only navigate out if cursor is on last line
      if (direction === 'down') {
        const textAfterCursor = value.substring(selectionEnd);
        const isLastLine = !textAfterCursor.includes('\n');
        if (!isLastLine) return;
      }
    }

    // Get all focusable elements
    const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter(el => {
        // Must be visible
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        // Must have size
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return true;
      });

    if (focusables.length === 0) return;

    const currentRect = getRect(activeEl);
    const candidates = focusables
      .filter(el => el !== activeEl)
      .map(el => ({ el, rect: getRect(el) }));

    const next = findClosest(currentRect, candidates, direction);

    if (next) {
      e.preventDefault();
      next.focus();
      onFocusChange?.(next);
    }
  }, [enabled, onFocusChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown, enabled]);

  return { containerRef };
}
