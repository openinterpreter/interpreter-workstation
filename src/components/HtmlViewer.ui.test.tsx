import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { HtmlViewer } from './HtmlViewer';

const TEST_FILE_PATH = '/workspace/sankey.html';

const apiMocks = vi.hoisted(() => ({
  readFile: vi.fn<(filePath: string) => Promise<{ content: string }>>(),
}));

const ipcMocks = vi.hoisted(() => ({
  openPath: vi.fn(async (_filePath: string) => ({ error: null as string | null })),
  pathBasename: vi.fn((_filePath: string) => 'sankey.html'),
}));

const toastMocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('@/api', () => apiMocks);

vi.mock('@/ipc', () => ipcMocks);

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => toastMocks,
}));

vi.mock('../hooks/useFileRefresh', () => ({
  useFileRefresh: vi.fn(),
}));

vi.mock('../utils/feedback', () => ({
  openFeedbackPopover: vi.fn(),
}));

vi.mock('./TextEditor', () => ({
  TextEditor: () => null,
}));

vi.mock('./SandboxedHtmlFrame', () => ({
  SandboxedHtmlFrame: ({ srcDoc, title }: { srcDoc: string; title: string }) => (
    <iframe sandbox="" srcDoc={srcDoc} title={title} />
  ),
}));

describe('HtmlViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('offers external browser fallback for html that embeds blocked frames', async () => {
    const user = userEvent.setup();
    apiMocks.readFile.mockResolvedValue({
      content: '<html><body><iframe src="https://charts.example/sankey"></iframe></body></html>',
    });

    render(<HtmlViewer filePath={TEST_FILE_PATH} />);

    expect(await screen.findByText('Interactive content is blocked in preview for safety.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open in default browser' }));

    await waitFor(() => {
      expect(ipcMocks.openPath).toHaveBeenCalledWith(TEST_FILE_PATH);
    });
  });

  test('shows toast when opening externally fails', async () => {
    const user = userEvent.setup();
    apiMocks.readFile.mockResolvedValue({
      content: '<html><body><iframe src="https://charts.example/sankey"></iframe></body></html>',
    });
    ipcMocks.openPath.mockResolvedValueOnce({ error: 'Failed to open: no app association' });

    render(<HtmlViewer filePath={TEST_FILE_PATH} />);

    await user.click(await screen.findByRole('button', { name: 'Open in default browser' }));

    await waitFor(() => {
      expect(toastMocks.showToast).toHaveBeenCalledWith(
        'Could not open file: Failed to open: no app association',
        'error',
        5000,
      );
    });
  });
});
