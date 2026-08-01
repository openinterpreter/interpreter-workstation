import { useState, useRef, useEffect, useCallback } from 'react';

interface UseResizableOptions {
  /** Initial height value */
  initialHeight?: number;
  /** Minimum height allowed */
  minHeight?: number;
  /** Maximum height allowed */
  maxHeight?: number;
  /** Direction of resize - 'up' means dragging up increases height */
  direction?: 'up' | 'down';
  /** Callback when height changes */
  onHeightChange?: (height: number) => void;
  /** Callback when dragging below minimum (e.g., to collapse) */
  onBelowMinimum?: () => void;
}

interface UseResizableReturn {
  /** Current height value */
  height: number;
  /** Set height directly */
  setHeight: (height: number) => void;
  /** Whether currently dragging */
  isDragging: boolean;
  /** Mouse down handler for resize handle */
  handleMouseDown: (e: React.MouseEvent) => void;
}

/**
 * Hook for resizable panel functionality
 * Used by HelpPanel and Composer for consistent resize behavior
 */
export function useResizable({
  initialHeight = 0,
  minHeight = 0,
  maxHeight = 300,
  direction = 'up',
  onHeightChange,
  onBelowMinimum,
}: UseResizableOptions = {}): UseResizableReturn {
  const [height, setHeightState] = useState(initialHeight);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  const setHeight = useCallback((newHeight: number) => {
    setHeightState(newHeight);
    onHeightChange?.(newHeight);
  }, [onHeightChange]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartY.current = e.clientY;
    dragStartHeight.current = height;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [height]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = direction === 'up'
        ? dragStartY.current - e.clientY
        : e.clientY - dragStartY.current;

      const newHeight = dragStartHeight.current + deltaY;

      if (newHeight < minHeight && onBelowMinimum) {
        onBelowMinimum();
        setIsDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        return;
      }

      setHeight(Math.max(minHeight, Math.min(maxHeight, newHeight)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, minHeight, maxHeight, direction, onBelowMinimum, setHeight]);

  return {
    height,
    setHeight,
    isDragging,
    handleMouseDown,
  };
}
