/**
 * useLayout Hook
 *
 * Provides access to the layout context (state + actions).
 * For components that only need actions (openFile, closeTab, etc.),
 * use useLayoutActions() instead — it won't re-render on state changes.
 */

import { useContext } from 'react';
import { LayoutContext, LayoutActionsContext } from '../contexts/LayoutContext';

export function useLayout() {
  const context = useContext(LayoutContext);

  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider');
  }

  return context;
}

/**
 * Returns only the action functions from LayoutContext.
 * Unlike useLayout(), this does NOT subscribe to state changes,
 * so components using it won't re-render on tab switches, etc.
 */
export function useLayoutActions() {
  const context = useContext(LayoutActionsContext);

  if (!context) {
    throw new Error('useLayoutActions must be used within a LayoutProvider');
  }

  return context;
}
