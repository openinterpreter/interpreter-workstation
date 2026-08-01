import { motion } from 'motion/react';
import type { CSSProperties } from 'react';

export const ASSISTANT_ACTIVITY_COLOR = 'var(--oa-text-strong, var(--foreground))';

interface AssistantActivityIndicatorProps {
  layoutId?: string;
  size?: number;
  style?: CSSProperties;
  className?: string;
  testId?: string;
}

export function AssistantActivityIndicator({
  layoutId,
  size = 8,
  style,
  className,
  testId,
}: AssistantActivityIndicatorProps) {
  return (
    <motion.span
      aria-hidden="true"
      data-testid={testId}
      layoutId={layoutId}
      className={className}
      animate={{
        opacity: [0.5, 1, 0.5],
        scale: [0.88, 1.08, 0.88],
      }}
      transition={{
        opacity: {
          duration: 1.1,
          ease: 'easeInOut',
          repeat: Infinity,
        },
        scale: {
          duration: 1.1,
          ease: 'easeInOut',
          repeat: Infinity,
        },
        layout: {
          duration: 0.22,
          ease: [0.16, 1, 0.3, 1],
        },
      }}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '999px',
        display: 'inline-block',
        flexShrink: 0,
        backgroundColor: ASSISTANT_ACTIVITY_COLOR,
        ...style,
      }}
    />
  );
}
