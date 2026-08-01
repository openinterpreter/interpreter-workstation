import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ThreadErrorDisplay, ThreadErrorWithLayout } from './thread-error-display';
import { openFeedbackPopover } from '../../../src/utils/feedback';

vi.mock('../../../src/utils/feedback', () => ({
  openFeedbackPopover: vi.fn(),
}));

vi.mock('../../../src/hooks/usePaidPlanStatus', () => ({
  usePaidPlanStatus: () => ({
    isPaid: false,
    loading: false,
    subscription: null,
  }),
}));

describe('ThreadErrorDisplay', () => {
  test('renders report bug, retry, and history-preserving new chat in action order', () => {
    const onRetry = vi.fn();
    const onNewChatWithHistory = vi.fn();

    render(
      <ThreadErrorWithLayout
        rawError="stream disconnected before completion"
        onRetry={onRetry}
        onStartNewChatWithHistory={onNewChatWithHistory}
      />,
    );

    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Report Bug', 'Retry', 'New Chat (with history)']);
    expect(screen.queryByRole('button', { name: 'Start new chat' })).not.toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    expect(retryButton).toHaveAttribute('title', 'Send Continue in this chat.');
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);

    const newChatButton = screen.getByRole('button', { name: 'New Chat (with history)' });
    expect(newChatButton).toHaveAttribute('title', 'Start a fresh chat and preserve history.');
    fireEvent.click(newChatButton);
    expect(onNewChatWithHistory).toHaveBeenCalledTimes(1);
  });

  test('report bug is primary and opens the feedback popover', () => {
    render(
      <ThreadErrorDisplay
        title="Request failed"
        message="Something broke."
      />,
    );

    const reportBugButton = screen.getByRole('button', { name: 'Report Bug' });
    expect(reportBugButton.className).toContain('bg-[var(--brand-accent)]');

    fireEvent.click(reportBugButton);
    expect(openFeedbackPopover).toHaveBeenCalledTimes(1);
  });

  test('renders Groq model missing guidance without Ollama copy', () => {
    render(
      <ThreadErrorWithLayout
        rawError="unexpected status 404 Not Found: The model `moonshotai/kimi-k2-instruct-0905` does not exist or you do not have access to it., url: , cf-ray: 9f5327a90e2ad92d-LIS, request id: req_01kqk3w250ff4r4vmdy8w36ky7"
        requestEndpointBaseUrl="https://api.groq.com/openai/v1"
        providerLabel="groq"
      />,
    );

    expect(screen.getByText('Invalid Groq model ID')).toBeInTheDocument();
    expect(screen.getByText('Check the model ID in Settings > Models for your Groq profile.')).toBeInTheDocument();
    expect(screen.queryByText(/Ollama/i)).not.toBeInTheDocument();
  });
});
