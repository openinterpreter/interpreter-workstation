import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BaseTiptapComposer } from './BaseTiptapComposer';
import { ConnectionOverlay } from '../../../src/components/ConnectionOverlay';

const layoutMocks = vi.hoisted(() => ({
  useLayout: vi.fn(),
  useLayoutActions: vi.fn(),
}));

vi.mock('../../../src/hooks/useLayout', () => ({
  useLayout: layoutMocks.useLayout,
  useLayoutActions: layoutMocks.useLayoutActions,
}));

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock('../../../src/components/FileSystemProxy', () => ({
  FileSystemProxy: ({
    filename,
    onClick,
    onRemove,
  }: {
    filename?: string;
    onClick?: () => void;
    onRemove?: () => void;
  }) => (
    <button type="button" onClick={onClick} data-remove={Boolean(onRemove)}>
      {filename}
    </button>
  ),
}));

describe('BaseTiptapComposer hover connectors', () => {
  beforeEach(() => {
    layoutMocks.useLayout.mockReset();
    layoutMocks.useLayoutActions.mockReset();
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
    layoutMocks.useLayoutActions.mockReturnValue({
      openFile: vi.fn(),
      openFolder: vi.fn(),
      openBrowser: vi.fn(),
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

  test('draws the delayed connection overlay when hovering a composer file mention', async () => {
    const { container } = render(
      <>
        <ConnectionOverlay />
        <BaseTiptapComposer
          initialContent="[example.md](/workspace/example.md)"
          onSend={() => {}}
        />
      </>,
    );

    const mention = await waitFor(() => {
      const mention = container.querySelector('.mention-node-view') as HTMLElement | null;
      expect(mention).toBeTruthy();
      return mention as HTMLElement;
    });

    vi.useFakeTimers();

    Object.defineProperty(mention, 'getBoundingClientRect', {
      value: () => ({
        left: 120,
        top: 110,
        width: 96,
        height: 28,
        right: 216,
        bottom: 138,
      }),
      configurable: true,
    });

    act(() => {
      fireEvent.mouseEnter(mention);
      vi.advanceTimersByTime(2100);
    });

    const overlay = document.body.querySelector('svg.fixed.inset-0.pointer-events-none');
    expect(overlay).toBeTruthy();
    expect(overlay?.querySelector('line')).toBeTruthy();
  });
});
