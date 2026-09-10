import { render, waitFor } from '@testing-library/react';
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
  useToast: () => ({ showToast: vi.fn() }),
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

describe('BaseTiptapComposer file redaction notice', () => {
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
    document.body.appendChild(tab);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll('[data-tab-id]').forEach((node) => node.remove());
  });

  // NOTE: queries stay scoped to the render container. The bare `screen`
  // queries resolve against a stale tree once the async editor mounts and
  // miss content that container queries reliably find.
  test('shows the notice when a file mention is staged on an API provider', async () => {
    const { container } = render(
      <>
        <ConnectionOverlay />
        <BaseTiptapComposer
          initialContent="[example.md](/workspace/example.md)"
          onSend={() => {}}
          modelProvider="api"
        />
      </>,
    );
    await waitFor(() => {
      expect(container.querySelector('.mention-node-view')).toBeTruthy();
    });
    await waitFor(() => {
      expect(container.textContent).toContain('Files will be redacted before sending to');
    });
  });

  test('hides the notice on a trusted provider', async () => {
    const { container } = render(
      <>
        <ConnectionOverlay />
        <BaseTiptapComposer
          initialContent="[example.md](/workspace/example.md)"
          onSend={() => {}}
          modelProvider="local"
        />
      </>,
    );
    await waitFor(() => {
      expect(container.querySelector('.mention-node-view')).toBeTruthy();
    });
    expect(container.textContent).not.toContain('Files will be redacted');
  });
});
