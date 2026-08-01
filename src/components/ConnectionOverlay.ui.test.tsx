import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ConnectionOverlay } from './ConnectionOverlay';

const layoutMocks = vi.hoisted(() => ({
  useLayout: vi.fn(),
}));

vi.mock('../hooks/useLayout', () => ({
  useLayout: layoutMocks.useLayout,
}));

describe('ConnectionOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    layoutMocks.useLayout.mockReset();
    layoutMocks.useLayout.mockReturnValue({
      state: {
        tabs: {
          'tab-1': {
            id: 'tab-1',
            type: 'file',
            label: 'example.md',
            path: '/workspace/example.md',
          },
        },
      },
    });

    const tab = document.createElement('div');
    tab.dataset.tabId = 'tab-1';
    Object.defineProperty(tab, 'getBoundingClientRect', {
      value: () => ({
        left: 460,
        top: 20,
        width: 140,
        height: 30,
        right: 600,
        bottom: 50,
      }),
      configurable: true,
    });
    document.body.appendChild(tab);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll('[data-tab-id]').forEach((node) => node.remove());
  });

  test('waits before drawing a connector to the open tab header', () => {
    render(<ConnectionOverlay />);

    act(() => {
      window.dispatchEvent(new CustomEvent('mention:hover-start', {
        detail: {
          path: '/workspace/example.md',
          mentionRect: {
            left: 120,
            top: 110,
            width: 96,
            height: 28,
          },
        },
      }));
    });

    expect(document.body.querySelector('svg.fixed.inset-0.pointer-events-none')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    const overlay = document.body.querySelector('svg.fixed.inset-0.pointer-events-none');
    expect(overlay).toBeTruthy();

    const rects = overlay?.querySelectorAll('rect') ?? [];
    expect(rects).toHaveLength(2);
    expect(overlay?.querySelector('line')).toBeTruthy();

    const targetRect = rects[1];
    expect(targetRect?.getAttribute('x')).toBe('448');
    expect(targetRect?.getAttribute('y')).toBe('8');
    expect(targetRect?.getAttribute('rx')).toBe('12');
  });
});
