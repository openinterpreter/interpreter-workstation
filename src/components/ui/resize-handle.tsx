import * as React from 'react';

interface ResizeHandleProps {
  /** Mouse down handler */
  onMouseDown: (e: React.MouseEvent) => void;
  /** Orientation of the resize handle */
  orientation?: 'horizontal' | 'vertical';
  /** Whether to show a visible border line (default: false) */
  showBorder?: boolean;
  /** Optional className for additional styling */
  className?: string;
  /** Optional inline styles for custom hit areas */
  style?: React.CSSProperties;
}

/**
 * Resize handle component for resizable panels
 * Pure hit area by default - no visual unless showBorder is true
 */
export function ResizeHandle({
  onMouseDown,
  orientation = 'horizontal',
  showBorder = false,
  className,
  style,
}: ResizeHandleProps) {
  const isHorizontal = orientation === 'horizontal';
  const borderStyle = isHorizontal
    ? { height: 'var(--border-width)' }
    : { width: 'var(--border-width)' };

  return (
    <div
      onMouseDown={onMouseDown}
      className={`${isHorizontal ? 'resize-handle-horizontal' : 'resize-handle-vertical'} ${className || ''}`}
      style={style}
    >
      {showBorder && (
        <div
          className={`${isHorizontal ? 'w-full' : 'h-full'} bg-border`}
          style={borderStyle}
        />
      )}
    </div>
  );
}
