/**
 * Layout Persistence Utilities
 *
 * Handles saving and loading tree-based layout state from localStorage
 * keyed by the current window session.
 */

import type { LayoutState } from '../../shared/types/layout';
import { createDefaultLayoutState, isValidLayoutState, ensureMinimumLayout } from './layoutHelpers';
import { getMarketingDemoLayoutState, isMarketingDemoMode } from '../demo/marketingDemo';

const STORAGE_KEY_PREFIX = 'workstation.layout.v6';
const BOOTSTRAP_CONSUMED_KEY_PREFIX = 'workstation.layout.bootstrap.v1';
const DEBOUNCE_DELAY = 500;

let saveTimeout: NodeJS.Timeout | null = null;
let pendingState: LayoutState | null = null;
let pendingStorageKey: string | null = null;

function getStorageKey(windowSessionKey: string): string {
  return `${STORAGE_KEY_PREFIX}.${windowSessionKey}`;
}

function getBootstrapConsumedKey(windowSessionKey: string): string {
  return `${BOOTSTRAP_CONSUMED_KEY_PREFIX}.${windowSessionKey}`;
}

function writeLayoutState(storageKey: string, state: LayoutState): void {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function resolveInitialLayoutState(
  windowSessionKey: string,
  bootstrapLayout: LayoutState | null,
): LayoutState {
  if (bootstrapLayout) {
    const bootstrapConsumedKey = getBootstrapConsumedKey(windowSessionKey);
    if (sessionStorage.getItem(bootstrapConsumedKey) !== '1') {
      sessionStorage.setItem(bootstrapConsumedKey, '1');
      if (!isValidLayoutState(bootstrapLayout)) {
        console.warn('Invalid bootstrap layout state, using default');
        return createDefaultLayoutState();
      }
      return ensureMinimumLayout(bootstrapLayout);
    }
  }

  return createDefaultLayoutState();
}

export function saveLayoutState(windowSessionKey: string, state: LayoutState): void {
  if (isMarketingDemoMode()) {
    return;
  }

  pendingState = state;
  pendingStorageKey = getStorageKey(windowSessionKey);
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      if (!pendingState || !pendingStorageKey) return;
      writeLayoutState(pendingStorageKey, pendingState);
      pendingState = null;
      pendingStorageKey = null;
    } catch (error) {
      console.error('Failed to save layout state:', error);
    } finally {
      saveTimeout = null;
    }
  }, DEBOUNCE_DELAY);
}

export function flushLayoutState(windowSessionKey: string, state?: LayoutState): void {
  if (isMarketingDemoMode()) {
    return;
  }

  if (state) {
    pendingState = state;
    pendingStorageKey = getStorageKey(windowSessionKey);
  }

  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }

  if (!pendingState || !pendingStorageKey) {
    return;
  }

  try {
    writeLayoutState(pendingStorageKey, pendingState);
    pendingState = null;
    pendingStorageKey = null;
  } catch (error) {
    console.error('Failed to flush layout state:', error);
  }
}

export function loadLayoutState(
  windowSessionKey: string,
  bootstrapLayout: LayoutState | null = null,
): LayoutState {
  if (isMarketingDemoMode()) {
    return getMarketingDemoLayoutState();
  }

  try {
    const storageKey = getStorageKey(windowSessionKey);
    const stored = localStorage.getItem(storageKey);
    if (!stored) {
      return resolveInitialLayoutState(windowSessionKey, bootstrapLayout);
    }

    const parsed = JSON.parse(stored);
    if (!isValidLayoutState(parsed)) {
      console.warn('Invalid layout state in localStorage, using default');
      return createDefaultLayoutState();
    }

    return ensureMinimumLayout(parsed as LayoutState);
  } catch (error) {
    console.error('Failed to load layout state, using default:', error);
    return createDefaultLayoutState();
  }
}

export function clearLayoutState(windowSessionKey: string): void {
  if (isMarketingDemoMode()) {
    return;
  }

  try {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    pendingState = null;
    pendingStorageKey = null;
    localStorage.removeItem(getStorageKey(windowSessionKey));
    sessionStorage.removeItem(getBootstrapConsumedKey(windowSessionKey));
  } catch (error) {
    console.error('Failed to clear layout state:', error);
  }
}
