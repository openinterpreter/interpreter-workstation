import { useCallback, useRef } from 'react';

interface FocusableItem {
  id: string;
  row: number;
  col: number;
  element: HTMLElement;
}

interface UseFocusGridOptions {
  /**
   * Whether to wrap around when reaching edges
   */
  wrap?: boolean;
  /**
   * Callback when an item is activated (Enter/Space)
   */
  onActivate?: (id: string) => void;
}

/**
 * A hook for grid-based keyboard navigation.
 *
 * Usage:
 * 1. Call useFocusGrid() to get the grid controller
 * 2. Use registerItem to register each focusable element with its row/col
 * 3. Attach handleKeyDown to your container
 * 4. Arrow keys navigate the grid, Enter/Space activates
 */
export function useFocusGrid(options: UseFocusGridOptions = {}) {
  const { wrap = false, onActivate } = options;
  const itemsRef = useRef<Map<string, FocusableItem>>(new Map());
  const currentIdRef = useRef<string | null>(null);

  // Register a focusable item
  const registerItem = useCallback((id: string, row: number, col: number, element: HTMLElement | null) => {
    if (element) {
      itemsRef.current.set(id, { id, row, col, element });

      // Make it focusable
      if (!element.hasAttribute('tabindex')) {
        element.setAttribute('tabindex', '-1');
      }

      // Track focus
      const handleFocus = () => {
        currentIdRef.current = id;
      };
      element.addEventListener('focus', handleFocus);

      return () => {
        element.removeEventListener('focus', handleFocus);
        itemsRef.current.delete(id);
      };
    }
    return () => {
      itemsRef.current.delete(id);
    };
  }, []);

  // Get item at position
  const getItemAt = useCallback((row: number, col: number): FocusableItem | undefined => {
    for (const item of itemsRef.current.values()) {
      if (item.row === row && item.col === col) {
        return item;
      }
    }
    return undefined;
  }, []);

  // Get items in a row or column
  const getItemsInRow = useCallback((row: number): FocusableItem[] => {
    return Array.from(itemsRef.current.values())
      .filter(item => item.row === row)
      .sort((a, b) => a.col - b.col);
  }, []);

  const getItemsInCol = useCallback((col: number): FocusableItem[] => {
    return Array.from(itemsRef.current.values())
      .filter(item => item.col === col)
      .sort((a, b) => a.row - b.row);
  }, []);

  // Get bounds
  const getBounds = useCallback(() => {
    const items = Array.from(itemsRef.current.values());
    if (items.length === 0) return { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 };

    return {
      minRow: Math.min(...items.map(i => i.row)),
      maxRow: Math.max(...items.map(i => i.row)),
      minCol: Math.min(...items.map(i => i.col)),
      maxCol: Math.max(...items.map(i => i.col)),
    };
  }, []);

  // Move focus
  const moveFocus = useCallback((direction: 'up' | 'down' | 'left' | 'right') => {
    const currentId = currentIdRef.current;
    const current = currentId ? itemsRef.current.get(currentId) : null;

    if (!current) {
      // Focus first item if nothing is focused
      const bounds = getBounds();
      const first = getItemAt(bounds.minRow, bounds.minCol);
      first?.element.focus();
      return;
    }

    const bounds = getBounds();
    let targetRow = current.row;
    let targetCol = current.col;

    switch (direction) {
      case 'up':
        targetRow = current.row - 1;
        if (targetRow < bounds.minRow) {
          targetRow = wrap ? bounds.maxRow : bounds.minRow;
        }
        break;
      case 'down':
        targetRow = current.row + 1;
        if (targetRow > bounds.maxRow) {
          targetRow = wrap ? bounds.minRow : bounds.maxRow;
        }
        break;
      case 'left':
        targetCol = current.col - 1;
        if (targetCol < bounds.minCol) {
          targetCol = wrap ? bounds.maxCol : bounds.minCol;
        }
        break;
      case 'right':
        targetCol = current.col + 1;
        if (targetCol > bounds.maxCol) {
          targetCol = wrap ? bounds.minCol : bounds.maxCol;
        }
        break;
    }

    // Find item at target position, or closest in that direction
    let target = getItemAt(targetRow, targetCol);

    // If no exact match, find closest item in that row/col
    if (!target) {
      if (direction === 'up' || direction === 'down') {
        const itemsInRow = getItemsInRow(targetRow);
        // Find closest column
        target = itemsInRow.reduce((closest, item) => {
          if (!closest) return item;
          return Math.abs(item.col - current.col) < Math.abs(closest.col - current.col) ? item : closest;
        }, undefined as FocusableItem | undefined);
      } else {
        const itemsInCol = getItemsInCol(targetCol);
        // Find closest row
        target = itemsInCol.reduce((closest, item) => {
          if (!closest) return item;
          return Math.abs(item.row - current.row) < Math.abs(closest.row - current.row) ? item : closest;
        }, undefined as FocusableItem | undefined);
      }
    }

    if (target && target.id !== currentId) {
      target.element.focus();
    }
  }, [wrap, getBounds, getItemAt, getItemsInRow, getItemsInCol]);

  // Keyboard handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        moveFocus('up');
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveFocus('down');
        break;
      case 'ArrowLeft':
        e.preventDefault();
        moveFocus('left');
        break;
      case 'ArrowRight':
        e.preventDefault();
        moveFocus('right');
        break;
      case 'Enter':
      case ' ':
        if (currentIdRef.current && onActivate) {
          e.preventDefault();
          onActivate(currentIdRef.current);
        }
        break;
      case 'Home':
        e.preventDefault();
        const boundsHome = getBounds();
        getItemAt(boundsHome.minRow, boundsHome.minCol)?.element.focus();
        break;
      case 'End':
        e.preventDefault();
        const boundsEnd = getBounds();
        getItemAt(boundsEnd.maxRow, boundsEnd.maxCol)?.element.focus();
        break;
    }
  }, [moveFocus, onActivate, getBounds, getItemAt]);

  // Focus a specific item
  const focusItem = useCallback((id: string) => {
    const item = itemsRef.current.get(id);
    item?.element.focus();
  }, []);

  return {
    registerItem,
    handleKeyDown,
    focusItem,
    moveFocus,
  };
}

/**
 * Helper to create a ref callback for registering grid items
 */
export function createGridItemRef(
  registerItem: ReturnType<typeof useFocusGrid>['registerItem'],
  id: string,
  row: number,
  col: number
) {
  let cleanup: (() => void) | undefined;

  return (element: HTMLElement | null) => {
    cleanup?.();
    cleanup = registerItem(id, row, col, element);
  };
}
