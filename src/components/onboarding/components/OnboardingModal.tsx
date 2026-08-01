import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';

import { cn } from '@/lib/utils';

interface OnboardingModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}

const OVERLAY_TRANSITION = {
  duration: 0.2,
  ease: [0.22, 1, 0.36, 1] as const,
};

const PANEL_TRANSITION = {
  duration: 0.24,
  ease: [0.22, 1, 0.36, 1] as const,
};

export function OnboardingModal({
  open,
  onClose,
  children,
  className,
  panelClassName,
  panelStyle,
  closeOnBackdrop = true,
  closeOnEscape = true,
}: OnboardingModalProps) {
  useEffect(() => {
    if (!open || !closeOnEscape) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeOnEscape, onClose, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn('fixed inset-0 z-[60] flex items-center justify-center px-6', className)}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <motion.div
            className="absolute inset-0 bg-black/18"
            variants={{
              hidden: { opacity: 0 },
              visible: { opacity: 1, transition: OVERLAY_TRANSITION },
              exit: { opacity: 0, transition: OVERLAY_TRANSITION },
            }}
            onClick={closeOnBackdrop ? onClose : undefined}
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            className={cn('relative w-full', panelClassName)}
            style={panelStyle}
            variants={{
              hidden: { opacity: 0, scale: 1.045 },
              visible: { opacity: 1, scale: 1, transition: PANEL_TRANSITION },
              exit: { opacity: 0, scale: 1.045, transition: PANEL_TRANSITION },
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
