import type { Transition } from 'motion/react';

type SidebarFooterMotionKind = 'panel' | 'trigger' | 'divider';

const SIDEBAR_FOOTER_EASE = [0.22, 1, 0.36, 1] as const;
const SIDEBAR_FOOTER_REDUCED_TRANSITION: Transition = {
  duration: 0.12,
};
const SIDEBAR_FOOTER_STANDARD_TRANSITION: Transition = {
  duration: 0.18,
  ease: SIDEBAR_FOOTER_EASE,
};

export const SIDEBAR_FOOTER_HEIGHT_TRANSITION = 'height 180ms cubic-bezier(0.22, 1, 0.36, 1)';
export const SIDEBAR_FOOTER_PANEL_STYLE = {
  transformOrigin: 'bottom center',
} as const;

export function getSidebarFooterMotion(kind: SidebarFooterMotionKind, reducedMotion: boolean) {
  if (reducedMotion) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: SIDEBAR_FOOTER_REDUCED_TRANSITION,
    };
  }

  if (kind === 'panel') {
    return {
      initial: { opacity: 0, y: 8 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -6 },
      transition: SIDEBAR_FOOTER_STANDARD_TRANSITION,
    };
  }

  if (kind === 'trigger') {
    return {
      initial: { opacity: 0, y: -6 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: 6 },
      transition: SIDEBAR_FOOTER_STANDARD_TRANSITION,
    };
  }

  return {
    initial: { opacity: 0, y: -2 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 2 },
    transition: SIDEBAR_FOOTER_STANDARD_TRANSITION,
  };
}
