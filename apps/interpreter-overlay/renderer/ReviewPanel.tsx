import type { ReviewAction } from '../shared/ipc.js';

interface ReviewPanelProps {
  action: ReviewAction | null;
  active?: boolean;
  blink?: boolean;
  pressed?: boolean;
  executing?: boolean;
  frameColor?: string;
  frameOpacity?: number;
  outlineWidth?: number;
}

function getTargetRadius(action: ReviewAction): number {
  const baseRadius = (action.type === 'click' || action.type === 'scroll')
    ? action.bounds.height * 0.18
    : action.bounds.height * 0.24;
  return Math.max(8, Math.min(16, Math.round(baseRadius)));
}

export function ReviewPanel({
  action,
  active = false,
  blink = false,
  pressed = false,
  executing = false,
  frameColor = 'rgba(148, 163, 184, 0.55)',
  frameOpacity = 1,
  outlineWidth = 2,
}: ReviewPanelProps) {
  if (!action) return null;

  const frameLeft = action.bounds.x;
  const frameTop = action.bounds.y;
  const frameBoxWidth = Math.max(action.bounds.width, 8);
  const frameBoxHeight = Math.max(action.bounds.height, 8);
  const radius = getTargetRadius(action);

  if (active) {
    return (
      <div
        className={[
          'review-target-lift',
          'pushable-surface',
          pressed ? 'pushable-surface-pressed' : '',
          pressed ? 'review-target-lift-pressed' : '',
          executing ? 'review-target-lift-executing' : '',
        ].filter(Boolean).join(' ')}
        style={{
          left: `${frameLeft}px`,
          top: `${frameTop}px`,
          width: `${frameBoxWidth}px`,
          height: `${frameBoxHeight}px`,
          borderRadius: `${radius}px`,
          opacity: frameOpacity,
          animation: blink ? 'overlaySoftPulse 180ms ease-out 1' : 'none',
          transition: 'left 180ms cubic-bezier(0.22, 1, 0.36, 1), top 180ms cubic-bezier(0.22, 1, 0.36, 1), width 180ms cubic-bezier(0.22, 1, 0.36, 1), height 180ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease, transform 55ms ease-out, box-shadow 55ms ease-out, background-color 55ms ease-out',
        }}
      />
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: `${frameLeft}px`,
        top: `${frameTop}px`,
        width: `${frameBoxWidth}px`,
        height: `${frameBoxHeight}px`,
        border: 'none',
        outline: `${outlineWidth}px solid ${frameColor}`,
        outlineOffset: '2px',
        borderRadius: `${radius}px`,
        pointerEvents: 'none',
        boxShadow: 'none',
        zIndex: 999998,
        transition: 'none',
        opacity: frameOpacity,
        animation: blink ? 'overlaySoftPulse 180ms ease-out 1' : 'none',
      }}
    />
  );
}
