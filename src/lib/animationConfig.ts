/**
 * Centralized animation configuration (Doc 06).
 *
 * Goal: every motion-react `transition` in the app reads from one source
 * of truth. Today many components declare their own duration/easing
 * inline (`transition={{ duration: 0.2 }}`, `transition-transform`,
 * `animate-blink`, etc.) which makes the app's motion feel inconsistent.
 *
 * New components should import from here. Existing components migrate
 * opportunistically when they're touched for other reasons.
 */

import type { Transition } from 'motion/react';

/**
 * Default spring used for collapse / expand / scale transitions.
 * Snappy enough to feel responsive, damped enough to avoid overshoot.
 */
export const SPRING_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 220,
  damping: 26,
  mass: 1,
};

/**
 * Standard easing curve for tween-based fades and slides.
 * Matches the cubic-bezier sprinkled throughout the codebase today.
 */
export const STANDARD_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * Named tween durations (seconds, motion-react convention).
 */
export const DURATIONS = {
  /** Hover state changes, chevron rotations, small toggles. */
  fast: 0.15,
  /** Default for collapse/expand bodies and fades. */
  standard: 0.22,
  /** Slow reveals (onboarding, large surfaces). */
  slow: 0.4,
} as const;

/**
 * Standard tween used as a motion-react transition object.
 */
export const STANDARD_TWEEN: Transition = {
  duration: DURATIONS.standard,
  ease: STANDARD_EASE,
};

export const FAST_TWEEN: Transition = {
  duration: DURATIONS.fast,
  ease: STANDARD_EASE,
};

/**
 * Default transition the app's MotionConfig provider applies. Anything
 * that doesn't override `transition=` inherits this.
 */
export const APP_DEFAULT_TRANSITION: Transition = STANDARD_TWEEN;

/**
 * Height-collapse + opacity-fade pair shared by ExpandableToolSection,
 * panel collapse animations, and the fade-mask primitive.
 */
export const COLLAPSE_TRANSITION = {
  height: {
    duration: DURATIONS.standard,
    ease: STANDARD_EASE,
  },
  opacity: {
    duration: DURATIONS.fast,
    ease: STANDARD_EASE,
  },
} as const;
