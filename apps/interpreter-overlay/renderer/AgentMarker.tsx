import { motion } from 'motion/react';

export const OVERLAY_AGENT_MARKER_LAYOUT_ID = 'overlay-agent-marker';
const OVERLAY_AGENT_MARKER_LAYOUT_TRANSITION = {
  layout: {
    type: 'spring',
    stiffness: 520,
    damping: 40,
    mass: 0.86,
  },
} as const;

interface AgentMarkerProps {
  className?: string;
  layoutId?: string;
  variant?: 'dot' | 'send';
  size?: 'compact' | 'input';
}

export function AgentMarker({
  className = '',
  layoutId = undefined,
  variant = 'dot',
  size = 'compact',
}: AgentMarkerProps) {
  return (
    <motion.div
      className={`overlay-agent-marker overlay-agent-marker-${size} ${className}`.trim()}
      layoutId={layoutId}
      transition={OVERLAY_AGENT_MARKER_LAYOUT_TRANSITION}
    >
      <div className="overlay-agent-marker-core">
        {variant === 'send' && (
          <svg
            className="overlay-agent-marker-send-icon"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path
              d="M8 11V4.75M5.5 7.15L8 4.75L10.5 7.15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
    </motion.div>
  );
}
