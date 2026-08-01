/**
 * GhostElement - Shared animation component for flying elements
 *
 * Used for animating UI elements from one position to another,
 * like prompts flying to the composer or buttons flying to their final location.
 */

import { useState, useEffect, type ReactNode, type CSSProperties } from 'react';

export interface GhostElementProps {
  /** Starting position and size */
  startRect: DOMRect;
  /** Target X coordinate */
  endX: number;
  /** Target Y coordinate */
  endY: number;
  /** Content to render inside the ghost */
  children: ReactNode;
  /** Called when animation completes */
  onComplete: () => void;
  /** Animation duration in ms (default: 400) */
  duration?: number;
  /** Scale at end of animation (default: 0.5) */
  endScale?: number;
  /** Opacity at end of animation (default: 0) */
  endOpacity?: number;
  /** Starting opacity (default: 0.4) */
  startOpacity?: number;
  /** Additional className for the container */
  className?: string;
  /** Additional inline styles */
  style?: CSSProperties;
}

export function GhostElement({
  startRect,
  endX,
  endY,
  children,
  onComplete,
  duration = 400,
  endScale = 0.5,
  endOpacity = 0,
  startOpacity = 0.4,
  className = '',
  style,
}: GhostElementProps) {
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    // Start animation on next frame
    requestAnimationFrame(() => {
      setAnimating(true);
    });

    // Complete after animation
    const timer = setTimeout(onComplete, duration);
    return () => clearTimeout(timer);
  }, [onComplete, duration]);

  return (
    <div
      className={`fixed pointer-events-none z-[9999] ${className}`}
      style={{
        ...style,
        left: startRect.left,
        top: startRect.top,
        width: startRect.width,
        height: startRect.height,
        transform: animating
          ? `translate(${endX - startRect.left}px, ${endY - startRect.top}px) scale(${endScale})`
          : 'translate(0, 0) scale(1)',
        opacity: animating ? endOpacity : startOpacity,
        transition: `transform ${duration}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      }}
    >
      {children}
    </div>
  );
}
