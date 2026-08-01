import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { LowerLeftNoticeProvider, useLowerLeftNotices } from '../contexts/LowerLeftNoticesContext';
import { ToastProvider } from '../contexts/ToastContext';
import { FeedbackPopover } from './FeedbackPopover';

vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: {
      button: React.forwardRef<HTMLButtonElement, React.ComponentProps<'button'> & { whileTap?: unknown; transition?: unknown }>(
        ({ whileTap: _whileTap, transition: _transition, ...props }, ref) => (
          <button ref={ref} {...props} />
        ),
      ),
    },
    useReducedMotion: () => false,
  };
});

const ipcMocks = vi.hoisted(() => ({
  getRuntimeSystemInfo: vi.fn(() => ({ platform: 'darwin' })),
  isBrowserDevMode: vi.fn(() => false),
}));

const telemetryMocks = vi.hoisted(() => ({
  trackFeedbackOpened: vi.fn(),
  trackFeedbackSubmitted: vi.fn(),
}));

vi.mock('@/ipc', () => ({
  getRuntimeSystemInfo: ipcMocks.getRuntimeSystemInfo,
  isBrowserDevMode: ipcMocks.isBrowserDevMode,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    session: {
      user: {
        email: 'tester@example.com',
      },
    },
  }),
}));

vi.mock('../utils/telemetry', () => telemetryMocks);

vi.mock('../utils/userVisibleErrorLog', () => ({
  logUserVisibleError: vi.fn(),
}));

function NoticeViewport() {
  const { notices } = useLowerLeftNotices();
  return (
    <div data-testid="toast-viewport">
      {notices.map((notice) => (
        <div key={notice.id}>{notice.content}</div>
      ))}
    </div>
  );
}

function renderFeedbackPopover() {
  return render(
    <LowerLeftNoticeProvider>
      <ToastProvider>
        <FeedbackPopover />
        <NoticeViewport />
      </ToastProvider>
    </LowerLeftNoticeProvider>,
  );
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function submitMeaningfulFeedback(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Feedback' }));
  await user.clear(await screen.findByLabelText('Email'));
  await user.type(screen.getByLabelText('Email'), 'tester@example.com');
  await user.type(screen.getByLabelText('Message'), 'Feedback submission should show visible toast progress.');
  await user.click(screen.getByRole('button', { name: 'Send Feedback' }));
}

describe('FeedbackPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).electron = {
      feedback: {
        submit: vi.fn(),
      },
    };
  });

  test('closes the popover after submit and keeps success visible in the toast', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<{ success: boolean; id: string }>();
    (window as any).electron.feedback.submit.mockReturnValue(deferred.promise);

    renderFeedbackPopover();

    await submitMeaningfulFeedback(user);

    expect(await screen.findByText('Sending feedback...')).toBeVisible();
    expect((window as any).electron.feedback.submit).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    });

    await act(async () => {
      deferred.resolve({ success: true, id: 'feedback-1' });
    });

    expect(await screen.findByText('Feedback sent!')).toBeVisible();
    expect(screen.queryByText('Sending feedback...')).not.toBeInTheDocument();
  });

  test('closes the popover after submit and replaces the sending toast when submission fails', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<{ success: boolean; error: string }>();
    (window as any).electron.feedback.submit.mockReturnValue(deferred.promise);

    renderFeedbackPopover();

    await submitMeaningfulFeedback(user);
    expect(await screen.findByText('Sending feedback...')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    });

    await act(async () => {
      deferred.resolve({ success: false, error: 'Feedback server unavailable' });
    });

    expect(await screen.findByText('Feedback server unavailable')).toBeVisible();
    expect(screen.queryByText('Sending feedback...')).not.toBeInTheDocument();
  });

  test('does not show a sending toast when validation blocks submission', async () => {
    const user = userEvent.setup();

    renderFeedbackPopover();

    await user.click(screen.getByRole('button', { name: 'Feedback' }));
    await user.type(await screen.findByLabelText('Message'), 'abcd');
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }));

    expect(await screen.findByText('Please add more details')).toBeVisible();
    expect(screen.queryByText('Sending feedback...')).not.toBeInTheDocument();
    expect((window as any).electron.feedback.submit).not.toHaveBeenCalled();
  });

  test('tabs from the email field to the message field inside the popover form', async () => {
    const user = userEvent.setup();

    renderFeedbackPopover();

    await user.click(screen.getByRole('button', { name: 'Feedback' }));
    const emailInput = await screen.findByLabelText('Email');
    const messageInput = screen.getByLabelText('Message');

    await user.click(emailInput);
    expect(emailInput).toHaveFocus();

    await user.tab();

    expect(messageInput).toHaveFocus();
  });
});
