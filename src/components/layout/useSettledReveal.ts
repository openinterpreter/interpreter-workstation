import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const DEFAULT_QUIET_MS = 72;
const RECT_DELTA_PX = 0.5;

interface UseSettledRevealOptions {
  enabled: boolean;
  targetRef: React.RefObject<HTMLElement | null>;
  quietMs?: number;
  blockersReady?: boolean;
}

function hasRenderableRect(rect: DOMRect | null): rect is DOMRect {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function rectMoved(first: DOMRect, second: DOMRect): boolean {
  return (
    Math.abs(first.top - second.top) > RECT_DELTA_PX
    || Math.abs(first.left - second.left) > RECT_DELTA_PX
    || Math.abs(first.width - second.width) > RECT_DELTA_PX
    || Math.abs(first.height - second.height) > RECT_DELTA_PX
  );
}

export function useSettledReveal({
  enabled,
  targetRef,
  quietMs = DEFAULT_QUIET_MS,
  blockersReady = true,
}: UseSettledRevealOptions): boolean {
  "use no memo";

  const [isReady, setIsReady] = useState(!enabled);
  const [isTracking, setIsTracking] = useState(enabled);
  const timeoutRef = useRef<number | null>(null);
  const firstRafRef = useRef<number | null>(null);
  const secondRafRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const previousEnabledRef = useRef(false);
  const previousBlockersReadyRef = useRef(blockersReady);
  const trackingRef = useRef(enabled);

  useEffect(() => {
    trackingRef.current = isTracking;
  }, [isTracking]);

  const cancelPending = useCallback(() => {
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (firstRafRef.current != null) {
      window.cancelAnimationFrame(firstRafRef.current);
      firstRafRef.current = null;
    }
    if (secondRafRef.current != null) {
      window.cancelAnimationFrame(secondRafRef.current);
      secondRafRef.current = null;
    }
  }, []);

  const scheduleReveal = useCallback(() => {
    if (!enabled || !blockersReady || !trackingRef.current) return;

    cancelPending();
    const generation = ++generationRef.current;

    timeoutRef.current = window.setTimeout(() => {
      const target = targetRef.current;
      if (!enabled || !blockersReady || !trackingRef.current || generationRef.current !== generation || !target) {
        return;
      }

      const firstRect = target.getBoundingClientRect();
      if (!hasRenderableRect(firstRect)) {
        scheduleReveal();
        return;
      }

      firstRafRef.current = window.requestAnimationFrame(() => {
        secondRafRef.current = window.requestAnimationFrame(() => {
          const latestTarget = targetRef.current;
          if (!enabled || !blockersReady || !trackingRef.current || generationRef.current !== generation || !latestTarget) {
            return;
          }

          const latestRect = latestTarget.getBoundingClientRect();
          if (!hasRenderableRect(latestRect) || rectMoved(firstRect, latestRect)) {
            scheduleReveal();
            return;
          }

          setIsReady(true);
          setIsTracking(false);
        });
      });
    }, quietMs);
  }, [blockersReady, cancelPending, enabled, quietMs, targetRef]);

  useLayoutEffect(() => {
    const wasEnabled = previousEnabledRef.current;
    previousEnabledRef.current = enabled;
    const wereBlockersReady = previousBlockersReadyRef.current;
    previousBlockersReadyRef.current = blockersReady;

    if (!enabled) {
      generationRef.current += 1;
      cancelPending();
      setIsReady(true);
      setIsTracking(false);
      return;
    }

    if (!blockersReady) {
      generationRef.current += 1;
      cancelPending();
      setIsReady(false);
      setIsTracking(true);
      return;
    }

    if (!wasEnabled || !wereBlockersReady) {
      setIsReady(false);
      setIsTracking(true);
    }
  }, [blockersReady, cancelPending, enabled]);

  useEffect(() => {
    if (!enabled || !blockersReady || !isTracking) return;

    const target = targetRef.current;

    const handleChange = () => {
      if (!trackingRef.current) return;
      scheduleReveal();
    };

    const handleResizeStart = () => {
      if (!trackingRef.current) return;
      generationRef.current += 1;
      cancelPending();
      setIsReady(false);
    };

    const observer = target ? new ResizeObserver(handleChange) : null;
    if (observer && target) {
      observer.observe(target);
    }

    window.addEventListener('layout:resize-start', handleResizeStart);
    window.addEventListener('layout:resize-end', handleChange);
    window.addEventListener('layout:sidebar-settled', handleChange);

    scheduleReveal();

    return () => {
      generationRef.current += 1;
      cancelPending();
      observer?.disconnect();
      window.removeEventListener('layout:resize-start', handleResizeStart);
      window.removeEventListener('layout:resize-end', handleChange);
      window.removeEventListener('layout:sidebar-settled', handleChange);
    };
  }, [blockersReady, cancelPending, enabled, isTracking, scheduleReveal, targetRef]);

  return isReady;
}
