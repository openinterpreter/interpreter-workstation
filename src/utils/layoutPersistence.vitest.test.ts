import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDefaultLayoutState } from './layoutHelpers';
import { clearLayoutState, saveLayoutState } from './layoutPersistence';

const WINDOW_SESSION_KEY = 'window-test';
const STORAGE_KEY = `workstation.layout.v6.${WINDOW_SESSION_KEY}`;

describe('layoutPersistence', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  test('clearLayoutState cancels a pending debounced save', () => {
    vi.useFakeTimers();

    saveLayoutState(WINDOW_SESSION_KEY, createDefaultLayoutState());
    clearLayoutState(WINDOW_SESSION_KEY);
    vi.runAllTimers();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
