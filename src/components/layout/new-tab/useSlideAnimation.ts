import { useState, useCallback } from 'react';

// Animation direction types
export type AnimDirection = 'deeper' | 'back' | 'up' | 'down';

// Reusable hook for spatial slide animations
// Handles exit/enter animations with proper direction for tree navigation
export function useSlideAnimation() {
  const [animPhase, setAnimPhase] = useState<'idle' | 'exiting' | 'entering'>('idle');
  const [animDirection, setAnimDirection] = useState<AnimDirection>('deeper');
  // Track if an animation has been triggered - distinguishes "idle on mount" from "idle after animation"
  const [hasAnimated, setHasAnimated] = useState(false);

  // Get animation classes based on phase and direction
  const getAnimClass = useCallback(() => {
    if (animPhase === 'idle') return '';

    // Horizontal animations (deeper/back)
    if (animDirection === 'deeper' || animDirection === 'back') {
      if (animPhase === 'exiting') {
        // Exiting: going deeper = exit left, going back = exit right
        return animDirection === 'deeper' ? 'opacity-0 -translate-x-4' : 'opacity-0 translate-x-4';
      }
      if (animPhase === 'entering') {
        // Entering: going deeper = enter from right, going back = enter from left
        return animDirection === 'deeper' ? 'opacity-0 translate-x-4' : 'opacity-0 -translate-x-4';
      }
    }

    // Vertical animations (up/down)
    if (animDirection === 'up' || animDirection === 'down') {
      if (animPhase === 'exiting') {
        // Exiting: going up = exit upward, going down = exit downward
        return animDirection === 'up' ? 'opacity-0 -translate-y-4' : 'opacity-0 translate-y-4';
      }
      if (animPhase === 'entering') {
        // Entering: going up = enter from below, going down = enter from above
        return animDirection === 'up' ? 'opacity-0 translate-y-4' : 'opacity-0 -translate-y-4';
      }
    }

    return '';
  }, [animPhase, animDirection]);

  // Get transition class
  // - During 'exiting': apply transition for exit animation
  // - During 'entering': NO transition so element jumps to offset position instantly
  // - During 'idle' after animation: apply transition for enter animation (offset -> final)
  // - During 'idle' on mount: NO transition to prevent unwanted animation from CSS property initialization
  const getTransitionClass = useCallback(() => {
    if (animPhase === 'exiting') return 'transition-all duration-150';
    if (animPhase === 'idle' && hasAnimated) return 'transition-all duration-150';
    return '';
  }, [animPhase, hasAnimated]);

  // Trigger animation for navigation
  // Optional onComplete callback fires after the enter animation settles
  const animate = useCallback((
    direction: AnimDirection,
    onContentChange: () => void,
    onComplete?: () => void
  ) => {
    setHasAnimated(true);
    setAnimDirection(direction);
    setAnimPhase('exiting');

    setTimeout(() => {
      onContentChange();
      setAnimPhase('entering');

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setAnimPhase('idle');
          // After idle, the 150ms CSS enter transition plays. Fire onComplete after it finishes.
          if (onComplete) {
            setTimeout(onComplete, 160);
          }
        });
      });
    }, 150);
  }, []);

  // Set entering state directly (for initial mount animation)
  const setEntering = useCallback((direction: AnimDirection) => {
    setHasAnimated(true);
    setAnimDirection(direction);
    setAnimPhase('entering');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setAnimPhase('idle');
      });
    });
  }, []);

  return { animPhase, getAnimClass, getTransitionClass, animate, setEntering };
}
