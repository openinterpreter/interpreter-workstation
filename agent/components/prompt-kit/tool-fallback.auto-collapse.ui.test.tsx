// Behavior tests for tool-fallback auto-collapse / auto-expand-on-error.
//
// The hook owns the timing rules:
//   * Loading → complete: schedule a collapse if open && !userToggled && !defaultOpen
//   * Loading → error:    cancel any scheduled collapse, surface error
//   * User toggles:       cancel the scheduled collapse, never auto-collapse again
//
// We render a small harness component that consumes the hook so jsdom is
// actually exercising the React lifecycle, not just calling the function.

import { useState } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ToolCallInfo } from '../../../src/hooks/use-chat';

import {
  AUTO_COLLAPSE_DELAY_MS,
  useAutoCollapseAfterSuccess,
} from './tool-fallback';

interface HarnessHandle {
  isOpen: () => boolean;
  setStateExternal: (state: ToolCallInfo['state']) => void;
  toggleAsUser: () => void;
}

const handles: HarnessHandle[] = [];

function Harness(props: {
  initialState: ToolCallInfo['state'];
  initialOpen?: boolean;
  defaultOpen?: boolean;
}) {
  const [state, setState] = useState<ToolCallInfo['state']>(props.initialState);
  const [open, setOpen] = useState<boolean>(props.initialOpen ?? true);

  const { onUserToggle } = useAutoCollapseAfterSuccess({
    open,
    setOpen,
    state,
    defaultOpen: props.defaultOpen ?? false,
  });

  handles.push({
    isOpen: () => open,
    setStateExternal: (next) => setState(next),
    toggleAsUser: () => {
      onUserToggle();
      setOpen((value) => !value);
    },
  });

  return <div data-open={open}>{state}</div>;
}

function latestHandle(): HarnessHandle {
  const h = handles[handles.length - 1];
  if (!h) throw new Error('no harness mounted');
  return h;
}

describe('useAutoCollapseAfterSuccess', () => {
  beforeEach(() => {
    handles.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('collapses ~1.2s after loading → complete', () => {
    render(<Harness initialState="loading" initialOpen={true} />);
    expect(latestHandle().isOpen()).toBe(true);

    act(() => latestHandle().setStateExternal('complete'));
    expect(latestHandle().isOpen()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS - 1);
    });
    expect(latestHandle().isOpen()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(latestHandle().isOpen()).toBe(false);
  });

  test('does NOT auto-collapse when user has manually toggled', () => {
    render(<Harness initialState="loading" initialOpen={true} />);

    // User explicitly toggles closed then back open before completion.
    act(() => latestHandle().toggleAsUser());
    act(() => latestHandle().toggleAsUser());
    expect(latestHandle().isOpen()).toBe(true);

    act(() => latestHandle().setStateExternal('complete'));
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS * 3);
    });

    // Stays open because the user has expressed intent.
    expect(latestHandle().isOpen()).toBe(true);
  });

  test('does NOT auto-collapse when state goes to error', () => {
    render(<Harness initialState="loading" initialOpen={true} />);

    act(() => latestHandle().setStateExternal('error'));
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS * 3);
    });

    // Errored cards stay open so the failure is visible. (Auto-expand
    // logic lives in the card component; here we only assert that the
    // collapse timer does not fire for error.)
    expect(latestHandle().isOpen()).toBe(true);
  });

  test('does NOT auto-collapse cards that were intentionally defaultOpen', () => {
    // Subagents / approvals are defaultOpen — they want to stay open.
    render(<Harness initialState="loading" initialOpen={true} defaultOpen={true} />);

    act(() => latestHandle().setStateExternal('complete'));
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS * 3);
    });

    expect(latestHandle().isOpen()).toBe(true);
  });

  test('cancels a scheduled collapse if user toggles during the delay window', () => {
    render(<Harness initialState="loading" initialOpen={true} />);

    act(() => latestHandle().setStateExternal('complete'));

    // Half-way through the collapse delay, user clicks.
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS / 2);
    });
    act(() => latestHandle().toggleAsUser()); // closes
    act(() => latestHandle().toggleAsUser()); // reopens

    // Finish what would have been the timer window — collapse should NOT fire.
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS);
    });

    expect(latestHandle().isOpen()).toBe(true);
  });

  test('does nothing when state was already complete on mount (no false collapse)', () => {
    render(<Harness initialState="complete" initialOpen={true} />);

    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS * 2);
    });

    expect(latestHandle().isOpen()).toBe(true);
  });
});
