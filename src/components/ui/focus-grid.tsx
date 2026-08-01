import * as React from 'react';
import { createContext, useContext, useCallback, useRef, useEffect, useState } from 'react';

interface GridItem {
  id: string;
  row: number;
  col: number;
  element: HTMLElement;
}

interface FocusGridContextValue {
  register: (id: string, row: number, col: number, element: HTMLElement) => void;
  unregister: (id: string) => void;
  focusId: string | null;
}

const FocusGridContext = createContext<FocusGridContextValue | null>(null);

// Context for auto-assigning rows within a content area
interface FocusGridAreaContextValue {
  col: number;
  getNextRow: () => number;
}

const FocusGridAreaContext = createContext<FocusGridAreaContextValue | null>(null);

interface FocusGridProps {
  children: React.ReactNode;
  className?: string;
  /**
   * Called when an item is activated (Enter/Space)
   */
  onActivate?: (id: string) => void;
}

/**
 * Container for grid-based keyboard navigation.
 * Wrap your focusable items with FocusGridItem components.
 */
export function FocusGrid({ children, className, onActivate }: FocusGridProps) {
  const itemsRef = useRef<Map<string, GridItem>>(new Map());
  const [focusId, setFocusId] = React.useState<string | null>(null);

  const register = useCallback((id: string, row: number, col: number, element: HTMLElement) => {
    itemsRef.current.set(id, { id, row, col, element });
  }, []);

  const unregister = useCallback((id: string) => {
    itemsRef.current.delete(id);
  }, []);


  const getClosestInDirection = useCallback((
    fromRow: number,
    fromCol: number,
    direction: 'up' | 'down' | 'left' | 'right'
  ): GridItem | undefined => {
    const items = Array.from(itemsRef.current.values());
    let candidates: GridItem[] = [];

    switch (direction) {
      case 'up':
        candidates = items.filter(i => i.row < fromRow);
        // Sort by row descending (closest first), then by col distance
        candidates.sort((a, b) => {
          if (b.row !== a.row) return b.row - a.row;
          return Math.abs(a.col - fromCol) - Math.abs(b.col - fromCol);
        });
        break;
      case 'down':
        candidates = items.filter(i => i.row > fromRow);
        candidates.sort((a, b) => {
          if (a.row !== b.row) return a.row - b.row;
          return Math.abs(a.col - fromCol) - Math.abs(b.col - fromCol);
        });
        break;
      case 'left':
        candidates = items.filter(i => i.col < fromCol);
        candidates.sort((a, b) => {
          if (b.col !== a.col) return b.col - a.col;
          return Math.abs(a.row - fromRow) - Math.abs(b.row - fromRow);
        });
        break;
      case 'right':
        candidates = items.filter(i => i.col > fromCol);
        candidates.sort((a, b) => {
          if (a.col !== b.col) return a.col - b.col;
          return Math.abs(a.row - fromRow) - Math.abs(b.row - fromRow);
        });
        break;
    }

    return candidates[0];
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;

    // Find which item is currently focused
    let currentItem: GridItem | undefined;
    for (const item of itemsRef.current.values()) {
      if (item.element === target || item.element.contains(target)) {
        currentItem = item;
        break;
      }
    }

    if (!currentItem) return;

    let nextItem: GridItem | undefined;

    switch (e.key) {
      case 'ArrowUp':
        nextItem = getClosestInDirection(currentItem.row, currentItem.col, 'up');
        break;
      case 'ArrowDown':
        nextItem = getClosestInDirection(currentItem.row, currentItem.col, 'down');
        break;
      case 'ArrowLeft':
        nextItem = getClosestInDirection(currentItem.row, currentItem.col, 'left');
        break;
      case 'ArrowRight':
        nextItem = getClosestInDirection(currentItem.row, currentItem.col, 'right');
        break;
      case 'Enter':
      case ' ':
        // Only prevent default for Space if not in an input
        if (e.key === ' ' && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
          return;
        }
        e.preventDefault();
        onActivate?.(currentItem.id);
        return;
      default:
        return;
    }

    if (nextItem) {
      e.preventDefault();
      nextItem.element.focus();
      setFocusId(nextItem.id);
    }
  }, [getClosestInDirection, onActivate]);

  return (
    <FocusGridContext.Provider value={{ register, unregister, focusId }}>
      <div className={className} onKeyDown={handleKeyDown}>
        {children}
      </div>
    </FocusGridContext.Provider>
  );
}

/**
 * Wraps content controls and provides auto-row assignment.
 * All FocusGridItem children without explicit row/col will get auto-assigned.
 */
interface FocusGridAreaProps {
  children: React.ReactNode;
  /** Starting column for all items in this area */
  col: number;
  /** Starting row number (default: 1) */
  startRow?: number;
  className?: string;
}

export function FocusGridArea({ children, col, startRow = 1, className }: FocusGridAreaProps) {
  const rowRef = useRef(startRow);

  // Reset row counter when component mounts/remounts
  useEffect(() => {
    rowRef.current = startRow;
  }, [startRow]);

  const getNextRow = useCallback(() => {
    const row = rowRef.current;
    rowRef.current += 1;
    return row;
  }, []);

  return (
    <FocusGridAreaContext.Provider value={{ col, getNextRow }}>
      <div className={className}>{children}</div>
    </FocusGridAreaContext.Provider>
  );
}

interface FocusGridItemProps {
  id: string;
  /** Row position. If omitted and inside FocusGridArea, auto-assigned. */
  row?: number;
  /** Column position. If omitted and inside FocusGridArea, uses area's col. */
  col?: number;
  children: React.ReactNode;
  className?: string;
  /**
   * If true, the children will be wrapped in a focusable div.
   * If false, the first focusable child will be used.
   */
  asWrapper?: boolean;
}

/**
 * An item in the focus grid. Specify its row/col position.
 * If inside FocusGridArea, row/col can be auto-assigned.
 * Does not modify focus styles - uses native component focus.
 */
export function FocusGridItem({ id, row, col, children, className }: FocusGridItemProps) {
  const gridContext = useContext(FocusGridContext);
  const areaContext = useContext(FocusGridAreaContext);
  const ref = useRef<HTMLDivElement>(null);

  // Determine actual row/col - use explicit values or auto-assign from area context
  const [assignedRow] = useState(() => {
    if (row !== undefined) return row;
    if (areaContext) return areaContext.getNextRow();
    return 0; // Fallback
  });
  const actualCol = col !== undefined ? col : (areaContext?.col ?? 0);

  useEffect(() => {
    if (!gridContext) return;

    // Find first focusable child - don't modify it, just register it
    const element = ref.current?.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ) as HTMLElement;

    if (element) {
      gridContext.register(id, assignedRow, actualCol, element);
      return () => gridContext.unregister(id);
    }
  }, [gridContext, id, assignedRow, actualCol]);

  return (
    <div ref={ref} className={className} data-focus-grid-item={id}>
      {children}
    </div>
  );
}
