/**
 * Reusable collapse-with-fade-mask primitive (Doc 06).
 *
 * Use for any panel whose content can be long (reasoning, plans, large
 * tool outputs). Open: full height, fully visible. Closed: clipped at
 * `previewHeight` with a bottom gradient so text doesn't hard-cut.
 *
 * The motion timing comes from `animationConfig.ts` so this stays
 * consistent with other collapse animations in the app.
 */

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { COLLAPSE_TRANSITION } from '@/lib/animationConfig';

export interface CollapsibleWithFadeMaskProps {
  isOpen: boolean;
  /**
   * Pixel height of the visible preview when closed. A bottom-fade
   * gradient softens the edge so the text doesn't clip mid-line.
   * Default 0 — set to a positive value to show a "peek" preview.
   */
  previewHeight?: number;
  /**
   * CSS color the bottom-fade gradient blends INTO. Should match the
   * surface the collapsed preview sits on so the fade is invisible
   * against the surrounding chrome. Defaults to the app background.
   */
  fadeToColor?: string;
  /**
   * className applied to the outermost motion.div so callers can
   * size or scope the collapse.
   */
  className?: string;
  children: ReactNode;
}

export function CollapsibleWithFadeMask({
  isOpen,
  previewHeight = 0,
  fadeToColor = 'var(--oa-bg-app, var(--background))',
  className,
  children,
}: CollapsibleWithFadeMaskProps) {
  const reduceMotion = useReducedMotion();
  const hasPreview = previewHeight > 0;

  // Closed-with-preview: render a clipped peek with a fade mask.
  // Closed-without-preview: render nothing.
  if (!isOpen) {
    if (!hasPreview) return null;
    return (
      <div
        className={className}
        style={{
          position: 'relative',
          maxHeight: previewHeight,
          overflow: 'hidden',
        }}
      >
        {children}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 'auto 0 0 0',
            height: Math.min(previewHeight, 96),
            pointerEvents: 'none',
            background: `linear-gradient(to bottom, transparent, ${fadeToColor})`,
          }}
        />
      </div>
    );
  }

  return (
    <AnimatePresence initial={false}>
      <motion.div
        className={className}
        initial={reduceMotion ? false : { height: hasPreview ? previewHeight : 0, opacity: hasPreview ? 1 : 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { height: hasPreview ? previewHeight : 0, opacity: hasPreview ? 1 : 0 }}
        transition={reduceMotion ? { duration: 0 } : COLLAPSE_TRANSITION}
        style={{ overflow: 'hidden' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
